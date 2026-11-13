use super::*;
use anyhow::{Context, ensure};
use codex_protocol::protocol::{TurnAbortReason, TurnAbortedEvent};
use std::{fs::File, io};

pub(super) struct RecoverySource {
    pub(super) id: ThreadId,
    parent: Option<usize>,
    edge: Option<ThreadSpawnEdgeStatus>,
    pub(super) path: PathBuf,
    pub(super) items: Vec<RolloutItem>,
    own_start: usize,
}

impl RecoverySource {
    pub(super) async fn read(
        id: ThreadId,
        path: PathBuf,
        parent: Option<(usize, &RecoverySource, ThreadSpawnEdgeStatus)>,
    ) -> anyhow::Result<Self> {
        let items = read_complete(id, &path).await?;
        Self::from_items(id, path, items, parent).await
    }

    pub(super) async fn from_items(
        id: ThreadId,
        path: PathBuf,
        items: Vec<RolloutItem>,
        parent: Option<(usize, &RecoverySource, ThreadSpawnEdgeStatus)>,
    ) -> anyhow::Result<Self> {
        let own_start = if let Some((_, parent, _)) = parent {
            descendant_start(id, &path, &items, parent).await?
        } else {
            validate_root_header(id, &items)?;
            0
        };
        Ok(Self {
            id,
            parent: parent.map(|(index, _, _)| index),
            edge: parent.map(|(_, _, status)| status),
            path,
            items,
            own_start,
        })
    }

    fn own(&self) -> &[RolloutItem] {
        &self.items[self.own_start..]
    }
}

async fn read_complete(id: ThreadId, path: &Path) -> anyhow::Result<Vec<RolloutItem>> {
    let (items, owner, errors) = codex_rollout::RolloutRecorder::load_rollout_items(path).await?;
    ensure!(
        owner == Some(id) && errors == 0,
        "cannot read incomplete rollout or another thread's history"
    );
    Ok(items)
}

async fn descendant_start(
    id: ThreadId,
    path: &Path,
    items: &[RolloutItem],
    parent: &RecoverySource,
) -> anyhow::Result<usize> {
    let Some(RolloutItem::SessionMeta(header)) = items.first() else {
        anyhow::bail!("missing descendant header");
    };
    let meta = &header.meta;
    ensure!(
        meta.id == id
            && meta
                .source
                .parent_thread_id()
                .is_none_or(|id| id == parent.id)
            && meta.parent_thread_id.is_none_or(|id| id == parent.id)
            && (meta.source.parent_thread_id().is_some() || meta.parent_thread_id.is_some()),
        "descendant header does not match its graph edge"
    );
    if let Some(start) = meta.subagent_history_start_ordinal {
        // The native ordinal belongs to the file, not a vector index after decoding.
        let mut reader = codex_rollout::open_rollout_line_reader(path).await?;
        let mut index = 0;
        while let Some(line) = reader.next_line().await? {
            if line.trim().is_empty() {
                continue;
            }
            let row = codex_rollout::parse_rollout_line(&line)?;
            if row.ordinal.context("missing descendant rollout ordinal")? >= start {
                return Ok(index);
            }
            index += 1;
        }
        return Ok(items.len());
    }
    if meta.history_base.is_some() {
        // The referenced prefix lives in a different rollout.
        return Ok(1);
    }
    // Legacy copied forks may lack source-tagged settings. A distinct turn
    // before the first tagged settings belongs to an earlier writer of this child.
    let parent_turns = recorded_turns(&parent.items);
    let first_own_turn = items.iter().position(|row| {
        matches!(
            row, RolloutItem::EventMsg(EventMsg::TurnStarted(event))
                if !parent_turns.contains_key(&event.turn_id)
        )
    });
    if let Some(index) = items.iter().position(|row| {
        matches!(
            row, RolloutItem::EventMsg(EventMsg::ThreadSettingsApplied(event))
                if event.thread_id == Some(id)
        )
    }) && first_own_turn.is_none_or(|turn| index <= turn)
    {
        return Ok(index);
    }
    // Check any invocation before the first distinct turn before excluding it
    // from the child's ledger.
    let copied = meta.forked_from_id == Some(parent.id)
        || items.iter().any(|row| {
            matches!(
                row, RolloutItem::EventMsg(EventMsg::TurnStarted(event))
                    if parent_turns.contains_key(&event.turn_id)
            )
        });
    if !copied {
        return Ok(1);
    }
    let mut turn = None;
    for (index, row) in items.iter().enumerate().skip(1) {
        observe_turn(&mut turn, row);
        if matches!(row, RolloutItem::EventMsg(EventMsg::TurnStarted(event))
            if !parent_turns.contains_key(&event.turn_id))
        {
            return Ok(index);
        }
        if let RolloutItem::ResponseItem(item) = row
            && matches!(
                item.item,
                ResponseItem::FunctionCall { .. }
                    | ResponseItem::CustomToolCall { .. }
                    | ResponseItem::ComputerCall { .. }
                    | ResponseItem::ApplyPatchCall { .. }
            )
        {
            ensure!(
                item.item
                    .turn_id()
                    .or(turn.as_deref())
                    .is_some_and(|id| parent_turns.contains_key(id)),
                "cannot identify the owner of a copied descendant invocation"
            );
        }
    }
    Ok(items.len())
}

