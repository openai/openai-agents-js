//! Read the native spawn graph without loading or resuming child runtimes.

use anyhow::{Context, ensure};
use codex_agent_graph_store::ThreadSpawnEdgeStatus;
use codex_core::context::{
    ContextualUserFragment, InternalContextSource, InternalModelContextFragment,
};
use codex_core_api::{CodexThread, ThreadManager, WithTurnExtensionData};
use codex_protocol::ThreadId;
use codex_protocol::models::{ContentItem, MessagePhase, ResponseItem};
use codex_protocol::protocol::{Event, EventMsg, TokenUsageInfo, TurnAbortReason};
use codex_protocol::turn_input::{
    NotSubmittedReason, StartIfIdleSubmission, SteerSubmission, TurnInput, TurnInputRequest,
    TurnInputSubmission,
};
use codex_protocol::user_input::UserInput;
use codex_thread_store::{LoadThreadHistoryParams, ThreadStoreError};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock, Weak};
use tokio::sync::{Mutex, watch};

use crate::engine::ThreadState;
use crate::usage::{exact_counter, exact_usage};

pub struct Instance {
    pub id: u64,
    pub thread: Weak<CodexThread>,
    pub turn: Option<Arc<Turn>>,
    pub usage: Option<TokenUsageInfo>,
    // None keeps raw child output semantics. Managed turns retain explicit
    // blank-final authority instead of inheriting Core's prior commentary.
    pub blank_final: Option<bool>,
    pub last_blank: bool,
    pub submitted: HashMap<String, Arc<Turn>>,
    pub during_submission: Option<HashMap<String, Arc<Turn>>>,
}

pub struct Turn {
    pub child_id: ThreadId,
    pub instance_id: u64,
    pub incarnation: String,
    pub turn_id: String,
    pub owner: Weak<ThreadState>,
    thread: Weak<CodexThread>,
    result: watch::Sender<Option<Outcome>>,
    sdk_admission: OnceLock<Arc<crate::turn_settlement::Turn>>,
    // Confirmed cancellation owns its original strong cell/session references
    // until termination succeeds, including after terminal delivery or failure.
    cancel_cleanup: Mutex<Option<Arc<crate::native_interception::CapturedTurnStop>>>,
}

#[derive(Clone)]
struct Outcome {
    result: Result<String, String>,
    terminal: bool,
    usage: Option<TokenUsageInfo>,
    error: Option<serde_json::Value>,
}

impl Turn {
    fn new(
        owner: &Arc<ThreadState>,
        child_id: ThreadId,
        instance: &Instance,
        turn_id: String,
    ) -> Self {
        let incarnation = instance
            .thread
            .upgrade()
            .and_then(|thread| {
                thread
                    .thread_extension_data()
                    .get::<crate::native_interception::Control>()
            })
            .map(|control| control.incarnation.clone())
            .unwrap_or_default();
        Self {
            child_id,
            instance_id: instance.id,
            incarnation,
            turn_id,
            owner: Arc::downgrade(owner),
            thread: instance.thread.clone(),
            result: watch::channel(None).0,
            sdk_admission: OnceLock::new(),
            cancel_cleanup: Mutex::new(None),
        }
    }
    pub(crate) fn terminal_error(&self) -> Option<String> {
        self.result
            .borrow()
            .as_ref()
            .and_then(|outcome| outcome.error.as_ref())
            .map(|error| serde_json::to_string(error).expect("serializable native error"))
    }

    fn finish(
        &self,
        result: Result<String, String>,
        terminal: bool,
        usage: Option<TokenUsageInfo>,
    ) {
        self.finish_with_error(result, terminal, usage, None);
    }

    fn finish_aborted(&self, reason: &TurnAbortReason, usage: Option<TokenUsageInfo>) {
        let (message, details) = match reason {
            TurnAbortReason::Interrupted => (
                "Native child turn was interrupted",
                Some(serde_json::json!({"_sdk_child_interrupted": true})),
            ),
            TurnAbortReason::Replaced
            | TurnAbortReason::ReviewEnded
            | TurnAbortReason::BudgetLimited => ("Native child turn was aborted", None),
        };
        self.finish_with_error(Err(message.into()), true, usage, details);
    }

