//! Track exact native turn admission and bounded retries after raw terminal delivery.
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use codex_core::context::{
    ContextualUserFragment, InternalContextSource, InternalModelContextFragment,
};
use codex_core_api::{CodexThread, Config, ManagedLocalExecCancelFailure, WithTurnExtensionData};
use codex_extension_api::{
    ExtensionData, ExtensionDataInit, ExtensionFuture, ThreadIdleCause, ThreadIdleInput,
    ThreadLifecycleContributor, ThreadStopInput, TurnAbortInput, TurnErrorInput,
    TurnLifecycleContributor, TurnSamplingStop, TurnStartInput, TurnStopInput,
};
use codex_protocol::items::TurnItem;
use codex_protocol::protocol::{EventMsg, Op};
use codex_protocol::turn_input::{
    NotSubmittedReason, StartIfIdleSubmission, TurnInput, TurnInputRequest, TurnInputSubmission,
    TurnStartOptions,
};
use tokio::sync::{MutexGuard, oneshot, watch};
use tokio::time::{Instant, timeout_at};

// This bounds settlement waits, not provider work or an accepted native start.
const SETTLEMENT_GRACE: Duration = Duration::from_secs(1);
const LOCAL_COMMAND_CLEANUP_FAILED: &str = "Native local command cleanup could not confirm exit";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Admission {
    Pending,
    Ready,
    Closed,
}

pub(crate) struct Turn {
    id: String,
    accepted: AtomicBool,
    delivered: AtomicBool,
    successful: AtomicBool,
    rejected: AtomicBool,
    managed_response: bool,
    admission: watch::Sender<Admission>,
    steering: Option<Steering>,
    graceful: AtomicBool,
    sampling_stop: TurnSamplingStop,
    input_recorded: AtomicBool,
    terminal: AtomicBool,
    local_exec_cancel_failed: AtomicBool,
    born_fenced: bool,
    same_id_recovery: bool,
    provider_error: Mutex<
        Option<(
            codex_protocol::protocol::CodexErrorInfo,
            crate::provider_error::Receipt,
        )>,
    >,
}

#[derive(Default)]
struct Steering {
    // Only an outstanding ID issued by the exact-ID Session route can credit
    // this turn. UserMessage IDs become public and cannot remain reusable.
    issued: Mutex<HashSet<String>>,
    tail: AtomicBool,
}

impl Turn {
    fn capture_provider_error(
        &self,
        category: codex_protocol::protocol::CodexErrorInfo,
        error: &codex_protocol::error::CodexErr,
    ) {
        // Every error replaces the snapshot, including non-provider failures.
        *self
            .provider_error
            .lock()
            .expect("provider error receipt poisoned") =
            Some((category, crate::provider_error::Receipt::capture(error)));
    }

    pub(crate) fn error_json(
        &self,
        error: &codex_protocol::protocol::ErrorEvent,
    ) -> serde_json::Value {
        let mut value = serde_json::to_value(error).expect("serializable native error");
        if let Some((category, metadata)) = self
            .provider_error
            .lock()
            .expect("provider error receipt poisoned")
            .as_ref()
            && error.codex_error_info.as_ref() == Some(category)
        {
            value["_sdk_provider_error"] = metadata.to_json();
        }
        value
    }

    pub(crate) fn attach_provider_error(&self, event: &mut serde_json::Value) {
        // Root terminal acquisition retains the current receipt by stable ID.
        // A queued terminal cannot prove it belongs to a same-ID replacement.
        if self.same_id_recovery
            || event["id"].as_str() != Some(self.id.as_str())
            || !matches!(
                event["msg"]["type"].as_str(),
                Some("task_complete" | "turn_complete")
            )
        {
            return;
        }
        let Some(error) = event["msg"]["error"].as_object_mut() else {
            return;
        };
        if let Some((category, metadata)) = self
            .provider_error
            .lock()
            .expect("provider error receipt poisoned")
            .as_ref()
            && error.get("codex_error_info")
                == Some(&serde_json::to_value(category).expect("serializable native category"))
        {
            error.insert("_sdk_provider_error".into(), metadata.to_json());
        }
    }

    pub(crate) fn confirm_admission(&self) {
        self.accepted.store(true, Ordering::Release);
    }