pub(super) struct TreeRecoveryPlan {
    pub(super) root: local_reconciliation::Plan,
    pub(super) root_receipts: Vec<Receipt>,
    pub(super) writes: Vec<SourceWrite>,
    pub(super) stage_root: bool,
}

#[derive(Default)]
pub(super) struct SourceWrite {
    rows: Vec<RolloutItem>,
    acknowledged: bool,
}

impl SourceWrite {
    pub(super) fn needs_publication(&self) -> bool {
        !self.rows.is_empty() || self.acknowledged
    }
}

pub(super) async fn plan_recovery_tree(
    inner: &LocalThreadStore,
    sources: &[RecoverySource],
    root_model: &[RolloutItem],
    receipts: Vec<Receipt>,
) -> anyhow::Result<TreeRecoveryPlan> {
    let own_turns: Vec<_> = sources
        .iter()
        .map(|source| recorded_turns(source.own()))
        .collect();
    let supplied = !receipts.is_empty();
    let mut by_source = HashMap::<_, Vec<_>>::new();
    for receipt in receipts {
        by_source
            .entry(receipt.thread_id)
            .or_default()
            .push(receipt);
    }
    let receipt_sources = sources
        .iter()
        .filter(|source| by_source.contains_key(&source.id))
        .count();
    ensure!(
        receipt_sources == by_source.len(),
        "reconciliation receipt belongs to a different thread"
    );
    let mut root = local_reconciliation::Plan::default();
    let mut root_receipts = Vec::new();
    let mut writes: Vec<SourceWrite> = Vec::with_capacity(sources.len());
    let mut missing = Vec::new();
    let mut descendant_histories = Vec::new();
    let mut affected_turns = Vec::with_capacity(sources.len());
    let mut automatic_turns = Vec::with_capacity(sources.len());
    for (index, source) in sources.iter().enumerate() {
        let receipts = by_source.remove(&source.id).unwrap_or_default();
        let model;
        let model_history: &[RolloutItem] = if index == 0 {
            root_model
        } else if receipts.is_empty() {
            &[]
        } else {
            model = inner
                .load_model_context_for_rollout(source.id, &source.path)
                .await?;
            &model.items
        };
        let (plan, turns) =
            match local_reconciliation::plan(source.id, source.own(), model_history, &receipts) {
                Ok(plan) => {
                    let turns: HashSet<_> = plan
                        .append
                        .iter()
                        .filter_map(|row| match row {
                            RolloutItem::ResponseItem(item) => {
                                item.item.turn_id().map(str::to_owned)
                            }
                            _ => None,
                        })
                        .collect();
                    (plan, turns)
                }
                Err(error) => {
                    let hold = error.downcast::<local_reconciliation::RecoveryRequired>()?;
                    ensure!(!supplied, "reconciliation must cover every unresolved call");
                    let turns = hold.calls.iter().map(|call| call.turn_id.clone()).collect();
                    missing.extend(hold.calls);
                    if index != 0 {
                        descendant_histories.push((source.id, source.own().to_vec()));
                    }
                    (local_reconciliation::Plan::default(), turns)
                }
            };
        let mut turns = turns;
        let mut automatic = HashSet::new();
        if index != 0 && own_turns[index].values().any(|active| *active) {
            automatic.extend(own_turns[index].iter().filter_map(|(turn, active)| {
                (*active && !turns.contains(turn)).then_some(turn.clone())
            }));
            turns.extend(automatic.iter().cloned());
        }
        affected_turns.push(turns);
        automatic_turns.push(automatic);
        if index == 0 {
            root = plan;
            root_receipts = receipts;
            writes.push(SourceWrite::default());
        } else {
            writes.push(SourceWrite {
                rows: plan.append,
                acknowledged: !plan.protected_ids.is_empty(),
            });
        }
    }
    let recovering_descendants = affected_turns[1..].iter().any(|turns| !turns.is_empty());
    let mut affected: Vec<_> = affected_turns
        .iter()
        .map(|turns| !turns.is_empty())
        .collect();
    for (index, source) in sources.iter().enumerate().rev() {
        let own = &own_turns[index];
        // A root-only receipt can leave an older start without an abort.
        // Only the latest root start can represent unrelated current work.
        let current_root_turn = if index == 0 && recovering_descendants {
            source.own().iter().rev().find_map(|row| match row {
                RolloutItem::EventMsg(EventMsg::TurnStarted(event)) => Some(event.turn_id.as_str()),
                _ => None,
            })
        } else {
            None
        };
        if source.edge == Some(ThreadSpawnEdgeStatus::Open) {
            ensure!(
                !own.is_empty(),
                "local history has an active descendant; its runtime cannot be restored"
            );
        }
        for (turn, active) in own {
            if !*active {
                continue;
            }
            if affected_turns[index].contains(turn) {
                if index != 0 || recovering_descendants {
                    writes[index].rows.push(interruption(turn.clone()));
                }
            } else if source.edge == Some(ThreadSpawnEdgeStatus::Open)
                || current_root_turn == Some(turn.as_str())
            {
                anyhow::bail!("local history has an unrelated active descendant or spawning turn");
            }
        }
        if affected[index]
            && let Some(parent) = source.parent
        {
            affected[parent] = true;
            let parent_source = &sources[parent];
            let spawn_turns = local_reconciliation::completed_spawn_turns(
                parent_source.id,
                source.id,
                parent_source.own(),
            )?;
            // An earlier attempt can replace an abort-only ancestor and fail
            // before syncing its directory. Confirm it before the leaf write.
            writes[parent].acknowledged |= parent_source.own().iter().any(|row| {
                matches!(row, RolloutItem::EventMsg(EventMsg::TurnAborted(event))
                    if event.reason == TurnAbortReason::Interrupted
                        && event.turn_id.as_ref().is_some_and(|turn| spawn_turns.contains(turn)))
            });
            if !automatic_turns[index].is_empty() {
                automatic_turns[parent].extend(spawn_turns.iter().cloned());
            }
            affected_turns[parent].extend(spawn_turns);
        }
    }
    if !missing.is_empty() {
        return Err(local_reconciliation::RecoveryRequired {
            calls: missing,
            history: sources[0].items.clone(),
            descendants: descendant_histories,
        }
        .into());
    }

    for (source, write) in sources.iter().zip(&mut writes) {
        write.acknowledged |= source.own().iter().any(|row| matches!(row,
            RolloutItem::EventMsg(EventMsg::TurnAborted(event))
                if event.reason == TurnAbortReason::Interrupted && event.turn_id.is_some()
                    && event.model_attempt.is_none() && event.error.is_none()
                    && event.started_at.is_none() && event.completed_at.is_none() && event.duration_ms.is_none()));
    }
    if recovering_descendants {
        for (index, source) in sources.iter().enumerate() {
            let active: HashSet<_> = own_turns[index]
                .iter()
                .filter_map(|(turn, active)| {
                    (*active && automatic_turns[index].contains(turn)).then_some(turn.clone())
                })
                .collect();
            if !active.is_empty() {
                local_reconciliation::validate_native_effects(source.own(), &active)?;
            }
        }
        let aborts = std::mem::take(&mut writes[0].rows);
        writes[0].rows = std::mem::take(&mut root.append);
        writes[0].rows.extend(aborts);
    }
    // A previous replacement may be visible even though its directory sync
    // failed. Reconfirm the tagged files even if receipts are omitted on retry.
    if sources.len() > 1 {
        writes[0].acknowledged |= !root.protected_ids.is_empty();
    }
    Ok(TreeRecoveryPlan {
        root,
        root_receipts,
        writes,
        stage_root: recovering_descendants,
    })
}