    fn finish_with_error(
        &self,
        result: Result<String, String>,
        terminal: bool,
        usage: Option<TokenUsageInfo>,
        error: Option<serde_json::Value>,
    ) {
        self.result.send_if_modified(|current| {
            if current.is_some() {
                return false;
            }
            let policy_failed = terminal
                && self
                    .thread
                    .upgrade()
                    .and_then(|thread| {
                        thread
                            .thread_extension_data()
                            .get::<crate::mcp_result_control::McpResultControl>()
                    })
                    .is_some_and(|control| control.take_unresolved(&self.turn_id));
            let result = if policy_failed && result.is_ok() {
                Err("Native MCP result policy failed".into())
            } else {
                result
            };
            *current = Some(Outcome {
                result,
                terminal,
                usage,
                error,
            });
            true
        });
    }

    async fn outcome(&self) -> anyhow::Result<Outcome> {
        let mut result = self.result.subscribe();
        loop {
            let current = result.borrow_and_update().clone();
            if let Some(current) = current {
                return Ok(current);
            }
            result
                .changed()
                .await
                .context("Native child result is unavailable")?;
        }
    }

    pub async fn wait_with_usage(&self) -> anyhow::Result<String> {
        let outcome = self.outcome().await?;
        let usage = outcome.usage.as_ref().map(|info| {
            serde_json::json!({
                "total_token_usage": exact_usage(&info.total_token_usage),
                "last_token_usage": exact_usage(&info.last_token_usage),
                "model_context_window": info.model_context_window.map(exact_counter),
            })
        });
        // The common observational wire keeps native counters exact before JSON.parse.
        serde_json::to_string(&serde_json::json!({
            "final_output": outcome.result.map_err(anyhow::Error::msg)?,
            "usage": usage,
        }))
        .context("Native child result could not be encoded")
    }

    // None distinguishes confirmed interruption with failed cleanup from an
    // unconfirmed cancellation. The JS owner must still join its callbacks.
    pub async fn cancel(self: &Arc<Self>) -> anyhow::Result<Option<bool>> {
        let Some(owner) = self.owner.upgrade() else {
            return Ok(Some(false));
        };
        // Serialize attempts on this exact receipt. A retained cleanup already
        // proves interruption; retry it without looking up a current turn.
        let mut retained = self.cancel_cleanup.lock().await;
        let interrupted = if retained.is_some() {
            true
        } else {
            let Some(thread) = self.thread.upgrade() else {
                return Ok(Some(false));
            };
            ensure!(
                owner
                    .engine
                    .manager
                    .list_agent_subtree_thread_ids(owner.id)
                    .await?
                    .contains(&self.child_id),
                "Thread is not a child of this Session"
            );
            {
                let instances = owner
                    .child_instances
                    .read()
                    .map_err(|_| anyhow::anyhow!("Native child state unavailable"))?;
                if owner.child_events_retired()
                    || !instances.get(&self.child_id).is_some_and(|current| {
                        current.id == self.instance_id
                            && Weak::ptr_eq(&current.thread, &self.thread)
                            && current
                                .turn
                                .as_ref()
                                .is_some_and(|turn| Arc::ptr_eq(turn, self))
                    })
                {
                    return Ok(Some(false));
                }
            }
            // Capture without stopping while the original owner is still live.
            // Terminal delivery may clear it or publish a successor before we resume.
            let cleanup = thread
                .thread_extension_data()
                .get::<crate::native_interception::Control>()
                .and_then(|control| control.capture_turn_stop(&self.turn_id));
            let interrupted =
                crate::ops::interrupt_if_no_pending_input(&thread, self.turn_id.clone())
                    .await
                    .context("Native child cancellation did not return a confirmed decision")?;
            if interrupted {
                // Publish ownership before awaiting the terminal or cleanup.
                // An unconfirmed decision or error never retains or stops it.
                *retained = cleanup;
            }
            interrupted
        };
        if interrupted {
            ensure!(
                self.outcome().await?.terminal,
                "Native child closed before its terminal event was observed"
            );
            return Ok(finish_confirmed_child_cancel(&mut retained, &owner.engine.manager).await);
        }
        Ok(Some(false))
    }
}

// Called only after confirmed interruption and terminal observation. Keep the
// original Arc in its receipt's slot on every failed finish, including retry.
pub(crate) async fn finish_confirmed_child_cancel(
    retained: &mut Option<Arc<crate::native_interception::CapturedTurnStop>>,
    manager: &ThreadManager,
) -> Option<bool> {
    let cleanup = retained.as_ref()?;
    cleanup.stop();
    if cleanup.finish(manager).await.is_err() {
        return None;
    }
    let local_exec_cancel_confirmed = cleanup.local_exec_cancel_confirmed();
    *retained = None;
    local_exec_cancel_confirmed.then_some(true)
}

