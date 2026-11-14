//! Native thread storage, accepted checklist data, and parent/child topology.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock, Weak};
use std::time::SystemTime;

use codex_agent_graph_store::{
    AgentGraphStore, AgentGraphStoreFuture, AgentGraphStoreResult, LocalAgentGraphStore,
    ThreadSpawnEdgeStatus,
};
use codex_app_server_protocol::{ThreadHistoryBuilder, TurnStatus, project_rollout_line};
use codex_history::{RolloutItem, RolloutLine};
use codex_protocol::{
    ThreadId,
    models::ResponseItem,
    plan_tool::PlanItemArg,
    protocol::{EventMsg, ThreadMemoryMode},
};
use codex_thread_store::*;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, mpsc};

/// Last accepted whole-list update. Never a source of runtime configuration.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChecklistState {
    pub thread_id: ThreadId,
    pub turn_id: String,
    pub explanation: Option<String>,
    pub plan: Vec<PlanItemArg>,
}

impl ChecklistState {
    pub fn validate(&self, id: ThreadId, history: &[RolloutItem]) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.thread_id == id,
            "checkpoint checklist thread identity mismatch"
        );
        anyhow::ensure!(
            !self.turn_id.is_empty()
                && history.iter().any(|item| {
                    matches!(item, RolloutItem::EventMsg(EventMsg::TurnStarted(turn))
                    if turn.turn_id == self.turn_id)
                }),
            "checkpoint checklist turn identity missing from history"
        );
        Ok(())
    }
}

/// The native store retains complete replay records even for paginated threads.
/// Expose those records through the SDK's portable-checkpoint read boundary.
#[derive(Default)]
struct ManualWriter {
    turn: Option<String>,
    calls: usize,
    sampled_calls: usize,
    capture: Option<ManualCapture>,
}

fn native_mcp_prefix_matches(
    history: &[RolloutItem],
    data: &codex_core::McpApprovalCheckpointData,
) -> bool {
    let Some(start) = history.iter().rposition(|row| {
        matches!(row,
        RolloutItem::EventMsg(EventMsg::TurnStarted(turn)) if turn.turn_id == data.turn_id)
    }) else {
        return false;
    };
    let mut calls = 0;
    for row in &history[start..] {
        match row {
            RolloutItem::EventMsg(EventMsg::TurnComplete(_) | EventMsg::TurnAborted(_)) => {
                return false;
            }
            RolloutItem::ResponseItem(item) => match &item.item {
                ResponseItem::FunctionCall { .. } => {
                    if !data.matches_canonical_call(&item.item) {
                        return false;
                    }
                    calls += 1;
                }
                ResponseItem::FunctionCallOutput { .. }
                | ResponseItem::CustomToolCall { .. }
                | ResponseItem::CustomToolCallOutput { .. }
                | ResponseItem::ComputerCall { .. }
                | ResponseItem::ComputerCallOutput { .. }
                | ResponseItem::ApplyPatchCall { .. }
                | ResponseItem::ApplyPatchCallOutput { .. }
                | ResponseItem::ShellCall { .. }
                | ResponseItem::ShellCallOutput { .. } => return false,
                ResponseItem::Message { .. } | ResponseItem::Reasoning { .. } => {}
                _ => return false,
            },
            _ => {}
        }
    }
    calls == 1
}

// A recovery has no fresh model sample. Its private frame retains the exact
// original sample, while the actual new native question still owns approval.
fn recovered_native_mcp_prefix_matches(
    history: &[RolloutItem],
    data: &codex_core::McpApprovalCheckpointData,
    sample: &str,
) -> bool {
    use codex_protocol::protocol::ResponseObservationStatus;
    let anchors: Vec<_> = history.iter().enumerate().filter_map(|(index, row)| match row {
        RolloutItem::ResponseObservationRecord(record) if record.id == sample => Some((index, record)),
        _ => None,
    }).collect();
    let [(anchor, observed)] = anchors.as_slice() else { return false; };
    if observed.thread_id != data.source_thread_id || observed.turn_id != data.turn_id
        || observed.compaction == Some(true)
        || observed.observation.status != ResponseObservationStatus::Completed { return false; }
    let Some(start) = history[..*anchor].iter().rposition(|row| matches!(row,
        RolloutItem::EventMsg(EventMsg::TurnStarted(_)))) else { return false; };
    if !matches!(&history[start], RolloutItem::EventMsg(EventMsg::TurnStarted(turn))
        if turn.turn_id == data.turn_id) { return false; }
    let mut calls = 0;
    for row in &history[start + 1..*anchor] {
        if let RolloutItem::ResponseItem(envelope) = row {
            match &envelope.item {
                ResponseItem::FunctionCall { .. } if data.matches_canonical_call(&envelope.item) => calls += 1,
                ResponseItem::Message { .. } | ResponseItem::Reasoning { .. } => {},
                _ => return false,
            }
        }
    }
    if calls != 1 { return false; }
    let Some(current_start) = history.iter().rposition(|row| matches!(row,
        RolloutItem::EventMsg(EventMsg::TurnStarted(_)))) else { return false; };
    if current_start <= *anchor || !matches!(&history[current_start],
        RolloutItem::EventMsg(EventMsg::TurnStarted(turn)) if turn.turn_id == data.turn_id) { return false; }
    for (index, row) in history.iter().enumerate().skip(*anchor + 1) {
        match row {
            RolloutItem::ResponseObservationRecord(_) | RolloutItem::ResponseItem(_) => return false,
            RolloutItem::EventMsg(EventMsg::TurnStarted(turn)) if turn.turn_id != data.turn_id => return false,
            RolloutItem::EventMsg(EventMsg::TurnComplete(_) | EventMsg::TurnAborted(_))
                if index >= current_start => return false,
            _ => {},
        }
    }
    true
}

struct SuspendedCall {
    turn: String,
    call: String,
}

struct ManualCapture {
    turn: String,
    pending: Vec<SuspendedCall>,
    prefix: Vec<RolloutItem>,
    sampled_calls: usize,
    suffix: Vec<Vec<RolloutItem>>,
    shutdown: bool,
}

pub struct MemoryThreadStore {
    // Exists only for native writers created by this portable memory store.
    manual_writers: Mutex<HashMap<ThreadId, ManualWriter>>,
    #[cfg(test)]
    pub(crate) completion_hold: std::sync::Mutex<Option<Arc<CompletionHold>>>,
    #[cfg(test)]
    pub(crate) next_flush_hold: std::sync::Mutex<Option<Arc<CompletionHold>>>,
    #[cfg(test)]
    pub(crate) completion_flush_hold: std::sync::Mutex<Option<Arc<CompletionHold>>>,
    #[cfg(test)]
    pub(crate) flush_traces: std::sync::Mutex<
        Option<Arc<std::sync::Mutex<Vec<(ThreadId, codex_protocol::protocol::W3cTraceContext)>>>>,
    >,
    inner: Arc<dyn ThreadStore>,
    archived: Mutex<HashMap<ThreadId, SystemTime>>,
    // The native in-memory store applies this policy but does not expose it.
    // Retain it with the store mutations for portable checkpoint export.
    memory_modes: Mutex<HashMap<ThreadId, ThreadMemoryMode>>,
    checklists: Mutex<HashMap<ThreadId, ChecklistState>>,
    fork_boundary: OnceLock<Weak<crate::native_interception::Boundary>>,
}

