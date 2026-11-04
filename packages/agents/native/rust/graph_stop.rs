//! Session-owned stop fences. Membership is the native Control index, never UI rows.
use anyhow::{Context, Result, ensure};
use codex_core_api::{CodexThread, ThreadManager};
use codex_extension_api::{
    ContextContributor, ExtensionData, ExtensionFuture, TurnLifecycleContributor, TurnSamplingStop,
    TurnStartInput, TurnStartPhase, WorldStateContributionInput, WorldStateSectionContribution,
};
use codex_protocol::protocol::Op;
use std::sync::Weak;
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

use crate::native_interception::{Boundary, Control};
use crate::turn_settlement::Turn;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Scope {
    Root,
    Tree,
}

impl Scope {
    pub(crate) fn parse(scope: &str) -> Result<Self> {
        match scope {
            "root" => Ok(Self::Root),
            "thread_tree" => Ok(Self::Tree),
            _ => anyhow::bail!("Invalid Session stop scope"),
        }
    }
}

#[derive(Default)]
pub(crate) struct State {
    pub(crate) fenced: bool,
    pub(crate) root_stops: usize,
    pub(crate) tree_stops: usize,
    pub(crate) failure: Option<&'static str>,
}

impl State {
    pub(crate) fn stopping(&self) -> bool {
        self.root_stops != 0 || self.tree_stops != 0
    }
}

pub(crate) struct Graph {
    pub(crate) state: Mutex<State>,
    pub(crate) changed: watch::Sender<()>,
    // Every turn in this channel sees close, including a turn admitted while
    // the native shutdown still owns cleanup.
    pub(crate) close_sampling: TurnSamplingStop,
}

impl Default for Graph {
    fn default() -> Self {
        Self {
            state: Mutex::default(),
            changed: watch::channel(()).0,
            close_sampling: TurnSamplingStop::default(),
        }
    }
}

pub(crate) struct Request {
    pub(crate) root: Arc<Control>,
    scope: Scope,
    force: bool,
    completed: bool,
}

impl Drop for Request {
    fn drop(&mut self) {
        let graph = self.root.graph();
        let mut state = graph.state.lock().expect("graph stop poisoned");
        match self.scope {
            Scope::Root => state.root_stops -= 1,
            Scope::Tree => state.tree_stops -= 1,
        }
        // Failure to create or poll the bridge cannot quietly resume partial work.
        if !self.completed && !self.root.is_stopped() {
            state
                .failure
                .get_or_insert("Native Session stop did not settle");
        }
        drop(state);
        graph.changed.send_replace(());
    }
}

impl Request {
    // Synchronous through N-API, before returning any future to JS. The same
    // graph mutex encloses Turn installation, including same-ID recovery.
    pub(crate) fn begin(
        boundary: &Boundary,
        root: Arc<Control>,
        scope: Scope,
        force: bool,
    ) -> Result<Self> {
        ensure!(
            root.is_root() && root.managed_response() && !root.is_stopped(),
            "Stop requires a live managed root Session"
        );
        {
            let mut graph = root.graph().state.lock().expect("graph stop poisoned");
            ensure!(
                graph.failure.is_none(),
                "Native Session stop previously failed"
            );
            match scope {
                Scope::Root => graph.root_stops += 1,
                Scope::Tree => {
                    graph.tree_stops += 1;
                    graph.fenced = true;
                }
            }
            for owner in boundary.graph_members(&root, scope) {
                if let Some(turn) = owner
                    .settlement
                    .get()
                    .and_then(|s| s.upgrade())
                    .and_then(|s| s.active())
                {
                    turn.request_graceful();
                    if force {
                        turn.stop_sampling();
                    }
                    if scope == Scope::Tree || force {
                        turn.reject_model();
                    }
                }
            }
        }
        root.graph().changed.send_replace(());
        Ok(Self {
            root,
            scope,
            force,
            completed: false,
        })
    }

    pub(crate) fn complete(&mut self) {
        self.completed = true;
    }

    pub(crate) async fn settle(&mut self, state: &crate::engine::ThreadState) -> Result<()> {
        loop {
            settle(
                &state.engine.interception,
                &state.engine.manager,
                &self.root,
                self.scope,
                self.force,
                false,
            )
            .await?;
            // Never hold mutations while graceful tools wait. A previously
            // admitted operation (including manual recovery) may have created
            // a fenced turn while we waited for its lock. Drain it as well.
            let mutation = state.mutations.lock().await;
            let members = state
                .engine
                .interception
                .graph_members(&self.root, self.scope);
            if members.iter().any(|owner| {
                owner
                    .settlement
                    .get()
                    .and_then(|s| s.upgrade())
                    .is_some_and(|s| s.active().is_some())
            }) {
                drop(mutation);
                continue;
            }
            for owner in members {
                owner.interrupt_code_mode_cells().await?;
            }
            return Ok(());
        }
    }
}