impl Instance {
    fn submission_turn(
        &mut self,
        owner: &Arc<ThreadState>,
        child_id: ThreadId,
        turn_id: &str,
    ) -> Arc<Turn> {
        if let Some(turn) = self.turn.as_ref().filter(|turn| turn.turn_id == turn_id) {
            return turn.clone();
        }
        if let Some(turn) = self
            .during_submission
            .as_ref()
            .and_then(|capture| capture.get(turn_id))
        {
            return turn.clone();
        }
        if let Some(turn) = self.submitted.get(turn_id) {
            return turn.clone();
        }
        let turn = Arc::new(Turn::new(owner, child_id, self, turn_id.to_owned()));
        // Before Core acknowledges input, the existing capture owns this
        // slot. Drop removes rejected or cancelled pre-submit work.
        self.during_submission
            .as_mut()
            .expect("child submission capture must be open")
            .insert(turn_id.to_owned(), turn.clone());
        turn
    }

    fn acknowledge_submission(
        &mut self,
        owner: &Arc<ThreadState>,
        child_id: ThreadId,
        turn_id: &str,
    ) -> Arc<Turn> {
        let turn = self.submission_turn(owner, child_id, turn_id);
        // Promote only an acknowledged turn whose TurnStarted the reader has
        // not yet observed. Completed captures can be returned without lingering.
        if !self
            .turn
            .as_ref()
            .is_some_and(|live| Arc::ptr_eq(live, &turn))
            && turn.result.borrow().is_none()
        {
            self.submitted.insert(turn_id.to_owned(), turn.clone());
        }
        turn
    }

    pub fn retire(&self) {
        for turn in self.submitted.values() {
            turn.finish(
                Err("Native child runtime closed or was replaced".into()),
                false,
                None,
            );
        }
        if let Some(turn) = &self.turn {
            turn.finish(
                Err("Native child runtime closed or was replaced".into()),
                false,
                self.usage.clone(),
            );
        }
    }

    pub fn observe(
        &mut self,
        owner: &Arc<ThreadState>,
        id: ThreadId,
        event: &Event,
        terminal_error: Option<&serde_json::Value>,
    ) -> Option<bool> {
        if let EventMsg::TurnStarted(start) = &event.msg {
            if let Some(previous) = &self.turn {
                previous.finish(
                    Err("Native child turn ended without a terminal".into()),
                    false,
                    self.usage.clone(),
                );
            }
            self.usage = None;
            self.last_blank = false;
            let control = self.thread.upgrade().and_then(|thread| {
                thread
                    .thread_extension_data()
                    .get::<crate::native_interception::Control>()
            });
            self.blank_final = control
                .as_ref()
                .is_some_and(|control| control.managed_response())
                .then_some(false);
            self.turn = Some(
                self.submitted
                    .remove(&start.turn_id)
                    .or_else(|| {
                        self.during_submission
                            .as_ref()
                            .and_then(|capture| capture.get(&start.turn_id))
                            .cloned()
                    })
                    .unwrap_or_else(|| Arc::new(Turn::new(owner, id, self, start.turn_id.clone()))),
            );
            if let Some(capture) = self.during_submission.as_mut() {
                capture.insert(
                    start.turn_id.clone(),
                    self.turn.as_ref().expect("installed turn").clone(),
                );
            }
            return None;
        }
        let Some(turn) = &self.turn else {
            return None;
        };
        match &event.msg {
            EventMsg::RawResponseItem(item)
                if event.id == turn.turn_id && self.blank_final.is_some() =>
            {
                if let ResponseItem::Message {
                    role,
                    content,
                    phase,
                    ..
                } = &item.item
                    && role == "assistant"
                {
                    let mut texts = content
                        .iter()
                        .filter_map(|part| match part {
                            ContentItem::InputText { text } | ContentItem::OutputText { text } => {
                                Some(text)
                            }
                            _ => None,
                        })
                        .peekable();
                    let blank = texts.peek().is_some()
                        && texts.all(|text| text.chars().all(char::is_whitespace));
                    self.last_blank = blank;
                    if !blank || *phase == Some(MessagePhase::FinalAnswer) {
                        self.blank_final = Some(blank);
                    }
                }
            }
            EventMsg::TokenCount(count)
                if event.id == turn.turn_id
                    && (count.api_rate_limits.is_none()
                        || count.info.is_some()
                        || count.rate_limits.is_some()) =>
            {
                self.usage = count.info.clone();
            }
            EventMsg::TurnComplete(end) if end.turn_id == turn.turn_id => {
                // Capture before publishing Outcome: waiters may wake immediately.
                let error = end.error.as_ref().map(|error| {
                    terminal_error.cloned().unwrap_or_else(|| {
                        serde_json::to_value(error).expect("serializable native error")
                    })
                });
                turn.finish_with_error(
                    if end.error.is_some() {
                        Err("Native child turn failed".into())
                    } else if self.blank_final == Some(true) {
                        Ok(String::new())
                    } else {
                        end.last_agent_message
                            .clone()
                            .or_else(|| {
                                (self.blank_final.is_some() && self.last_blank).then(String::new)
                            })
                            .ok_or_else(|| {
                                "Native child completed without an assistant output".into()
                            })
                    },
                    true,
                    self.usage.clone(),
                    error,
                );
                return turn
                    .result
                    .borrow()
                    .as_ref()
                    .filter(|outcome| outcome.terminal)
                    .map(|outcome| outcome.result.is_err());
            }
            EventMsg::TurnAborted(end) if end.turn_id.as_ref() == Some(&turn.turn_id) => {
                turn.finish_aborted(&end.reason, self.usage.clone());
            }
            EventMsg::ShutdownComplete => self.retire(),
            _ => {}
        }
        None
    }
}