    pub(crate) fn request_graceful(&self) {
        self.graceful.store(true, Ordering::Release);
    }
    pub(crate) fn stop_sampling(&self) {
        self.sampling_stop.request();
    }
    pub(crate) fn born_fenced(&self) -> bool {
        self.born_fenced
    }
    pub(crate) fn terminal(&self) -> bool {
        self.terminal.load(Ordering::Acquire)
    }
    pub(crate) fn local_exec_cancel_failed(&self) -> bool {
        self.local_exec_cancel_failed.load(Ordering::Acquire)
    }
    pub(crate) fn record_input(&self) {
        self.input_recorded.store(true, Ordering::Release);
    }
    pub(crate) fn graceful_ready(&self, recovered: bool) -> bool {
        self.graceful.load(Ordering::Acquire)
            && (self.input_recorded.load(Ordering::Acquire) || recovered)
    }
    pub async fn wait(&self) -> anyhow::Result<()> {
        let mut admission = self.admission.subscribe();
        loop {
            match *admission.borrow_and_update() {
                Admission::Ready => return Ok(()),
                Admission::Closed => anyhow::bail!("Native turn admission receipt closed"),
                Admission::Pending => {}
            }
            admission.changed().await?;
        }
    }

    fn settle_pending(&self, next: Admission) {
        self.admission.send_if_modified(|state| {
            if *state == Admission::Pending {
                *state = next;
                true
            } else {
                false
            }
        });
    }

    pub(crate) fn reserve_steering(&self) -> Option<String> {
        let steering = self.steering.as_ref()?;
        let id = codex_protocol::ThreadId::new().to_string();
        steering
            .issued
            .lock()
            .expect("turn steering poisoned")
            .insert(id.clone());
        Some(id)
    }

    pub(crate) fn discard_steering(&self, id: &str) {
        if let Some(steering) = &self.steering {
            steering
                .issued
                .lock()
                .expect("turn steering poisoned")
                .remove(id);
        }
    }

    fn record_steering(&self, id: Option<&str>) {
        if let (Some(steering), Some(id)) = (&self.steering, id)
            && steering
                .issued
                .lock()
                .expect("turn steering poisoned")
                .remove(id)
        {
            steering.tail.store(true, Ordering::Release);
        }
    }

    pub(crate) fn managed_response(&self) -> bool {
        self.managed_response
    }

    /// A response or an explicit cancellation revoked this exact turn.
    pub(crate) fn reject_model(&self) {
        self.rejected.store(true, Ordering::Release);
    }

    pub(crate) fn begin_generation(&self) {
        if let Some(steering) = &self.steering {
            steering.tail.store(false, Ordering::Release);
        }
    }

    pub(crate) fn unsampled_steering(&self) -> Option<bool> {
        self.steering
            .as_ref()
            .map(|steering| steering.tail.load(Ordering::Acquire))
    }
}

#[derive(Default)]
struct Current {
    turn: Option<Arc<Turn>>,
    retired: bool,
}

// Only tests can withhold the native idle receipt after a terminal event.
#[cfg(test)]
pub(crate) struct IdleHold {
    pub(crate) entered: tokio::sync::Semaphore,
    pub(crate) release: Arc<tokio::sync::Semaphore>,
}

pub(crate) struct Settlement {
    current: Mutex<Current>,
    changed: watch::Sender<()>,
    #[cfg(test)]
    pub(crate) waiting: tokio::sync::Semaphore,
    #[cfg(test)]
    pub(crate) idle_hold: Mutex<Option<Arc<IdleHold>>>,
}

/// Passive native ownership evidence, independent of terminal reader delivery.
pub(crate) struct Observation {
    pub(crate) retired: bool,
    pub(crate) receipt: Option<Arc<Turn>>,
    pub(crate) active: bool,
}

impl Default for Settlement {
    fn default() -> Self {
        Self {
            current: Mutex::new(Current::default()),
            changed: watch::channel(()).0,
            #[cfg(test)]
            waiting: tokio::sync::Semaphore::new(0),
            #[cfg(test)]
            idle_hold: Mutex::new(None),
        }
    }
}

// Core can retain initializers for future turns, including same-ID recovery.
// Only the first native turn can belong to this managed submission.
#[derive(Default)]
pub(crate) struct Seed(OnceLock<Arc<Turn>>);

impl Seed {
    pub(crate) fn confirm(&self, turn_id: &str) {
        if let Some(turn) = self.0.get()
            && turn.id == turn_id
        {
            turn.accepted.store(true, Ordering::Release);
        }
    }
}

impl Settlement {
    pub(crate) async fn finish_child_before_submit(
        &self,
        thread: &CodexThread,
    ) -> anyhow::Result<()> {
        let previous = self
            .current
            .lock()
            .expect("turn settlement poisoned")
            .turn
            .clone();
        if let Some(previous) = previous
            && previous.terminal()
            && previous.delivered.load(Ordering::Acquire)
        {
            self.finish_interrupted(thread, &previous).await?;
        }
        Ok(())
    }