fn interruption(turn: String) -> RolloutItem {
    RolloutItem::EventMsg(EventMsg::TurnAborted(TurnAbortedEvent {
        model_attempt: None,
        turn_id: Some(turn),
        reason: TurnAbortReason::Interrupted,
        error: None,
        started_at: None,
        completed_at: None,
        duration_ms: None,
    }))
}

pub(super) async fn publish_recovery(
    source: &RecoverySource,
    write: &SourceWrite,
    #[cfg(test)] fail: Option<RecoveryWritePoint>,
) -> anyhow::Result<()> {
    if !write.needs_publication() {
        return Ok(());
    }
    let directory = source
        .path
        .parent()
        .context("rollout has no containing directory")?;
    if write.rows.is_empty() {
        tokio::fs::OpenOptions::new()
            .write(true)
            .open(&source.path)
            .await?
            .sync_all()
            .await?;
    } else {
        let mut stage = tempfile::Builder::new()
            .suffix(".jsonl")
            .tempfile_in(directory)?;
        let compressed = source
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".jsonl.zst"));
        let stage = if compressed {
            let path = source.path.clone();
            tokio::task::spawn_blocking(move || -> io::Result<_> {
                let mut decoder = zstd::stream::read::Decoder::new(File::open(path)?)?;
                io::copy(&mut decoder, stage.as_file_mut())?;
                Ok(stage)
            })
            .await??
        } else {
            tokio::fs::copy(&source.path, stage.path()).await?;
            stage
        };
        for row in &write.rows {
            codex_rollout::append_rollout_item_to_path(stage.path(), row).await?;
        }
        let replacement = if compressed {
            let mut output = tempfile::NamedTempFile::new_in(directory)?;
            let permissions = tokio::fs::metadata(&source.path).await?.permissions();
            tokio::task::spawn_blocking(move || -> io::Result<_> {
                let mut input = File::open(stage.path())?;
                let mut encoder = zstd::stream::write::Encoder::new(
                    output.as_file_mut(),
                    zstd::DEFAULT_COMPRESSION_LEVEL,
                )?;
                encoder.set_pledged_src_size(Some(input.metadata()?.len()))?;
                io::copy(&mut input, &mut encoder)?;
                encoder.finish()?;
                output.as_file().set_permissions(permissions)?;
                Ok(output)
            })
            .await??
        } else {
            stage
        };
        replacement.as_file().sync_all()?;
        #[cfg(test)]
        ensure!(
            fail != Some(RecoveryWritePoint::BeforeReplace),
            "injected failure before recovery replacement"
        );
        replacement
            .persist(&source.path)
            .map_err(|error| error.error)?;
    }
    #[cfg(test)]
    ensure!(
        fail != Some(RecoveryWritePoint::BeforeDirectorySync),
        "injected failure before recovery directory sync"
    );
    sync_checklist_directory(directory)?;
    if write.rows.is_empty() {
        return Ok(());
    }
    let persisted = read_complete(source.id, &source.path).await?;
    let tail = persisted
        .get(source.items.len()..)
        .context("recovery rollout lost its original records")?;
    ensure!(
        serde_json::to_value(tail)? == serde_json::to_value(&write.rows)?,
        "recovery records were not confirmed in storage"
    );
    Ok(())
}