impl Default for MemoryThreadStore {
    fn default() -> Self {
        Self {
            #[cfg(test)]
            completion_hold: std::sync::Mutex::new(None),
            #[cfg(test)]
            next_flush_hold: std::sync::Mutex::new(None),
            #[cfg(test)]
            completion_flush_hold: std::sync::Mutex::new(None),
            #[cfg(test)]
            flush_traces: std::sync::Mutex::new(None),
            manual_writers: Mutex::default(),
            inner: Arc::new(InMemoryThreadStore::default()),
            archived: Mutex::new(HashMap::new()),
            memory_modes: Mutex::new(HashMap::new()),
            checklists: Mutex::new(HashMap::new()),
            fork_boundary: OnceLock::new(),
        }
    }
}

impl MemoryThreadStore {
    pub(crate) fn bind_fork_boundary(&self, boundary: &Arc<crate::native_interception::Boundary>) {
        let _ = self.fork_boundary.set(Arc::downgrade(boundary));
    }

    async fn append_manual_committed(
        &self,
        params: AppendThreadItemsParams,
    ) -> ThreadStoreResult<()> {
        // Serialize the raw-event observation with the delegated append.
        // The native rollout filter removes PlanUpdate, but keeps turn boundaries.
        let mut checklists = self.checklists.lock().await;
        let id = params.thread_id;
        let last_plan =
            params
                .items
                .iter()
                .enumerate()
                .rev()
                .find_map(|(index, item)| match item {
                    RolloutItem::EventMsg(EventMsg::PlanUpdate(args)) => Some((index, args)),
                    _ => None,
                });
        let replacement = if let Some((index, args)) = last_plan {
            let history = self
                .inner
                .load_latest_model_context(LoadThreadHistoryParams {
                    thread_id: id,
                    include_archived: true,
                })
                .await?;
            let turn_id = history
                .items
                .iter()
                .chain(params.items[..index].iter())
                .rev()
                .find_map(|item| match item {
                    RolloutItem::EventMsg(EventMsg::TurnStarted(turn)) => {
                        Some(Some(turn.turn_id.clone()))
                    }
                    RolloutItem::EventMsg(EventMsg::TurnComplete(_) | EventMsg::TurnAborted(_)) => {
                        Some(None)
                    }
                    _ => None,
                })
                .flatten()
                .ok_or_else(|| ThreadStoreError::InvalidRequest {
                    message: "accepted checklist has no open native turn owner".to_owned(),
                })?;
            Some(ChecklistState {
                thread_id: id,
                turn_id,
                explanation: args.explanation.clone(),
                plan: args.plan.clone(),
            })
        } else {
            None
        };
        self.inner.append_items(params).await?;
        if let Some(replacement) = replacement {
            checklists.insert(id, replacement);
        }
        Ok(())
    }

    pub(crate) async fn manual_sampling_ready(
        &self,
        id: ThreadId,
        keys: &[crate::python_tools::PendingKey],
    ) -> anyhow::Result<bool> {
        let writers = self.manual_writers.lock().await;
        let Some(writer) = writers.get(&id) else {
            return Ok(false);
        };
        Ok(writer.capture.is_none()
            && writer.calls > 0
            && writer.calls == writer.sampled_calls
            && keys.iter().all(|key| {
                key.reply.thread == id.to_string()
                    && writer.turn.as_deref() == Some(key.turn.as_str())
            }))
    }

    pub(crate) async fn native_mcp_capture_ready(
        &self,
        id: ThreadId,
        captured: &codex_core::CapturedMcpApproval,
        retained_sample: Option<&str>,
    ) -> anyhow::Result<bool> {
        let writers = self.manual_writers.lock().await;
        let Some(writer) = writers.get(&id) else {
            return Ok(false);
        };
        Ok(self
            .native_mcp_capture(id, writer, &captured.checkpoint_data(), retained_sample)
            .await?
            .is_some())
    }

    pub(crate) async fn begin_native_mcp_capture(
        &self,
        id: ThreadId,
        claim: &codex_core::ClaimedMcpApproval,
        retained_sample: Option<&str>,
    ) -> anyhow::Result<bool> {
        let mut writers = self.manual_writers.lock().await;
        let Some(writer) = writers.get_mut(&id) else {
            return Ok(false);
        };
        if !claim.is_live() {
            return Ok(false);
        }
        let Some(capture) = self
            .native_mcp_capture(id, writer, &claim.checkpoint_data(), retained_sample)
            .await?
        else {
            return Ok(false);
        };
        if !claim.is_live() {
            return Ok(false);
        }
        writer.capture = Some(capture);
        Ok(true)
    }

    async fn native_mcp_capture(
        &self,
        id: ThreadId,
        writer: &ManualWriter,
        data: &codex_core::McpApprovalCheckpointData,
        retained_sample: Option<&str>,
    ) -> anyhow::Result<Option<ManualCapture>> {
        if writer.capture.is_some()
            || data.source_thread_id != id
            || writer.turn.as_deref() != Some(data.turn_id.as_str())
            || if retained_sample.is_some() {
                writer.calls != 0 || writer.sampled_calls != 0
            } else {
                writer.calls != 1 || writer.sampled_calls != 1
            }
        {
            return Ok(None);
        }
        self.inner.flush_thread(id).await?;
        let history = self
            .inner
            .load_latest_model_context(LoadThreadHistoryParams {
                thread_id: id,
                include_archived: true,
            })
            .await?;
        let matches = match retained_sample {
            Some(sample) => recovered_native_mcp_prefix_matches(&history.items, data, sample),
            None => native_mcp_prefix_matches(&history.items, data),
        };
        if !matches { return Ok(None); }
        Ok(Some(ManualCapture {
            turn: data.turn_id.clone(),
            pending: vec![SuspendedCall {
                turn: data.turn_id.clone(),
                call: data.call_id.clone(),
            }],
            prefix: history.items,
            sampled_calls: writer.sampled_calls,
            suffix: Vec::new(),
            shutdown: false,
        }))
    }