    /// The managed Session is the sole submission owner. Its caller retains
    /// ThreadState.mutations through both queued operations and acknowledgement.
    pub async fn interrupt_session(&self, thread: &CodexThread) -> anyhow::Result<()> {
        let receipt = {
            let current = self.current.lock().expect("turn settlement poisoned");
            anyhow::ensure!(!current.retired, "Native turn admission receipt closed");
            current.turn.clone()
        };
        if let Some(receipt) = &receipt {
            receipt.reject_model();
        }
        crate::ops::interrupt(thread).await?;
        if let Some(receipt) = receipt {
            self.finish_interrupted(thread, &receipt).await?;
        }
        Ok(())
    }

    pub(crate) async fn finish_interrupted(
        &self,
        thread: &CodexThread,
        receipt: &Arc<Turn>,
    ) -> anyhow::Result<()> {
        let (reply, acknowledged) = oneshot::channel();
        // The convenience method can return before enqueueing when Core
        // has detached its finishing task. The queued Op is the barrier.
        thread
            .submit(Op::InterruptIfNoPendingInput {
                turn_id: receipt.id.clone(),
                reply,
            })
            .await?;
        anyhow::ensure!(
            !acknowledged.await?,
            "Native managed turn restarted during interruption"
        );
        anyhow::ensure!(
            !thread.managed_local_exec_cancel_failed(&receipt.id),
            LOCAL_COMMAND_CLEANUP_FAILED
        );
        {
            let current = self.current.lock().expect("turn settlement poisoned");
            anyhow::ensure!(
                !current.retired
                    && current
                        .turn
                        .as_ref()
                        .is_some_and(|turn| Arc::ptr_eq(turn, receipt)),
                "Native managed turn changed during interruption"
            );
        }
        // Only Core can establish that its slot and trigger mailbox are
        // idle. An acknowledged interrupt alone does not prove readiness.
        thread
            .emit_thread_idle_lifecycle_if_idle(ThreadIdleCause::Interrupted)
            .await;
        Ok(())
    }

    pub(crate) fn observe(&self) -> Observation {
        let current = self.current.lock().expect("turn settlement poisoned");
        Observation {
            retired: current.retired,
            receipt: current.turn.clone(),
            active: !current.retired
                && current.turn.as_ref().is_some_and(|turn| {
                    *turn.admission.borrow() == Admission::Pending || !turn.terminal()
                }),
        }
    }

    pub(crate) fn active(&self) -> Option<Arc<Turn>> {
        let observed = self.observe();
        observed.receipt.filter(|_| observed.active)
    }

    pub fn admission_ready(&self, id: &str) -> anyhow::Result<Option<Arc<Turn>>> {
        let current = self.current.lock().expect("turn settlement poisoned");
        anyhow::ensure!(!current.retired, "Native turn admission receipt closed");
        let turn = current
            .turn
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Native turn admission receipt missing"))?;
        // Native idle can admit a new turn before the Session reader has
        // consumed a completed raw compaction's terminal. Only the current
        // receipt owns managed admission or delivery bookkeeping.
        Ok((turn.id == id).then(|| Arc::clone(turn)))
    }

    // Unseeded event readers cannot distinguish queued events from a previous
    // same-ID lifecycle. Never borrow the replacement's provider details.
    pub(crate) fn observed(&self, id: &str) -> Option<Arc<Turn>> {
        self.matching(id).filter(|turn| !turn.same_id_recovery)
    }

    // Submission routing sends wrong or already-closed IDs to Core for its
    // not_submitted result; terminal delivery must still reject retired state.
    pub(crate) fn matching(&self, id: &str) -> Option<Arc<Turn>> {
        let current = self.current.lock().expect("turn settlement poisoned");
        current
            .turn
            .as_ref()
            .filter(|turn| !current.retired && turn.id == id)
            .cloned()
    }

    fn completed(&self) -> Option<Arc<Turn>> {
        let current = self.current.lock().expect("turn settlement poisoned");
        current
            .turn
            .as_ref()
            .filter(|turn| {
                !current.retired
                    && turn.accepted.load(Ordering::Acquire)
                    && turn.delivered.load(Ordering::Acquire)
            })
            .cloned()
    }

    pub(crate) fn is_current(&self, expected: &Arc<Turn>) -> bool {
        let current = self.current.lock().expect("turn settlement poisoned");
        !current.retired
            && current
                .turn
                .as_ref()
                .is_some_and(|turn| Arc::ptr_eq(turn, expected))
    }

    fn is_completed(&self, expected: &Arc<Turn>) -> bool {
        self.completed()
            .is_some_and(|turn| Arc::ptr_eq(&turn, expected))
    }