pub async fn current(state: &ThreadState, id: ThreadId) -> anyhow::Result<Option<Arc<Turn>>> {
    ensure!(
        id != state.id
            && state
                .engine
                .manager
                .list_agent_subtree_thread_ids(state.id)
                .await?
                .contains(&id),
        "Thread is not a child of this Session"
    );
    let instances = state
        .child_instances
        .read()
        .map_err(|_| anyhow::anyhow!("Native child state unavailable"))?;
    Ok(instances
        .get(&id)
        .and_then(|instance| instance.turn.clone()))
}

#[derive(Serialize)]
pub struct Subagent {
    pub id: ThreadId,
    object: &'static str,
    session_id: ThreadId,
    name: Option<String>,
    pub parent_agent_id: ThreadId,
    pub status: &'static str,
    opened_at: i64,
    pub closed_at: Option<i64>,
}

pub async fn list(state: &ThreadState) -> anyhow::Result<Vec<Subagent>> {
    let engine = &state.engine;
    let ids = engine
        .manager
        .list_agent_subtree_thread_ids(state.id)
        .await?;
    let mut subagents = Vec::new();
    for id in ids.into_iter().filter(|id| *id != state.id) {
        let edge = engine.agent_graph.edge(id).await;
        let live = match engine.manager.get_thread(id).await {
            Ok(thread) => Some(thread.config_snapshot().await),
            Err(error)
                if matches!(
                    error.details(),
                    codex_protocol::error::CodexErrorDetails::ThreadNotFound(_)
                ) =>
            {
                None
            }
            Err(error) => return Err(error.into()),
        };
        let stored = if live.as_ref().is_some_and(|config| config.ephemeral) {
            None
        } else {
            match engine.read_stored_thread(id).await {
                Ok(stored) => Some(stored),
                // Graph persistence can precede rollout materialization or outlive a cancelled spawn.
                Err(ThreadStoreError::ThreadNotFound { .. })
                    if live.is_some() || edge.is_some() =>
                {
                    None
                }
                Err(error) => return Err(error).context(format!("Cannot read subagent {id}")),
            }
        };
        let parent_agent_id = edge
            .map(|edge| edge.parent)
            .or_else(|| {
                live.as_ref()
                    .and_then(|config| {
                        config
                            .parent_thread_id
                            .or(config.session_source.parent_thread_id())
                    })
                    .or_else(|| stored.as_ref().and_then(|thread| thread.parent_thread_id))
            })
            .with_context(|| format!("Subagent {id} has no parent metadata"))?;
        let name = live
            .as_ref()
            .and_then(|config| config.session_source.get_nickname())
            .or_else(|| {
                stored
                    .as_ref()
                    .and_then(|thread| thread.agent_nickname.clone())
            });
        let opened_at = match stored {
            Some(thread) => thread.created_at.timestamp(),
            None => creation_timestamp(id)?,
        };
        subagents.push(Subagent {
            id,
            object: "agent.session.subagent",
            session_id: state.id,
            name,
            parent_agent_id,
            status: if edge.is_some_and(|edge| edge.status == ThreadSpawnEdgeStatus::Closed) {
                "closed"
            } else {
                "active"
            },
            opened_at,
            closed_at: edge.and_then(|edge| edge.closed_at),
        });
    }
    Ok(subagents)
}

