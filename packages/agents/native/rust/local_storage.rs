//! Durable local writer adapter for root JavaScript-managed tools.
//!
//! Native LocalThreadStore owns paths, recorder lifetime and OS writer exclusion.
//! This adapter orders acknowledged SDK receipts before Core's ordered drain.
use crate::local_reconciliation::{self, Receipt};
use crate::storage::{ChecklistState, MemoryAgentGraph, SpawnEdge};
use codex_agent_graph_store::{AgentGraphStore, ThreadSpawnEdgeStatus};
use codex_history::{ResponseItemEnvelope, RolloutItem};
use codex_protocol::{
    ThreadId,
    models::ResponseItem,
    protocol::{EventMsg, ThreadHistoryMode},
};
use codex_thread_store::*;
use std::collections::{HashMap, HashSet};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex;

pub(crate) struct LocalReceiptStore(pub Arc<LocalChecklistStore>);

pub struct LocalChecklistStore {
    inner: LocalThreadStore,
    checklist_directory: PathBuf,
    graph: Arc<MemoryAgentGraph>,
    state: Arc<codex_state::StateRuntime>,
    writers: Mutex<HashMap<ThreadId, Writer>>,
    // Stop new acquisitions before database draining; this is not close completion.
    admissions_closed: std::sync::atomic::AtomicBool,
    resume_admissions: std::sync::Mutex<ResumeAdmissions>,
    #[cfg(test)]
    startup_close_probe: std::sync::Mutex<Option<Arc<StartupCloseProbe>>>,
    #[cfg(test)]
    pub(crate) fail_receipt_flush: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    checklist_read_hook: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>>,
    #[cfg(test)]
    checklist_read_complete: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    #[cfg(test)]
    checklist_write_hook: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>>,
    #[cfg(test)]
    checklist_failure_stage: std::sync::atomic::AtomicU8,
    #[cfg(test)]
    fail_writer_shutdown: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    fail_discard_after_join: AtomicBool,
    #[cfg(test)]
    creation_header_hook:
        std::sync::Mutex<Option<Box<dyn FnOnce(ThreadId, &std::path::Path) + Send>>>,
}

#[derive(Default)]
struct Writer {
    turn: Option<String>,
    // Exact native-dispatched SDK calls remain tracked until writer shutdown.
    managed: HashSet<(String, String)>,
    early: HashMap<(String, String), ResponseItem>,
    failure: Option<String>,
    // A failed opening has no published Core thread to retry this cleanup.
    resume_cleanup_pending: bool,
    // A completed native drain can retain this entry's original failure report.
    native_drain_joined: bool,
    // Only this exact admission can transfer a prepared native writer to Core.
    prepared: Option<Arc<ResumeExpectation>>,
    // Native discard removes its recorder before awaiting its exit. Keep that
    // exact operation reachable if Core stops waiting during failed startup.
    discard: Option<tokio::task::JoinHandle<ThreadStoreResult<()>>>,
}

#[derive(Default)]
struct ResumeAdmissions {
    active: HashMap<ThreadId, Arc<ResumeExpectation>>,
    // Preserve the constructor's first model read until native acquisition succeeds.
    initial: Option<(ThreadId, Option<String>)>,
}

struct ResumeExpectation {
    model: Option<String>,
    history: Arc<Vec<RolloutItem>>,
    instructions: Arc<crate::options::ThreadInstructions>,
    prepared: OnceLock<ResumeThreadParams>,
    protected_call_ids: OnceLock<HashSet<String>>,
    retired: AtomicBool,
    transferred: AtomicBool,
}

impl ResumeExpectation {
    fn history(&self) -> &Arc<Vec<RolloutItem>> {
        self.prepared
            .get()
            .and_then(|params| params.history.as_ref())
            .unwrap_or(&self.history)
    }

    fn matches(&self, params: &ResumeThreadParams) -> bool {
        !self.retired.load(Ordering::Acquire)
            && !self.transferred.load(Ordering::Acquire)
            && params
                .history
                .as_ref()
                .is_some_and(|history| Arc::ptr_eq(history, self.history()))
            && self.prepared.get().is_none_or(|prepared| {
                params.thread_id == prepared.thread_id
                    && params.rollout_path == prepared.rollout_path
                    && params.include_archived == prepared.include_archived
                    && params.metadata == prepared.metadata
                    && params.history_revision == prepared.history_revision
            })
    }
}

pub(crate) struct LocalResumeAdmission<'a> {
    store: &'a LocalChecklistStore,
    id: ThreadId,
    expected: Arc<ResumeExpectation>,
}

impl LocalResumeAdmission<'_> {
    pub(crate) fn protected_call_ids(&self) -> &HashSet<String> {
        self.expected
            .protected_call_ids
            .get()
            .expect("local writer was prepared")
    }

    pub(crate) fn prepared_params(&self) -> ThreadStoreResult<&ResumeThreadParams> {
        self.expected
            .prepared
            .get()
            .ok_or_else(|| checklist_error("local writer was not prepared"))
    }

    pub(crate) fn validate(
        &self,
        store: &LocalChecklistStore,
        id: ThreadId,
        history: &Arc<Vec<RolloutItem>>,
        instructions: &Arc<crate::options::ThreadInstructions>,
    ) -> ThreadStoreResult<()> {
        let pending = self
            .store
            .resume_admissions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !std::ptr::eq(self.store, store)
            || self.id != id
            || self.expected.retired.load(Ordering::Acquire)
            || !Arc::ptr_eq(self.expected.history(), history)
            || !Arc::ptr_eq(&self.expected.instructions, instructions)
            || !pending
                .active
                .get(&id)
                .is_some_and(|entry| Arc::ptr_eq(entry, &self.expected))
        {
            return Err(checklist_error(
                "local resume admission does not match this opening",
            ));
        }
        Ok(())
    }
}

impl Drop for LocalResumeAdmission<'_> {
    fn drop(&mut self) {
        // The retained worker or close_database still owns native cleanup.
        // A canceled opening cannot be resurrected by an in-flight acquisition.
        self.expected.retired.store(true, Ordering::Release);
        let mut pending = self
            .store
            .resume_admissions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if pending
            .active
            .get(&self.id)
            .is_some_and(|entry| Arc::ptr_eq(entry, &self.expected))
        {
            pending.active.remove(&self.id);
        }
    }
}
impl Writer {
    fn check(&self) -> ThreadStoreResult<()> {
        match &self.failure {
            Some(message) => Err(checklist_error(message)),
            None => Ok(()),
        }
    }
}
fn checklist_error(error: impl std::fmt::Display) -> ThreadStoreError {
    ThreadStoreError::Internal {
        message: format!("native local storage: {error}"),
    }
}
pub(crate) fn observe_turn(turn: &mut Option<String>, item: &RolloutItem) {
    match item {
        RolloutItem::EventMsg(EventMsg::TurnStarted(start)) => *turn = Some(start.turn_id.clone()),
        RolloutItem::EventMsg(EventMsg::TurnComplete(_) | EventMsg::TurnAborted(_)) => *turn = None,
        _ => {}
    }
}

// Refuse unknown effects rather than allow Core recovery to fabricate cancelled
// outputs or automatically replay a callback after process loss.
fn validate_settled(history: &[RolloutItem]) -> ThreadStoreResult<()> {
    local_reconciliation::validate_settled(history).map_err(checklist_error)
}

// This validates recorded data only. It does not grant child execution or acquire
// a writer. The caller must obtain the complete graph and histories under the
// reviewed root-writer ownership boundary before publishing a Session.
fn validate_root_header(id: ThreadId, history: &[RolloutItem]) -> ThreadStoreResult<()> {
    if !matches!(history.first(), Some(RolloutItem::SessionMeta(header))
        if header.meta.id == id
            && header.meta.source.parent_thread_id().is_none()
            && header.meta.parent_thread_id.is_none())
    {
        return Err(checklist_error(
            "local resume requires its root header identity",
        ));
    }
    Ok(())
}

fn recorded_turns(history: &[RolloutItem]) -> HashMap<String, bool> {
    let mut turns = HashMap::new();
    for item in history {
        match item {
            RolloutItem::EventMsg(EventMsg::TurnStarted(start)) => {
                turns.insert(start.turn_id.clone(), true);
            }
            RolloutItem::EventMsg(EventMsg::TurnComplete(done)) => {
                turns.insert(done.turn_id.clone(), false);
            }
            RolloutItem::EventMsg(EventMsg::TurnAborted(done)) => {
                if let Some(id) = &done.turn_id {
                    turns.insert(id.clone(), false);
                }
            }
            _ => {}
        }
    }
    turns
}

fn validate_local_tree(
    root: ThreadId,
    edges: &[(ThreadId, SpawnEdge)],
    histories: &HashMap<ThreadId, Vec<RolloutItem>>,
) -> ThreadStoreResult<()> {
    let root_history = histories
        .get(&root)
        .ok_or_else(|| checklist_error("missing root history during descendant admission"))?;
    validate_root_header(root, root_history)?;
    validate_settled(root_history)?;
    let mut parents = HashMap::new();
    for (child, edge) in edges {
        if *child == root || parents.insert(*child, edge.parent).is_some() {
            return Err(checklist_error("invalid descendant topology"));
        }
    }
    let mut turns = HashMap::from([(root, recorded_turns(root_history))]);
    for (child, edge) in edges {
        let mut parent = *child;
        let mut visited = HashSet::new();
        while parent != root {
            if !visited.insert(parent) {
                return Err(checklist_error("cyclic descendant topology"));
            }
            parent = *parents
                .get(&parent)
                .ok_or_else(|| checklist_error("descendant is not connected to this root"))?;
        }
        let history = histories
            .get(child)
            .ok_or_else(|| checklist_error("missing recorded descendant history"))?;
        if !matches!(history.first(), Some(RolloutItem::SessionMeta(header))
            if header.meta.id == *child
                && header.meta.source.parent_thread_id().is_none_or(|id| id == edge.parent)
                && header.meta.parent_thread_id.is_none_or(|id| id == edge.parent)
                && (header.meta.source.parent_thread_id().is_some()
                    || header.meta.parent_thread_id.is_some()))
        {
            return Err(checklist_error(
                "descendant header does not match its graph edge",
            ));
        }
        // Closed edges do not prove an external effect's outcome.
        validate_settled(history)?;
        turns.insert(*child, recorded_turns(history));
    }
    for (child, edge) in edges {
        if edge.status == ThreadSpawnEdgeStatus::Closed {
            continue;
        }
        let parent_turns = turns
            .get(&edge.parent)
            .ok_or_else(|| checklist_error("missing parent turns during descendant admission"))?;
        let own: Vec<_> = turns[child]
            .iter()
            .filter(|(id, _)| !parent_turns.contains_key(*id))
            .collect();
        if own.is_empty() || own.iter().any(|(_, active)| **active) {
            return Err(checklist_error(
                "local history has an active descendant; its runtime cannot be restored",
            ));
        }
    }
    Ok(())
}

impl LocalChecklistStore {
    pub fn new(
        inner: LocalThreadStore,
        state: Arc<codex_state::StateRuntime>,
        home: PathBuf,
    ) -> Self {
        let graph = Arc::new(MemoryAgentGraph::local(state.clone()));
        Self::with_graph(inner, state, home, graph)
    }