#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum RecoveryWritePoint {
    BeforeReplace,
    BeforeDirectorySync,
}

impl LocalChecklistStore {
    pub(super) async fn recovery_edges(
        &self,
        root: ThreadId,
    ) -> anyhow::Result<Vec<(ThreadId, SpawnEdge)>> {
        self.graph.hydrate(root).await?;
        let mut ids = self.graph.list_thread_spawn_descendants(root, None).await?;
        ids.sort_by_cached_key(ThreadId::to_string);
        let mut edges = Vec::with_capacity(ids.len());
        for child in ids {
            let edge = self
                .graph
                .edge(child)
                .await
                .context("descendant graph was not fully hydrated")?;
            edges.push((child, edge));
        }
        Ok(edges)
    }

    pub(super) fn lock_descendants(
        &self,
        root: ThreadId,
        edges: &[(ThreadId, SpawnEdge)],
        writers: &HashMap<ThreadId, Writer>,
    ) -> anyhow::Result<Vec<WriterLockGuard>> {
        let mut ids = HashSet::from([root]);
        edges
            .iter()
            .map(|(child, _)| {
                ensure!(ids.insert(*child), "invalid descendant topology");
                ensure!(
                    !writers.contains_key(child),
                    "local descendant still has a native writer"
                );
                Ok(self.writer_locks.acquire(*child)?)
            })
            .collect()
    }

    pub(super) async fn read_recovery_sources(
        &self,
        root: RecoverySource,
        edges: &[(ThreadId, SpawnEdge)],
    ) -> anyhow::Result<Vec<RecoverySource>> {
        let mut children = HashMap::<_, Vec<_>>::new();
        for (child, edge) in edges {
            children
                .entry(edge.parent)
                .or_default()
                .push((*child, edge.status));
        }
        let mut sources = vec![root];
        let mut parent = 0;
        while let Some(source) = sources.get(parent) {
            for (child, status) in children.remove(&source.id).unwrap_or_default() {
                let stored = self
                    .inner
                    .read_thread(ReadThreadParams {
                        thread_id: child,
                        include_archived: true,
                        include_history: false,
                    })
                    .await?;
                let path = self.recovery_path(stored.rollout_path).await?;
                let child =
                    RecoverySource::read(child, path, Some((parent, &sources[parent], status)))
                        .await?;
                sources.push(child);
            }
            parent += 1;
        }
        ensure!(
            children.is_empty(),
            "descendant is not connected to this root"
        );
        Ok(sources)
    }

    pub(super) async fn recovery_path(&self, path: Option<PathBuf>) -> anyhow::Result<PathBuf> {
        let path = path.context("missing recorded rollout path")?;
        Ok(self.inner.resolve_cold_rollout_path(&path).await?)
    }
}

pub(super) fn same_edges(left: &[(ThreadId, SpawnEdge)], right: &[(ThreadId, SpawnEdge)]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .all(|((a, x), (b, y))| a == b && x.parent == y.parent && x.status == y.status)
}