pub async fn read_history(
    state: &ThreadState,
    subagent_id: Option<ThreadId>,
) -> anyhow::Result<Vec<codex_history::RolloutItem>> {
    let id = subagent_id.unwrap_or(state.id);
    anyhow::ensure!(
        state
            .engine
            .manager
            .list_agent_subtree_thread_ids(state.id)
            .await?
            .contains(&id),
        "Thread is not part of this session"
    );
    // Flush an already loaded runtime only; history reads never load or resume children.
    match state.engine.manager.get_thread(id).await {
        Ok(thread) => {
            if !matches!(
                thread.agent_status().await,
                codex_protocol::protocol::AgentStatus::Shutdown
                    | codex_protocol::protocol::AgentStatus::NotFound
            ) {
                thread.ensure_rollout_materialized().await;
                thread.flush_rollout().await?;
            }
        }
        Err(error)
            if matches!(
                error.details(),
                codex_protocol::error::CodexErrorDetails::ThreadNotFound(_)
            ) => {}
        Err(error) => return Err(error.into()),
    }
    Ok(state
        .engine
        .store
        .load_history(LoadThreadHistoryParams {
            thread_id: id,
            include_archived: true,
        })
        .await?
        .items)
}

fn creation_timestamp(id: ThreadId) -> anyhow::Result<i64> {
    // Codex-generated thread IDs are UUIDv7; their first 48 bits are Unix milliseconds.
    let id = id.to_string();
    anyhow::ensure!(
        id.as_bytes()[14] == b'7',
        "Subagent creation time unavailable for {id}"
    );
    let timestamp = id[..8].to_owned() + &id[9..13];
    Ok(i64::from_str_radix(&timestamp, 16)? / 1000)
}

struct SubmissionCapture {
    owner: Weak<ThreadState>,
    child_id: ThreadId,
    instance_id: u64,
}

impl Drop for SubmissionCapture {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.upgrade()
            && let Ok(mut instances) = owner.child_instances.write()
            && let Some(current) = instances.get_mut(&self.child_id)
            && current.id == self.instance_id
        {
            current.during_submission.take();
        }
    }
}