    // The engine must pass this same graph to ThreadManager and interception.
    pub(crate) fn with_graph(
        inner: LocalThreadStore,
        state: Arc<codex_state::StateRuntime>,
        home: PathBuf,
        graph: Arc<MemoryAgentGraph>,
    ) -> Self {
        let checklist_directory = home.join("sdk-checklists");
        let cleanup = checklist_directory.clone();
        let inner = inner.with_thread_data_cleanup(move |ids| {
            let directory = cleanup.clone();
            Box::pin(async move {
                tokio::task::block_in_place(move || {
                    for id in ids {
                        match std::fs::remove_file(directory.join(format!("{id}.json"))) {
                            Ok(()) => {}
                            Err(error) if error.kind() == ErrorKind::NotFound => {}
                            Err(error) => return Err(checklist_error(error)),
                        }
                    }
                    Ok(())
                })
            })
        });
        Self {
            inner,
            checklist_directory,
            graph,
            state,
            writers: Mutex::default(),
            admissions_closed: std::sync::atomic::AtomicBool::new(false),
            resume_admissions: std::sync::Mutex::default(),
            #[cfg(test)]
            startup_close_probe: std::sync::Mutex::default(),
            #[cfg(test)]
            fail_receipt_flush: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            checklist_read_hook: Default::default(),
            #[cfg(test)]
            checklist_read_complete: Default::default(),
            #[cfg(test)]
            checklist_write_hook: Default::default(),
            #[cfg(test)]
            checklist_failure_stage: Default::default(),
            #[cfg(test)]
            fail_writer_shutdown: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            fail_discard_after_join: AtomicBool::new(false),
            #[cfg(test)]
            creation_header_hook: std::sync::Mutex::new(None),
        }
    }
    pub(crate) fn expect_resume_model(&self, id: ThreadId, model: Option<String>) {
        self.resume_admissions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .initial
            .get_or_insert((id, model));
    }