    pub(crate) fn can_continue_id(&self, id: &str) -> bool {
        self.matching(id)
            .is_some_and(|turn| self.can_continue(&turn))
    }

    fn can_continue(&self, expected: &Arc<Turn>) -> bool {
        self.is_completed(expected)
            && expected.successful.load(Ordering::Acquire)
            && !expected.rejected.load(Ordering::Acquire)
            && expected.unsampled_steering() == Some(true)
    }

    pub fn delivered(&self, event: &EventMsg) {
        let id = match event {
            EventMsg::TurnComplete(event) => Some(event.turn_id.as_str()),
            EventMsg::TurnAborted(event) => event.turn_id.as_deref(),
            _ => None,
        };
        let current = self.current.lock().expect("turn settlement poisoned");
        if let Some(turn) = &current.turn
            && id == Some(turn.id.as_str())
        {
            turn.successful.store(
                matches!(event, EventMsg::TurnComplete(done) if done.error.is_none()),
                Ordering::Release,
            );
            turn.delivered.store(true, Ordering::Release);
        }
    }

    pub fn retire(&self) {
        let mut current = self.current.lock().expect("turn settlement poisoned");
        current.retired = true;
        if let Some(turn) = &current.turn {
            turn.admission.send_replace(Admission::Closed);
        }
        self.changed.send_replace(());
    }
}

pub(crate) struct Contributor;

impl ThreadLifecycleContributor<Config> for Contributor {
    fn on_thread_idle<'a>(&'a self, input: ThreadIdleInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if let Some(settlement) = input.thread_store.get::<Settlement>() {
                #[cfg(test)]
                {
                    let has_turn = settlement
                        .current
                        .lock()
                        .expect("turn settlement poisoned")
                        .turn
                        .is_some();
                    let hold = settlement.idle_hold.lock().unwrap().clone();
                    if has_turn && let Some(hold) = hold {
                        hold.entered.add_permits(1);
                        let _released = hold.release.acquire().await.unwrap();
                    }
                }
                if let Some(turn) = &settlement
                    .current
                    .lock()
                    .expect("turn settlement poisoned")
                    .turn
                {
                    turn.settle_pending(Admission::Ready);
                }
                settlement.changed.send_replace(());
                if let Some(owner) = input
                    .thread_store
                    .get::<crate::native_interception::Control>()
                {
                    owner.graph().changed.send_replace(());
                }
            }
        })
    }

    fn on_thread_stop<'a>(&'a self, input: ThreadStopInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if let Some(settlement) = input.thread_store.get::<Settlement>() {
                settlement.retire();
            }
            if let Some(owner) = input
                .thread_store
                .get::<crate::native_interception::Control>()
            {
                owner.graph().changed.send_replace(());
            }
        })
    }
}