// Only a live, already observed descendant is an input destination. Capture
// its authority and optional observed turn together, before releasing the lock.
// A reader without SDK Control can be observed but cannot grant SDK input.
pub async fn instance(
    state: &Arc<ThreadState>,
    id: ThreadId,
) -> anyhow::Result<Option<(u64, String, Option<Arc<Turn>>)>> {
    ensure!(
        id != state.id
            && state
                .engine
                .manager
                .list_agent_subtree_thread_ids(state.id)
                .await?
                .contains(&id),
        "Thread is not a child of this Session"
    );
    let Ok(thread) = state.engine.manager.get_thread(id).await else {
        return Ok(None);
    };
    let instances = state
        .child_instances
        .read()
        .map_err(|_| anyhow::anyhow!("Native child state unavailable"))?;
    Ok(instances
        .get(&id)
        .filter(|current| Weak::ptr_eq(&current.thread, &Arc::downgrade(&thread)))
        .and_then(|current| {
            thread
                .thread_extension_data()
                .get::<crate::native_interception::Control>()
                .map(|control| {
                    (
                        current.id,
                        control.incarnation.clone(),
                        current.turn.clone(),
                    )
                })
        }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChildInput {
    input: Vec<UserInput>,
}

pub async fn submit(
    state: &Arc<ThreadState>,
    child_id: ThreadId,
    instance_id: u64,
    value: serde_json::Value,
) -> anyhow::Result<Arc<Turn>> {
    use codex_otel::sdk_trace::FutureExt as _;

    let input: ChildInput = crate::config::decode(value)?;
    ensure!(
        !input.input.is_empty()
            && input.input.iter().all(|part| matches!(
                part,
                UserInput::Text { .. } | UserInput::Image { .. } | UserInput::LocalImage { .. }
            )),
        "Child submission requires text or image user input"
    );
    // Serialize SDK admission and close operations; Core still owns admission
    // against concurrently submitted native followups and steers.
    let _mutation = state.mutations.lock().await;
    ensure!(
        instance(state, child_id)
            .await?
            .is_some_and(|(current, _, _)| current == instance_id),
        "Native child instance changed or is no longer live"
    );
    let thread = {
        let mut instances = state
            .child_instances
            .write()
            .map_err(|_| anyhow::anyhow!("Native child state unavailable"))?;
        let current = instances
            .get_mut(&child_id)
            .filter(|current| current.id == instance_id)
            .context("Native child is no longer live")?;
        let thread = current
            .thread
            .upgrade()
            .context("Native child is no longer live")?;
        current.during_submission = Some(HashMap::new());
        thread
    };
    let _capture = SubmissionCapture {
        owner: Arc::downgrade(state),
        child_id,
        instance_id,
    };
    let control = thread
        .thread_extension_data()
        .get::<crate::native_interception::Control>()
        .context("Native child admission is unavailable")?;
    ensure!(
        control.has_native_agents(),
        "Child submission requires current NativeAgents ownership"
    );
    let mut request = TurnInputRequest::new(TurnInput::UserInput {
        content: input.input,
        client_id: None,
    });
    let creation_tracing = control.creation_tracing();
    request.trace = control.creation_trace()?;
    let settlement = thread
        .thread_extension_data()
        .get::<crate::turn_settlement::Settlement>()
        .context("Native child submission lost its turn owner")?;
    crate::graph_stop::submit(state, &serde_json::json!({})).await?;
    {
        let instances = state
            .child_instances
            .read()
            .map_err(|_| anyhow::anyhow!("Native child state unavailable"))?;
        instances
            .get(&child_id)
            .filter(|current| {
                current.id == instance_id && Weak::ptr_eq(&current.thread, &Arc::downgrade(&thread))
            })
            .context("Native child changed before submission")?;
    }
    // A terminal task can still own Core's active slot after completion;
    // aborts may never emit idle. Settle that exact native receipt before the
    // first input request. Reading an old Turn result never has this authority.
    settlement.finish_child_before_submit(&thread).await?;
    {
        let instances = state
            .child_instances
            .read()
            .map_err(|_| anyhow::anyhow!("Native child state unavailable"))?;
        ensure!(
            instances.get(&child_id).is_some_and(|current| {
                current.id == instance_id && Weak::ptr_eq(&current.thread, &Arc::downgrade(&thread))
            }),
            "Native child changed while finishing its previous turn"
        );
    }
    crate::graph_stop::check_after_wait(state, &serde_json::json!({}))?;
    let init = thread.config_snapshot().await.turn_extension_init;
    let turn_id = match settlement
        .start_child(state, &thread, request.clone(), init, || {
            let instances = state
                .child_instances
                .read()
                .map_err(|_| anyhow::anyhow!("Native child state unavailable"))?;
            ensure!(
                instances.get(&child_id).is_some_and(|current| {
                    current.id == instance_id
                        && Weak::ptr_eq(&current.thread, &Arc::downgrade(&thread))
                }),
                "Native child changed while waiting for admission"
            );
            Ok(())
        })
        .with_context(crate::lease_context(creation_tracing.as_deref())?)
        .await?
    {
        StartIfIdleSubmission::Started { turn_id } => turn_id,
        StartIfIdleSubmission::NotSubmitted {
            reason: NotSubmittedReason::NotIdle,
        } => {
            crate::graph_stop::check_after_wait(state, &serde_json::json!({}))?;
            let expected = control
                .active_turn_id()
                .context("Native child no longer has an active turn to steer")?;
            // Attach before Core can record input or publish completion. The
            // sole event reader may beat this submit's acknowledgement.
            let receipt = settlement
                .admission_ready(&expected)?
                .context("Native child turn changed")?;
            let steering_id = receipt
                .reserve_steering()
                .context("Native child does not accept managed steering")?;
            let mut request = request;
            request.trace = receipt
                .tracing
                .as_ref()
                .map(|tracing| codex_otel::sdk_trace::trace_carrier(tracing.token()))
                .transpose()
                .map_err(anyhow::Error::msg)?
                .or_else(|| control.raw_creation_trace());
            if let TurnInput::UserInput { client_id, .. } = &mut request.input {
                *client_id = Some(steering_id.clone());
            }
            {
                let mut instances = state
                    .child_instances
                    .write()
                    .map_err(|_| anyhow::anyhow!("Native child state unavailable"))?;
                let current = instances
                    .get_mut(&child_id)
                    .filter(|current| {
                        current.id == instance_id
                            && Weak::ptr_eq(&current.thread, &Arc::downgrade(&thread))
                    })
                    .context("Native child changed before steering")?;
                let turn = current.submission_turn(state, child_id, &expected);
                let owner = turn.sdk_admission.get_or_init(|| receipt.clone());
                ensure!(
                    Arc::ptr_eq(owner, &receipt),
                    "Native child turn ownership changed"
                );
            }
            match thread
                .steer_turn(request, expected)
                .with_context(crate::lease_context(receipt.tracing.as_deref())?)
                .await
            {
                Ok(SteerSubmission::Steered { turn_id }) => {
                    receipt.confirm_admission();
                    turn_id
                }
                Ok(SteerSubmission::NotSubmitted { reason }) => {
                    receipt.discard_steering(&steering_id);
                    anyhow::bail!("Native child steer was not submitted: {reason:?}")
                }
                Err(error) => {
                    receipt.discard_steering(&steering_id);
                    return Err(error.into());
                }
            }
        }
        StartIfIdleSubmission::NotSubmitted { reason } => {
            anyhow::bail!("Native child input was not submitted: {reason:?}")
        }
    };
    let mut instances = state
        .child_instances
        .write()
        .map_err(|_| anyhow::anyhow!("Native child state unavailable"))?;
    let current = instances
        .get_mut(&child_id)
        .filter(|current| {
            current.id == instance_id && Weak::ptr_eq(&current.thread, &Arc::downgrade(&thread))
        })
        .context("Native child closed before its admission receipt")?;
    Ok(current.acknowledge_submission(state, child_id, &turn_id))
}

fn owns_turn(state: &ThreadState, turn: &Arc<Turn>) -> anyhow::Result<bool> {
    let instances = state
        .child_instances
        .read()
        .map_err(|_| anyhow::anyhow!("Native child state unavailable"))?;
    Ok(!state.is_closed()
        && instances.get(&turn.child_id).is_some_and(|current| {
            current.id == turn.instance_id
                && Weak::ptr_eq(&current.thread, &turn.thread)
                && current
                    .turn
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, turn))
        }))
}

pub async fn continue_retained(
    state: &Arc<ThreadState>,
    turn: &Arc<Turn>,
) -> anyhow::Result<Option<Arc<Turn>>> {
    use codex_otel::sdk_trace::FutureExt as _;

    ensure!(
        Weak::ptr_eq(&turn.owner, &Arc::downgrade(state)),
        "Child turn belongs to another Session"
    );
    let Some(receipt) = turn.sdk_admission.get() else {
        return Ok(None);
    };
    // This is invoked only after Python callback settlement, never by wait().
    // Do not wait for a result while holding the SDK admission lock.
    if !turn
        .result
        .borrow()
        .as_ref()
        .is_some_and(|outcome| outcome.terminal && outcome.result.is_ok())
    {
        return Ok(None);
    }
    let _mutation = state.mutations.lock().await;
    if !owns_turn(state, turn)?
        || !instance(state, turn.child_id)
            .await?
            .is_some_and(|(id, incarnation, _)| {
                id == turn.instance_id && incarnation == turn.incarnation
            })
    {
        return Ok(None);
    }
    let Some(thread) = turn.thread.upgrade() else {
        return Ok(None);
    };
    let control = thread
        .thread_extension_data()
        .get::<crate::native_interception::Control>()
        .context("Native child continuation lost its tracing owner")?;
    let settlement = thread
        .thread_extension_data()
        .get::<crate::turn_settlement::Settlement>()
        .context("Native child continuation lost its turn owner")?;
    if !settlement.is_current(receipt)
        || !settlement.can_continue_id(&turn.turn_id)
        || !crate::graph_stop::continuation_allowed(state)
    {
        return Ok(None);
    }
    settlement.finish_child_before_submit(&thread).await?;
    let mut init = thread.config_snapshot().await.turn_extension_init;
    if !owns_turn(state, turn)?
        || !settlement.is_current(receipt)
        || !settlement.can_continue_id(&turn.turn_id)
        || !crate::graph_stop::continuation_allowed(state)
    {
        return Ok(None);
    }
    {
        let mut instances = state
            .child_instances
            .write()
            .map_err(|_| anyhow::anyhow!("Native child state unavailable"))?;
        let current = instances
            .get_mut(&turn.child_id)
            .context("Native child is no longer live")?;
        current.during_submission = Some(HashMap::new());
    }
    let _capture = SubmissionCapture {
        owner: Arc::downgrade(state),
        child_id: turn.child_id,
        instance_id: turn.instance_id,
    };
    let mut request = TurnInputRequest::new(TurnInput::ResponseItem(ContextualUserFragment::into(
        InternalModelContextFragment::new(
            InternalContextSource::from_static("agents_steering"),
            "Continue with the latest user input already in the conversation. Do not repeat completed work.",
        ),
    )));
    request.trace = receipt
        .tracing
        .as_ref()
        .map(|tracing| codex_otel::sdk_trace::trace_carrier(tracing.token()))
        .transpose()
        .map_err(anyhow::Error::msg)?
        .or_else(|| control.raw_creation_trace());

    let seed = Arc::new(crate::turn_settlement::Seed::default());
    init.insert(seed.clone());
    let submitted = thread
        .continue_turn_if_idle(
            WithTurnExtensionData::new(request, init),
            turn.turn_id.clone(),
        )
        .with_context(crate::lease_context(receipt.tracing.as_deref())?)
        .await?;
    let turn_id = match submitted {
        TurnInputSubmission::Started { turn_id } => {
            seed.confirm(&turn_id);
            turn_id
        }
        TurnInputSubmission::NotSubmitted {
            reason: NotSubmittedReason::Superseded | NotSubmittedReason::PendingTriggerTurn,
        } => return Ok(None),
        TurnInputSubmission::NotSubmitted {
            reason: NotSubmittedReason::NotIdle,
        } if !owns_turn(state, turn)? || !settlement.is_current(receipt) => {
            return Ok(None);
        }
        _ => anyhow::bail!("Native child continuation was not admitted"),
    };
    let mut instances = state
        .child_instances
        .write()
        .map_err(|_| anyhow::anyhow!("Native child state unavailable"))?;
    let current = instances
        .get_mut(&turn.child_id)
        .filter(|current| {
            current.id == turn.instance_id && Weak::ptr_eq(&current.thread, &turn.thread)
        })
        .context("Native child closed before its continuation receipt")?;
    Ok(Some(current.acknowledge_submission(
        state,
        turn.child_id,
        &turn_id,
    )))
}

#[cfg(test)]
mod terminal_error_tests {
    use super::*;
    use serde_json::json;

    fn turn(incarnation: &str) -> Turn {
        Turn {
            child_id: ThreadId::new(),
            instance_id: 1,
            incarnation: incarnation.into(),
            turn_id: "same-id".into(),
            owner: Weak::new(),
            thread: Weak::new(),
            result: watch::channel(None).0,
            sdk_admission: OnceLock::new(),
            cancel_cleanup: Mutex::new(None),
        }
    }

    #[tokio::test]
    async fn cached_terminal_is_published_before_wait_rejects_and_stays_on_that_handle() {
        let old = turn("old-runtime");
        let new = turn("new-runtime");
        assert!(old.terminal_error().is_none());
        let details = json!({"message":"provider rejected", "codex_error_info":"Unauthorized",
            "_sdk_provider_error":{"status_code":401,"code":"invalid_api_key","request_id":"old"}});
        old.finish_with_error(
            Err("Native child turn failed".into()),
            true,
            None,
            Some(details.clone()),
        );
        assert_eq!(
            old.wait_with_usage().await.unwrap_err().to_string(),
            "Native child turn failed"
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&old.terminal_error().unwrap()).unwrap(),
            details
        );
        assert!(new.terminal_error().is_none());
        old.finish(
            Err("Native child runtime closed or was replaced".into()),
            false,
            None,
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&old.terminal_error().unwrap()).unwrap(),
            details
        );
    }

    #[tokio::test]
    async fn successful_and_nonprovider_child_outcomes_do_not_invent_terminal_details() {
        let success = turn("success");
        success.finish(Ok("answer".into()), true, None);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&success.wait_with_usage().await.unwrap())
                .unwrap(),
            json!({"final_output":"answer","usage":null})
        );
        assert!(success.terminal_error().is_none());
        let retired = turn("retired");
        retired.finish(
            Err("Native child runtime closed or was replaced".into()),
            false,
            None,
        );
        assert!(retired.wait_with_usage().await.is_err());
        assert!(retired.terminal_error().is_none());
    }

    #[tokio::test]
    async fn only_interrupted_child_abort_publishes_the_interruption_marker() {
        let interrupted = turn("interrupted");
        interrupted.finish_aborted(&TurnAbortReason::Interrupted, None);
        assert!(interrupted.wait_with_usage().await.is_err());
        let details = interrupted.terminal_error().unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&details).unwrap(),
            json!({"_sdk_child_interrupted": true})
        );

        for reason in [
            TurnAbortReason::Replaced,
            TurnAbortReason::ReviewEnded,
            TurnAbortReason::BudgetLimited,
        ] {
            let aborted = turn("aborted");
            aborted.finish_aborted(&reason, None);
            assert!(aborted.wait_with_usage().await.is_err());
            assert!(aborted.terminal_error().is_none());
        }
    }
}