    pub(crate) fn admit_resume(
        &self,
        id: ThreadId,
        model: Option<String>,
        history: Arc<Vec<RolloutItem>>,
        instructions: Arc<crate::options::ThreadInstructions>,
    ) -> ThreadStoreResult<LocalResumeAdmission<'_>> {
        let mut pending = self
            .resume_admissions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if pending.active.contains_key(&id) {
            return Err(checklist_error("local thread already has a pending resume"));
        }
        let model = pending
            .initial
            .as_ref()
            .filter(|(owner, _)| *owner == id)
            .map_or(model, |(_, model)| model.clone());
        let expected = Arc::new(ResumeExpectation {
            model,
            history,
            instructions,
            prepared: OnceLock::new(),
            protected_call_ids: OnceLock::new(),
            retired: AtomicBool::new(false),
            transferred: AtomicBool::new(false),
        });
        pending.active.insert(id, expected.clone());
        Ok(LocalResumeAdmission {
            store: self,
            id,
            expected,
        })
    }

    // Keep acquisition alive across cancellation, but keep cleanup in the same
    // writer map that close_database drains. No detached writer can outlive it.
    pub(crate) async fn prepare_resume(
        self: &Arc<Self>,
        params: ResumeThreadParams,
        model: Option<String>,
        instructions: Arc<crate::options::ThreadInstructions>,
        executor_policy: crate::environment::LocalResumeExecutorPolicy,
        receipts: Vec<Receipt>,
    ) -> anyhow::Result<LocalResumeAdmission<'_>> {
        let history = params
            .history
            .clone()
            .ok_or_else(|| checklist_error("local preparation requires stored history"))?;
        validate_root_header(params.thread_id, &history)?;
        let admission = self.admit_resume(params.thread_id, model, history, instructions)?;
        let expected = admission.expected.clone();
        let store = self.clone();
        // The admission guard is registered before spawning or awaiting any
        // operation that can install a native recorder.
        tokio::spawn(async move {
            store
                .prepare_writer(params, expected, executor_policy, receipts)
                .await
        })
        .await
        .map_err(checklist_error)??;
        Ok(admission)
    }

    async fn prepare_writer(
        &self,
        mut params: ResumeThreadParams,
        expected: Arc<ResumeExpectation>,
        executor_policy: crate::environment::LocalResumeExecutorPolicy,
        receipts: Vec<Receipt>,
    ) -> anyhow::Result<()> {
        let id = params.thread_id;
        let mut writers = self.writers.lock().await;
        if self.admissions_closed.load(Ordering::Acquire)
            || expected.retired.load(Ordering::Acquire)
        {
            return Err(checklist_error("local resume preparation was retired").into());
        }
        if writers.contains_key(&id) {
            return Err(checklist_error("local thread already has a native writer").into());
        }
        // Register responsibility BEFORE native acquisition. Cancellation of the
        // outer opening drops only its claim, never this retained cleanup owner.
        writers.insert(
            id,
            Writer {
                resume_cleanup_pending: true,
                ..Writer::default()
            },
        );
        let mut acquired = false;
        let result: anyhow::Result<()> = async {
            #[cfg(test)]
            self.hold_startup_close_probe(Some(id), StartupClosePoint::BeforePreparedAcquire)
                .await;
            if expected.retired.load(Ordering::Acquire) {
                return Err(checklist_error("local resume preparation was retired").into());
            }
            let mut history = self.inner.resume_thread(params.clone()).await?;
            acquired = true;
            #[cfg(test)]
            self.hold_startup_close_probe(Some(id), StartupClosePoint::PreparedNativeWriter)
                .await;
            let current = self
                .inner
                .read_thread(ReadThreadParams {
                    thread_id: id,
                    include_archived: params.include_archived,
                    include_history: false,
                })
                .await?;
            if current.model != expected.model {
                return Err(checklist_error("local model changed during resume admission").into());
            }
            let path = self.inner.live_rollout_path(id).await?;
            let (mut complete, owner, errors) =
                codex_rollout::RolloutRecorder::load_rollout_items(&path)
                    .await
                    .map_err(checklist_error)?;
            if owner != Some(id) || errors != 0 {
                return Err(checklist_error(
                    "cannot resume incomplete rollout or another thread's history",
                )
                .into());
            }
            validate_root_header(id, &complete)?;
            validate_root_header(id, &history)?;
            executor_policy
                .validate(&complete, id)
                .map_err(checklist_error)?;
            let plan = match local_reconciliation::plan(id, &complete, &history, &receipts) {
                Ok(plan) => plan,
                Err(error) => match error.downcast::<local_reconciliation::RecoveryRequired>() {
                    Ok(mut hold) => {
                        hold.history = complete;
                        return Err(hold.into());
                    }
                    Err(error) => return Err(checklist_error(error).into()),
                },
            };
            complete.extend(plan.append.iter().cloned());
            self.graph.hydrate(id).await.map_err(checklist_error)?;
            self.check_tree_settled_inner(id, &complete, &writers)
                .await?;
            if expected.instructions.managed() {
                let text = expected
                    .instructions
                    .text()
                    .map_err(checklist_error)?
                    .unwrap_or_default();
                if let Some(accepted) = crate::application_instructions::validate(&complete, &text)
                    .map_err(checklist_error)?
                {
                    expected
                        .instructions
                        .confirm(accepted)
                        .map_err(checklist_error)?;
                }
            }
            if expected.retired.load(Ordering::Acquire)
                || self.admissions_closed.load(Ordering::Acquire)
            {
                return Err(checklist_error("local resume preparation was retired").into());
            }
            if !plan.append.is_empty() {
                self.inner
                    .append_items(AppendThreadItemsParams {
                        thread_id: id,
                        items: plan.append.clone(),
                    })
                    .await?;
                let persisted = self.load_owned_history_inner(id).await?;
                let verified = local_reconciliation::plan(id, &persisted, &history, &receipts)
                    .map_err(checklist_error)?;
                if !verified.append.is_empty() {
                    return Err(checklist_error(
                        "reconciliation results were not confirmed in storage",
                    )
                    .into());
                }
                Arc::make_mut(&mut history).extend(plan.append);
            }
            expected
                .protected_call_ids
                .set(plan.protected_ids)
                .map_err(|_| checklist_error("local replay guard already prepared"))?;
            // Core will use this canonical path and exact authoritative Arc.
            // Revision selection has already happened in the native acquisition.
            params.rollout_path = Some(path);
            params.history = Some(history.clone());
            params.history_revision = None;
            expected
                .prepared
                .set(params)
                .map_err(|_| checklist_error("local writer already prepared"))?;
            let writer = writers.get_mut(&id).expect("registered local acquisition");
            for row in history.iter() {
                observe_turn(&mut writer.turn, row);
            }
            writer.prepared = Some(expected.clone());
            Ok(())
        }
        .await;
        if let Err(error) = result {
            if !acquired {
                // Native resume registers its recorder as its final fallible
                // operation. An unsuccessful acquisition installed no writer;
                // never shut down a competing opening's recorder on this path.
                writers.remove(&id);
                return Err(error);
            }
            writers
                .get_mut(&id)
                .expect("registered local acquisition")
                .failure = Some(error.to_string());
            return match self.shutdown_native_writer(id).await {
                Ok(()) => {
                    writers.remove(&id);
                    Err(error)
                }
                Err(cleanup) => {
                    let failure = format!("{error}; native writer cleanup failed: {cleanup}");
                    writers
                        .get_mut(&id)
                        .expect("retained local acquisition")
                        .failure = Some(failure.clone());
                    Err(checklist_error(failure).into())
                }
            };
        }
        Ok(())
    }

    fn claim_resume(
        &self,
        params: &ResumeThreadParams,
    ) -> ThreadStoreResult<Option<Arc<ResumeExpectation>>> {
        let mut pending = self
            .resume_admissions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match pending.active.get(&params.thread_id) {
            Some(expected) if expected.matches(params) => {
                Ok(pending.active.remove(&params.thread_id))
            }
            Some(_) => Err(checklist_error("local resume belongs to another opening")),
            None if params.history.is_some()
                || pending
                    .initial
                    .as_ref()
                    .is_some_and(|(id, _)| *id == params.thread_id) =>
            {
                Err(checklist_error(
                    "local resume admission is no longer active",
                ))
            }
            // Direct store resumes with no supplied model window carry no SDK
            // instruction owner. They cannot take the managed-startup shortcut.
            None => Ok(None),
        }
    }

    pub(crate) async fn canonical_creation_time(
        &self,
        id: ThreadId,
    ) -> ThreadStoreResult<std::time::SystemTime> {
        let mut writers = self.writers.lock().await;
        let writer = writers
            .get_mut(&id)
            .ok_or(ThreadStoreError::ThreadNotFound { thread_id: id })?;
        writer.check()?;
        let durable = async {
            self.inner
                .persist_thread(id, PersistContext::Standard)
                .await?;
            self.inner.flush_thread(id).await
        }
        .await;
        if let Err(error) = durable {
            writer.failure.get_or_insert_with(|| error.to_string());
            return Err(error);
        }
        let path = self.inner.live_rollout_path(id).await?;
        #[cfg(test)]
        if let Some(hook) = self
            .creation_header_hook
            .lock()
            .expect("creation hook poisoned")
            .take()
        {
            hook(id, &path);
        }
        let header = codex_rollout::read_session_meta_line(&path)
            .await
            .map_err(checklist_error)?;
        if header.meta.id != id {
            return Err(checklist_error(
                "local creation header thread identity mismatch",
            ));
        }
        let timestamp = chrono::DateTime::parse_from_rfc3339(&header.meta.timestamp)
            .map_err(checklist_error)?;
        Ok(timestamp.with_timezone(&chrono::Utc).into())
    }

    pub(crate) async fn check_settled(&self, id: ThreadId) -> ThreadStoreResult<()> {
        validate_settled(&self.load_owned_history(id).await?)
    }

    async fn check_tree_settled_inner(
        &self,
        root: ThreadId,
        history: &[RolloutItem],
        writers: &HashMap<ThreadId, Writer>,
    ) -> ThreadStoreResult<()> {
        let mut histories = HashMap::from([(root, history.to_vec())]);
        let mut edges = Vec::new();
        for child in self
            .graph
            .list_thread_spawn_descendants(root, None)
            .await
            .map_err(checklist_error)?
        {
            if writers.contains_key(&child) {
                return Err(checklist_error(
                    "local descendant still has a native writer",
                ));
            }
            let edge = self
                .graph
                .edge(child)
                .await
                .ok_or_else(|| checklist_error("descendant graph was not fully hydrated"))?;
            let stored = self
                .inner
                .read_thread(ReadThreadParams {
                    thread_id: child,
                    include_archived: true,
                    include_history: false,
                })
                .await?;
            let path = stored
                .rollout_path
                .ok_or_else(|| checklist_error("missing descendant rollout path"))?;
            let (items, owner, errors) = codex_rollout::RolloutRecorder::load_rollout_items(&path)
                .await
                .map_err(checklist_error)?;
            if owner != Some(child) || errors != 0 {
                return Err(checklist_error(
                    "cannot read incomplete descendant rollout or another thread's history",
                ));
            }
            histories.insert(child, items);
            edges.push((child, edge));
        }
        validate_local_tree(root, &edges, &histories)
    }

    pub(crate) async fn close_database(&self) -> ThreadStoreResult<()> {
        let mut writers = self.writers.lock().await;
        let pending: Vec<_> = writers
            .iter()
            .filter_map(|(id, writer)| writer.resume_cleanup_pending.then_some(*id))
            .collect();
        let mut failures = Vec::new();
        for id in pending {
            let result = if let Some(writer) = writers.get_mut(&id)
                && writer.discard.is_some()
            {
                self.discard_native_writer(id, writer).await
            } else {
                self.shutdown_native_writer(id).await
            };
            match result {
                Ok(()) => {
                    writers.remove(&id);
                }
                Err(error) => failures.push(error.to_string()),
            }
        }
        if !failures.is_empty() {
            return Err(checklist_error(failures.join("; ")));
        }
        if let Some(writer) = writers.values().find(|writer| !writer.native_drain_joined) {
            writer.check()?;
            return Err(checklist_error(
                "native writer shutdown is still pending; retry close after cleanup",
            ));
        }
        self.admissions_closed
            .store(true, std::sync::atomic::Ordering::Release);
        *self
            .resume_admissions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = ResumeAdmissions::default();
        drop(writers);
        #[cfg(test)]
        self.hold_startup_close_probe(None, StartupClosePoint::BeforeDatabaseClose)
            .await;
        self.state.close().await;
        Ok(())
    }

    async fn shutdown_native_writer(&self, id: ThreadId) -> ThreadStoreResult<()> {
        #[cfg(test)]
        if self
            .fail_writer_shutdown
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err(checklist_error("injected native writer shutdown failure"));
        }
        self.inner.shutdown_thread(id).await
    }

    async fn discard_native_writer(
        &self,
        id: ThreadId,
        writer: &mut Writer,
    ) -> ThreadStoreResult<()> {
        if writer.native_drain_joined {
            return writer.check();
        }
        if writer.discard.is_none() {
            let inner = self.inner.clone();
            #[cfg(test)]
            let probe = self.startup_close_probe_for(Some(id));
            #[cfg(test)]
            let fail_after_join = self.fail_discard_after_join.load(Ordering::SeqCst);
            writer.resume_cleanup_pending = true;
            writer.discard = Some(tokio::spawn(async move {
                let result = inner.discard_thread(id).await;
                #[cfg(test)]
                {
                    if let Some(probe) = probe {
                        probe.hold(StartupClosePoint::DiscardNativeJoined).await;
                    }
                    if fail_after_join && result.is_ok() {
                        return Err(checklist_error("injected discard error after native join"));
                    }
                }
                result
            }));
        }
        let result = writer
            .discard
            .as_mut()
            .expect("retained native discard")
            .await;
        writer.discard = None;
        writer.resume_cleanup_pending = false;
        match result {
            Ok(result) => {
                // Recorder::discard always joins before returning an IO error.
                // ThreadNotFound can occur before reaching that recorder and
                // therefore cannot establish that its drain was joined.
                writer.native_drain_joined =
                    !matches!(&result, Err(ThreadStoreError::ThreadNotFound { .. }));
                if let Err(error) = &result {
                    writer.failure.get_or_insert_with(|| error.to_string());
                }
                result?;
                writer.check()
            }
            Err(error) => {
                let failure = format!("native discard task failed: {error}");
                writer.failure.get_or_insert_with(|| failure.clone());
                Err(checklist_error(failure))
            }
        }
    }

    pub(crate) async fn check_failure(&self, id: Option<ThreadId>) -> ThreadStoreResult<()> {
        let writers = self.writers.lock().await;
        for (thread, writer) in writers.iter() {
            if id.is_none_or(|id| id == *thread) {
                writer.check()?;
            }
        }
        Ok(())
    }

    pub(crate) async fn register_call(
        &self,
        id: ThreadId,
        turn: &str,
        call: &str,
    ) -> ThreadStoreResult<()> {
        let mut writers = self.writers.lock().await;
        let writer = writers
            .get_mut(&id)
            .ok_or(ThreadStoreError::ThreadNotFound { thread_id: id })?;
        writer.check()?;
        if writer.turn.as_deref() != Some(turn)
            || !writer.managed.insert((turn.into(), call.into()))
        {
            return Err(checklist_error(
                "SDK call does not belong to the active local writer",
            ));
        }
        Ok(())
    }
    pub(crate) async fn commit_sdk_receipt(
        &self,
        id: ThreadId,
        key: &crate::python_tools::PendingKey,
        item: ResponseItem,
    ) -> ThreadStoreResult<()> {
        let mut writers = self.writers.lock().await;
        let writer = writers
            .get_mut(&id)
            .ok_or(ThreadStoreError::ThreadNotFound { thread_id: id })?;
        writer.check()?;
        let identity = (key.turn.clone(), key.call.clone());
        if key.reply.thread != id.to_string()
            || writer.turn.as_deref() != Some(key.turn.as_str())
            || !writer.managed.contains(&identity)
            || writer.early.contains_key(&identity)
        {
            return Err(checklist_error(
                "SDK receipt does not belong to the active local writer",
            ));
        }
        if !matches!(&item, ResponseItem::FunctionCallOutput { call_id: Some(call), internal_chat_message_metadata_passthrough: Some(meta), .. } if *call == key.call && meta.turn_id.as_deref() == Some(key.turn.as_str()))
        {
            return Err(checklist_error("SDK receipt identity mismatch"));
        }
        let result = async {
            self.inner
                .append_items(AppendThreadItemsParams {
                    thread_id: id,
                    items: vec![RolloutItem::ResponseItem(ResponseItemEnvelope::new(
                        item.clone(),
                    ))],
                })
                .await?;
            #[cfg(test)]
            if self
                .fail_receipt_flush
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return Err(checklist_error("injected receipt flush failure"));
            }
            self.inner.flush_thread(id).await
        }
        .await;
        if let Err(error) = result {
            writer.failure.get_or_insert_with(|| error.to_string());
            return Err(error);
        }
        writer.early.insert(identity, item);
        Ok(())
    }
    pub async fn load_owned_history(&self, id: ThreadId) -> ThreadStoreResult<Vec<RolloutItem>> {
        let writers = self.writers.lock().await;
        writers
            .get(&id)
            .ok_or(ThreadStoreError::ThreadNotFound { thread_id: id })?
            .check()?;
        self.load_owned_history_inner(id).await
    }

    // Caller owns writers and checked its live owner. Never call a locking wrapper here.
    async fn load_owned_history_inner(&self, id: ThreadId) -> ThreadStoreResult<Vec<RolloutItem>> {
        self.inner.flush_thread(id).await?;
        let path = self.inner.live_rollout_path(id).await?;
        let (items, owner, errors) = codex_rollout::RolloutRecorder::load_rollout_items(&path)
            .await
            .map_err(checklist_error)?;
        if owner != Some(id) || errors != 0 {
            return Err(checklist_error(
                "cannot read incomplete rollout or another thread's history",
            ));
        }
        Ok(items)
    }

    pub async fn checklist(&self, id: ThreadId) -> ThreadStoreResult<Option<ChecklistState>> {
        let writers = self.writers.lock().await;
        let writer = writers
            .get(&id)
            .ok_or(ThreadStoreError::ThreadNotFound { thread_id: id })?;
        writer.check()?;
        let history = self.load_owned_history_inner(id).await?;
        let path = self.checklist_directory.join(format!("{id}.json"));
        #[cfg(test)]
        let hook = self
            .checklist_read_hook
            .lock()
            .expect("checklist read hook poisoned")
            .take();
        #[cfg(test)]
        let complete = self.checklist_read_complete.lock().unwrap().take();
        // Cancellation may abandon this read, but it owns no store or publication callback.
        let value =
            tokio::task::spawn_blocking(move || -> ThreadStoreResult<Option<ChecklistState>> {
                #[cfg(test)]
                let _complete = ChecklistReadCompletion(complete);
                #[cfg(test)]
                if let Some(hook) = hook {
                    hook();
                }
                let file = match std::fs::File::open(path) {
                    Ok(file) => file,
                    Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
                    Err(error) => return Err(checklist_error(error)),
                };
                let value: ChecklistState =
                    serde_json::from_reader(file).map_err(checklist_error)?;
                value.validate(id, &history).map_err(checklist_error)?;
                Ok(Some(value))
            })
            .await
            .map_err(checklist_error)??;
        // Keep this borrow and the one writer guard through the complete snapshot.
        writer.check()?;
        Ok(value)
    }

    #[cfg(test)]
    fn checklist_stage(&self, stage: u8) -> ThreadStoreResult<()> {
        if self
            .checklist_failure_stage
            .load(std::sync::atomic::Ordering::Acquire)
            == stage
        {
            return Err(checklist_error(format!(
                "injected checklist persistence stage {stage}"
            )));
        }
        Ok(())
    }

    fn write_checklist(&self, value: ChecklistState) -> ThreadStoreResult<()> {
        // Do not detach a write across cancellation or native writer shutdown.
        tokio::task::block_in_place(|| {
            #[cfg(test)]
            if let Some(hook) = self
                .checklist_write_hook
                .lock()
                .expect("checklist write hook poisoned")
                .take()
            {
                hook();
            }
            std::fs::create_dir_all(&self.checklist_directory).map_err(checklist_error)?;
            let mut file = tempfile::NamedTempFile::new_in(&self.checklist_directory)
                .map_err(checklist_error)?;
            serde_json::to_writer(&mut file, &value).map_err(checklist_error)?;
            #[cfg(test)]
            self.checklist_stage(2)?;
            file.flush().map_err(checklist_error)?;
            #[cfg(test)]
            self.checklist_stage(3)?;
            file.as_file().sync_all().map_err(checklist_error)?;
            #[cfg(test)]
            self.checklist_stage(4)?;
            file.persist(
                self.checklist_directory
                    .join(format!("{}.json", value.thread_id)),
            )
            .map_err(checklist_error)?;
            #[cfg(test)]
            self.checklist_stage(5)?;
            sync_checklist_directory(&self.checklist_directory)
        })
    }
}