impl TurnLifecycleContributor for Contributor {
    fn on_turn_start<'a>(&'a self, input: TurnStartInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            let settlement = input.thread_store.get_or_init(Settlement::default);
            let own_instructions = input
                .thread_store
                .get::<crate::options::ThreadInstructions>()
                .is_some_and(|instructions| instructions.managed());
            let managed_response = own_instructions
                || input
                    .thread_store
                    .get::<crate::native_interception::Control>()
                    .is_some_and(|control| control.managed_response());
            let managed_steering = own_instructions
                || input
                    .thread_store
                    .get::<crate::native_interception::Control>()
                    .is_some_and(|control| control.has_native_agents());
            let owner = input
                .thread_store
                .get::<crate::native_interception::Control>();
            let sampling_stop = owner
                .as_ref()
                .map(|owner| owner.graph().close_sampling.for_turn())
                .unwrap_or_default();
            input.turn_store.insert(sampling_stop.clone());
            let graph = owner
                .as_ref()
                .map(|control| control.graph().state.lock().expect("graph stop poisoned"));
            let born_fenced = graph.as_ref().is_some_and(|graph| {
                graph.fenced
                    || (graph.root_stops != 0
                        && owner.as_ref().is_some_and(|owner| owner.is_root()))
            });
            let same_id_recovery = settlement
                .current
                .lock()
                .expect("turn settlement poisoned")
                .turn
                .as_ref()
                .is_some_and(|turn| turn.id == input.turn_id);
            // Even same-ID recovery receives a new native lifecycle receipt.
            input.turn_store.insert(Turn {
                id: input.turn_id.to_owned(),
                accepted: AtomicBool::new(false),
                delivered: AtomicBool::new(false),
                successful: AtomicBool::new(false),
                rejected: AtomicBool::new(false),
                managed_response,
                admission: watch::channel(Admission::Pending).0,
                steering: managed_steering.then(Steering::default),
                graceful: AtomicBool::new(false),
                sampling_stop,
                input_recorded: AtomicBool::new(false),
                terminal: AtomicBool::new(false),
                local_exec_cancel_failed: AtomicBool::new(false),
                born_fenced,
                same_id_recovery,
                provider_error: Mutex::default(),
            });
            let turn = input
                .turn_store
                .get::<Turn>()
                .expect("inserted turn receipt");
            if let Some(seed) = input.turn_store.get::<Arc<Seed>>() {
                let _ = seed.0.set(turn.clone());
            }
            if let Some(previous) = settlement
                .current
                .lock()
                .expect("turn settlement poisoned")
                .turn
                .replace(turn)
            {
                previous.settle_pending(Admission::Closed);
            }
            drop(graph);
            settlement.changed.send_replace(());
            if let Some(owner) = &owner {
                owner.graph().changed.send_replace(());
            }
        })
    }

    fn on_turn_error<'a>(&'a self, input: TurnErrorInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if let Some(turn) = input.turn_store.get::<Turn>()
                && turn.id == input.turn_id
            {
                turn.capture_provider_error(input.error, input.original_error);
            }
        })
    }

    fn on_item_completed<'a>(
        &'a self,
        thread_store: &'a ExtensionData,
        turn_store: &'a ExtensionData,
        item: &'a TurnItem,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if let TurnItem::UserMessage(message) = item
                && let Some(turn) = turn_store.get::<Turn>()
                && thread_store
                    .get::<Settlement>()
                    .is_some_and(|s| s.is_current(&turn))
            {
                turn.record_input();
                turn.record_steering(message.client_id.as_deref());
            }
        })
    }
    fn on_turn_stop<'a>(&'a self, input: TurnStopInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move { terminal(input.thread_store, input.turn_store, false) })
    }
    fn on_turn_abort<'a>(&'a self, input: TurnAbortInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            let local_exec_cancel_failed = input
                .turn_store
                .get::<ManagedLocalExecCancelFailure>()
                .is_some();
            if local_exec_cancel_failed
                && let Some(owner) = input
                    .thread_store
                    .get::<crate::native_interception::Control>()
            {
                // A graph stop can finish as soon as the last turn goes terminal.
                // Record the cleanup failure first, and only for a covered turn.
                let mut graph = owner.graph().state.lock().expect("graph stop poisoned");
                if graph.tree_stops != 0 || (graph.root_stops != 0 && owner.is_root()) {
                    graph.failure.get_or_insert(LOCAL_COMMAND_CLEANUP_FAILED);
                }
            }
            terminal(
                input.thread_store,
                input.turn_store,
                local_exec_cancel_failed,
            );
        })
    }
}

fn terminal(
    thread_store: &ExtensionData,
    turn_store: &ExtensionData,
    local_exec_cancel_failed: bool,
) {
    if let Some(turn) = turn_store.get::<Turn>() {
        if local_exec_cancel_failed {
            turn.local_exec_cancel_failed.store(true, Ordering::Release);
        }
        turn.terminal.store(true, Ordering::Release);
        if let Some(owner) = thread_store.get::<crate::native_interception::Control>() {
            owner.graph().changed.send_replace(());
        }
    }
}

pub(crate) async fn start<'a>(
    state: &'a crate::engine::ThreadState,
    mutation: &mut Option<MutexGuard<'a, ()>>,
    request: TurnInputRequest,
    mut init: ExtensionDataInit,
) -> anyhow::Result<StartIfIdleSubmission> {
    let settlement = state
        .thread
        .thread_extension_data()
        .get_or_init(Settlement::default);
    // Subscribe before the authority check and first native attempt. A native
    // transition between rejection and waiting must remain visible.
    let mut changed = settlement.changed.subscribe();
    let expected = settlement.completed();
    let seed = Arc::new(Seed::default());
    init.insert(seed.clone());
    let mut result = state
        .thread
        .start_turn_if_idle(WithTurnExtensionData::new(request.clone(), init.clone()))
        .await?;
    let deadline = Instant::now() + SETTLEMENT_GRACE;
    loop {
        if let StartIfIdleSubmission::Started { turn_id } = &result {
            seed.confirm(turn_id);
        }
        if result
            != (StartIfIdleSubmission::NotSubmitted {
                reason: NotSubmittedReason::NotIdle,
            })
        {
            return Ok(result);
        }
        let Some(expected) = &expected else {
            return Ok(result);
        };
        if !settlement.is_completed(expected) {
            return Ok(result);
        }
        drop(mutation.take());
        #[cfg(test)]
        settlement.waiting.add_permits(1);
        if !matches!(timeout_at(deadline, changed.changed()).await, Ok(Ok(()))) {
            return Ok(result);
        }
        let Ok(guard) = timeout_at(deadline, state.mutations.lock()).await else {
            return Ok(result);
        };
        *mutation = Some(guard);
        if Instant::now() >= deadline
            || !settlement.is_completed(expected)
            || !crate::graph_stop::continuation_allowed(state)
        {
            return Ok(result);
        }
        result = state
            .thread
            .start_turn_if_idle(WithTurnExtensionData::new(request.clone(), init.clone()))
            .await?;
    }
}

