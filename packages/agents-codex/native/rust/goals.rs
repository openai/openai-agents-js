//! Local and retained checkpoint goals backed by the native goal store.

use std::sync::Arc;

use anyhow::{Context, Result, ensure};
use chrono::DateTime;
use codex_core::context::UserGoalUpdate;
use codex_core_api::{Config, StateDbHandle};
use codex_goal_extension::{
    GoalObjectiveUpdate, GoalService, GoalServiceError, GoalSetRequest, GoalTokenBudgetUpdate,
};
use codex_protocol::ThreadId;
use codex_protocol::protocol::{ThreadGoal, ThreadGoalStatus, validate_thread_goal_objective};
use serde::{Deserialize, Serialize};

use crate::engine::{EngineState, ThreadState};
use crate::local_storage::LocalChecklistStore;

pub(crate) fn tool_names() -> std::collections::HashSet<codex_tools::ToolName> {
    [
        codex_goal_extension::CREATE_GOAL_TOOL_NAME,
        codex_goal_extension::GET_GOAL_TOOL_NAME,
        codex_goal_extension::UPDATE_GOAL_TOOL_NAME,
    ]
    .into_iter()
    .map(|name| codex_tools::ToolName::plain(name).with_default_namespace())
    .collect()
}

async fn local_authority(
    state: &ThreadState,
) -> Result<(&LocalChecklistStore, &GoalBackend, Arc<Config>)> {
    ensure!(!state.is_closed(), "goal owner is closed");
    let store = state
        .engine
        .local_checklist_store
        .as_ref()
        .context("goal requires local storage")?;
    let backend = state
        .engine
        .goals
        .as_ref()
        .context("goal requires current goal storage")?;
    let config = state.thread.config().await;
    ensure!(
        !config.ephemeral && config.features.enabled(codex_core_api::Feature::Goals),
        "goal requires current NativeGoals"
    );
    Ok((store, backend, config))
}

pub(crate) async fn read(state: &ThreadState) -> Result<Option<serde_json::Value>> {
    let (store, backend, _) = local_authority(state).await?;
    store.check_failure(Some(state.id)).await?;
    let goal = backend
        .service
        .get_thread_goal(&backend.state_db, state.id)
        .await?;
    store.check_failure(Some(state.id)).await?;
    Ok(goal.map(goal_value))
}

/// The caller holds the native mutation lock through validation and publication.
pub(crate) async fn set_paused(
    state: &ThreadState,
    objective: &str,
    token_budget: Option<i64>,
) -> Result<serde_json::Value> {
    let (store, backend, config) = local_authority(state).await?;
    let snapshot = state.thread.config_snapshot().await;
    ensure!(
        !snapshot.session_source.is_non_root_agent() && snapshot.parent_thread_id.is_none(),
        "setPausedGoal requires a root thread"
    );
    let tools = state
        .thread
        .thread_extension_data()
        .get::<crate::python_tools::PythonTools>()
        .context("setPausedGoal requires a managed Session")?;
    tools.check_idle(&state.thread).await?;
    store.check_failure(Some(state.id)).await?;

    let objective = objective.trim();
    let status = Some(ThreadGoalStatus::Paused);
    let outcome = backend
        .service
        .set_thread_goal(
            &backend.state_db,
            GoalSetRequest {
                thread_id: state.id,
                objective: GoalObjectiveUpdate::Set(objective),
                status,
                token_budget: token_budget.map_or(GoalTokenBudgetUpdate::Keep, |budget| {
                    GoalTokenBudgetUpdate::Set(Some(budget))
                }),
                max_goal_token_budget: config.max_goal_token_budget,
            },
            async {
                state
                    .thread
                    .record_user_goal_update(UserGoalUpdate::Set {
                        objective: Some(objective.to_owned()),
                        status,
                    })
                    .await
                    .map_err(|err| {
                        GoalServiceError::Internal(format!(
                            "failed to record goal instruction: {err}"
                        ))
                    })
            },
        )
        .await?;
    outcome.apply_runtime_effects(&backend.service).await;
    Ok(goal_value(outcome.goal))
}

fn goal_value(goal: ThreadGoal) -> serde_json::Value {
    let mut value = serde_json::json!({
        "threadId": goal.thread_id.to_string(),
        "objective": goal.objective,
        "status": goal.status,
        "tokensUsed": goal.tokens_used.to_string(),
        "timeUsedSeconds": goal.time_used_seconds.to_string(),
        "createdAt": goal.created_at.to_string(),
        "updatedAt": goal.updated_at.to_string(),
    });
    if let Some(budget) = goal.token_budget {
        value["tokenBudget"] = budget.to_string().into();
    }
    value
}

/// Constructed only from current application runtime configuration.
pub struct GoalBackend {
    pub state_db: StateDbHandle,
    pub service: Arc<GoalService>,
}

/// Portable data only. Neither native goal identity nor request authority is imported.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GoalSnapshot {
    pub(crate) thread_id: ThreadId,
    objective: String,
    status: ThreadGoalStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    token_budget: Option<i64>,
    #[serde(default)]
    tokens_used: i64,
    #[serde(default)]
    time_used_seconds: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    created_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    updated_at: Option<i64>,
}