#[cfg(test)]
struct ChecklistReadCompletion(Option<tokio::sync::oneshot::Sender<()>>);
#[cfg(test)]
impl Drop for ChecklistReadCompletion {
    fn drop(&mut self) {
        if let Some(complete) = self.0.take() {
            let _ = complete.send(());
        }
    }
}

fn sync_checklist_directory(directory: &Path) -> ThreadStoreResult<()> {
    #[cfg(unix)]
    std::fs::File::open(directory)
        .and_then(|file| file.sync_all())
        .map_err(checklist_error)?;
    #[cfg(not(unix))]
    let _ = directory;
    Ok(())
}
impl ThreadStore for LocalChecklistStore {
    // Core downcasts this exact native identity to resolve paths and state DB.
    fn as_any(&self) -> &dyn std::any::Any {
        self.inner.as_any()
    }
    fn create_thread(&self, params: CreateThreadParams) -> ThreadStoreFuture<'_, ()> {
        Box::pin(async move {
            let parent = params.source.parent_thread_id().or(params.parent_thread_id);
            if params
                .source
                .parent_thread_id()
                .zip(params.parent_thread_id)
                .is_some_and(|(source, explicit)| source != explicit)
            {
                return Err(checklist_error("conflicting local child parent identities"));
            }
            let mut writers = self.writers.lock().await;
            if self
                .admissions_closed
                .load(std::sync::atomic::Ordering::Acquire)
            {
                return Err(checklist_error(
                    "local storage is closed to new native writers",
                ));
            }
            let id = params.thread_id;
            if let Some(parent) = parent {
                writers
                    .get(&parent)
                    .ok_or_else(|| {
                        checklist_error("local child creation requires its current parent writer")
                    })?
                    .check()?;
            }
            #[cfg(test)]
            if let Some(probe) = self.startup_close_probe_for(Some(id)) {
                probe
                    .native_creates
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            self.inner.create_thread(params).await?;
            if let Some(parent) = parent {
                // Core only warns if its later graph upsert fails. Make the
                // actual header readable and its edge durable before returning
                // creation to Core, which can then admit child execution.
                let admission = async {
                    self.inner
                        .persist_thread(id, PersistContext::Standard)
                        .await?;
                    self.inner.flush_thread(id).await?;
                    self.graph.admit(parent, id).await.map_err(checklist_error)
                }
                .await;
                if let Err(error) = admission {
                    let writer = writers.entry(id).or_default();
                    if let Err(cleanup) = self.discard_native_writer(id, writer).await {
                        let message = format!("{error}; child admission cleanup failed: {cleanup}");
                        writer.failure = Some(message.clone());
                        return Err(checklist_error(message));
                    }
                    writers.remove(&id);
                    return Err(error);
                }
            }
            writers.insert(id, Writer::default());
            Ok(())
        })
    }
    fn resume_thread(
        &self,
        params: ResumeThreadParams,
    ) -> ThreadStoreFuture<'_, Arc<Vec<RolloutItem>>> {
        #[cfg(test)]
        let probe = self.startup_close_probe_for(Some(params.thread_id));
        let operation = async move {
            // Core may retain this acquisition after the opening future is
            // dropped. Claim its exact metadata before waiting for the writer.
            let admission = self.claim_resume(&params)?;
            let mut writers = self.writers.lock().await;
            if self
                .admissions_closed
                .load(std::sync::atomic::Ordering::Acquire)
            {
                return Err(checklist_error(
                    "local storage is closed to new native writers",
                ));
            }
            let id = params.thread_id;
            if let Some(expected) = &admission
                && expected.prepared.get().is_some()
            {
                let writer = writers
                    .get_mut(&id)
                    .ok_or_else(|| checklist_error("prepared local writer is no longer owned"))?;
                writer.check()?;
                if !expected.matches(&params)
                    || !writer
                        .prepared
                        .as_ref()
                        .is_some_and(|owner| Arc::ptr_eq(owner, expected))
                {
                    return Err(checklist_error(
                        "prepared local writer does not match this opening",
                    ));
                }
                let history = expected.history().clone();
                writer.prepared = None;
                writer.resume_cleanup_pending = false;
                expected.transferred.store(true, Ordering::Release);
                // No await after consumption: Core now owns its init cleanup.
                return Ok(history);
            }
            if writers.contains_key(&id) {
                return Err(checklist_error("local thread already has a native writer"));
            }
            let history = self.inner.resume_thread(params).await?;
            {
                let mut pending = self
                    .resume_admissions
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if pending
                    .initial
                    .as_ref()
                    .is_some_and(|(owner, _)| *owner == id)
                {
                    pending.initial = None;
                }
            }
            let validate = async {
                if let Some(expected) = &admission {
                    let current = self
                        .inner
                        .read_thread(ReadThreadParams {
                            thread_id: id,
                            include_archived: true,
                            include_history: false,
                        })
                        .await?;
                    if current.model != expected.model {
                        return Err(checklist_error(
                            "local model changed during resume admission",
                        ));
                    }
                }
                let path = self.inner.live_rollout_path(id).await?;
                let (complete, owner, errors) =
                    codex_rollout::RolloutRecorder::load_rollout_items(&path)
                        .await
                        .map_err(checklist_error)?;
                if owner != Some(id) || errors != 0 {
                    return Err(checklist_error(
                        "cannot resume incomplete rollout or another thread's history",
                    ));
                }
                validate_root_header(id, &complete)?;
                // Retain refusal until the separately reviewed pre-manager
                // writer acquisition and whole-tree admission are wired.
                if !self
                    .graph
                    .list_thread_spawn_descendants(id, None)
                    .await
                    .map_err(checklist_error)?
                    .is_empty()
                {
                    return Err(checklist_error(
                        "local storage does not yet support descendant-bearing profiles",
                    ));
                }
                validate_settled(&complete)?;
                if let Some(expected) = &admission
                    && expected.instructions.managed()
                {
                    let current = expected
                        .instructions
                        .text()
                        .map_err(checklist_error)?
                        .unwrap_or_default();
                    let accepted = crate::application_instructions::validate(&complete, &current)
                        .map_err(checklist_error)?;
                    if let Some(accepted) = accepted {
                        // Core consumes this provider only after resume returns.
                        expected
                            .instructions
                            .confirm(accepted)
                            .map_err(checklist_error)?;
                    }
                }
                Ok(())
            }
            .await;
            if let Err(error) = validate {
                writers.insert(
                    id,
                    Writer {
                        failure: Some(error.to_string()),
                        resume_cleanup_pending: true,
                        ..Writer::default()
                    },
                );
                return match self.shutdown_native_writer(id).await {
                    Ok(()) => {
                        writers.remove(&id);
                        Err(error)
                    }
                    Err(cleanup) => {
                        let failure = format!("{error}; native writer cleanup failed: {cleanup}");
                        writers
                            .get_mut(&id)
                            .expect("retained resume writer")
                            .failure = Some(failure.clone());
                        Err(checklist_error(failure))
                    }
                };
            }
            let mut writer = Writer::default();
            for row in history.iter() {
                observe_turn(&mut writer.turn, row);
            }
            writers.insert(id, writer);
            #[cfg(test)]
            {
                drop(writers);
                self.hold_startup_close_probe(Some(id), StartupClosePoint::RegisteredResume)
                    .await;
            }
            Ok(history)
        };
        #[cfg(test)]
        {
            return Box::pin(async move {
                let result = operation.await;
                if let Some(probe) = probe {
                    probe.completed.add_permits(1);
                }
                result
            });
        }
        #[cfg(not(test))]
        Box::pin(operation)
    }
    fn append_items(&self, mut params: AppendThreadItemsParams) -> ThreadStoreFuture<'_, ()> {
        Box::pin(async move {
            let mut writers = self.writers.lock().await;
            let id = params.thread_id;
            let writer = writers
                .get_mut(&id)
                .ok_or(ThreadStoreError::ThreadNotFound { thread_id: id })?;
            writer.check()?;
            let mut retained = Vec::new();
            let mut checklist = None;
            for row in params.items {
                observe_turn(&mut writer.turn, &row);
                if let RolloutItem::EventMsg(EventMsg::PlanUpdate(plan)) = &row {
                    let Some(turn_id) = writer.turn.clone() else {
                        let message = "accepted checklist has no open native turn owner";
                        writer.failure = Some(message.into());
                        return Err(checklist_error(message));
                    };
                    checklist = Some(ChecklistState {
                        thread_id: id,
                        turn_id,
                        explanation: plan.explanation.clone(),
                        plan: plan.plan.clone(),
                    });
                }
                if let RolloutItem::ResponseItem(envelope) = &row
                    && let ResponseItem::FunctionCallOutput {
                        call_id: Some(call),
                        internal_chat_message_metadata_passthrough,
                        ..
                    } = &envelope.item
                {
                    let owned = writer.managed.iter().any(|(_, id)| id == call);
                    if owned {
                        let identity = internal_chat_message_metadata_passthrough
                            .as_ref()
                            .and_then(|meta| meta.turn_id.as_ref())
                            .map(|turn| (turn.clone(), call.clone()));
                        if let Some(identity) = identity
                            && let Some(expected) = writer.early.remove(&identity)
                        {
                            let matches = match (&expected, &envelope.item) {
                                (
                                    ResponseItem::FunctionCallOutput {
                                        output: expected, ..
                                    },
                                    ResponseItem::FunctionCallOutput { output: actual, .. },
                                ) => {
                                    serde_json::to_value(expected).map_err(checklist_error)?
                                        == serde_json::to_value(actual).map_err(checklist_error)?
                                }
                                _ => false,
                            };
                            // Core adds an output ID and creation timestamp at
                            // drain. The actual result body must stay unchanged.
                            if !matches {
                                writer.failure =
                                    Some("Core drain changed an acknowledged SDK receipt".into());
                                return writer.check();
                            }
                        }
                        // Missing/foreign metadata cannot turn a cancellation
                        // into an SDK receipt. Keep the original call unknown.
                        continue;
                    }
                }
                retained.push(row);
            }
            params.items = retained;
            let result: ThreadStoreResult<()> = async {
                self.inner.append_items(params).await?;
                if let Some(checklist) = checklist {
                    #[cfg(test)]
                    self.checklist_stage(1)?;
                    self.inner.flush_thread(id).await?;
                    self.write_checklist(checklist)?;
                }
                Ok(())
            }
            .await;
            if let Err(error) = &result {
                writer.failure.get_or_insert_with(|| error.to_string());
            }
            result
        })
    }
    fn persist_thread(&self, id: ThreadId, context: PersistContext) -> ThreadStoreFuture<'_, ()> {
        Box::pin(async move {
            let mut writers = self.writers.lock().await;
            if let Some(writer) = writers.get(&id) {
                writer.check()?;
            }
            let result = self.inner.persist_thread(id, context).await;
            if let Err(error) = &result
                && let Some(writer) = writers.get_mut(&id)
            {
                writer.failure.get_or_insert_with(|| error.to_string());
            }
            result
        })
    }
    fn flush_thread(&self, id: ThreadId) -> ThreadStoreFuture<'_, ()> {
        Box::pin(async move {
            let mut writers = self.writers.lock().await;
            if let Some(writer) = writers.get(&id) {
                writer.check()?;
            }
            let result = self.inner.flush_thread(id).await;
            if let Err(error) = &result
                && let Some(writer) = writers.get_mut(&id)
            {
                writer.failure.get_or_insert_with(|| error.to_string());
            }
            result
        })
    }
    fn shutdown_thread(&self, id: ThreadId) -> ThreadStoreFuture<'_, ()> {
        Box::pin(async move {
            let mut writers = self.writers.lock().await;
            if let Some(writer) = writers.get_mut(&id)
                && (writer.discard.is_some() || writer.native_drain_joined)
            {
                self.discard_native_writer(id, writer).await?;
                writers.remove(&id);
                return Ok(());
            }
            self.shutdown_native_writer(id).await?;
            if writers
                .get(&id)
                .is_some_and(|writer| writer.resume_cleanup_pending)
            {
                writers.remove(&id);
                return Ok(());
            }
            if let Some(writer) = writers.get_mut(&id) {
                writer.native_drain_joined = true;
                writer.check()?;
            }
            writers.remove(&id);
            Ok(())
        })
    }
    fn discard_thread(&self, id: ThreadId) -> ThreadStoreFuture<'_, ()> {
        Box::pin(async move {
            let mut writers = self.writers.lock().await;
            let writer = writers
                .get_mut(&id)
                .ok_or(ThreadStoreError::ThreadNotFound { thread_id: id })?;
            self.discard_native_writer(id, writer).await?;
            writer.check()?;
            writers.remove(&id);
            Ok(())
        })
    }
    fn default_history_mode(&self) -> ThreadHistoryMode {
        ThreadStore::default_history_mode(&self.inner)
    }

    fn stage_pending_thread_metadata(
        &self,
        thread_id: ThreadId,
        patch: ThreadMetadataPatch,
    ) -> ThreadStoreFuture<'_, ()> {
        ThreadStore::stage_pending_thread_metadata(&self.inner, thread_id, patch)
    }

    fn read_pending_thread_metadata(
        &self,
        thread_id: ThreadId,
    ) -> ThreadStoreFuture<'_, Option<ThreadMetadataPatch>> {
        ThreadStore::read_pending_thread_metadata(&self.inner, thread_id)
    }

    fn remove_pending_thread_metadata(&self, thread_id: ThreadId) -> ThreadStoreFuture<'_, ()> {
        ThreadStore::remove_pending_thread_metadata(&self.inner, thread_id)
    }

    fn load_history(
        &self,
        params: LoadThreadHistoryParams,
    ) -> ThreadStoreFuture<'_, StoredThreadHistory> {
        Box::pin(async move {
            let id = params.thread_id;
            let writers = self.writers.lock().await;
            if let Some(writer) = writers.get(&id) {
                writer.check()?;
            }
            let stored = self
                .inner
                .read_thread(ReadThreadParams {
                    thread_id: id,
                    include_archived: params.include_archived,
                    include_history: false,
                })
                .await?;
            if stored.history_mode != ThreadHistoryMode::Paginated {
                return ThreadStore::load_history(&self.inner, params).await;
            }
            // Native rejects its legacy history API for paginated threads.
            // Public SDK item/turn views need the complete saved audit, not
            // only the current model window returned by load_latest_model_context.
            // Resolve the path exclusively through this authorized native store.
            let path = stored.rollout_path.ok_or_else(|| {
                checklist_error("native thread store returned no path for stored history")
            })?;
            let (items, owner, parse_errors) =
                codex_rollout::RolloutRecorder::load_rollout_items(&path)
                    .await
                    .map_err(checklist_error)?;
            if owner != Some(id) || parse_errors != 0 {
                return Err(checklist_error(
                    "cannot read incomplete rollout or another thread's history",
                ));
            }
            Ok(StoredThreadHistory {
                thread_id: id,
                // Native does not issue a revision for this whole-file audit.
                // Only its model-context API grants a revision usable for writes.
                revision: None,
                items,
            })
        })
    }

    fn load_latest_model_context(
        &self,
        params: LoadThreadHistoryParams,
    ) -> ThreadStoreFuture<'_, StoredModelContext> {
        Box::pin(async move {
            let writers = self.writers.lock().await;
            if let Some(writer) = writers.get(&params.thread_id) {
                writer.check()?;
            }
            self.inner.load_latest_model_context(params).await
        })
    }

    fn prepare_fork(&self, params: PrepareForkParams) -> ThreadStoreFuture<'_, PreparedFork> {
        ThreadStore::prepare_fork(&self.inner, params)
    }

    fn revert_thread(&self, params: RevertThreadParams) -> ThreadStoreFuture<'_, ()> {
        ThreadStore::revert_thread(&self.inner, params)
    }

    fn read_thread(&self, params: ReadThreadParams) -> ThreadStoreFuture<'_, StoredThread> {
        Box::pin(async move {
            let writers = self.writers.lock().await;
            if let Some(writer) = writers.get(&params.thread_id) {
                writer.check()?;
            }
            self.inner.read_thread(params).await
        })
    }

    fn read_thread_by_rollout_path(
        &self,
        params: ReadThreadByRolloutPathParams,
    ) -> ThreadStoreFuture<'_, StoredThread> {
        ThreadStore::read_thread_by_rollout_path(&self.inner, params)
    }

    fn list_threads(&self, params: ListThreadsParams) -> ThreadStoreFuture<'_, ThreadPage> {
        ThreadStore::list_threads(&self.inner, params)
    }

    fn supports_thread_sections(&self) -> bool {
        ThreadStore::supports_thread_sections(&self.inner)
    }

    fn list_thread_sections(
        &self,
        params: ListThreadSectionsParams,
    ) -> ThreadStoreFuture<'_, StoredThreadSectionsPage> {
        ThreadStore::list_thread_sections(&self.inner, params)
    }

    fn create_thread_section(
        &self,
        params: CreateThreadSectionParams,
    ) -> ThreadStoreFuture<'_, StoredThreadSection> {
        ThreadStore::create_thread_section(&self.inner, params)
    }

    fn rename_thread_section(
        &self,
        params: RenameThreadSectionParams,
    ) -> ThreadStoreFuture<'_, Option<StoredThreadSection>> {
        ThreadStore::rename_thread_section(&self.inner, params)
    }

    fn delete_thread_section(
        &self,
        params: DeleteThreadSectionParams,
    ) -> ThreadStoreFuture<'_, bool> {
        ThreadStore::delete_thread_section(&self.inner, params)
    }

    fn supports_thread_attachments(&self) -> bool {
        ThreadStore::supports_thread_attachments(&self.inner)
    }

    fn copy_thread_attachments(
        &self,
        source_thread_id: ThreadId,
        destination_thread_id: ThreadId,
    ) -> ThreadStoreFuture<'_, ()> {
        ThreadStore::copy_thread_attachments(&self.inner, source_thread_id, destination_thread_id)
    }

    fn add_thread_attachment(
        &self,
        params: AddThreadAttachmentParams,
    ) -> ThreadStoreFuture<'_, AddThreadAttachmentOutcome> {
        ThreadStore::add_thread_attachment(&self.inner, params)
    }

    fn list_thread_attachments(
        &self,
        params: ListThreadAttachmentsParams,
    ) -> ThreadStoreFuture<'_, ThreadAttachmentPage> {
        ThreadStore::list_thread_attachments(&self.inner, params)
    }

    fn list_thread_attachment_threads(
        &self,
        params: ListThreadAttachmentThreadsParams,
    ) -> ThreadStoreFuture<'_, ThreadAttachmentOwnerPage> {
        ThreadStore::list_thread_attachment_threads(&self.inner, params)
    }

    fn remove_thread_attachment(
        &self,
        params: RemoveThreadAttachmentParams,
    ) -> ThreadStoreFuture<'_, RemoveThreadAttachmentOutcome> {
        ThreadStore::remove_thread_attachment(&self.inner, params)
    }

    fn supports_projects(&self) -> bool {
        ThreadStore::supports_projects(&self.inner)
    }

    fn list_projects(
        &self,
        params: ListProjectsParams,
    ) -> ThreadStoreFuture<'_, StoredProjectsPage> {
        ThreadStore::list_projects(&self.inner, params)
    }

    fn read_project(&self, project_id: String) -> ThreadStoreFuture<'_, Option<StoredProject>> {
        ThreadStore::read_project(&self.inner, project_id)
    }

    fn create_project(&self, params: CreateProjectParams) -> ThreadStoreFuture<'_, CreatedProject> {
        ThreadStore::create_project(&self.inner, params)
    }

    fn update_project(
        &self,
        params: UpdateProjectParams,
    ) -> ThreadStoreFuture<'_, Option<UpdatedProject>> {
        ThreadStore::update_project(&self.inner, params)
    }

    fn move_project(
        &self,
        params: MoveProjectParams,
    ) -> ThreadStoreFuture<'_, Option<ProjectMoveOutcome>> {
        ThreadStore::move_project(&self.inner, params)
    }

    fn delete_project(&self, project_id: String) -> ThreadStoreFuture<'_, Option<DeletedProject>> {
        ThreadStore::delete_project(&self.inner, project_id)
    }

    fn supports_paginated_history_lists(&self) -> bool {
        ThreadStore::supports_paginated_history_lists(&self.inner)
    }

    fn list_turns(&self, params: ListTurnsParams) -> ThreadStoreFuture<'_, TurnPage> {
        ThreadStore::list_turns(&self.inner, params)
    }

    fn list_items(&self, params: ListItemsParams) -> ThreadStoreFuture<'_, ItemPage> {
        ThreadStore::list_items(&self.inner, params)
    }

    fn list_timeline(&self, params: ListTimelineParams) -> ThreadStoreFuture<'_, TimelinePage> {
        ThreadStore::list_timeline(&self.inner, params)
    }

    fn search_threads(
        &self,
        params: SearchThreadsParams,
    ) -> ThreadStoreFuture<'_, ThreadSearchPage> {
        ThreadStore::search_threads(&self.inner, params)
    }

    fn search_thread_occurrences(
        &self,
        params: SearchThreadOccurrencesParams,
    ) -> ThreadStoreFuture<'_, ThreadOccurrenceSearchPage> {
        ThreadStore::search_thread_occurrences(&self.inner, params)
    }

    fn update_thread_metadata(
        &self,
        params: UpdateThreadMetadataParams,
    ) -> ThreadStoreFuture<'_, Option<StoredThread>> {
        ThreadStore::update_thread_metadata(&self.inner, params)
    }

    fn move_thread_to_section(
        &self,
        params: MoveThreadToSectionParams,
    ) -> ThreadStoreFuture<'_, ()> {
        ThreadStore::move_thread_to_section(&self.inner, params)
    }

    fn archive_thread(&self, params: ArchiveThreadParams) -> ThreadStoreFuture<'_, ()> {
        ThreadStore::archive_thread(&self.inner, params)
    }

    fn archive_threads(
        &self,
        params: ArchiveThreadsParams,
    ) -> ThreadStoreFuture<'_, Vec<ThreadId>> {
        ThreadStore::archive_threads(&self.inner, params)
    }

    fn unarchive_thread(&self, params: ArchiveThreadParams) -> ThreadStoreFuture<'_, StoredThread> {
        ThreadStore::unarchive_thread(&self.inner, params)
    }

    fn delete_thread(&self, params: DeleteThreadParams) -> ThreadStoreFuture<'_, ()> {
        Box::pin(async move {
            let id = params.thread_id;
            let mut writers = self.writers.lock().await;
            ThreadStore::delete_thread(&self.inner, params).await?;
            writers.remove(&id);
            Ok(())
        })
    }

    fn delete_threads(&self, params: DeleteThreadsParams) -> ThreadStoreFuture<'_, ()> {
        Box::pin(async move {
            let ids = params.thread_ids.clone();
            let mut writers = self.writers.lock().await;
            ThreadStore::delete_threads(&self.inner, params).await?;
            for id in ids {
                writers.remove(&id);
            }
            Ok(())
        })
    }
}