async fn live_thread(manager: &ThreadManager, owner: &Arc<Control>) -> Option<Arc<CodexThread>> {
    let id = codex_core_api::ThreadId::from_string(owner.thread_id()).ok()?;
    let thread = manager.get_thread(id).await.ok()?;
    thread
        .thread_extension_data()
        .get::<Control>()
        .is_some_and(|current| Arc::ptr_eq(&current, owner))
        .then_some(thread)
}

// After native TurnAborted, Core may still own the SQ slot. Do not trust an
// event-reader idle hint; use the existing exact-turn conditional Op barrier.
async fn join_terminal(
    thread: &CodexThread,
    owner: &Arc<Control>,
    receipt: &Arc<Turn>,
) -> Result<()> {
    let Some(settlement) = owner.settlement.get().and_then(|s| s.upgrade()) else {
        return Ok(());
    };
    if !settlement.is_current(receipt) {
        return Ok(());
    }
    let barrier = settlement.finish_interrupted(thread, receipt);
    tokio::select! {
        biased;
        _ = owner.stopped_token().cancelled() => Ok(()),
        result = barrier => {
            if settlement.is_current(receipt) { result } else { Ok(()) }
        }
    }
}

async fn settle(
    boundary: &Boundary,
    manager: &ThreadManager,
    root: &Arc<Control>,
    scope: Scope,
    force: bool,
    reopening: bool,
) -> Result<()> {
    let graph = root.graph();
    let mut changed = graph.changed.subscribe();
    loop {
        if root.is_stopped() {
            return Ok(());
        }
        let pending = {
            let mut fence = graph.state.lock().expect("graph stop poisoned");
            if let Some(message) = fence.failure {
                anyhow::bail!(message)
            }
            if reopening {
                ensure!(!fence.stopping(), "Session is stopping");
                if !fence.fenced {
                    return Ok(());
                }
            }
            let pending: Vec<_> = boundary
                .graph_members(root, scope)
                .into_iter()
                .filter_map(|owner| {
                    let settlement = owner.settlement.get()?.upgrade()?;
                    let turn = settlement.active()?;
                    if reopening && !turn.born_fenced() {
                        return None;
                    }
                    Some((owner, turn))
                })
                .collect();
            if pending.is_empty() {
                if reopening {
                    fence.fenced = false;
                }
                return Ok(());
            }
            pending
        };
        for (owner, receipt) in pending {
            if let Some(thread) = live_thread(manager, &owner).await {
                let Some(settlement) = owner.settlement.get().and_then(|s| s.upgrade()) else {
                    continue;
                };
                if !settlement.is_current(&receipt) {
                    continue;
                }
                if receipt.terminal() {
                    join_terminal(&thread, &owner, &receipt).await?;
                } else if force {
                    receipt.stop_sampling();
                    receipt.reject_model();
                    thread
                        .submit(Op::Interrupt)
                        .await
                        .context("Native graph interruption failed")?;
                }
            } else if !owner.is_stopped() {
                anyhow::bail!("Native graph lost a live Session owner");
            }
        }
        changed
            .changed()
            .await
            .context("Native graph owner closed")?;
    }
}

pub(crate) async fn resume(state: &crate::engine::ThreadState) -> Result<()> {
    let root = state
        .thread
        .thread_extension_data()
        .get::<Control>()
        .context("Native Session lost its graph owner")?;
    settle(
        &state.engine.interception,
        &state.engine.manager,
        &root,
        Scope::Tree,
        false,
        true,
    )
    .await
}

// Called by SDK submission paths, never by automatic continuation. Preserve
// root graceful steering; no tree stop accepts new/queued input.
pub(crate) async fn submit(
    state: &crate::engine::ThreadState,
    params: &serde_json::Value,
) -> Result<()> {
    let Some(control) = state.thread.thread_extension_data().get::<Control>() else {
        return Ok(());
    };
    if !control.managed_response() {
        return Ok(());
    }
    if params
        .get("expected_previous_turn_id")
        .is_some_and(|id| !id.is_null())
    {
        // continue_retained revalidates its exact, unrevoked turn below.
        return Ok(());
    }
    let steering = params.get("mode").and_then(serde_json::Value::as_str) == Some("steer");
    check_input(&control, steering)?;
    if !steering {
        resume(state).await?;
    }
    Ok(())
}

// The outer ingress may have reopened before waiting for an unrelated
// mutation. Do not let a new reservation slip through that wait. Retained
// continuation has its own exact prior-turn rejection, not an admission error.
pub(crate) fn check_after_wait(
    state: &crate::engine::ThreadState,
    params: &serde_json::Value,
) -> Result<()> {
    let Some(control) = state.thread.thread_extension_data().get::<Control>() else {
        return Ok(());
    };
    if !control.managed_response()
        || params.get("mode").and_then(serde_json::Value::as_str) == Some("continue_if_idle")
    {
        return Ok(());
    }
    check_input(
        &control,
        params.get("mode").and_then(serde_json::Value::as_str) == Some("steer"),
    )?;
    if control
        .graph()
        .state
        .lock()
        .expect("graph stop poisoned")
        .fenced
    {
        return Err(crate::ops::pre_admission(anyhow::anyhow!(
            "Session graph changed while submission was waiting"
        )));
    }
    Ok(())
}