    pub(crate) async fn begin_manual_capture(
        &self,
        id: ThreadId,
        keys: Vec<crate::python_tools::PendingKey>,
        prefix: Vec<RolloutItem>,
    ) -> anyhow::Result<bool> {
        let mut writers = self.manual_writers.lock().await;
        let Some(writer) = writers.get_mut(&id) else {
            return Ok(false);
        };
        if writer.capture.is_some()
            || writer.calls == 0
            || writer.calls != writer.sampled_calls
            || keys.iter().any(|key| {
                key.reply.thread != id.to_string()
                    || writer.turn.as_deref() != Some(key.turn.as_str())
            })
        {
            return Ok(false);
        }
        self.inner.flush_thread(id).await?;
        let actual = self
            .inner
            .load_latest_model_context(LoadThreadHistoryParams {
                thread_id: id,
                include_archived: true,
            })
            .await?;
        if serde_json::to_value(&actual.items)? != serde_json::to_value(&prefix)? {
            return Ok(false);
        }
        let turn = writer.turn.clone().expect("keys matched the live turn");
        writer.capture = Some(ManualCapture {
            turn,
            pending: keys
                .into_iter()
                .map(|key| SuspendedCall {
                    turn: key.turn,
                    call: key.call,
                })
                .collect(),
            prefix,
            sampled_calls: writer.sampled_calls,
            suffix: Vec::new(),
            shutdown: false,
        });
        Ok(true)
    }

    pub(crate) async fn finish_manual_capture(
        &self,
        id: ThreadId,
        suspended: Option<&str>,
    ) -> ThreadStoreResult<bool> {
        let mut writers = self.manual_writers.lock().await;
        let writer = writers
            .get_mut(&id)
            .ok_or(ThreadStoreError::ThreadNotFound { thread_id: id })?;
        let capture = writer
            .capture
            .take()
            .ok_or_else(|| ThreadStoreError::InvalidRequest {
                message: "no portable manual capture".into(),
            })?;
        let mut preserve = suspended == Some(capture.turn.as_str());
        let mut excluded = HashSet::new();
        for key in &capture.pending {
            let shell = capture.prefix.iter().any(|row| matches!(row,
                RolloutItem::ResponseItem(item) if matches!(&item.item,
                    ResponseItem::ShellCall { provider_fields, .. }
                        if provider_fields.get("call_id").and_then(serde_json::Value::as_str) == Some(key.call.as_str()))));
            let patch = capture.prefix.iter().any(|row| {
                matches!(row,
                RolloutItem::ResponseItem(item) if matches!(&item.item,
                    ResponseItem::ApplyPatchCall { call_id, .. } if call_id == &key.call))
            });
            let mut in_turn = false;
            let mut sampled = None;
            let mut calls = 0usize;
            let mut matches = Vec::new();
            for (ordinal, row) in capture
                .prefix
                .iter()
                .chain(capture.suffix.iter().flatten())
                .enumerate()
            {
                match row {
                    RolloutItem::EventMsg(EventMsg::RawResponseCompleted(_)) if in_turn => {
                        sampled = sampled.map(|_| true);
                    }
                    RolloutItem::EventMsg(EventMsg::TurnStarted(start)) => {
                        in_turn = start.turn_id == capture.turn;
                        sampled = None;
                        calls = 0;
                    }
                    RolloutItem::EventMsg(EventMsg::TurnComplete(_) | EventMsg::TurnAborted(_)) => {
                        in_turn = false;
                        sampled = None;
                        calls = 0;
                    }
                    RolloutItem::ResponseItem(item) if in_turn => match &item.item {
                        ResponseItem::FunctionCall { call_id, .. } => {
                            calls += 1;
                            if call_id == &key.call {
                                if shell || patch {
                                    preserve = false;
                                }
                                sampled = Some(calls <= capture.sampled_calls);
                                if ordinal >= capture.prefix.len() {
                                    preserve = false;
                                }
                            }
                        }
                        ResponseItem::ApplyPatchCall { call_id, .. } => {
                            calls += 1;
                            if call_id == &key.call {
                                sampled = Some(calls <= capture.sampled_calls);
                                if !patch || ordinal >= capture.prefix.len() {
                                    preserve = false;
                                }
                            }
                        }
                        ResponseItem::ApplyPatchCallOutput { call_id, .. }
                            if call_id == &key.call && sampled == Some(true) =>
                        {
                            if !patch
                                || ordinal < capture.prefix.len()
                                || item.item.turn_id() != Some(key.turn.as_str())
                            {
                                preserve = false;
                            } else {
                                matches.push(ordinal - capture.prefix.len());
                            }
                        }
                        ResponseItem::ShellCall {
                            provider_fields, ..
                        } => {
                            calls += 1;
                            if provider_fields
                                .get("call_id")
                                .and_then(serde_json::Value::as_str)
                                == Some(key.call.as_str())
                            {
                                sampled = Some(calls <= capture.sampled_calls);
                                if !shell || ordinal >= capture.prefix.len() {
                                    preserve = false;
                                }
                            }
                        }
                        ResponseItem::ShellCallOutput { .. }
                            if crate::local_reconciliation::output_identity(&item.item)
                                .is_some_and(|(call, _)| call == key.call)
                                && sampled == Some(true) =>
                        {
                            if !shell
                                || ordinal < capture.prefix.len()
                                || item.item.turn_id() != Some(key.turn.as_str())
                            {
                                preserve = false;
                            } else {
                                matches.push(ordinal - capture.prefix.len());
                            }
                        }
                        ResponseItem::CustomToolCall { call_id, .. } => {
                            calls += 1;
                            if call_id == &key.call {
                                preserve = false;
                            }
                        }
                        ResponseItem::FunctionCallOutput {
                            call_id: Some(call_id),
                            name,
                            namespace,
                            internal_chat_message_metadata_passthrough: metadata,
                            ..
                        } if call_id == &key.call && sampled == Some(true) => {
                            if shell || patch || ordinal < capture.prefix.len() {
                                preserve = false;
                            } else {
                                matches.push(ordinal - capture.prefix.len());
                                if name.is_some()
                                    || namespace.is_some()
                                    || metadata.as_ref().and_then(|meta| meta.turn_id.as_deref())
                                        != Some(key.turn.as_str())
                                {
                                    preserve = false;
                                }
                            }
                        }
                        _ => {}
                    },
                    _ => {}
                }
            }
            if matches.len() > 1 {
                preserve = false;
            }
            excluded.extend(matches);
        }
        let mut ordinal = 0usize;
        let mut append_error = None;
        for batch in capture.suffix {
            let items = batch
                .into_iter()
                .filter_map(|row| {
                    let keep = !preserve || !excluded.contains(&ordinal);
                    ordinal += 1;
                    keep.then_some(row)
                })
                .collect();
            if let Err(error) = self
                .append_manual_committed(AppendThreadItemsParams {
                    thread_id: id,
                    items,
                })
                .await
            {
                append_error = Some(error);
                break;
            }
        }
        // Core's own writer release is deferred for this transaction only.
        // Finish/close it even if the buffered append failed.
        if capture.shutdown || suspended.is_some() {
            let flushed = self.inner.flush_thread(id).await;
            let closed = self.inner.shutdown_thread(id).await;
            writers.remove(&id);
            if let Some(error) = append_error {
                return Err(error);
            }
            flushed?;
            closed?;
        } else if let Some(error) = append_error {
            return Err(error);
        }
        Ok(preserve)
    }