/// Resume only an exact, successfully settled managed Session receipt. A stale
/// hint from JavaScript or a caller-created native turn grants no authority.
pub(crate) async fn continue_retained<'a>(
    state: &'a crate::engine::ThreadState,
    mutation: &mut Option<MutexGuard<'a, ()>>,
    previous_id: &str,
    start: TurnStartOptions,
    mut init: ExtensionDataInit,
) -> anyhow::Result<TurnInputSubmission> {
    let settlement = state
        .thread
        .thread_extension_data()
        .get_or_init(Settlement::default);
    let mut changed = settlement.changed.subscribe();
    let Some(expected) = settlement
        .matching(previous_id)
        .filter(|turn| settlement.can_continue(turn))
    else {
        return Ok(TurnInputSubmission::NotSubmitted {
            reason: NotSubmittedReason::Superseded,
        });
    };
    let seed = Arc::new(Seed::default());
    init.insert(seed.clone());
    let mut request = TurnInputRequest::new(TurnInput::ResponseItem(ContextualUserFragment::into(
        InternalModelContextFragment::new(
            InternalContextSource::from_static("agents_steering"),
            "Continue with the latest user input already in the conversation. Do not repeat completed work.",
        ),
    )));
    request.start = start;
    let deadline = Instant::now() + SETTLEMENT_GRACE;
    loop {
        if !crate::graph_stop::continuation_allowed(state) || !settlement.can_continue(&expected) {
            return Ok(TurnInputSubmission::NotSubmitted {
                reason: NotSubmittedReason::Superseded,
            });
        }
        let result = state
            .thread
            .continue_turn_if_idle(
                WithTurnExtensionData::new(request.clone(), init.clone()),
                previous_id.to_owned(),
            )
            .await?;
        if let TurnInputSubmission::Started { turn_id } = &result {
            seed.confirm(turn_id);
        }
        if result
            != (TurnInputSubmission::NotSubmitted {
                reason: NotSubmittedReason::NotIdle,
            })
        {
            return Ok(result);
        }
        if !crate::graph_stop::continuation_allowed(state) || !settlement.can_continue(&expected) {
            return Ok(TurnInputSubmission::NotSubmitted {
                reason: NotSubmittedReason::Superseded,
            });
        }
        drop(mutation.take());
        #[cfg(test)]
        settlement.waiting.add_permits(1);
        if !matches!(timeout_at(deadline, changed.changed()).await, Ok(Ok(()))) {
            return Ok(result);
        }
        let Ok(guard) = timeout_at(deadline, state.mutations.lock()).await else {
            return Ok(result);
        };
        *mutation = Some(guard);
        if Instant::now() >= deadline {
            return Ok(result);
        }
    }
}

#[cfg(test)]
mod provider_error_tests {
    use super::*;
    use codex_protocol::error::{CodexErr, CodexErrorDetails, UnexpectedResponseError};
    use codex_protocol::protocol::{CodexErrorInfo, ErrorEvent};
    use serde_json::json;

    fn failure(request_id: &str) -> CodexErr {
        CodexErrorDetails::UnexpectedStatus(UnexpectedResponseError {
            status: http::StatusCode::UNAUTHORIZED,
            body: r#"{"error":{"code":"invalid_api_key"}}"#.into(),
            user_message: None,
            url: None,
            cf_ray: None,
            request_id: Some(request_id.into()),
            identity_authorization_error: None,
            identity_error_code: None,
        })
        .into()
    }

    fn error(category: CodexErrorInfo) -> ErrorEvent {
        serde_json::from_value(
            json!({"message":"unchanged native message", "codex_error_info":category}),
        )
        .unwrap()
    }

    async fn start(thread: &ExtensionData, turn: &ExtensionData, id: &str) -> Arc<Turn> {
        let session = ExtensionData::new("session");
        let mode = serde_json::from_value(json!({
            "mode":"default", "settings":{"model":"test","reasoning_effort":null,"developer_instructions":null}
        })).unwrap();
        Contributor
            .on_turn_start(TurnStartInput {
                turn_id: id,
                collaboration_mode: &mode,
                token_usage_at_turn_start: None,
                session_store: &session,
                thread_store: thread,
                turn_store: turn,
            })
            .await;
        turn.get::<Turn>().unwrap()
    }