#[cfg(test)]
#[path = "local_descendant_admission_tests.rs"]
mod local_descendant_admission_tests;

#[cfg(test)]
#[path = "resume_admission_tests.rs"]
mod resume_admission_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use codex_core_api::{AbsolutePathBuf, SqliteConfig};
    use codex_protocol::{
        models::BaseInstructions,
        protocol::{SessionSource, ThreadMemoryMode},
    };
    use serde_json::{Value, json};

    pub(super) async fn store(home: &std::path::Path) -> LocalChecklistStore {
        let config = LocalThreadStoreConfig {
            codex_home: home.into(),
            sqlite: SqliteConfig::from_sqlite_home(
                AbsolutePathBuf::try_from(home.to_path_buf()).unwrap(),
            ),
            default_model_provider_id: "local-fixture".into(),
        };
        let state = codex_state::StateRuntime::init(config.sqlite.clone(), "local-fixture".into())
            .await
            .unwrap();
        LocalChecklistStore::new(
            LocalThreadStore::new(config, Some(state.clone())),
            state,
            home.to_path_buf(),
        )
    }
    fn metadata(home: &std::path::Path) -> ThreadPersistenceMetadata {
        ThreadPersistenceMetadata {
            cwd: Some(home.into()),
            model_provider: "local-fixture".into(),
            memory_mode: ThreadMemoryMode::Disabled,
        }
    }
    pub(super) fn create_params(id: ThreadId, home: &std::path::Path) -> CreateThreadParams {
        CreateThreadParams {
            creator_user_id: None,
            creator_account_id: None,
            session_id: id.into(),
            thread_id: id,
            extra_config: None,
            forked_from_id: None,
            parent_thread_id: None,
            source: SessionSource::Exec,
            thread_source: None,
            originator: "local-fixture".into(),
            base_instructions: BaseInstructions::default(),
            dynamic_tools: vec![],
            selected_capability_roots: vec![],
            multi_agent_version: None,
            history_mode: ThreadHistoryMode::Legacy,
            history_base: None,
            subagent_history_start_ordinal: None,
            initial_window_id: id.to_string(),
            runtime_workspace_roots: None,
            metadata: metadata(home),
        }
    }
    async fn create(store: &LocalChecklistStore, id: ThreadId, home: &std::path::Path) {
        store.create_thread(create_params(id, home)).await.unwrap();
        store
            .persist_thread(id, PersistContext::Standard)
            .await
            .unwrap();
    }
    pub(super) fn resume(id: ThreadId, home: &std::path::Path) -> ResumeThreadParams {
        ResumeThreadParams {
            thread_id: id,
            rollout_path: None,
            history: None,
            history_revision: None,
            include_archived: true,
            metadata: metadata(home),
        }
    }
    fn key(id: ThreadId, call: &str) -> crate::python_tools::PendingKey {
        crate::python_tools::PendingKey {
            reply: crate::python_tools::ReplyKey {
                thread: id.to_string(),
                generation: 0,
                slot: 0,
                instance: None,
                manual_grant: None,
            },
            turn: "original-turn".into(),
            call: call.into(),
        }
    }
    fn turn() -> RolloutItem {
        RolloutItem::EventMsg(serde_json::from_value(json!({"type":"task_started","turn_id":"original-turn","root_turn_id":"original-turn"})).unwrap())
    }
    fn call(id: &str) -> RolloutItem {
        RolloutItem::ResponseItem(ResponseItemEnvelope::new(
            serde_json::from_value(
                json!({"type":"function_call","name":"managed","call_id":id,"arguments":"{}"}),
            )
            .unwrap(),
        ))
    }
    fn receipt(key: &crate::python_tools::PendingKey) -> ResponseItem {
        crate::python_tools::PythonOutput(serde_json::from_value(json!({"contentItems":[{"type":"inputText","text":"actual durable output"}],"success":true})).unwrap()).receipt(key)
    }
    async fn append(store: &LocalChecklistStore, id: ThreadId, items: Vec<RolloutItem>) {
        store
            .append_items(AppendThreadItemsParams {
                thread_id: id,
                items,
            })
            .await
            .unwrap();
    }
    fn outputs(history: &[RolloutItem]) -> Vec<Value> {
        history
            .iter()
            .filter_map(|row| match row {
                RolloutItem::ResponseItem(envelope)
                    if matches!(envelope.item, ResponseItem::FunctionCallOutput { .. }) =>
                {
                    Some(serde_json::to_value(&envelope.item).unwrap())
                }
                _ => None,
            })
            .collect()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn native_local_writer_excludes_competitors_until_joined_release() {
        let home = tempfile::tempdir().unwrap();
        let first = store(home.path()).await;
        let second = store(home.path()).await;
        let id = ThreadId::new();
        create(&first, id, home.path()).await;
        assert!(first.as_any().is::<LocalThreadStore>());
        assert!(second.resume_thread(resume(id, home.path())).await.is_err());
        first.shutdown_thread(id).await.unwrap();
        second.resume_thread(resume(id, home.path())).await.unwrap();
        second.shutdown_thread(id).await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn native_local_early_receipt_survives_parked_sibling_and_deduplicates_drain() {
        let home = tempfile::tempdir().unwrap();
        let owner = store(home.path()).await;
        let id = ThreadId::new();
        create(&owner, id, home.path()).await;
        append(&owner, id, vec![turn(), call("parked"), call("done")]).await;
        let done = key(id, "done");
        owner
            .register_call(id, &done.turn, &done.call)
            .await
            .unwrap();
        owner.register_call(id, &done.turn, "parked").await.unwrap();
        let actual = receipt(&done);
        let mut wrong = done.clone();
        wrong.turn = "foreign-turn".into();
        assert!(
            owner
                .commit_sdk_receipt(id, &wrong, receipt(&wrong))
                .await
                .is_err()
        );
        owner
            .commit_sdk_receipt(id, &done, actual.clone())
            .await
            .unwrap();
        assert_eq!(
            outputs(&owner.load_owned_history(id).await.unwrap()),
            vec![serde_json::to_value(&actual).unwrap()]
        );
        assert!(
            owner
                .commit_sdk_receipt(id, &done, actual.clone())
                .await
                .is_err()
        );
        append(
            &owner,
            id,
            vec![RolloutItem::ResponseItem(ResponseItemEnvelope::new(
                actual.clone(),
            ))],
        )
        .await;
        assert_eq!(
            outputs(&owner.load_owned_history(id).await.unwrap()).len(),
            1
        );
        // A synthetic output from closing the parked callback cannot become a
        // receipt or erase the unknown external effect.
        append(
            &owner,
            id,
            vec![RolloutItem::ResponseItem(ResponseItemEnvelope::new(
                receipt(&key(id, "parked")),
            ))],
        )
        .await;
        owner.shutdown_thread(id).await.unwrap();
        let next = store(home.path()).await;
        let error = next
            .resume_thread(resume(id, home.path()))
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("unknown tool effects"),
            "{error}"
        );
        // Failed admission released the native writer.
        let raw = next
            .inner
            .resume_thread(resume(id, home.path()))
            .await
            .unwrap();
        assert_eq!(outputs(&raw).len(), 1);
        next.inner.shutdown_thread(id).await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn native_local_flush_failure_sticks_through_reads_and_close_but_releases_writer() {
        let home = tempfile::tempdir().unwrap();
        let owner = store(home.path()).await;
        let id = ThreadId::new();
        create(&owner, id, home.path()).await;
        append(&owner, id, vec![turn(), call("effect")]).await;
        let key = key(id, "effect");
        owner.register_call(id, &key.turn, &key.call).await.unwrap();
        owner
            .fail_receipt_flush
            .store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(
            owner
                .commit_sdk_receipt(id, &key, receipt(&key))
                .await
                .unwrap_err()
                .to_string()
                .contains("injected")
        );
        assert!(owner.load_owned_history(id).await.is_err());
        assert!(owner.flush_thread(id).await.is_err());
        assert!(owner.shutdown_thread(id).await.is_err());
        assert!(owner.check_failure(Some(id)).await.is_err());
        let other = store(home.path()).await;
        other
            .inner
            .resume_thread(resume(id, home.path()))
            .await
            .unwrap();
        other.inner.shutdown_thread(id).await.unwrap();
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn native_local_reopen_rechecks_model_and_rejects_saved_descendants() {
        let home = tempfile::tempdir().unwrap();
        let owner = store(home.path()).await;
        let id = ThreadId::new();
        create(&owner, id, home.path()).await;
        owner.shutdown_thread(id).await.unwrap();
        let history = Arc::new(
            owner
                .load_history(LoadThreadHistoryParams {
                    thread_id: id,
                    include_archived: true,
                })
                .await
                .unwrap()
                .items,
        );
        let _admission = owner
            .admit_resume(
                id,
                Some("stale-admitted-model".into()),
                history.clone(),
                Arc::new(crate::options::ThreadInstructions::for_test(None, false)),
            )
            .unwrap();
        let mut params = resume(id, home.path());
        params.history = Some(history);
        let error = owner.resume_thread(params).await.unwrap_err();
        assert!(error.to_string().contains("model changed"), "{error}");
        // Model rejection did not retain the OS writer.
        owner
            .inner
            .resume_thread(resume(id, home.path()))
            .await
            .unwrap();
        owner.inner.shutdown_thread(id).await.unwrap();
        let child = ThreadId::new();
        create(&owner, child, home.path()).await;
        owner.shutdown_thread(child).await.unwrap();
        owner
            .graph
            .upsert_thread_spawn_edge(
                id,
                child,
                codex_agent_graph_store::ThreadSpawnEdgeStatus::Closed,
            )
            .await
            .unwrap();
        let error = owner
            .resume_thread(resume(id, home.path()))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("descendant-bearing"), "{error}");
        owner
            .inner
            .resume_thread(resume(id, home.path()))
            .await
            .unwrap();
        owner.inner.shutdown_thread(id).await.unwrap();
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn native_local_bad_creation_header_joins_cleanup_and_releases_writer() {
        for fault in ["missing", "timestamp", "identity"] {
            let profile = tempfile::tempdir().unwrap();
            let work = tempfile::tempdir().unwrap();
            let config = json!({"model":"gpt-5.1-codex", "model_provider":"local-fixture",
                "model_providers.local-fixture":{"name":"Header fixture","base_url":"http://127.0.0.1:9/v1",
                    "wire_api":"responses","requires_openai_auth":false,"supports_websockets":false},
                "agents.enabled":false,"tools.update_plan.enabled":false,"features.code_mode":false,"features.goals":false,
                "features.shell_snapshot":false,"features.apps":false,"features.plugins":false,"features.tool_registry.error_on_tool_collisions":true,"analytics.enabled":false,"web_search":"disabled"});
            let runtime = json!({"codex_home":work.path(),"cwd":work.path(),"native_thread_store":profile.path()});
            let engine = crate::create_engine(config.to_string(), runtime.to_string(), None, None)
                .await
                .unwrap();
            let selected = engine.current().unwrap();
            let local = selected.local_checklist_store.as_ref().unwrap().clone();
            let failed_id = Arc::new(std::sync::Mutex::new(None));
            let observed = failed_id.clone();
            *local.creation_header_hook.lock().unwrap() = Some(Box::new(move |id, path| {
                *observed.lock().unwrap() = Some(id);
                let raw = std::fs::read_to_string(path).unwrap();
                let mut rows: Vec<Value> = raw
                    .lines()
                    .map(|line| serde_json::from_str(line).unwrap())
                    .collect();
                match fault {
                    "missing" => {
                        rows.remove(0);
                    }
                    "timestamp" => rows[0]["payload"]["timestamp"] = json!("not-a-timestamp"),
                    "identity" => rows[0]["payload"]["id"] = json!(ThreadId::new()),
                    _ => unreachable!(),
                }
                std::fs::write(
                    path,
                    rows.iter()
                        .map(|row| format!("{row}\n"))
                        .collect::<String>(),
                )
                .unwrap();
            }));
            let failure = engine
                .start_replaceable_thread(
                    "{\"tool_policy\":{\"allowed_tools\":[]}}".into(),
                    "[]".into(),
                )
                .await
                .err()
                .expect("invalid native header must fail opening");
            assert!(!failure.reason.is_empty());
            let id = failed_id
                .lock()
                .unwrap()
                .expect("actual native writer reached the header read");
            assert!(selected.manager.get_thread(id).await.is_err());
            assert!(!local.writers.lock().await.contains_key(&id));
            assert!(
                !selected
                    .restored_creation_times
                    .lock()
                    .await
                    .contains_key(&id)
            );
            // A fresh native store can acquire the failed identity's OS writer.
            let probe = store(profile.path()).await;
            probe
                .inner
                .create_thread(create_params(id, work.path()))
                .await
                .unwrap();
            probe.inner.shutdown_thread(id).await.unwrap();
            drop(selected);
            engine.close().await.unwrap();
        }
    }
    fn checklist_turn(name: &str) -> RolloutItem {
        RolloutItem::EventMsg(
            serde_json::from_value(
                json!({"type":"task_started","turn_id":name,"root_turn_id":name}),
            )
            .unwrap(),
        )
    }
    fn checklist_update(step: Option<&str>) -> RolloutItem {
        RolloutItem::EventMsg(serde_json::from_value(json!({"type":"plan_update","explanation":"","plan":step.map(|step| vec![json!({"step":step,"status":"pending"})]).unwrap_or_default()})).unwrap())
    }
    fn checklist_complete(name: &str) -> RolloutItem {
        RolloutItem::EventMsg(
            serde_json::from_value(
                json!({"type":"task_complete","turn_id":name,"last_agent_message":null}),
            )
            .unwrap(),
        )
    }
    fn checklist_batch(turn: &str, step: Option<&str>) -> Vec<RolloutItem> {
        vec![
            checklist_turn(turn),
            checklist_update(step),
            checklist_complete(turn),
        ]
    }
    fn checklist_file(store: &LocalChecklistStore, id: ThreadId) -> PathBuf {
        store.checklist_directory.join(format!("{id}.json"))
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn checklist_persists_whole_list_empty_state_and_native_turn_across_new_store() {
        let home = tempfile::tempdir().unwrap();
        let owner = store(home.path()).await;
        let id = ThreadId::new();
        create(&owner, id, home.path()).await;
        assert!(owner.checklist(id).await.unwrap().is_none());
        append(&owner, id, checklist_batch("first", Some("first list"))).await;
        let before = owner.checklist(id).await.unwrap().unwrap();
        assert_eq!(before.turn_id, "first");
        assert_eq!(before.plan[0].step, "first list");
        append(&owner, id, checklist_batch("second", None)).await;
        let empty = owner.checklist(id).await.unwrap().unwrap();
        assert_eq!(empty.turn_id, "second");
        assert!(empty.plan.is_empty());
        assert_eq!(empty.explanation.as_deref(), Some(""));
        owner.shutdown_thread(id).await.unwrap();
        drop(owner);
        let next = store(home.path()).await;
        next.resume_thread(resume(id, home.path())).await.unwrap();
        assert_eq!(
            serde_json::to_value(next.checklist(id).await.unwrap()).unwrap(),
            serde_json::to_value(Some(empty)).unwrap()
        );
        next.shutdown_thread(id).await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn checklist_errors_are_not_absence_or_foreign_turn_data() {
        let home = tempfile::tempdir().unwrap();
        let owner = store(home.path()).await;
        let id = ThreadId::new();
        create(&owner, id, home.path()).await;
        assert!(owner.checklist(ThreadId::new()).await.is_err());
        append(&owner, id, checklist_batch("owned", Some("saved"))).await;
        let path = checklist_file(&owner, id);
        let good = std::fs::read(&path).unwrap();
        for change in [
            json!({"thread_id":id,"turn_id":"foreign","explanation":null,"plan":[]}),
            json!({"thread_id":ThreadId::new(),"turn_id":"owned","explanation":null,"plan":[]}),
            json!({"thread_id":id,"turn_id":"owned","explanation":null,"plan":[{"step":"saved","status":"done"}]}),
        ] {
            std::fs::write(&path, serde_json::to_vec(&change).unwrap()).unwrap();
            assert!(owner.checklist(id).await.is_err());
        }
        std::fs::write(&path, b"{").unwrap();
        assert!(owner.checklist(id).await.is_err());
        std::fs::write(&path, good).unwrap();
        owner.shutdown_thread(id).await.unwrap();
        assert!(owner.checklist(id).await.is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rejected_native_append_never_replaces_the_durable_checklist() {
        let home = tempfile::tempdir().unwrap();
        let owner = store(home.path()).await;
        let id = ThreadId::new();
        create(&owner, id, home.path()).await;
        append(&owner, id, checklist_batch("old", Some("kept"))).await;
        let path = checklist_file(&owner, id);
        let saved = std::fs::read(&path).unwrap();
        owner.inner.shutdown_thread(id).await.unwrap();
        assert!(
            owner
                .append_items(AppendThreadItemsParams {
                    thread_id: id,
                    items: checklist_batch("new", Some("rejected"))
                })
                .await
                .is_err()
        );
        assert_eq!(std::fs::read(path).unwrap(), saved);
        assert!(owner.checklist(id).await.is_err());
        assert!(
            owner
                .persist_thread(id, PersistContext::Standard)
                .await
                .is_err()
        );
        assert!(owner.flush_thread(id).await.is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn atomic_replace_failure_poison_is_visible_to_read_flush_and_shutdown() {
        let home = tempfile::tempdir().unwrap();
        let owner = store(home.path()).await;
        let id = ThreadId::new();
        create(&owner, id, home.path()).await;
        std::fs::create_dir_all(checklist_file(&owner, id)).unwrap();
        assert!(
            owner
                .append_items(AppendThreadItemsParams {
                    thread_id: id,
                    items: checklist_batch("turn", Some("cannot persist"))
                })
                .await
                .is_err()
        );
        assert!(owner.checklist(id).await.is_err());
        assert!(owner.flush_thread(id).await.is_err());
        assert!(owner.shutdown_thread(id).await.is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn checklist_snapshot_serializes_history_and_sidecar_against_a_new_turn() {
        tokio::time::timeout(std::time::Duration::from_secs(15),async {
            let home = tempfile::tempdir().unwrap(); let owner = Arc::new(store(home.path()).await);
            let id = ThreadId::new(); create(&owner,id,home.path()).await;
            append(&owner,id,checklist_batch("old",Some("old"))).await;
            let entered=Arc::new(tokio::sync::Semaphore::new(0)); let signal=entered.clone();
            let (release,held)=std::sync::mpsc::channel();
            *owner.checklist_read_hook.lock().unwrap()=Some(Box::new(move ||{signal.add_permits(1);held.recv().unwrap();}));
            let reader=owner.clone(); let read=tokio::spawn(async move{reader.checklist(id).await});
            entered.acquire().await.unwrap().forget();
            let write=owner.append_items(AppendThreadItemsParams{thread_id:id,items:checklist_batch("new",Some("new"))});
            tokio::pin!(write);
            tokio::select!{biased; result=&mut write=>panic!("append escaped snapshot lock: {result:?}"), _=tokio::task::yield_now()=>{}}
            release.send(()).unwrap(); assert_eq!(read.await.unwrap().unwrap().unwrap().turn_id,"old");
            write.await.unwrap(); assert_eq!(owner.checklist(id).await.unwrap().unwrap().turn_id,"new");
            owner.shutdown_thread(id).await.unwrap();
        }).await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelled_read_cannot_publish_or_mutate_after_writer_shutdown() {
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            let home = tempfile::tempdir().unwrap();
            let owner = Arc::new(store(home.path()).await);
            let id = ThreadId::new();
            create(&owner, id, home.path()).await;
            append(&owner, id, checklist_batch("saved", Some("saved"))).await;
            let before = std::fs::read(checklist_file(&owner, id)).unwrap();
            let entered = Arc::new(tokio::sync::Semaphore::new(0));
            let signal = entered.clone();
            let (release, held) = std::sync::mpsc::channel();
            *owner.checklist_read_hook.lock().unwrap() = Some(Box::new(move || {
                signal.add_permits(1);
                held.recv().unwrap();
            }));
            let (finished, joined) = tokio::sync::oneshot::channel();
            *owner.checklist_read_complete.lock().unwrap() = Some(finished);
            let reader = owner.clone();
            let read = tokio::spawn(async move { reader.checklist(id).await });
            entered.acquire().await.unwrap().forget();
            read.abort();
            let Err(cancelled) = read.await else {
                panic!("cancelled read published a result");
            };
            assert!(cancelled.is_cancelled());
            owner.shutdown_thread(id).await.unwrap();
            release.send(()).unwrap();
            joined
                .await
                .expect("blocking read must finish before observation");
            assert_eq!(std::fs::read(checklist_file(&owner, id)).unwrap(), before);
            assert!(owner.checklist(id).await.is_err());
        })
        .await
        .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelled_blocking_commit_keeps_writer_until_complete() {
        tokio::time::timeout(std::time::Duration::from_secs(15),async {
            let home=tempfile::tempdir().unwrap(); let owner=Arc::new(store(home.path()).await);
            let id=ThreadId::new(); create(&owner,id,home.path()).await;
            append(&owner,id,checklist_batch("old",Some("old"))).await;
            let entered=Arc::new(tokio::sync::Semaphore::new(0)); let signal=entered.clone(); let (release,held)=std::sync::mpsc::channel();
            *owner.checklist_write_hook.lock().unwrap()=Some(Box::new(move ||{signal.add_permits(1);held.recv().unwrap();}));
            let writer=owner.clone(); let write=tokio::spawn(async move{writer.append_items(AppendThreadItemsParams{thread_id:id,items:checklist_batch("new",Some("new"))}).await});
            entered.acquire().await.unwrap().forget(); write.abort();
            let close=owner.shutdown_thread(id); tokio::pin!(close);
            tokio::select!{biased; result=&mut close=>panic!("shutdown escaped commit: {result:?}"), _=tokio::task::yield_now()=>{}}
            release.send(()).unwrap(); let _=write.await; close.await.unwrap();
            let saved:ChecklistState=serde_json::from_slice(&std::fs::read(checklist_file(&owner,id)).unwrap()).unwrap();
            assert_eq!(saved.turn_id,"new");
        }).await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn append_first_snapshot_waits_for_commit_without_recursive_history_lock() {
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            let home = tempfile::tempdir().unwrap();
            let owner = Arc::new(store(home.path()).await);
            let id = ThreadId::new();
            create(&owner, id, home.path()).await;
            append(&owner, id, checklist_batch("old", Some("old"))).await;
            let entered = Arc::new(tokio::sync::Semaphore::new(0));
            let signal = entered.clone();
            let (release, held) = std::sync::mpsc::channel();
            *owner.checklist_write_hook.lock().unwrap() = Some(Box::new(move || {
                signal.add_permits(1);
                held.recv().unwrap();
            }));
            let writer = owner.clone();
            let write = tokio::spawn(async move {
                writer
                    .append_items(AppendThreadItemsParams {
                        thread_id: id,
                        items: checklist_batch("new", Some("new")),
                    })
                    .await
            });
            entered.acquire().await.unwrap().forget();
            let read = owner.checklist(id);
            let history = owner.load_owned_history(id);
            tokio::pin!(read, history);
            tokio::select! { biased;
                _ = &mut read => panic!("read escaped pending commit"),
                _ = &mut history => panic!("history escaped pending commit"),
                _ = tokio::task::yield_now() => {}
            }
            release.send(()).unwrap();
            write.await.unwrap().unwrap();
            let (list, history) = tokio::join!(read, history);
            let list = list.unwrap().unwrap();
            assert_eq!(list.turn_id, "new");
            list.validate(id, &history.unwrap()).unwrap();
            owner.shutdown_thread(id).await.unwrap();
        })
        .await
        .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn native_delete_owns_checklist_cleanup_and_failure_retry() {
        let home = tempfile::tempdir().unwrap();
        let owner = store(home.path()).await;
        let id = ThreadId::new();
        create(&owner, id, home.path()).await;
        append(&owner, id, checklist_batch("saved", Some("saved"))).await;
        owner.shutdown_thread(id).await.unwrap();
        let path = checklist_file(&owner, id);
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(
            owner
                .delete_thread(DeleteThreadParams { thread_id: id })
                .await
                .is_err()
        );
        std::fs::remove_dir(&path).unwrap();
        owner
            .delete_thread(DeleteThreadParams { thread_id: id })
            .await
            .unwrap();
        assert!(!path.exists());
        let other = ThreadId::new();
        create(&owner, other, home.path()).await;
        append(&owner, other, checklist_batch("other", None)).await;
        owner.shutdown_thread(other).await.unwrap();
        owner
            .delete_threads(DeleteThreadsParams {
                thread_ids: vec![other],
            })
            .await
            .unwrap();
        assert!(!checklist_file(&owner, other).exists());
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn checklist_commit_boundaries_latch_failure_without_false_rollback_claims() {
        for stage in 1..=5 {
            let home = tempfile::tempdir().unwrap();
            let owner = store(home.path()).await;
            let id = ThreadId::new();
            create(&owner, id, home.path()).await;
            append(&owner, id, checklist_batch("old", Some("old"))).await;
            let before = std::fs::read(checklist_file(&owner, id)).unwrap();
            owner
                .checklist_failure_stage
                .store(stage, std::sync::atomic::Ordering::Release);
            let error = owner
                .append_items(AppendThreadItemsParams {
                    thread_id: id,
                    items: checklist_batch("new", Some("new")),
                })
                .await
                .unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("injected checklist persistence stage")
            );
            if stage < 5 {
                assert_eq!(std::fs::read(checklist_file(&owner, id)).unwrap(), before);
            } else {
                let value: ChecklistState =
                    serde_json::from_slice(&std::fs::read(checklist_file(&owner, id)).unwrap())
                        .unwrap();
                assert_eq!(value.turn_id, "new");
            }
            assert!(owner.checklist(id).await.is_err());
            assert!(owner.flush_thread(id).await.is_err());
            assert!(owner.shutdown_thread(id).await.is_err());
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn final_whole_list_survives_multiple_updates_and_aborted_turn_in_one_batch() {
        let home = tempfile::tempdir().unwrap();
        let owner = store(home.path()).await;
        let id = ThreadId::new();
        create(&owner, id, home.path()).await;
        let aborted = RolloutItem::EventMsg(
            serde_json::from_value(json!({
                "type": "turn_aborted", "turn_id": "aborted", "reason": "interrupted"
            }))
            .unwrap(),
        );
        append(
            &owner,
            id,
            vec![
                checklist_turn("aborted"),
                checklist_update(Some("obsolete")),
                checklist_update(Some("last accepted")),
                aborted,
            ],
        )
        .await;
        let accepted = owner.checklist(id).await.unwrap().unwrap();
        assert_eq!(accepted.turn_id, "aborted");
        assert_eq!(accepted.plan.len(), 1);
        assert_eq!(accepted.plan[0].step, "last accepted");
        owner.shutdown_thread(id).await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn native_history_reference_blocks_cleanup_and_unrelated_root_survives() {
        let home = tempfile::tempdir().unwrap();
        let owner = store(home.path()).await;
        let id = ThreadId::new();
        let other = ThreadId::new();
        let mut source = create_params(id, home.path());
        source.history_mode = ThreadHistoryMode::Paginated;
        owner.create_thread(source).await.unwrap();
        owner
            .persist_thread(id, PersistContext::Standard)
            .await
            .unwrap();
        create(&owner, other, home.path()).await;
        append(&owner, id, checklist_batch("owned", Some("owned"))).await;
        append(&owner, other, checklist_batch("other", Some("other"))).await;
        owner.shutdown_thread(id).await.unwrap();
        // Test the existing native reference boundary without exposing public fork.
        let prepared = owner
            .inner
            .prepare_fork(PrepareForkParams {
                thread_id: id,
                boundary: ForkBoundary::Latest,
            })
            .await
            .unwrap();
        let reference = ThreadId::new();
        let mut child = create_params(reference, home.path());
        child.history_mode = ThreadHistoryMode::Paginated;
        child.forked_from_id = Some(id);
        child.history_base = prepared.history_base.clone();
        assert!(child.history_base.is_some());
        owner.inner.create_thread(child).await.unwrap();
        owner
            .inner
            .persist_thread(reference, PersistContext::Standard)
            .await
            .unwrap();
        drop(prepared);
        owner.inner.shutdown_thread(reference).await.unwrap();
        let error = owner
            .delete_thread(DeleteThreadParams { thread_id: id })
            .await
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("forked history still references it")
        );
        assert!(checklist_file(&owner, id).exists());
        owner
            .inner
            .delete_thread(DeleteThreadParams {
                thread_id: reference,
            })
            .await
            .unwrap();
        owner
            .delete_thread(DeleteThreadParams { thread_id: id })
            .await
            .unwrap();
        assert!(!checklist_file(&owner, id).exists());
        assert_eq!(
            owner.checklist(other).await.unwrap().unwrap().turn_id,
            "other"
        );
        owner.shutdown_thread(other).await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn held_checklist_commit_excludes_a_process_until_joined_shutdown() {
        const HOME: &str = "SDK_LOCAL_CHECKLIST_PROBE_HOME";
        const ID: &str = "SDK_LOCAL_CHECKLIST_PROBE_ID";
        const EXPECT: &str = "SDK_LOCAL_CHECKLIST_PROBE_EXPECT";
        if let Some(home) = std::env::var_os(HOME) {
            let home = PathBuf::from(home);
            let owner = store(&home).await;
            let id = ThreadId::from_string(&std::env::var(ID).unwrap()).unwrap();
            let acquired = owner.inner.resume_thread(resume(id, &home)).await;
            if std::env::var(EXPECT).unwrap() == "blocked" {
                assert!(
                    acquired.is_err(),
                    "second process acquired a live native writer"
                );
            } else {
                acquired.unwrap();
                owner.inner.shutdown_thread(id).await.unwrap();
            }
            return;
        }
        async fn probe(home: PathBuf, id: ThreadId, expected: &'static str) {
            tokio::task::spawn_blocking(move || {
                let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "local_storage::tests::held_checklist_commit_excludes_a_process_until_joined_shutdown", "--nocapture"])
                    .env(HOME, home).env(ID, id.to_string()).env(EXPECT, expected)
                    .env_remove("OPENAI_API_KEY")
                    .spawn().unwrap();
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
                loop {
                    if let Some(status) = child.try_wait().unwrap() {
                        assert!(status.success(), "native writer child failed: {status}");
                        break;
                    }
                    if std::time::Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        panic!("native writer child did not settle");
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            }).await.unwrap();
        }
        tokio::time::timeout(std::time::Duration::from_secs(30), async {
            let home = tempfile::tempdir().unwrap();
            let owner = Arc::new(store(home.path()).await);
            let id = ThreadId::new();
            create(&owner, id, home.path()).await;
            append(&owner, id, checklist_batch("old", Some("old"))).await;
            let entered = Arc::new(tokio::sync::Semaphore::new(0));
            let signal = entered.clone();
            let (release, held) = std::sync::mpsc::channel();
            *owner.checklist_write_hook.lock().unwrap() = Some(Box::new(move || {
                signal.add_permits(1);
                held.recv().unwrap();
            }));
            let writer = owner.clone();
            let write = tokio::spawn(async move {
                writer
                    .append_items(AppendThreadItemsParams {
                        thread_id: id,
                        items: checklist_batch("new", Some("new")),
                    })
                    .await
            });
            entered.acquire().await.unwrap().forget();
            probe(home.path().to_path_buf(), id, "blocked").await;
            release.send(()).unwrap();
            write.await.unwrap().unwrap();
            owner.shutdown_thread(id).await.unwrap();
            probe(home.path().to_path_buf(), id, "acquired").await;
        })
        .await
        .unwrap();
    }
}

// Instrumentation only: all fields, holds and observations disappear outside tests.
#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
enum StartupClosePoint {
    BeforePreparedAcquire,
    PreparedNativeWriter,
    RegisteredResume,
    BeforeDatabaseClose,
    ObserveOnly,
    DiscardNativeJoined,
}

#[cfg(test)]
struct StartupCloseProbe {
    thread: Option<ThreadId>,
    point: StartupClosePoint,
    armed: std::sync::atomic::AtomicBool,
    entered: tokio::sync::Semaphore,
    release: tokio::sync::Semaphore,
    completed: tokio::sync::Semaphore,
    native_creates: std::sync::atomic::AtomicUsize,
}

#[cfg(test)]
impl StartupCloseProbe {
    fn new(thread: Option<ThreadId>, point: StartupClosePoint) -> Arc<Self> {
        Arc::new(Self {
            thread,
            point,
            armed: std::sync::atomic::AtomicBool::new(true),
            entered: tokio::sync::Semaphore::new(0),
            release: tokio::sync::Semaphore::new(0),
            completed: tokio::sync::Semaphore::new(0),
            native_creates: std::sync::atomic::AtomicUsize::new(0),
        })
    }

    async fn hold(&self, point: StartupClosePoint) {
        if self.point == point && self.armed.swap(false, Ordering::SeqCst) {
            self.entered.add_permits(1);
            self.release.acquire().await.unwrap().forget();
        }
    }
}

#[cfg(test)]
impl LocalChecklistStore {
    fn startup_close_probe_for(&self, thread: Option<ThreadId>) -> Option<Arc<StartupCloseProbe>> {
        self.startup_close_probe
            .lock()
            .unwrap()
            .as_ref()
            .filter(|probe| probe.thread.is_none() || probe.thread == thread)
            .cloned()
    }

    async fn hold_startup_close_probe(&self, thread: Option<ThreadId>, point: StartupClosePoint) {
        // Copy the handle and release the configuration mutex before any await.
        if let Some(probe) = self.startup_close_probe_for(thread) {
            probe.hold(point).await;
        }
    }
}

#[cfg(test)]
#[path = "unpublished_startup_close_tests.rs"]
mod unpublished_startup_close_tests;

#[cfg(test)]
#[path = "local_compaction_tests.rs"]
mod local_compaction_tests;

#[cfg(test)]
#[path = "local_writer_cleanup_tests.rs"]
mod local_writer_cleanup_tests;