    fn numeric_fork_source(&self, thread_id: ThreadId, history: &mut Vec<RolloutItem>) -> bool {
        if !self
            .fork_boundary
            .get()
            .and_then(Weak::upgrade)
            .is_some_and(|boundary| boundary.take_numeric_fork_source(thread_id))
        {
            return false;
        }
        // A real replacement checkpoint is a model-history base, irrespective
        // of its producer or window-number schema. It is NOT an original user
        // turn; Core counts the genuine fork boundaries in its tail.
        // Supported application compaction refuses rollback-after-compaction
        // histories. If an imported/native history has one, let Core replay
        // it all; do not guess which older checkpoint survived a rollback.
        let mut checkpoint = None;
        for (index, item) in history.iter().enumerate().rev() {
            match item {
                RolloutItem::EventMsg(EventMsg::ThreadRolledBack(_)) => return false,
                RolloutItem::Compacted(compacted) => {
                    if compacted.replacement_history.is_some() {
                        checkpoint = Some(index);
                    }
                    break;
                }
                _ => {}
            }
        }
        let Some(checkpoint) = checkpoint else {
            return false;
        };
        // Preserve canonical source SessionMeta for Core's capability-root
        // selection. The copied numeric fork suffix alone is scoped, never
        // the underlying stored history, checkpoint, or a complete audit read.
        let meta = history[..checkpoint]
            .iter()
            .find_map(|item| matches!(item, RolloutItem::SessionMeta(_)).then(|| item.clone()));
        let mut tail = history.split_off(checkpoint);
        if let Some(meta) = meta {
            tail.insert(0, meta);
        }
        *history = tail;
        true
    }
    pub async fn memory_mode(&self, id: ThreadId) -> Option<ThreadMemoryMode> {
        self.memory_modes.lock().await.get(&id).copied()
    }

    pub async fn checklist(&self, id: ThreadId) -> ThreadStoreResult<Option<ChecklistState>> {
        let checklists = self.checklists.lock().await;
        // Missing native storage is an error, distinct from no accepted update.
        self.inner
            .read_thread(ReadThreadParams {
                thread_id: id,
                include_archived: true,
                include_history: false,
            })
            .await?;
        Ok(checklists.get(&id).cloned())
    }

    pub async fn restore_checklist(&self, checklist: ChecklistState) {
        self.checklists
            .lock()
            .await
            .insert(checklist.thread_id, checklist);
    }
}