// Automatic continuation cannot reopen a reserved or completed tree fence,
// including when the previous receipt was already delivered before stop.
pub(crate) fn continuation_allowed(state: &crate::engine::ThreadState) -> bool {
    state
        .thread
        .thread_extension_data()
        .get::<Control>()
        .is_none_or(|control| {
            let graph = control.graph().state.lock().expect("graph stop poisoned");
            graph.failure.is_none() && !graph.fenced && !graph.stopping()
        })
}

pub(crate) fn check_mutation(state: &crate::engine::ThreadState) -> Result<()> {
    state.engine.interception.check_code_import_admission()?;
    if let Some(control) = state.thread.thread_extension_data().get::<Control>() {
        let graph = control.graph().state.lock().expect("graph stop poisoned");
        if let Some(error) = graph.failure {
            anyhow::bail!(error)
        }
        ensure!(!graph.stopping(), "Session is stopping");
    }
    Ok(())
}

pub(crate) fn check_input(control: &Control, steering: bool) -> Result<()> {
    ensure!(
        !control.code_import_poisoned(),
        "Native CodeMode import cleanup failed"
    );
    let state = control.graph().state.lock().expect("graph stop poisoned");
    if let Some(error) = state.failure {
        anyhow::bail!(error)
    }
    if state.tree_stops != 0 || (state.fenced && steering) {
        return Err(crate::ops::pre_admission(anyhow::anyhow!(
            "Session graph is stopping"
        )));
    }
    if !steering && state.root_stops != 0 {
        return Err(crate::ops::pre_admission(anyhow::anyhow!(
            "Session root is stopping"
        )));
    }
    Ok(())
}

pub(crate) struct Contributor {
    pub(crate) manager: Weak<ThreadManager>,
}

impl TurnLifecycleContributor for Contributor {
    fn turn_start_phase(&self, _: &ExtensionData) -> TurnStartPhase {
        TurnStartPhase::RegularTaskStart
    }

    fn on_turn_start<'a>(&'a self, input: TurnStartInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            let Some(owner) = input.thread_store.get::<Control>() else {
                return;
            };
            let Some(receipt) = input.turn_store.get::<Turn>() else {
                return;
            };
            let Some(settlement) = input
                .thread_store
                .get::<crate::turn_settlement::Settlement>()
            else {
                return;
            };
            if !receipt.born_fenced() || !settlement.is_current(&receipt) {
                return;
            }
            let stopped = async {
                let manager = self
                    .manager
                    .upgrade()
                    .context("Native graph owner closed")?;
                let thread = live_thread(&manager, &owner)
                    .await
                    .context("Native graph owner changed")?;
                if settlement.is_current(&receipt) {
                    thread.submit(Op::Interrupt).await?;
                }
                anyhow::Ok(())
            }
            .await;
            if stopped.is_err() {
                owner
                    .graph()
                    .state
                    .lock()
                    .expect("graph stop poisoned")
                    .failure = Some("Native graph could not stop a queued turn");
                owner.graph().changed.send_replace(());
            }
            std::future::pending::<()>().await;
        })
    }
}

impl ContextContributor for Contributor {
    fn contribute_world_state<'a>(
        &'a self,
        input: WorldStateContributionInput<'a>,
    ) -> ExtensionFuture<'a, Vec<WorldStateSectionContribution>> {
        Box::pin(async move {
            let Some(owner) = input.thread_store.get::<Control>() else {
                return Vec::new();
            };
            let Some(receipt) = input.turn_store.get::<Turn>() else {
                return Vec::new();
            };
            let Some(settlement) = input
                .thread_store
                .get::<crate::turn_settlement::Settlement>()
            else {
                return Vec::new();
            };
            let recovered = input
                .thread_store
                .get::<crate::recovery_guard::Guard>()
                .is_some_and(|guard| guard.has_active_recovery());
            if !settlement.is_current(&receipt) || !receipt.graceful_ready(recovered) {
                return Vec::new();
            }
            let decision = async {
                let manager = self
                    .manager
                    .upgrade()
                    .context("Native graph owner closed")?;
                let thread = live_thread(&manager, &owner)
                    .await
                    .context("Native graph owner changed")?;
                if !settlement.is_current(&receipt) {
                    return Ok(false);
                }
                let fenced = owner
                    .graph()
                    .state
                    .lock()
                    .expect("graph stop poisoned")
                    .fenced;
                if fenced {
                    thread.submit(Op::Interrupt).await?;
                    anyhow::Ok(true)
                } else {
                    Ok(thread.interrupt_if_no_pending_input(input.turn_id).await?)
                }
            }
            .await;
            match decision {
                Ok(false) => Vec::new(),
                Ok(true) => std::future::pending().await,
                Err(_) => {
                    owner
                        .graph()
                        .state
                        .lock()
                        .expect("graph stop poisoned")
                        .failure = Some("Native graph graceful interruption failed");
                    owner.graph().changed.send_replace(());
                    std::future::pending().await
                }
            }
        })
    }
}