    #[tokio::test]
    async fn passive_observation_preserves_pending_identity_until_native_idle() {
        let empty = Settlement::default().observe();
        assert!(!empty.active && !empty.retired && empty.receipt.is_none());
        let thread = ExtensionData::new("thread");
        let store = ExtensionData::new("turn");
        let receipt = start(&thread, &store, "turn").await;
        let settlement = thread.get::<Settlement>().unwrap();
        assert!(!receipt.accepted.load(Ordering::Acquire));
        let started = settlement.observe();
        assert!(started.active);
        assert!(Arc::ptr_eq(started.receipt.as_ref().unwrap(), &receipt));
        terminal(&thread, &store, false);
        assert!(receipt.terminal());
        // Terminal delivery alone cannot settle an unaccepted pending receipt.
        assert!(settlement.observe().active);
        let session = ExtensionData::new("session");
        Contributor
            .on_thread_idle(ThreadIdleInput {
                cause: ThreadIdleCause::Completed,
                session_store: &session,
                thread_store: &thread,
            })
            .await;
        let idle = settlement.observe();
        assert!(!idle.active && !idle.retired);
        assert!(Arc::ptr_eq(idle.receipt.as_ref().unwrap(), &receipt));
        settlement.retire();
        let retired = settlement.observe();
        assert!(retired.retired && !retired.active);
        assert!(Arc::ptr_eq(retired.receipt.as_ref().unwrap(), &receipt));
    }

    #[tokio::test]
    async fn replacement_keeps_original_local_exec_cleanup_receipt() {
        let thread = ExtensionData::new("child");
        let original = {
            let store = ExtensionData::new("original");
            let receipt = start(&thread, &store, "original").await;
            terminal(&thread, &store, true);
            receipt
        };
        let replacement_store = ExtensionData::new("replacement");
        let replacement = start(&thread, &replacement_store, "replacement").await;
        terminal(&thread, &replacement_store, false);

        let settlement = thread.get::<Settlement>().unwrap();
        assert!(settlement.is_current(&replacement));
        assert!(original.terminal() && original.local_exec_cancel_failed());
        assert!(replacement.terminal() && !replacement.local_exec_cancel_failed());
    }

    async fn capture(
        thread: &ExtensionData,
        turn: &ExtensionData,
        id: &str,
        category: CodexErrorInfo,
        original_error: &CodexErr,
    ) {
        let session = ExtensionData::new("session");
        Contributor
            .on_turn_error(TurnErrorInput {
                turn_id: id,
                error: category,
                error_details: original_error.details(),
                original_error,
                session_store: &session,
                thread_store: thread,
                turn_store: turn,
            })
            .await;
    }

    #[tokio::test]
    async fn captures_without_reporting_projection_and_replaces_or_clears_every_error() {
        let thread = ExtensionData::new("thread");
        let store = ExtensionData::new("turn");
        let receipt = start(&thread, &store, "turn").await;
        capture(
            &thread,
            &store,
            "turn",
            CodexErrorInfo::Unauthorized,
            &failure("first"),
        )
        .await;
        assert_eq!(
            receipt.error_json(&error(CodexErrorInfo::Unauthorized))["_sdk_provider_error"]["request_id"],
            "first"
        );
        capture(
            &thread,
            &store,
            "turn",
            CodexErrorInfo::Unauthorized,
            &failure("second"),
        )
        .await;
        assert_eq!(
            receipt.error_json(&error(CodexErrorInfo::Unauthorized))["_sdk_provider_error"]["request_id"],
            "second"
        );
        capture(
            &thread,
            &store,
            "turn",
            CodexErrorInfo::Other,
            &CodexErrorDetails::InvalidRequest("local".into()).into(),
        )
        .await;
        assert!(
            receipt
                .error_json(&error(CodexErrorInfo::Unauthorized))
                .get("_sdk_provider_error")
                .is_none()
        );
        let replacement = receipt.error_json(&error(CodexErrorInfo::Other));
        assert_eq!(replacement["_sdk_provider_error"]["retryable"], false);
        assert!(replacement["_sdk_provider_error"]["retry_after_ms"].is_null());
        assert!(
            replacement["_sdk_provider_error"]
                .get("request_id")
                .is_none()
        );
    }