impl ThreadStore for MemoryThreadStore {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn create_thread(&self, params: CreateThreadParams) -> ThreadStoreFuture<'_, ()> {
        Box::pin(async move {
            let id = params.thread_id;
            let memory_mode = params.metadata.memory_mode;
            let mut memory_modes = self.memory_modes.lock().await;
            let now = SystemTime::now().into();
            let patch = ThreadMetadataPatch {
                created_at: Some(now),
                updated_at: Some(now),
                advance_recency_at: Some(now),
                model_provider: Some(params.metadata.model_provider.clone()),
                cwd: params.metadata.cwd.clone(),
                ..Default::default()
            };
            self.inner.create_thread(params).await?;
            self.inner
                .update_thread_metadata(UpdateThreadMetadataParams {
                    thread_id: id,
                    include_archived: true,
                    patch,
                })
                .await?;
            memory_modes.insert(id, memory_mode);
            self.manual_writers
                .lock()
                .await
                .insert(id, ManualWriter::default());
            Ok(())
        })
    }

    fn resume_thread(
        &self,
        params: ResumeThreadParams,
    ) -> ThreadStoreFuture<'_, Arc<Vec<RolloutItem>>> {
        Box::pin(async move {
            let id = params.thread_id;
            let mut writers = self.manual_writers.lock().await;
            if writers
                .get(&id)
                .is_some_and(|writer| writer.capture.is_some())
            {
                return Err(ThreadStoreError::InvalidRequest {
                    message: "cannot resume a suspending manual writer".into(),
                });
            }
            let history = self.inner.resume_thread(params).await?;
            // Imported/cold history never produces a live sampling receipt.
            writers.entry(id).or_default();
            Ok(history)
        })
    }

    fn append_items(&self, params: AppendThreadItemsParams) -> ThreadStoreFuture<'_, ()> {
        Box::pin(async move {
            #[cfg(test)]
            {
                let hold = self.completion_hold.lock().unwrap().clone();
                if let Some(hold) = hold
                    && hold.parent == params.thread_id
                    && params.items.iter().any(|item| matches!(item,
                        RolloutItem::EventMsg(EventMsg::ItemStarted(event))
                        if matches!(&event.item, codex_protocol::items::TurnItem::SubAgentActivity(item)
                            if item.kind == codex_protocol::protocol::SubAgentActivityKind::Completed)))
                {
                    hold.entered.add_permits(1);
                    hold.release.acquire().await.unwrap().forget();
                }
            }
            let mut writers = self.manual_writers.lock().await;
            let writer =
                writers
                    .get_mut(&params.thread_id)
                    .ok_or(ThreadStoreError::ThreadNotFound {
                        thread_id: params.thread_id,
                    })?;
            if let Some(capture) = &mut writer.capture {
                capture.suffix.push(params.items);
                return Ok(());
            }
            for item in &params.items {
                match item {
                    RolloutItem::EventMsg(EventMsg::TurnStarted(start)) => {
                        writer.turn = Some(start.turn_id.clone());
                        writer.calls = 0;
                        writer.sampled_calls = 0;
                    }
                    RolloutItem::ResponseItem(item)
                        if writer.turn.is_some()
                            && matches!(
                                &item.item,
                                ResponseItem::FunctionCall { .. }
                                    | ResponseItem::CustomToolCall { .. }
                                    | ResponseItem::ShellCall { .. }
                                    | ResponseItem::ApplyPatchCall { .. }
                            ) =>
                    {
                        writer.calls += 1;
                    }
                    RolloutItem::EventMsg(EventMsg::RawResponseCompleted(_)) => {
                        writer.sampled_calls = writer.calls;
                    }
                    RolloutItem::EventMsg(EventMsg::TurnComplete(_) | EventMsg::TurnAborted(_)) => {
                        writer.turn = None;
                        writer.calls = 0;
                        writer.sampled_calls = 0;
                    }
                    _ => {}
                }
            }
            self.append_manual_committed(params).await
        })
    }

    fn persist_thread(&self, id: ThreadId, context: PersistContext) -> ThreadStoreFuture<'_, ()> {
        self.inner.persist_thread(id, context)
    }

    fn flush_thread(&self, id: ThreadId) -> ThreadStoreFuture<'_, ()> {
        #[cfg(test)]
        {
            return Box::pin(async move {
                let completing = at_turn_completion_flush();
                if completing
                    && let Some(probe) = self.flush_traces.lock().unwrap().clone()
                    && let Some(trace) = codex_otel::current_span_w3c_trace_context()
                {
                    probe.lock().unwrap().push((id, trace));
                }
                let completion = if completing {
                    let mut next = self.completion_flush_hold.lock().unwrap();
                    if next.as_ref().is_some_and(|hold| hold.parent == id) {
                        next.take()
                    } else {
                        None
                    }
                } else {
                    None
                };
                let hold = completion.or_else(|| {
                    let mut next = self.next_flush_hold.lock().unwrap();
                    if next.as_ref().is_some_and(|hold| hold.parent == id) {
                        next.take()
                    } else {
                        None
                    }
                });
                if let Some(hold) = hold {
                    hold.entered.add_permits(1);
                    hold.release.acquire().await.unwrap().forget();
                }
                self.inner.flush_thread(id).await
            });
        }
        #[cfg(not(test))]
        self.inner.flush_thread(id)
    }

    fn shutdown_thread(&self, id: ThreadId) -> ThreadStoreFuture<'_, ()> {
        Box::pin(async move {
            let mut writers = self.manual_writers.lock().await;
            if let Some(capture) = writers
                .get_mut(&id)
                .and_then(|writer| writer.capture.as_mut())
            {
                capture.shutdown = true;
                return Ok(());
            }
            self.inner.shutdown_thread(id).await?;
            writers.remove(&id);
            Ok(())
        })
    }

    fn discard_thread(&self, id: ThreadId) -> ThreadStoreFuture<'_, ()> {
        // Discard releases the writer; the in-memory store retains durable data.
        Box::pin(async move {
            let mut writers = self.manual_writers.lock().await;
            if let Some(capture) = writers
                .get_mut(&id)
                .and_then(|writer| writer.capture.as_mut())
            {
                capture.shutdown = true;
                return Ok(());
            }
            self.inner.discard_thread(id).await?;
            writers.remove(&id);
            Ok(())
        })
    }

    fn load_history(
        &self,
        params: LoadThreadHistoryParams,
    ) -> ThreadStoreFuture<'_, StoredThreadHistory> {
        Box::pin(async move {
            let context = self.inner.load_latest_model_context(params).await?;
            Ok(StoredThreadHistory {
                revision: context.revision,
                thread_id: context.thread_id,
                items: context.items,
            })
        })
    }

    fn read_original_history(
        &self,
        params: LoadThreadHistoryParams,
        reader: Box<dyn codex_thread_store::OriginalHistoryReader>,
    ) -> ThreadStoreFuture<'_, codex_thread_store::OriginalHistorySnapshot> {
        self.inner.read_original_history(params, reader)
    }

    fn load_latest_model_context(
        &self,
        params: LoadThreadHistoryParams,
    ) -> ThreadStoreFuture<'_, StoredModelContext> {
        Box::pin(async move {
            let mut context = self.inner.load_latest_model_context(params).await?;
            if self.numeric_fork_source(context.thread_id, &mut context.items) {
                context.revision = None;
            }
            Ok(context)
        })
    }

    fn prepare_fork(&self, params: PrepareForkParams) -> ThreadStoreFuture<'_, PreparedFork> {
        Box::pin(async move {
            let mut history = self
                .load_history(LoadThreadHistoryParams {
                    thread_id: params.thread_id,
                    include_archived: true,
                })
                .await?
                .items;
            let end = fork_end(&history, &params.boundary)?;
            history.truncate(end);
            Ok(PreparedFork::new(
                params.thread_id,
                None,
                Arc::new(history),
                (),
            ))
        })
    }

    fn read_thread(&self, mut params: ReadThreadParams) -> ThreadStoreFuture<'_, StoredThread> {
        Box::pin(async move {
            let include_history = params.include_history;
            params.include_history = false;
            let history_params = LoadThreadHistoryParams {
                thread_id: params.thread_id,
                include_archived: params.include_archived,
            };
            let mut thread = self.inner.read_thread(params).await?;
            thread.archived_at = self
                .archived
                .lock()
                .await
                .get(&thread.thread_id)
                .copied()
                .map(Into::into);
            if thread.archived_at.is_some() && !history_params.include_archived {
                return Err(ThreadStoreError::ThreadNotFound {
                    thread_id: thread.thread_id,
                });
            }
            if include_history {
                let mut history = self.load_history(history_params).await?;
                if self.numeric_fork_source(history.thread_id, &mut history.items) {
                    history.revision = None;
                }
                thread.history = Some(history);
            }
            Ok(thread)
        })
    }

    fn read_thread_by_rollout_path(
        &self,
        _params: ReadThreadByRolloutPathParams,
    ) -> ThreadStoreFuture<'_, StoredThread> {
        Box::pin(async {
            Err(ThreadStoreError::Unsupported {
                operation: "read_thread_by_rollout_path",
            })
        })
    }

    fn list_threads(&self, params: ListThreadsParams) -> ThreadStoreFuture<'_, ThreadPage> {
        Box::pin(async move {
            let include_archived = params.archived;
            let mut page = self.inner.list_threads(params).await?;
            let archived = self.archived.lock().await;
            for thread in &mut page.items {
                thread.archived_at = archived.get(&thread.thread_id).copied().map(Into::into);
            }
            page.items
                .retain(|thread| thread.archived_at.is_some() == include_archived);
            Ok(page)
        })
    }

    fn update_thread_metadata(
        &self,
        params: UpdateThreadMetadataParams,
    ) -> ThreadStoreFuture<'_, Option<StoredThread>> {
        Box::pin(async move {
            let id = params.thread_id;
            let mode = params.patch.memory_mode;
            let mut memory_modes = self.memory_modes.lock().await;
            let result = self.inner.update_thread_metadata(params).await?;
            if let Some(mode) = mode {
                memory_modes.insert(id, mode);
            }
            Ok(result)
        })
    }

    fn archive_thread(&self, params: ArchiveThreadParams) -> ThreadStoreFuture<'_, ()> {
        Box::pin(async move {
            self.inner
                .read_thread(ReadThreadParams {
                    thread_id: params.thread_id,
                    include_archived: true,
                    include_history: false,
                })
                .await?;
            self.archived
                .lock()
                .await
                .insert(params.thread_id, SystemTime::now());
            Ok(())
        })
    }

    fn unarchive_thread(&self, params: ArchiveThreadParams) -> ThreadStoreFuture<'_, StoredThread> {
        Box::pin(async move {
            self.archived.lock().await.remove(&params.thread_id);
            self.inner.unarchive_thread(params).await
        })
    }

    fn delete_thread(&self, params: DeleteThreadParams) -> ThreadStoreFuture<'_, ()> {
        Box::pin(async move {
            let id = params.thread_id;
            let mut memory_modes = self.memory_modes.lock().await;
            let mut checklists = self.checklists.lock().await;
            self.inner.delete_thread(params).await?;
            self.archived.lock().await.remove(&id);
            memory_modes.remove(&id);
            checklists.remove(&id);
            Ok(())
        })
    }
}