impl GoalSnapshot {
    pub fn validate(&self, id: ThreadId) -> Result<()> {
        ensure!(
            self.thread_id == id,
            "checkpoint goal thread identity mismatch"
        );
        ensure!(
            matches!(
                self.status,
                ThreadGoalStatus::Paused | ThreadGoalStatus::Complete
            ),
            "checkpoint goals must be paused or complete"
        );
        validate_thread_goal_objective(self.objective.trim()).map_err(anyhow::Error::msg)?;
        ensure!(
            self.token_budget.is_none_or(|budget| budget > 0)
                && self.tokens_used >= 0
                && self.time_used_seconds >= 0,
            "invalid checkpoint goal budget or usage"
        );
        ensure!(
            [self.created_at, self.updated_at]
                .into_iter()
                .flatten()
                .all(|time| time >= 0 && DateTime::from_timestamp(time, 0).is_some()),
            "checkpoint goal timestamps exceed native timestamp range"
        );
        Ok(())
    }

    pub async fn capture(backend: &GoalBackend, id: ThreadId) -> Result<Option<Self>> {
        let current = backend
            .service
            .get_thread_goal(&backend.state_db, id)
            .await?;
        current
            .map(|current| {
                let result = Self {
                    thread_id: current.thread_id,
                    objective: current.objective,
                    status: current.status,
                    token_budget: current.token_budget,
                    tokens_used: current.tokens_used,
                    time_used_seconds: current.time_used_seconds,
                    created_at: Some(current.created_at),
                    updated_at: Some(current.updated_at),
                };
                result.validate(id)?;
                Ok(result)
            })
            .transpose()
    }

    /// Check before importing any records so corrected restore remains possible.
    pub async fn check_restore(&self, backend: &GoalBackend, config: &Config) -> Result<()> {
        if let (Some(budget), Some(maximum)) = (self.token_budget, config.max_goal_token_budget) {
            ensure!(
                budget <= maximum,
                "checkpoint goal token budget exceeds the maximum allowed goal token budget"
            );
        }
        ensure!(
            backend
                .service
                .get_thread_goal(&backend.state_db, self.thread_id)
                .await?
                .is_none(),
            "checkpoint goal already exists in the configured goal store"
        );
        Ok(())
    }

    pub async fn restore(self, engine: &EngineState, config: &Config) -> Result<()> {
        self.validate(self.thread_id)?;
        let backend = engine
            .goals
            .as_ref()
            .context("checkpoint goals require current native goal storage")?;
        self.check_restore(backend, config).await?;
        backend
            .ensure_thread(engine, config, self.thread_id)
            .await?;
        let outcome = backend
            .service
            .set_thread_goal(
                &backend.state_db,
                GoalSetRequest {
                    thread_id: self.thread_id,
                    objective: GoalObjectiveUpdate::Set(&self.objective),
                    status: Some(self.status),
                    token_budget: GoalTokenBudgetUpdate::Set(self.token_budget),
                    max_goal_token_budget: config.max_goal_token_budget,
                },
                // History already contains the goal. Never resubmit its work.
                async { Ok(()) },
            )
            .await?;
        let mut fresh = backend
            .state_db
            .thread_goals()
            .get_thread_goal(self.thread_id)
            .await?
            .context("newly created checkpoint goal is missing")?;
        fresh.tokens_used = self.tokens_used;
        fresh.time_used_seconds = self.time_used_seconds;
        if let Some(time) = self.created_at {
            fresh.created_at = DateTime::from_timestamp(time, 0)
                .context("checkpoint goal created_at exceeds native timestamp range")?;
        }
        if let Some(time) = self.updated_at {
            fresh.updated_at = DateTime::from_timestamp(time, 0)
                .context("checkpoint goal updated_at exceeds native timestamp range")?;
        }
        // Keep the identity assigned by GoalService. This write defers continuation.
        backend
            .state_db
            .thread_goals()
            .replace_thread_goal_snapshot(&fresh)
            .await?;
        outcome.apply_runtime_effects(&backend.service).await;
        Ok(())
    }
}

impl GoalBackend {
    async fn ensure_thread(
        &self,
        engine: &EngineState,
        config: &Config,
        id: ThreadId,
    ) -> Result<()> {
        // Inert imported children have no active native thread lifecycle to
        // register their required state-db metadata. Create only that row;
        // the SDK's memory thread store still owns all rollout history.
        if self.state_db.get_thread(id).await?.is_none() {
            let thread = engine.read_stored_thread(id).await?;
            let mut metadata = codex_state::ThreadMetadataBuilder::new(
                id,
                config
                    .codex_home
                    .as_path()
                    .join(format!("sdk-memory-{id}.jsonl")),
                thread.created_at,
                thread.source,
            );
            metadata.history_mode = thread.history_mode;
            metadata.cwd = thread.cwd;
            metadata.originator = thread.originator;
            metadata.model_provider = Some(thread.model_provider.clone());
            metadata.updated_at = Some(thread.updated_at);
            metadata.recency_at = Some(thread.recency_at);
            metadata.agent_role = thread.agent_role;
            metadata.agent_nickname = thread.agent_nickname;
            metadata.agent_path = thread.agent_path;
            self.state_db
                .insert_thread_if_absent(&metadata.build(&thread.model_provider))
                .await?;
        }
        Ok(())
    }
}