    #[tokio::test]
    async fn attaches_only_to_matching_terminal_category_and_turn() {
        let thread = ExtensionData::new("thread");
        let store = ExtensionData::new("turn");
        let receipt = start(&thread, &store, "turn").await;
        capture(
            &thread,
            &store,
            "other",
            CodexErrorInfo::Unauthorized,
            &failure("wrong-owner"),
        )
        .await;
        assert!(
            receipt
                .error_json(&error(CodexErrorInfo::Unauthorized))
                .get("_sdk_provider_error")
                .is_none()
        );
        capture(
            &thread,
            &store,
            "turn",
            CodexErrorInfo::Unauthorized,
            &failure("owned"),
        )
        .await;
        for (id, kind, category) in [
            ("other", "task_complete", CodexErrorInfo::Unauthorized),
            ("turn", "error", CodexErrorInfo::Unauthorized),
            ("turn", "task_complete", CodexErrorInfo::Other),
        ] {
            let mut event = json!({"id":id,"msg":{"type":kind,"error":error(category)}});
            receipt.attach_provider_error(&mut event);
            assert!(event["msg"]["error"].get("_sdk_provider_error").is_none());
        }
        let mut event = json!({"id":"turn","msg":{"type":"task_complete","error":error(CodexErrorInfo::Unauthorized)}});
        receipt.attach_provider_error(&mut event);
        assert_eq!(event["msg"]["error"]["message"], "unchanged native message");
        assert_eq!(
            event["msg"]["error"]["_sdk_provider_error"]["status_code"],
            401
        );
    }

    #[tokio::test]
    async fn same_id_recovery_cannot_supply_metadata_to_an_unowned_queued_child_event() {
        let thread = ExtensionData::new("thread");
        let first_store = ExtensionData::new("turn");
        let first = start(&thread, &first_store, "same-id").await;
        let settlement = thread.get::<Settlement>().unwrap();
        assert!(Arc::ptr_eq(
            &settlement.observed("same-id").unwrap(),
            &first
        ));
        capture(
            &thread,
            &first_store,
            "same-id",
            CodexErrorInfo::Unauthorized,
            &failure("old"),
        )
        .await;
        let second_store = ExtensionData::new("turn");
        let second = start(&thread, &second_store, "same-id").await;
        capture(
            &thread,
            &second_store,
            "same-id",
            CodexErrorInfo::Unauthorized,
            &failure("new"),
        )
        .await;
        assert!(!Arc::ptr_eq(&first, &second));
        assert!(settlement.observed("same-id").is_none());
        assert!(first.wait().await.is_err());
        assert_eq!(
            first.error_json(&error(CodexErrorInfo::Unauthorized))["_sdk_provider_error"]["request_id"],
            "old"
        );
        assert_eq!(
            second.error_json(&error(CodexErrorInfo::Unauthorized))["_sdk_provider_error"]["request_id"],
            "new"
        );
        // A different ID has ordinary, positive spawned-child correlation.
        let third_store = ExtensionData::new("third");
        let third = start(&thread, &third_store, "third").await;
        assert!(Arc::ptr_eq(&settlement.observed("third").unwrap(), &third));
        assert!(
            third
                .error_json(&error(CodexErrorInfo::Unauthorized))
                .get("_sdk_provider_error")
                .is_none()
        );
    }

    #[tokio::test]
    async fn delayed_root_terminal_cannot_borrow_same_id_replacement_metadata() {
        let thread = ExtensionData::new("thread");
        let first_store = ExtensionData::new("old-turn");
        let first = start(&thread, &first_store, "same-id").await;
        capture(
            &thread,
            &first_store,
            "same-id",
            CodexErrorInfo::Unauthorized,
            &failure("old"),
        )
        .await;
        // The original terminal can remain in the native queue while recovery
        // installs a new lifecycle with the same stable turn ID and category.
        let mut old_terminal = json!({"id":"same-id", "msg":{
            "type":"task_complete", "error":error(CodexErrorInfo::Unauthorized)
        }});
        let second_store = ExtensionData::new("new-turn");
        let second = start(&thread, &second_store, "same-id").await;
        capture(
            &thread,
            &second_store,
            "same-id",
            CodexErrorInfo::Unauthorized,
            &failure("replacement"),
        )
        .await;
        second.settle_pending(Admission::Ready);
        let selected = thread
            .get::<Settlement>()
            .unwrap()
            .admission_ready("same-id")
            .unwrap()
            .unwrap();
        assert!(Arc::ptr_eq(&selected, &second));
        assert!(!Arc::ptr_eq(&selected, &first));
        selected.wait().await.unwrap();
        selected.attach_provider_error(&mut old_terminal);
        assert!(
            old_terminal["msg"]["error"]
                .get("_sdk_provider_error")
                .is_none(),
            "an unseeded root terminal cannot prove ownership of a same-ID replacement receipt: {old_terminal}"
        );
    }
}