// Core's "turn" span exports as session_task.turn. Its completion flush runs
// after session_task.run returns and before publishing the terminal.
// Ignore startup and in-sample flushes in the after-last-sample test barrier.
#[cfg(test)]
fn at_turn_completion_flush() -> bool {
    use tracing_subscriber::registry::LookupSpan;
    tracing::Span::current()
        .with_subscriber(|(id, dispatch)| {
            let Some(registry) = dispatch.downcast_ref::<tracing_subscriber::Registry>() else {
                return false;
            };
            let Some(span) = registry.span(id) else {
                return false;
            };
            for span in span.scope() {
                match span.metadata().name() {
                    "session_task.run" => return false,
                    "turn" => return true,
                    _ => {}
                }
            }
            false
        })
        .unwrap_or(false)
}

#[cfg(test)]
pub(crate) struct CompletionHold {
    pub parent: ThreadId,
    pub entered: tokio::sync::Semaphore,
    pub release: tokio::sync::Semaphore,
}

fn fork_end(history: &[RolloutItem], boundary: &ForkBoundary) -> Result<usize, ThreadStoreError> {
    let turn_id = match boundary {
        ForkBoundary::Latest => return Ok(history.len()),
        ForkBoundary::BeforeTurn(id) | ForkBoundary::ThroughTurn(id) => id,
    };
    let start = match history.first() {
        Some(RolloutItem::SessionMeta(header)) => {
            header.meta.subagent_history_start_ordinal.unwrap_or(0)
        }
        _ => 0,
    };
    let mut builder = ThreadHistoryBuilder::new();
    let mut position: Option<(usize, Option<usize>)> = None;
    for (index, item) in history
        .iter()
        .enumerate()
        .filter(|(index, _)| *index as u64 >= start)
    {
        let changes = builder.handle_rollout_item_with_changes(item);
        if changes.removed_turn_ids.contains(turn_id) {
            position = None;
        }
        let projected = project_rollout_line(&RolloutLine {
            timestamp: String::new(),
            ordinal: Some(index as u64),
            item: item.clone(),
        });
        for turn in projected.changed_turns {
            if turn.turn_id != *turn_id {
                continue;
            }
            let (_, end) = position.get_or_insert((index, None));
            // Match the native materializer: preserve the first start and terminal
            // boundaries instead of extending a finished turn with later snapshots.
            if end.is_none() && turn.status != TurnStatus::InProgress {
                *end = Some(index + 1);
            }
        }
    }
    let result = match (boundary, position) {
        (ForkBoundary::BeforeTurn(_), Some((start, end))) if end != Some(start + 1) => Some(start),
        (ForkBoundary::ThroughTurn(_), Some((_, end))) => end,
        _ => None,
    };
    result.ok_or_else(|| ThreadStoreError::InvalidRequest {
        message: "fork boundary must identify a visible turn with a persisted start or completion"
            .to_string(),
    })
}

#[derive(Clone, Copy)]
pub struct SpawnEdge {
    pub parent: ThreadId,
    pub status: ThreadSpawnEdgeStatus,
    pub closed_at: Option<i64>,
}

#[derive(Clone, serde::Serialize)]
pub struct GraphEvent {
    pub kind: &'static str,
    pub subagent_id: ThreadId,
    pub parent_agent_id: ThreadId,
    pub status: &'static str,
    pub closed_at: Option<i64>,
}

impl GraphEvent {
    fn new(kind: &'static str, child: ThreadId, edge: SpawnEdge) -> Self {
        Self {
            kind,
            subagent_id: child,
            parent_agent_id: edge.parent,
            status: if edge.status == ThreadSpawnEdgeStatus::Closed {
                "closed"
            } else {
                "active"
            },
            closed_at: edge.closed_at,
        }
    }
}

#[derive(Default)]
struct GraphState {
    edges: HashMap<ThreadId, GraphEntry>,
    subscribers: Vec<(ThreadId, mpsc::UnboundedSender<GraphEvent>)>,
}

#[derive(Clone, Copy)]
struct GraphEntry {
    edge: SpawnEdge,
    // Admission commits a readable native record before the thread is ready.
    // Core's upsert or cancelled-spawn cleanup publishes the first transition.
    published: bool,
}

#[derive(Default)]
pub struct MemoryAgentGraph {
    state: Mutex<GraphState>,
    local: Option<LocalAgentGraphStore>,
}

impl MemoryAgentGraph {
    pub fn local(state_db: Arc<codex_state::StateRuntime>) -> Self {
        Self {
            state: Mutex::new(GraphState::default()),
            local: Some(LocalAgentGraphStore::new(state_db)),
        }
    }

    pub(crate) async fn admit(
        &self,
        parent: ThreadId,
        child: ThreadId,
    ) -> AgentGraphStoreResult<()> {
        let mut state = self.state.lock().await;
        if let Some(local) = &self.local {
            local
                .upsert_thread_spawn_edge(parent, child, ThreadSpawnEdgeStatus::Open)
                .await?;
            state.edges.entry(child).or_insert(GraphEntry {
                edge: SpawnEdge {
                    parent,
                    status: ThreadSpawnEdgeStatus::Open,
                    closed_at: None,
                },
                published: false,
            });
        } else {
            return Err(codex_agent_graph_store::AgentGraphStoreError::Internal {
                message: "local child admission requires a durable graph".into(),
            });
        }
        // Core's later upsert publishes the live event once it has finished
        // constructing the thread. Admission only owns durable records.
        Ok(())
    }

    /// Load persisted topology while holding the same lock used for subscription
    /// snapshots and writes. The pinned store exposes status but no close time.
    pub async fn hydrate(&self, root: ThreadId) -> AgentGraphStoreResult<()> {
        let Some(local) = &self.local else {
            return Ok(());
        };
        let mut state = self.state.lock().await;
        let mut queue = std::collections::VecDeque::from([root]);
        let mut visited = HashSet::from([root]);
        // Stage the complete read before changing the cache. A failed read must
        // not publish a partial tree or delete the last known good snapshot.
        let mut loaded = HashMap::new();
        while let Some(parent) = queue.pop_front() {
            for status in [ThreadSpawnEdgeStatus::Open, ThreadSpawnEdgeStatus::Closed] {
                for child in local
                    .list_thread_spawn_children(parent, Some(status))
                    .await?
                {
                    if visited.insert(child) {
                        let closed_at = state
                            .edges
                            .get(&child)
                            .filter(|entry| {
                                entry.edge.parent == parent && entry.edge.status == status
                            })
                            .and_then(|entry| entry.edge.closed_at);
                        loaded.insert(
                            child,
                            GraphEntry {
                                edge: SpawnEdge {
                                    parent,
                                    status,
                                    closed_at,
                                },
                                published: true,
                            },
                        );
                        queue.push_back(child);
                    }
                }
            }
        }
        for child in descendants(&state.edges, root) {
            state.edges.remove(&child);
        }
        state.edges.extend(loaded);
        Ok(())
    }

    pub async fn edge(&self, child: ThreadId) -> Option<SpawnEdge> {
        self.state
            .lock()
            .await
            .edges
            .get(&child)
            .map(|entry| entry.edge)
    }

    pub async fn restore_edge(&self, child: ThreadId, edge: SpawnEdge) {
        // Import preserves unknown historical close times and emits no transitions.
        self.state.lock().await.edges.insert(
            child,
            GraphEntry {
                edge,
                published: true,
            },
        );
    }

    pub(crate) async fn remove_checkpoint_edges(&self, imported: &[ThreadId]) {
        let mut state = self.state.lock().await;
        for id in imported {
            state.edges.remove(id);
        }
    }

    pub(crate) async fn retire_closed_root_subscriptions(&self, root: ThreadId) {
        self.state
            .lock()
            .await
            .subscribers
            .retain(|(owner, sender)| *owner != root || !sender.is_closed());
    }

    pub async fn subscribe(&self, root: ThreadId) -> mpsc::UnboundedReceiver<GraphEvent> {
        let (sender, receiver) = mpsc::unbounded_channel();
        let mut state = self.state.lock().await;
        for child in descendants(&state.edges, root) {
            let entry = state.edges[&child];
            if entry.published {
                let _ = sender.send(GraphEvent::new("snapshot", child, entry.edge));
            }
        }
        // Snapshot and subscription share the mutation lock, so neither gaps nor duplicates occur.
        state.subscribers.push((root, sender));
        receiver
    }

    async fn update(
        &self,
        parent: Option<ThreadId>,
        child: ThreadId,
        status: ThreadSpawnEdgeStatus,
    ) -> AgentGraphStoreResult<()> {
        let mut state = self.state.lock().await;
        let previous = state.edges.get(&child).copied();
        if let Some(local) = &self.local {
            match parent {
                Some(parent) => {
                    local
                        .upsert_thread_spawn_edge(parent, child, status)
                        .await?
                }
                None => local.set_thread_spawn_edge_status(child, status).await?,
            }
        }
        let Some(parent) = parent.or(previous.map(|entry| entry.edge.parent)) else {
            return Ok(());
        };
        let changed = previous.is_none_or(|entry| !entry.published || entry.edge.status != status);
        let edge = SpawnEdge {
            parent,
            status,
            closed_at: if !changed {
                previous.and_then(|entry| entry.edge.closed_at)
            } else if status == ThreadSpawnEdgeStatus::Closed {
                Some(
                    SystemTime::now()
                        .duration_since(SystemTime::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs() as i64,
                )
            } else {
                None
            },
        };
        state.edges.insert(
            child,
            GraphEntry {
                edge,
                published: true,
            },
        );
        if !changed {
            return Ok(());
        }
        let kind = if previous.is_none()
            || (status == ThreadSpawnEdgeStatus::Open
                && previous.is_some_and(|entry| !entry.published))
        {
            "created"
        } else if status == ThreadSpawnEdgeStatus::Closed {
            "closed"
        } else {
            "active"
        };
        let event = GraphEvent::new(kind, child, edge);
        let GraphState { edges, subscribers } = &mut *state;
        subscribers.retain(|(root, sender)| {
            !sender.is_closed()
                && (!is_descendant(edges, *root, child) || sender.send(event.clone()).is_ok())
        });
        Ok(())
    }
}

fn is_descendant(edges: &HashMap<ThreadId, GraphEntry>, root: ThreadId, child: ThreadId) -> bool {
    let mut id = child;
    let mut visited = HashSet::new();
    while visited.insert(id) {
        let Some(entry) = edges.get(&id) else {
            return false;
        };
        if entry.edge.parent == root {
            return child != root;
        }
        id = entry.edge.parent;
    }
    false
}

fn children(
    edges: &HashMap<ThreadId, GraphEntry>,
    parent: ThreadId,
    status: Option<ThreadSpawnEdgeStatus>,
) -> Vec<ThreadId> {
    let mut children: Vec<_> = edges
        .iter()
        .filter_map(|(child, entry)| {
            (entry.edge.parent == parent && status.is_none_or(|status| status == entry.edge.status))
                .then_some(*child)
        })
        .collect();
    children.sort_by_key(ToString::to_string);
    children
}

fn descendants(edges: &HashMap<ThreadId, GraphEntry>, root: ThreadId) -> Vec<ThreadId> {
    let mut visited = HashSet::from([root]);
    let mut layer = vec![root];
    let mut descendants = Vec::new();
    while !layer.is_empty() {
        let mut next: Vec<_> = layer
            .into_iter()
            .flat_map(|parent| children(edges, parent, None))
            .filter(|child| visited.insert(*child))
            .collect();
        next.sort_by_key(ToString::to_string);
        descendants.extend(&next);
        layer = next;
    }
    descendants
}

impl AgentGraphStore for MemoryAgentGraph {
    fn upsert_thread_spawn_edge(
        &self,
        parent: ThreadId,
        child: ThreadId,
        status: ThreadSpawnEdgeStatus,
    ) -> AgentGraphStoreFuture<'_, ()> {
        Box::pin(self.update(Some(parent), child, status))
    }

    fn set_thread_spawn_edge_status(
        &self,
        child: ThreadId,
        status: ThreadSpawnEdgeStatus,
    ) -> AgentGraphStoreFuture<'_, ()> {
        Box::pin(self.update(None, child, status))
    }

    fn list_thread_spawn_children(
        &self,
        parent: ThreadId,
        status: Option<ThreadSpawnEdgeStatus>,
    ) -> AgentGraphStoreFuture<'_, Vec<ThreadId>> {
        Box::pin(async move {
            let state = self.state.lock().await;
            if let Some(local) = &self.local {
                local.list_thread_spawn_children(parent, status).await
            } else {
                Ok(children(&state.edges, parent, status))
            }
        })
    }

    fn list_thread_spawn_descendants(
        &self,
        root: ThreadId,
        status: Option<ThreadSpawnEdgeStatus>,
    ) -> AgentGraphStoreFuture<'_, Vec<ThreadId>> {
        Box::pin(async move {
            let state = self.state.lock().await;
            if let Some(local) = &self.local {
                return local.list_thread_spawn_descendants(root, status).await;
            }
            Ok(descendants(&state.edges, root)
                .into_iter()
                .filter(|id| status.is_none_or(|status| state.edges[id].edge.status == status))
                .collect())
        })
    }
}

#[cfg(test)]
mod graph_tests {
    use super::*;

    #[tokio::test]
    async fn transitions_remain_ordered_when_consumers_lag() {
        let graph = MemoryAgentGraph::default();
        let root = ThreadId::new();
        let child = ThreadId::new();
        let mut events = graph.subscribe(root).await;
        let mut unrelated = graph.subscribe(ThreadId::new()).await;
        graph
            .upsert_thread_spawn_edge(root, child, ThreadSpawnEdgeStatus::Open)
            .await
            .unwrap();
        let before = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        // Exceed a typical broadcast capacity before draining any events.
        for _ in 0..300 {
            graph
                .set_thread_spawn_edge_status(child, ThreadSpawnEdgeStatus::Closed)
                .await
                .unwrap();
            graph
                .set_thread_spawn_edge_status(child, ThreadSpawnEdgeStatus::Closed)
                .await
                .unwrap();
            graph
                .upsert_thread_spawn_edge(root, child, ThreadSpawnEdgeStatus::Open)
                .await
                .unwrap();
        }
        let after = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let created = events.try_recv().unwrap();
        assert_eq!(
            (created.kind, created.subagent_id, created.parent_agent_id),
            ("created", child, root)
        );
        assert!(created.closed_at.is_none());
        for _ in 0..300 {
            let closed = events.try_recv().unwrap();
            assert_eq!((closed.kind, closed.status), ("closed", "closed"));
            assert!((before..=after).contains(&closed.closed_at.unwrap()));
            let reopened = events.try_recv().unwrap();
            assert_eq!((reopened.kind, reopened.status), ("active", "active"));
            assert!(reopened.closed_at.is_none());
        }
        assert!(events.try_recv().is_err());
        assert!(unrelated.try_recv().is_err());
        assert!(graph.edge(child).await.unwrap().closed_at.is_none());
    }

    #[tokio::test]
    async fn restore_preserves_close_times_and_seeds_the_whole_subtree() {
        let graph = MemoryAgentGraph::default();
        let root = ThreadId::new();
        let child = ThreadId::new();
        let grandchild = ThreadId::new();
        let mut existing = graph.subscribe(root).await;
        graph
            .restore_edge(
                child,
                SpawnEdge {
                    parent: root,
                    status: ThreadSpawnEdgeStatus::Closed,
                    closed_at: Some(123),
                },
            )
            .await;
        graph
            .restore_edge(
                grandchild,
                SpawnEdge {
                    parent: child,
                    status: ThreadSpawnEdgeStatus::Closed,
                    closed_at: None,
                },
            )
            .await;
        assert!(existing.try_recv().is_err());
        let mut snapshots = graph.subscribe(root).await;
        let parent = snapshots.try_recv().unwrap();
        let nested = snapshots.try_recv().unwrap();
        assert_eq!(
            (parent.kind, parent.subagent_id, parent.closed_at),
            ("snapshot", child, Some(123))
        );
        assert_eq!(
            (
                nested.kind,
                nested.subagent_id,
                nested.parent_agent_id,
                nested.closed_at
            ),
            ("snapshot", grandchild, child, None)
        );
        graph
            .set_thread_spawn_edge_status(child, ThreadSpawnEdgeStatus::Closed)
            .await
            .unwrap();
        assert!(snapshots.try_recv().is_err());
        assert_eq!(graph.edge(child).await.unwrap().closed_at, Some(123));
        graph
            .set_thread_spawn_edge_status(grandchild, ThreadSpawnEdgeStatus::Open)
            .await
            .unwrap();
        assert_eq!(snapshots.try_recv().unwrap().kind, "active");
        assert_eq!(
            graph
                .list_thread_spawn_descendants(root, Some(ThreadSpawnEdgeStatus::Open))
                .await
                .unwrap(),
            vec![grandchild]
        );
    }
}

#[cfg(test)]
mod close_report_tests {
    use super::*;
    use crate::local_storage_tests::{Provider, options, specs};
    use serde_json::json;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn native_local_close_report_incomplete_engine_retains_slots_until_retry() {
        let provider = Provider::start().await;
        let work = tempfile::tempdir().unwrap();
        let engine = crate::create_engine(
            provider.config().to_string(),
            json!({"codex_home":work.path(),"cwd":work.path()}).to_string(),
            None,
            None,
        )
        .await
        .unwrap();
        let native = engine
            .start_replaceable_thread(options(None), specs())
            .await
            .unwrap();
        let owned = engine.current().unwrap();
        let store = owned
            .store
            .as_any()
            .downcast_ref::<MemoryThreadStore>()
            .unwrap();
        // Core's joined shutdown calls shutdown_thread, which must take this
        // existing writer lock. A flush hook would not hold that shutdown path.
        let writers = store.manual_writers.lock().await;
        let failure = engine._close_report().await.unwrap_err();
        assert!(failure.reason.contains("shutdown incomplete"));
        assert!(engine.inner.lock().unwrap().live.is_some());
        assert!(native.live().unwrap().is_some());
        assert!(
            !native
                .inner
                .lock()
                .unwrap()
                .interception_reader
                .is_cancelled()
        );
        drop(writers);
        assert!(engine._close_report().await.unwrap().is_none());
        assert!(engine.inner.lock().unwrap().live.is_none());
        assert!(native.live().unwrap().is_none());
        assert!(
            native
                .inner
                .lock()
                .unwrap()
                .interception_reader
                .is_cancelled()
        );
        drop(owned);
    }
}

#[cfg(test)]
mod private_graph_retirement_tests {
    use super::*;

    #[tokio::test]
    async fn private_retirement_removes_only_closed_matching_subscriptions() {
        let graph = MemoryAgentGraph::default();
        let root = ThreadId::new();
        let other = ThreadId::new();
        let mut closed = graph.subscribe(root).await;
        let live = graph.subscribe(root).await;
        let mut unrelated = graph.subscribe(other).await;
        closed.close();
        unrelated.close();
        graph.retire_closed_root_subscriptions(root).await;
        let state = graph.state.lock().await;
        assert_eq!(state.subscribers.len(), 2);
        assert!(
            state
                .subscribers
                .iter()
                .any(|(id, sender)| *id == root && !sender.is_closed())
        );
        assert!(
            state
                .subscribers
                .iter()
                .any(|(id, sender)| *id == other && sender.is_closed())
        );
        drop(live);
    }

    #[tokio::test]
    async fn private_retirement_bounds_repeated_text_only_subscriptions() {
        let graph = MemoryAgentGraph::default();
        let unrelated = ThreadId::new();
        let _live = graph.subscribe(unrelated).await;
        for _ in 0..64 {
            let root = ThreadId::new();
            let mut receiver = graph.subscribe(root).await;
            receiver.close();
            graph.retire_closed_root_subscriptions(root).await;
            let state = graph.state.lock().await;
            assert_eq!(state.subscribers.len(), 1);
            assert_eq!(state.subscribers[0].0, unrelated);
            assert!(state.edges.is_empty());
        }
    }
}
