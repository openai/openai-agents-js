//! Portable replay state for a whole native session tree. Live work is never resumed.

use std::collections::HashSet;
use std::sync::Arc;

use anyhow::{Context, ensure};
use codex_agent_graph_store::ThreadSpawnEdgeStatus;
use codex_core_api::{AbsolutePathBuf, InitialHistory, ThreadId};
use codex_history::{ResumedHistory, RolloutItem};
use codex_protocol::dynamic_tools::DynamicToolSpec;
use codex_protocol::protocol::{
    AgentStatus, EventMsg, SessionMeta, ThreadMemoryMode, TurnAbortReason, TurnAbortedEvent,
};
use codex_thread_store::{
    AppendThreadItemsParams, ArchiveThreadParams, CreateThreadParams, PersistContext,
    ReadThreadParams, StoredThread, ThreadMetadataPatch, ThreadPersistenceMetadata,
    ThreadStoreError, UpdateThreadMetadataParams,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    NativeThread,
    engine::{EngineState, ThreadState},
    options,
};

/// Immutable portable data on the existing thread owner; it grants no tools.
pub(crate) struct ForkMetadata {
    goal: Option<crate::goals::GoalSnapshot>,
    checklist: Option<crate::storage::ChecklistState>,
    code_mode: Option<codex_code_mode::CodeModeSnapshot>,
    executor_policy_digest: Option<String>,
}

/// Select fresh source declarations before allocation; saved state grants nothing.
pub(crate) fn restore_specs(
    payload: &Value,
    options: &mut options::ThreadOptions,
    specs: Option<Vec<DynamicToolSpec>>,
) -> anyhow::Result<Option<Vec<DynamicToolSpec>>> {
    let Some(opening) = &options.agent_profiles else {
        return Ok(specs);
    };
    ensure!(specs.is_some(), "Agent profiles require managed tools");
    let history: Vec<RolloutItem> = serde_json::from_value(payload["history"].clone())?;
    let (specs, _) = opening.restore_catalog(&history, &payload["managed_tool_specs"])?;
    // ProfileCatalog restores manual slots from the same fresh source template;
    // JavaScript's separate manual-name API retains its native grant fences.
    Ok(Some(specs))
}

impl ForkMetadata {
    pub(crate) fn validate_identity(&self, id: ThreadId) -> anyhow::Result<()> {
        if let Some(goal) = &self.goal {
            goal.validate(id)?;
        }
        if let Some(checklist) = &self.checklist {
            ensure!(
                checklist.thread_id == id,
                "retained checklist identity mismatch"
            );
        }
        if let Some(snapshot) = &self.code_mode {
            snapshot.validate().map_err(anyhow::Error::msg)?;
        }
        Ok(())
    }

    pub(crate) fn capture(source: &Value, id: ThreadId) -> anyhow::Result<Self> {
        ensure!(
            source["source_session_id"] == serde_json::to_value(id)?,
            "fork metadata source identity mismatch"
        );
        let goal: Option<crate::goals::GoalSnapshot> =
            serde_json::from_value(source["root_goal"].clone())?;
        let checklist: Option<crate::storage::ChecklistState> =
            serde_json::from_value(source["root_checklist"].clone())?;
        let code_mode: Option<codex_code_mode::CodeModeSnapshot> =
            serde_json::from_value(source["root_code_mode"].clone())?;
        if let Some(snapshot) = &code_mode {
            ensure!(
                source["format_version"] == 4,
                "code-mode state requires native checkpoint version 4"
            );
            snapshot.validate().map_err(anyhow::Error::msg)?;
        }
        if let Some(goal) = &goal {
            goal.validate(id)?;
        }
        if let Some(checklist) = &checklist {
            let history: Vec<RolloutItem> = serde_json::from_value(source["history"].clone())?;
            checklist.validate(id, &history)?;
        }
        Ok(Self {
            goal,
            checklist,
            code_mode,
            executor_policy_digest: serde_json::from_value(
                source["executor_policy_digest"].clone(),
            )?,
        })
    }

    pub(crate) fn code_state(&self) -> Option<&codex_code_mode::CodeModeSnapshot> {
        self.code_mode.as_ref()
    }

    pub(crate) fn retarget(&mut self, id: ThreadId) {
        if let Some(goal) = &mut self.goal {
            goal.thread_id = id;
        }
        if let Some(checklist) = &mut self.checklist {
            checklist.thread_id = id;
        }
    }

    pub(crate) fn overlay(&self, copied: &mut Value, id: ThreadId) -> anyhow::Result<()> {
        ensure!(
            copied["source_session_id"] == serde_json::to_value(id)?,
            "fork metadata copy identity mismatch"
        );
        if let Some(goal) = &self.goal {
            goal.validate(id)?;
            ensure!(
                copied["root_goal"].is_null(),
                "retained goal conflicts with a backend goal"
            );
            copied["root_goal"] = serde_json::to_value(goal)?;
        }
        if let Some(checklist) = &self.checklist {
            let history: Vec<RolloutItem> = serde_json::from_value(copied["history"].clone())?;
            checklist.validate(id, &history)?;
            copied["root_checklist"] = serde_json::to_value(checklist)?;
        }
        // A live or staged namespace supersedes the immutable fork fallback.
        if copied["root_code_mode"].is_null()
            && let Some(snapshot) = &self.code_mode
        {
            snapshot.validate().map_err(anyhow::Error::msg)?;
            copied["root_code_mode"] = serde_json::to_value(snapshot)?;
            copied["format_version"] = serde_json::json!(4);
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
pub struct Checkpoint {
    format_version: u32,
    codex_revision: String,
    source_session_id: ThreadId,
    history: Vec<RolloutItem>,
    root_metadata: StoredThread,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    root_memory_mode: Option<ThreadMemoryMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    root_checklist: Option<crate::storage::ChecklistState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    root_goal: Option<crate::goals::GoalSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    root_code_mode: Option<codex_code_mode::CodeModeSnapshot>,
    #[serde(default)]
    descendants: Vec<Descendant>,
    #[serde(default)]
    interrupted_thread_ids: Vec<ThreadId>,
    // Do not deserialize saved declarations into DynamicToolSpec: Core ignores
    // unknown fields there. Compare the complete saved value to trusted specs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    managed_tool_specs: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    root_turn_budget: Option<crate::response_control::BudgetSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    executor_policy_digest: Option<String>,
}

#[derive(Default)]
pub(crate) struct InitialModels {
    pub root_model: Option<String>,
    pub descendant_models: Vec<String>,
}

impl Checkpoint {
    /// Validate imported data without opening an engine, executor or writer.
    fn validate(
        &self,
        python_specs: Option<&[DynamicToolSpec]>,
        fresh_manual: bool,
    ) -> anyhow::Result<HashSet<ThreadId>> {
        ensure!(
            matches!(self.format_version, 2 | 4),
            "unsupported checkpoint format"
        );
        ensure!(
            self.codex_revision == include_str!("../CODEX_REVISION").trim(),
            "checkpoint core revision differs"
        );
        validate_code_states(
            self.format_version,
            self.root_code_mode.iter().chain(
                self.descendants
                    .iter()
                    .filter_map(|child| child.code_mode.as_ref()),
            ),
        )?;
        let trusted_specs = python_specs
            .map(crate::python_tools::checkpoint_specs)
            .transpose()?;
        ensure!(
            if fresh_manual {
                // Completed effects are data, not live tool declarations. The
                // subsequent manual restore binds each pending grant against the
                // current managed catalog before recovery can run any model work.
                self.managed_tool_specs.is_some() && trusted_specs.is_some()
            } else {
                self.managed_tool_specs == trusted_specs
            },
            "checkpoint tool mode and current managed specs must match; startup checkpoints cannot convert to managed tools"
        );
        let root = self.source_session_id;
        let mut ids = HashSet::from([root]);
        validate_history(root, &self.history)?;
        imported_memory_mode(root, &self.history, self.root_memory_mode)?;
        if let Some(checklist) = &self.root_checklist {
            checklist.validate(root, &self.history)?;
        }
        if let Some(goal) = &self.root_goal {
            goal.validate(root)?;
        }
        ensure!(
            self.root_metadata.thread_id == root,
            "checkpoint root metadata identity mismatch"
        );
        for child in &self.descendants {
            ensure!(ids.insert(child.thread_id), "duplicate checkpoint thread");
            let meta = validate_history(child.thread_id, &child.history)?;
            imported_memory_mode(child.thread_id, &child.history, child.memory_mode)?;
            if let Some(checklist) = &child.checklist {
                checklist.validate(child.thread_id, &child.history)?;
            }
            if let Some(goal) = &child.goal {
                goal.validate(child.thread_id)?;
            }
            ensure!(
                meta.parent_thread_id == Some(child.parent_thread_id)
                    && child.metadata.thread_id == child.thread_id,
                "checkpoint child identity mismatch"
            );
            ensure!(
                matches!(child.status.as_str(), "active" | "closed"),
                "invalid checkpoint child status"
            );
            ensure!(
                child.status == "closed" || child.closed_at.is_none(),
                "active checkpoint child has a close timestamp"
            );
        }
        // Validate the entire graph before writing any native records.
        for child in &self.descendants {
            let mut path = HashSet::from([child.thread_id]);
            let mut parent = child.parent_thread_id;
            while parent != root {
                ensure!(path.insert(parent), "checkpoint graph contains a cycle");
                parent = self
                    .descendants
                    .iter()
                    .find(|entry| entry.thread_id == parent)
                    .context("checkpoint parent missing")?
                    .parent_thread_id;
            }
        }
        Ok(ids)
    }

    pub(crate) fn initial_models(
        &self,
        python_specs: Option<&[DynamicToolSpec]>,
        fresh_manual: bool,
    ) -> anyhow::Result<InitialModels> {
        self.validate(python_specs, fresh_manual)?;
        // Preserve the managed-root selection used by restore. Saved data does
        // not select credentials, current tools or other application config.
        let root_model = self.managed_tool_specs.as_ref().and_then(|_| {
            self.history.iter().rev().find_map(|item| match item {
                RolloutItem::EventMsg(EventMsg::ThreadSettingsApplied(event))
                    if event.thread_id == Some(self.source_session_id) =>
                {
                    Some(event.thread_settings.model.clone())
                }
                _ => None,
            })
        });
        let mut descendant_models = Vec::new();
        // Core restores V2 identities from individually open graph edges. An
        // active descendant behind a closed parent is still in that traversal;
        // only the closed entry itself is excluded. The engine consumes this
        // list only when the destination currently grants NativeAgents.
        for child in self
            .descendants
            .iter()
            .filter(|child| child.status == "active")
        {
            if let Some(model) = &child.metadata.model {
                if !descendant_models.contains(model) {
                    descendant_models.push(model.clone());
                }
            }
        }
        Ok(InitialModels {
            root_model,
            descendant_models,
        })
    }
}

#[derive(Serialize, Deserialize)]
struct Descendant {
    thread_id: ThreadId,
    parent_thread_id: ThreadId,
    status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    closed_at: Option<i64>,
    history: Vec<RolloutItem>,
    metadata: StoredThread,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    memory_mode: Option<ThreadMemoryMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    checklist: Option<crate::storage::ChecklistState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    goal: Option<crate::goals::GoalSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    code_mode: Option<codex_code_mode::CodeModeSnapshot>,
}

fn validate_code_states<'a>(
    format_version: u32,
    snapshots: impl Iterator<Item = &'a codex_code_mode::CodeModeSnapshot>,
) -> anyhow::Result<()> {
    for snapshot in snapshots {
        ensure!(
            format_version == 4,
            "code-mode state requires native checkpoint version 4"
        );
        snapshot.validate().map_err(anyhow::Error::msg)?;
    }
    Ok(())
}

pub(crate) type CodeStates = std::collections::HashMap<ThreadId, codex_code_mode::CodeModeSnapshot>;

pub(crate) async fn code_state(
    state: &ThreadState,
    id: ThreadId,
) -> anyhow::Result<Option<codex_code_mode::CodeModeSnapshot>> {
    code_state_for_thread(&state.engine, id).await
}

pub(crate) async fn code_state_for_thread(
    engine: &EngineState,
    id: ThreadId,
) -> anyhow::Result<Option<codex_code_mode::CodeModeSnapshot>> {
    if let Some(snapshot) = engine.interception.pending_code_state(id) {
        snapshot.validate().map_err(anyhow::Error::msg)?;
        return Ok(Some(snapshot.as_ref().clone()));
    }
    let code_enabled = engine
        .service_config
        .features
        .enabled(codex_core_api::Feature::CodeMode);
    let snapshot = match engine.manager.get_thread(id).await {
        Ok(thread) => {
            let snapshot = thread
                .export_code_mode_state()
                .await
                .map_err(anyhow::Error::msg)?;
            if snapshot.is_none() && code_enabled {
                thread.ensure_rollout_materialized().await;
                thread.flush_rollout().await?;
            }
            snapshot
        }
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
    if let Some(snapshot) = &snapshot {
        snapshot.validate().map_err(anyhow::Error::msg)?;
    }
    if snapshot.is_some() || !code_enabled {
        return Ok(snapshot);
    }
    // Missing runtime state alone cannot prove that a used namespace is empty.
    let history = engine.load_checkpoint_history(id).await?;
    check_unused_code(id, &history)?;
    Ok(Some(codex_code_mode::CodeModeSnapshot {
        format_version: 1,
        next_cell_id: 1,
        stored_values: Default::default(),
        completed_cells: Default::default(),
    }))
}

pub(crate) async fn capture_code_states(state: &ThreadState) -> anyhow::Result<CodeStates> {
    let mut snapshots = CodeStates::new();
    for id in std::iter::once(state.id).chain(
        crate::subagents::list(state)
            .await?
            .into_iter()
            .map(|child| child.id),
    ) {
        if let Some(snapshot) = code_state(state, id).await? {
            snapshots.insert(id, snapshot);
        }
    }
    Ok(snapshots)
}

pub async fn export(state: &ThreadState, pending: Option<&Value>) -> anyhow::Result<Value> {
    export_inner(state, pending, false).await
}

pub(crate) fn redact_executor_observations(history: &mut [codex_history::RolloutItem]) {
    for record in history {
        if let codex_history::RolloutItem::TurnContext(context) = record
            && let Some(receipt) = context
                .sdk_receipt
                .as_mut()
                .and_then(serde_json::Value::as_object_mut)
        {
            receipt.remove("strict_executor_writes");
            if receipt
                .get("executors")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|value| !value.is_empty())
            {
                receipt.insert("executors".to_owned(), serde_json::Value::Null);
            }
        }
    }
}

#[cfg(test)]
mod receipt_projection_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn manual_history_projection_preserves_real_changes_and_raw_capture_authority() {
        for strict in [false, true] {
            for executors in [
                json!([]),
                json!([{"headers":{"Authorization":"synthetic-private"}}]),
            ] {
                let raw: Vec<RolloutItem> = serde_json::from_value(json!([
                    {"type":"turn_context","payload":{
                        "cwd":"/work","approval_policy":"never",
                        "sandbox_policy":{"type":"read-only"},"model":"fixture","summary":"auto",
                        "sdk_receipt":{"version":1,"strict_executor_writes":strict,"executors":executors}
                    }},
                    {"type":"response_item","payload":{
                        "type":"function_call_output","call_id":"manual","output":"original"
                    }}
                ])).unwrap();
                let raw_value = serde_json::to_value(&raw).unwrap();
                let mut exported = raw.clone();
                redact_executor_observations(&mut exported);
                let exported_value = serde_json::to_value(&exported).unwrap();
                assert!(
                    exported_value[0]["payload"]["sdk_receipt"]
                        .get("strict_executor_writes")
                        .is_none()
                );
                assert!(
                    exported_value[0]["payload"]["sdk_receipt"]["executors"].is_null()
                        || exported_value[0]["payload"]["sdk_receipt"]["executors"] == json!([])
                );
                assert_eq!(serde_json::to_value(&raw).unwrap(), raw_value);
                assert_ne!(raw_value, exported_value);

                // The comparison and final export use the same idempotent projection.
                let mut comparison = raw.clone();
                redact_executor_observations(&mut comparison);
                assert_eq!(serde_json::to_value(&comparison).unwrap(), exported_value);
                redact_executor_observations(&mut exported);
                assert_eq!(serde_json::to_value(&exported).unwrap(), exported_value);

                for (record, field, replacement) in [
                    (0, "model", "changed-settings"),
                    (1, "output", "changed-tool-result"),
                ] {
                    let mut changed = raw_value.clone();
                    changed[record]["payload"][field] = json!(replacement);
                    let mut changed: Vec<RolloutItem> = serde_json::from_value(changed).unwrap();
                    redact_executor_observations(&mut changed);
                    assert_ne!(serde_json::to_value(changed).unwrap(), exported_value);
                }
            }
        }
    }
}

async fn export_inner(
    state: &ThreadState,
    pending: Option<&Value>,
    probe: bool,
) -> anyhow::Result<Value> {
    ensure!(
        state.engine.local_checklist_store.is_none(),
        "local storage cannot export portable checkpoints"
    );
    let tools = state
        .thread
        .thread_extension_data()
        .get::<crate::python_tools::PythonTools>();
    if let Some(tools) = &tools {
        tools.check_prepared_checkpoint()?;
    }
    let managed_tool_specs = if let Some(tools) = &tools {
        if let Some(key) = pending {
            check_capture(state, key)?;
        } else {
            tools.check_idle(&state.thread).await?;
        }
        Some(
            match crate::agent_profiles::active_specs(&state.thread).await? {
                Some(specs) => specs,
                None => tools.current_specs()?,
            },
        )
    } else {
        if let Some(key) = pending {
            check_capture(state, key)?;
        }
        None
    };
    let graph = state
        .thread
        .thread_extension_data()
        .get::<crate::agent_profiles::OpeningProfiles>();
    if !probe
        && graph.is_none()
        && pending.is_none()
        && state.instructions.needs_publication(true)
        && tools
            .as_ref()
            .is_none_or(|tools| !tools.has_restored_manual())
    {
        ensure!(
            state
                .thread
                .active_turn_environment_selections()
                .await
                .is_none()
                && !matches!(
                    state.thread.agent_status().await,
                    AgentStatus::Running | AgentStatus::Shutdown | AgentStatus::NotFound
                ),
            "application instructions require an idle, open native thread"
        );
        crate::application_instructions::publish_if_ready(&state.thread, true).await?;
    }
    // Graph edges alone do not record a child turn that starts and finishes
    // while VM data and history are read. Keep the existing settlement receipt
    // across both reads. A pending manual root is the one active owner allowed.
    let code_graph = if !probe {
        Some(
            async {
                let graph = ProbeGraph::observe(state, pending.is_some())?;
                graph.check(state, pending.is_some()).await?;
                Ok::<_, anyhow::Error>(graph)
            }
            .await,
        )
    } else {
        None
    };
    let before = crate::subagents::list(state).await?;
    let code_states = capture_code_states(state).await?;
    // Model metadata can select CodeMode without the feature flag. Retain the
    // pre-export receipt for every actual or retained VM snapshot, but preserve
    // legacy running-child exports that contain no VM state.
    let requires_code_graph = !code_states.is_empty()
        || state
            .engine
            .service_config
            .features
            .enabled(codex_core_api::Feature::CodeMode)
        || state
            .retained_metadata
            .get()
            .is_some_and(|metadata| metadata.code_state().is_some());
    let mut interrupted_thread_ids = Vec::new();
    let (history, root_metadata) =
        capture(&state.engine, state.id, &mut interrupted_thread_ids).await?;
    if probe && graph.is_none() {
        // Validate actual evidence before a temporary new revision could shadow it.
        state.instructions.check_usable()?;
        crate::application_instructions::latest(&history)?;
        let restored_manual = tools
            .as_ref()
            .is_some_and(|tools| tools.has_restored_manual());
        let text = state.instructions.text()?.unwrap_or_default();
        if state.instructions.needs_publication(true) && !restored_manual {
            let mut prospective = history.clone();
            prospective.push(RolloutItem::ResponseItem(
                crate::application_instructions::publication(&text).into(),
            ));
            crate::application_instructions::validate(&prospective, &text)?;
        } else {
            crate::application_instructions::validate(&history, &text)?;
        }
    }
    if probe && let Some(graph) = &graph {
        crate::agent_profiles::validate_restored(graph, &history)?;
    }
    let root_memory_mode = memory_mode(state, state.id).await?;
    let root_checklist = checklist(state, state.id).await?;
    let root_goal = goal(state, state.id).await?;
    let mut descendants = Vec::new();
    for child in &before {
        let (history, metadata) =
            capture(&state.engine, child.id, &mut interrupted_thread_ids).await?;
        descendants.push(Descendant {
            thread_id: child.id,
            parent_thread_id: child.parent_agent_id,
            status: child.status.to_owned(),
            closed_at: child.closed_at,
            history,
            metadata,
            memory_mode: memory_mode(state, child.id).await?,
            checklist: checklist(state, child.id).await?,
            goal: goal(state, child.id).await?,
            code_mode: code_states.get(&child.id).cloned(),
        });
    }
    // A metadata-selected VM may first appear while history is read. Use the
    // original graph receipt if that happens; never substitute a later snapshot
    // for the namespace state captured before these histories.
    let requires_code_graph =
        requires_code_graph || (!probe && !capture_code_states(state).await?.is_empty());
    ensure!(
        graph_edges(&before) == graph_edges(&crate::subagents::list(state).await?),
        "subagent graph changed during checkpoint; save again at a stable boundary"
    );
    if requires_code_graph && let Some(graph) = code_graph {
        graph?.check(state, pending.is_some()).await?;
    }
    // Native cancellation can retire a pending executor while history flushes.
    if let Some(key) = pending {
        check_capture(state, key)?;
    }
    let control = state
        .thread
        .thread_extension_data()
        .get::<crate::response_control::ResponseControl>();
    let root_turn_budget = control.and_then(|control| control.checkpoint_budget());
    let mut history = history;
    redact_executor_observations(&mut history);
    for child in &mut descendants {
        redact_executor_observations(&mut child.history);
    }
    let executor_policy_digest = match state.retained_metadata.get() {
        Some(fork) => fork.executor_policy_digest.clone(),
        None => crate::environment::checkpoint_policy(&state.thread).await?,
    };
    let mut exported = serde_json::to_value(Checkpoint {
        format_version: if code_states.is_empty() { 2 } else { 4 },
        codex_revision: include_str!("../CODEX_REVISION").trim().to_owned(),
        source_session_id: state.id,
        history,
        root_metadata,
        root_memory_mode,
        root_checklist,
        root_goal,
        root_code_mode: code_states.get(&state.id).cloned(),
        descendants,
        interrupted_thread_ids,
        managed_tool_specs,
        root_turn_budget,
        executor_policy_digest,
    })?;
    if let Some(metadata) = state.retained_metadata.get() {
        metadata.overlay(&mut exported, state.id)?;
    }
    Ok(exported)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProbeRefusal {
    NativeBusy,
    NativeChanged,
}

impl std::fmt::Display for ProbeRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Native checkpoint boundary is not settled")
    }
}
impl std::error::Error for ProbeRefusal {}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum Probe<T> {
    Snapshot { snapshot: T },
    NotReady { reason: ProbeRefusal },
}

struct ProbeMember {
    control: Arc<crate::native_interception::Control>,
    settlement: Arc<crate::turn_settlement::Settlement>,
    receipt: Option<Arc<crate::turn_settlement::Turn>>,
    retired: bool,
}

struct ProbeGraph {
    fenced: bool,
    members: Vec<ProbeMember>,
}

impl ProbeGraph {
    fn observe(state: &ThreadState, pending_root: bool) -> anyhow::Result<Self> {
        let root = state
            .thread
            .thread_extension_data()
            .get::<crate::native_interception::Control>()
            .context("Checkpoint probe lost its native graph owner")?;
        // Preserve graph-before-settlement order; no synchronous lock crosses await.
        let graph = root.graph().state.lock().expect("graph stop poisoned");
        ensure!(
            !graph.stopping() && graph.failure.is_none(),
            ProbeRefusal::NativeBusy
        );
        let root_settlement = root
            .settlement
            .get()
            .and_then(|settlement| settlement.upgrade())
            .context("Checkpoint probe lost root settlement")?;
        ensure!(
            !root_settlement.observe().retired && !root.is_stopped(),
            ProbeRefusal::NativeChanged
        );
        let controls = state
            .engine
            .interception
            .graph_members(&root, crate::graph_stop::Scope::Tree);
        ensure!(
            controls.iter().any(|control| Arc::ptr_eq(control, &root)),
            "Checkpoint probe lost live root"
        );
        let mut members = Vec::with_capacity(controls.len());
        for control in controls {
            let settlement = control
                .settlement
                .get()
                .and_then(|settlement| settlement.upgrade())
                .context("Checkpoint probe lost native settlement")?;
            let observed = settlement.observe();
            ensure!(
                !observed.active || (pending_root && control.is_root()),
                ProbeRefusal::NativeBusy
            );
            members.push(ProbeMember {
                control,
                settlement,
                receipt: observed.receipt,
                retired: observed.retired,
            });
        }
        Ok(Self {
            fenced: graph.fenced,
            members,
        })
    }

    fn same(&self, other: &Self) -> bool {
        self.fenced == other.fenced
            && self.members.len() == other.members.len()
            && self.members.iter().all(|old| {
                other.members.iter().any(|new| {
                    Arc::ptr_eq(&old.control, &new.control)
                        && Arc::ptr_eq(&old.settlement, &new.settlement)
                        && old.retired == new.retired
                        && match (&old.receipt, &new.receipt) {
                            (None, None) => true,
                            (Some(old), Some(new)) => Arc::ptr_eq(old, new),
                            _ => false,
                        }
                })
            })
    }

    async fn check(&self, state: &ThreadState, pending_root: bool) -> anyhow::Result<()> {
        let after = Self::observe(state, pending_root)?;
        ensure!(self.same(&after), ProbeRefusal::NativeChanged);
        after.check_children(state).await?;
        ensure!(
            self.same(&Self::observe(state, pending_root)?),
            ProbeRefusal::NativeChanged
        );
        Ok(())
    }

    async fn check_children(&self, state: &ThreadState) -> anyhow::Result<()> {
        for member in &self.members {
            if member.control.is_root() {
                continue;
            }
            let id = ThreadId::from_string(member.control.thread_id())?;
            let thread = match state.engine.manager.get_thread(id).await {
                Ok(thread) => thread,
                Err(error)
                    if matches!(
                        error.details(),
                        codex_protocol::error::CodexErrorDetails::ThreadNotFound(_)
                    ) =>
                {
                    return Err(ProbeRefusal::NativeChanged.into());
                }
                Err(error) => return Err(error.into()),
            };
            let control = thread
                .thread_extension_data()
                .get::<crate::native_interception::Control>()
                .context("Checkpoint probe lost child control")?;
            ensure!(
                Arc::ptr_eq(&control, &member.control),
                ProbeRefusal::NativeChanged
            );
            ensure!(
                matches!(
                    thread.agent_status().await,
                    AgentStatus::Completed(_)
                        | AgentStatus::Errored(_)
                        | AgentStatus::Interrupted
                        | AgentStatus::Shutdown
                ) && thread.active_turn_environment_selections().await.is_none(),
                ProbeRefusal::NativeBusy
            );
        }
        Ok(())
    }
}

/// Private idle advice. The caller retains ThreadState.mutations across capture.
pub(crate) async fn probe(state: &ThreadState) -> anyhow::Result<Probe<Value>> {
    let result: anyhow::Result<Value> = async {
        let before = ProbeGraph::observe(state, false)?;
        before.check(state, false).await?;
        let captured = export_inner(state, None, true).await;
        before.check(state, false).await?;
        captured
    }
    .await;
    match result {
        Ok(snapshot) => Ok(Probe::Snapshot { snapshot }),
        Err(error) => match error.downcast::<ProbeRefusal>() {
            Ok(reason) => Ok(Probe::NotReady { reason }),
            Err(error) => Err(error),
        },
    }
}

// The root native mutation owner calls these around portable manual capture.
// Keep native child instances until the commit is done: an equal graph edge
// does not authorize shutting down a replacement writer for the same ID.
pub(crate) struct ManualGraph {
    children: Vec<(
        ThreadId,
        ThreadId,
        String,
        Option<i64>,
        Option<Arc<codex_core_api::CodexThread>>,
    )>,
}

pub(crate) async fn manual_graph(state: &ThreadState) -> anyhow::Result<Option<ManualGraph>> {
    let mut children = Vec::new();
    for child in crate::subagents::list(state).await? {
        let live = state.engine.manager.get_thread(child.id).await.ok();
        if let Some(thread) = &live {
            if !manual_child_ready(thread).await? {
                return Ok(None);
            }
        }
        children.push((
            child.id,
            child.parent_agent_id,
            child.status.to_owned(),
            child.closed_at,
            live,
        ));
    }
    Ok(Some(ManualGraph { children }))
}

async fn manual_child_ready(thread: &codex_core_api::CodexThread) -> anyhow::Result<bool> {
    if !matches!(
        thread.agent_status().await,
        AgentStatus::Completed(_)
            | AgentStatus::Errored(_)
            | AgentStatus::Interrupted
            | AgentStatus::Shutdown
    ) || thread.active_turn_environment_selections().await.is_some()
    {
        return Ok(false);
    }
    ensure!(
        !thread.config_snapshot().await.ephemeral
            && thread.list_background_terminals().await.is_empty(),
        "manual checkpoint requires a persistent child without live resources"
    );
    if !matches!(thread.agent_status().await, AgentStatus::Shutdown)
        && let Some(tools) = thread
            .thread_extension_data()
            .get::<crate::python_tools::PythonTools>()
    {
        tools.check_idle(thread).await?;
    }
    Ok(true)
}

impl ManualGraph {
    pub(crate) async fn check(&self, state: &ThreadState, saved: &Value) -> anyhow::Result<()> {
        let now = manual_graph(state)
            .await?
            .context("manual checkpoint child became busy")?;
        ensure!(
            self.children.len() == now.children.len(),
            "manual checkpoint graph changed"
        );
        for (id, parent, status, closed, live) in &self.children {
            let entry = now
                .children
                .iter()
                .find(|entry| entry.0 == *id)
                .context("manual checkpoint child disappeared")?;
            let same_instance = match (live, &entry.4) {
                (None, None) => true,
                (Some(before), Some(after)) => Arc::ptr_eq(before, after),
                _ => false,
            };
            ensure!(
                entry.1 == *parent && entry.2 == *status && entry.3 == *closed && same_instance,
                "manual checkpoint child changed before commit"
            );
        }
        let value: Checkpoint = serde_json::from_value(saved.clone())?;
        validate_code_states(
            value.format_version,
            value.root_code_mode.iter().chain(
                value
                    .descendants
                    .iter()
                    .filter_map(|child| child.code_mode.as_ref()),
            ),
        )?;
        ensure!(
            value
                .interrupted_thread_ids
                .iter()
                .all(|id| *id == state.id)
                && value.descendants.len() == self.children.len(),
            "manual checkpoint contains an interrupted child"
        );
        if let Some(checklist) = &value.root_checklist {
            checklist.validate(state.id, &value.history)?;
        }
        if let Some(goal) = &value.root_goal {
            goal.validate(state.id)?;
        }
        for child in &value.descendants {
            let meta = validate_history(child.thread_id, &child.history)?;
            ensure!(
                meta.parent_thread_id == Some(child.parent_thread_id)
                    && child.metadata.thread_id == child.thread_id,
                "manual child metadata differs"
            );
            if let Some(checklist) = &child.checklist {
                checklist.validate(child.thread_id, &child.history)?;
            }
            if let Some(goal) = &child.goal {
                goal.validate(child.thread_id)?;
            }
        }
        Ok(())
    }

    // Only called after a committed root capture, or as incomplete-commit
    // cleanup. No preflight can retire an idle descendant.
    pub(crate) async fn retire(&self, state: &ThreadState) -> anyhow::Result<ManualGraph> {
        for (id, _, _, _, live) in &self.children {
            if let Some(thread) = live {
                let current = state.engine.manager.get_thread(*id).await?;
                ensure!(
                    Arc::ptr_eq(thread, &current) && manual_child_ready(&current).await?,
                    "manual checkpoint child changed before writer retirement"
                );
                if !matches!(thread.agent_status().await, AgentStatus::Shutdown) {
                    thread.checkpoint_thread_settings().await?;
                    thread.shutdown_and_wait().await?;
                }
                ensure!(
                    state
                        .engine
                        .manager
                        .remove_thread_if_matches(id, thread)
                        .await
                        .is_some(),
                    "manual checkpoint child changed during writer retirement"
                );
            }
        }
        let retired = manual_graph(state)
            .await?
            .context("manual checkpoint child became busy")?;
        ensure!(
            retired.children.len() == self.children.len()
                && retired
                    .children
                    .iter()
                    .all(|(id, parent, status, closed, live)| {
                        live.is_none()
                            && self.children.iter().any(|entry| {
                                entry.0 == *id
                                    && entry.1 == *parent
                                    && entry.2 == *status
                                    && entry.3 == *closed
                            })
                    }),
            "manual checkpoint graph changed during writer retirement"
        );
        Ok(retired)
    }
}

pub(crate) async fn check_manual_root_history(
    state: &ThreadState,
    history: &[RolloutItem],
) -> anyhow::Result<()> {
    if state
        .thread
        .config()
        .await
        .features
        .enabled(codex_core_api::Feature::CodeMode)
    {
        // Export refuses active cells. A settled namespace can cross the same
        // manual boundary without reconstructing any suspended execution.
        if code_state(state, state.id).await?.is_none() {
            check_unused_code(state.id, history)?;
        }
    }
    Ok(())
}

// Context replacement needs complete, never-executed Code Mode history, but
// ordinary rollback without code execution does not make that proof ambiguous.
pub(crate) async fn check_context_history(
    state: &ThreadState,
    history: &[RolloutItem],
) -> anyhow::Result<()> {
    if state
        .thread
        .config()
        .await
        .features
        .enabled(codex_core_api::Feature::CodeMode)
    {
        check_unused_code_impl(state.id, history, false)?;
    }
    Ok(())
}

pub(crate) async fn check_manual_portability(
    state: &ThreadState,
    saved: &Value,
) -> anyhow::Result<()> {
    ensure!(
        state.thread.list_background_terminals().await.is_empty(),
        "manual checkpoint cannot retain live terminals"
    );
    if state
        .thread
        .config()
        .await
        .features
        .enabled(codex_core_api::Feature::CodeMode)
    {
        let checkpoint: Checkpoint = serde_json::from_value(saved.clone())?;
        check_code_portability(&checkpoint)?;
    }
    Ok(())
}

fn check_code_portability(checkpoint: &Checkpoint) -> anyhow::Result<()> {
    validate_code_states(
        checkpoint.format_version,
        checkpoint.root_code_mode.iter().chain(
            checkpoint
                .descendants
                .iter()
                .filter_map(|child| child.code_mode.as_ref()),
        ),
    )?;
    if checkpoint.root_code_mode.is_none() {
        check_unused_code(checkpoint.source_session_id, &checkpoint.history)?;
    }
    for child in &checkpoint.descendants {
        if child.code_mode.is_none() {
            check_unused_code(child.thread_id, &child.history)?;
        }
    }
    Ok(())
}

fn check_unused_code(id: ThreadId, history: &[RolloutItem]) -> anyhow::Result<()> {
    check_unused_code_impl(id, history, true)
}

fn check_unused_code_impl(
    id: ThreadId,
    history: &[RolloutItem],
    refuse_rollback: bool,
) -> anyhow::Result<()> {
    use codex_protocol::models::ResponseItem;
    ensure!(
        matches!(history.first(), Some(RolloutItem::SessionMeta(header))
        if header.meta.id == id && header.meta.history_base.is_none()),
        "cannot prove Code Mode unused from partial history"
    );
    for row in &history[1..] {
        match row {
            RolloutItem::SessionMeta(_) | RolloutItem::Compacted(_) => {
                anyhow::bail!(
                    "manual checkpoint cannot prove Code Mode unused after history replacement"
                );
            }
            RolloutItem::EventMsg(EventMsg::ThreadRolledBack(_)) if refuse_rollback => {
                anyhow::bail!("manual checkpoint cannot prove Code Mode unused after rollback");
            }
            RolloutItem::ResponseItem(item) => match &item.item {
                ResponseItem::Compaction { .. } | ResponseItem::ContextCompaction { .. } => {
                    anyhow::bail!(
                        "manual checkpoint cannot prove Code Mode unused after compaction"
                    );
                }
                ResponseItem::FunctionCall {
                    name, namespace, ..
                }
                | ResponseItem::CustomToolCall {
                    name, namespace, ..
                } => {
                    ensure!(
                        !(matches!(namespace.as_deref(), None | Some("" | "functions"))
                            && matches!(
                                name.as_str(),
                                "exec" | "wait" | "functions.exec" | "functions.wait"
                            )),
                        "manual checkpoint cannot capture used Code Mode"
                    );
                }
                _ => {}
            },
            _ => {}
        }
    }
    Ok(())
}

// Used only by the SDK executor ingress under its JavaScript ownership gate.
// Startup calls have no native managed sender: the SDK binds the call identity;
// the native response lease binds its turn. Managed calls must pass both checks.
pub(crate) fn check_capture(state: &ThreadState, request: &Value) -> anyhow::Result<()> {
    let tools = state
        .thread
        .thread_extension_data()
        .get::<crate::python_tools::PythonTools>()
        .context("tool capture requires managed tools")?;
    tools.check_pending(
        &state.id.to_string(),
        &serde_json::from_value(request.clone())?,
    )
}

async fn memory_mode(
    state: &ThreadState,
    id: ThreadId,
) -> anyhow::Result<Option<ThreadMemoryMode>> {
    let store = state
        .engine
        .store
        .as_any()
        .downcast_ref::<crate::storage::MemoryThreadStore>()
        .context("checkpoint requires the SDK-owned thread store")?;
    Ok(store.memory_mode(id).await)
}

pub(crate) async fn checklist(
    state: &ThreadState,
    id: ThreadId,
) -> anyhow::Result<Option<crate::storage::ChecklistState>> {
    if let Some(store) = &state.engine.local_checklist_store {
        Ok(store.checklist(id).await?)
    } else {
        Ok(state
            .engine
            .store
            .as_any()
            .downcast_ref::<crate::storage::MemoryThreadStore>()
            .context("checkpoint requires the SDK-owned thread store")?
            .checklist(id)
            .await?)
    }
}

async fn goal(
    state: &ThreadState,
    id: ThreadId,
) -> anyhow::Result<Option<crate::goals::GoalSnapshot>> {
    match &state.engine.goals {
        Some(backend) => crate::goals::GoalSnapshot::capture(backend, id).await,
        None => Ok(None),
    }
}

fn graph_edges(
    children: &[crate::subagents::Subagent],
) -> HashSet<(ThreadId, ThreadId, &str, Option<i64>)> {
    children
        .iter()
        .map(|child| {
            (
                child.id,
                child.parent_agent_id,
                child.status,
                child.closed_at,
            )
        })
        .collect()
}

pub(crate) async fn capture(
    engine: &EngineState,
    id: ThreadId,
    interrupted: &mut Vec<ThreadId>,
) -> anyhow::Result<(Vec<RolloutItem>, StoredThread)> {
    if let Ok(thread) = engine.manager.get_thread(id).await {
        ensure!(
            !thread.config_snapshot().await.ephemeral,
            "checkpoint cannot capture ephemeral thread {id}"
        );
        if !matches!(
            thread.agent_status().await,
            AgentStatus::Shutdown | AgentStatus::NotFound
        ) {
            thread.checkpoint_thread_settings().await?;
            thread.ensure_rollout_materialized().await;
            thread.flush_rollout().await?;
        }
    }
    let mut metadata = engine.read_stored_thread(id).await?;
    let mut history = engine.load_checkpoint_history(id).await?;
    if let Ok(thread) = engine.manager.get_thread(id).await
        && let Some(tools) = thread
            .thread_extension_data()
            .get::<crate::python_tools::PythonTools>()
    {
        tools.restore_schema_history(&mut history)?;
    }
    let unfinished = history
        .iter()
        .rev()
        .find_map(|item| match item {
            RolloutItem::EventMsg(EventMsg::TurnStarted(_)) => Some(true),
            RolloutItem::EventMsg(EventMsg::TurnComplete(_) | EventMsg::TurnAborted(_)) => {
                Some(false)
            }
            _ => None,
        })
        .unwrap_or(false);
    if unfinished {
        interrupted.push(id);
    }
    validate_history(id, &history)?;
    metadata.rollout_path = None;
    metadata.history = None;
    Ok((history, metadata))
}

fn validate_history(id: ThreadId, history: &[RolloutItem]) -> anyhow::Result<&SessionMeta> {
    let Some(RolloutItem::SessionMeta(header)) = history.first() else {
        anyhow::bail!("checkpoint thread {id} has no session metadata");
    };
    ensure!(header.meta.id == id, "checkpoint history identity mismatch");
    ensure!(
        header.meta.history_base.is_none(),
        "checkpoint history contains unresolved rollout references"
    );
    ensure!(
        header.meta.base_instructions.is_some(),
        "checkpoint lacks base instructions"
    );
    validate_imported_history(history)?;
    ensure!(
        header
            .meta
            .memory_mode
            .as_deref()
            .is_none_or(|mode| matches!(mode, "enabled" | "disabled")),
        "checkpoint contains an unknown memory mode"
    );
    if let Some(roots) = &header.meta.runtime_workspace_roots {
        for root in roots {
            AbsolutePathBuf::try_from(root.clone())?;
        }
    }
    Ok(&header.meta)
}

// Imported, cached, or caller-appended history must not pose as an accepted
// update. Only native tool appends (including same-batch starts) bypass this
// check; the pinned rollout never stores PlanUpdate in exported history.
pub(crate) fn validate_imported_history(history: &[RolloutItem]) -> anyhow::Result<()> {
    ensure!(
        !history
            .iter()
            .any(|item| matches!(item, RolloutItem::EventMsg(EventMsg::PlanUpdate(_)))),
        "caller-supplied history cannot contain a transient plan update"
    );
    Ok(())
}

pub async fn restore(
    engine: &Arc<EngineState>,
    mut checkpoint: Checkpoint,
    options: options::ThreadOptions,
    python_specs: Option<Vec<DynamicToolSpec>>,
    fresh_manual: bool,
) -> anyhow::Result<NativeThread> {
    let _lifecycle = engine.lifecycle.lock().await;
    ensure!(
        engine.local_checklist_store.is_none(),
        "local storage cannot import portable checkpoints"
    );
    let mut ids = checkpoint.validate(python_specs.as_deref(), fresh_manual)?;
    // Match the current application declaration before any native import or
    // config-dependent startup. This is the same parser used by JS preflight.
    let has_agent_profiles = options.agent_profiles.is_some();
    let accepted = options.validate_instructions(&checkpoint.history)?;
    if fresh_manual {
        let old = checkpoint.source_session_id;
        ensure!(
            python_specs.is_some() && checkpoint.root_turn_budget.is_none(),
            "manual restore requires ordinary managed tools without control"
        );
        validate_history(old, &checkpoint.history)?;
        ensure!(
            checkpoint.root_metadata.thread_id == old,
            "checkpoint root identity mismatch"
        );
        if let Some(checklist) = &checkpoint.root_checklist {
            checklist.validate(old, &checkpoint.history)?;
        }
        if let Some(goal) = &checkpoint.root_goal {
            goal.validate(old)?;
        }
        ensure!(
            checkpoint
                .interrupted_thread_ids
                .iter()
                .all(|id| *id == old),
            "manual checkpoint has foreign interrupted thread"
        );
        let root = ThreadId::new();
        for item in &mut checkpoint.history {
            match item {
                RolloutItem::SessionMeta(header) => {
                    ensure!(
                        header.meta.id == old,
                        "manual history has foreign session header"
                    );
                    header.meta.id = root;
                }
                RolloutItem::EventMsg(EventMsg::ThreadSettingsApplied(settings))
                    if settings.thread_id == Some(old) =>
                {
                    settings.thread_id = Some(root)
                }
                _ => {}
            }
        }
        // All remaining graph/history validation still runs below before the
        // first write. Remap only typed root-parent references, never payloads.
        for child in &mut checkpoint.descendants {
            if child.parent_thread_id == old {
                child.parent_thread_id = root;
                for item in &mut child.history {
                    if let RolloutItem::SessionMeta(header) = item {
                        ensure!(
                            header.meta.id == child.thread_id
                                && header.meta.parent_thread_id == Some(old),
                            "manual child has foreign source parent"
                        );
                        header.meta.parent_thread_id = Some(root);
                    }
                }
            }
        }
        if let Some(checklist) = &mut checkpoint.root_checklist {
            checklist.thread_id = root;
        }
        if let Some(goal) = &mut checkpoint.root_goal {
            goal.thread_id = root;
        }
        checkpoint.source_session_id = root;
        checkpoint.root_metadata.thread_id = root;
        for id in &mut checkpoint.interrupted_thread_ids {
            *id = root;
        }
    }
    let root = checkpoint.source_session_id;
    if fresh_manual {
        ids = checkpoint.validate(python_specs.as_deref(), fresh_manual)?;
    }
    if engine
        .service_config
        .features
        .enabled(codex_core_api::Feature::CodeMode)
    {
        check_code_portability(&checkpoint)?;
    }
    let has_goals = checkpoint.root_goal.is_some()
        || checkpoint
            .descendants
            .iter()
            .any(|child| child.goal.is_some());
    ensure!(
        !has_goals || engine.goals.is_some(),
        "checkpoint goals require current native goal storage"
    );
    for id in &ids {
        match engine
            .store
            .read_thread(ReadThreadParams {
                thread_id: *id,
                include_archived: true,
                include_history: false,
            })
            .await
        {
            Err(ThreadStoreError::ThreadNotFound { .. }) => {}
            Err(error) => return Err(error.into()),
            Ok(_) => anyhow::bail!("checkpoint thread already exists in this engine"),
        }
    }

    let (mut startup, instructions) = engine.build_startup(options).await?;
    crate::environment::check_checkpoint_policy(
        checkpoint.executor_policy_digest.as_deref(),
        &startup,
    )?;

    if python_specs.is_some() {
        // An absent current environment is an explicit empty selection on restore.
        startup.environments.get_or_insert_with(Vec::new);

        // The checkpoint owns accepted model choices, not provider credentials,
        // tools, permissions or any other current application configuration.
        if let Some(settings) = checkpoint.history.iter().rev().find_map(|item| match item {
            RolloutItem::EventMsg(EventMsg::ThreadSettingsApplied(settings))
                if settings.thread_id == Some(root) =>
            {
                Some(&settings.thread_settings)
            }
            _ => None,
        }) {
            startup.config.model = Some(settings.model.clone());
            startup.config.model_reasoning_effort = settings.reasoning_effort.clone();
            startup.config.model_reasoning_summary = settings.reasoning_summary;
            startup.config.service_tier = settings.service_tier.clone();
            startup.config.sdk_tool_choice = settings.tool_choice;
        }
    }
    if let Some(model) = &startup.config.model {
        engine.validate_hosted_search_model(model).await?;
    }
    let initial_receipt = if let Some(accepted) = accepted {
        let initial = if has_agent_profiles {
            None
        } else {
            crate::application_instructions::take_initial_receipt(
                &mut checkpoint.history,
                &accepted,
                root,
            )
        };
        instructions.confirm(accepted)?;
        initial
    } else {
        if fresh_manual {
            instructions.defer_manual()?;
        }
        None
    };
    // Retained goal data does not enable model-facing goal tools. Storage,
    // identity and current goal-budget restrictions are checked independently.
    if let Some(backend) = &engine.goals {
        if let Some(goal) = &checkpoint.root_goal {
            goal.check_restore(backend, &startup.config).await?;
        }
        for child in &checkpoint.descendants {
            if let Some(goal) = &child.goal {
                goal.check_restore(backend, &startup.config).await?;
            }
        }
    }
    if let Some(specs) = python_specs {
        // Validate the actual fixed history and current policy before import:
        // a bad catalog must not leave records that prevent a corrected restore.
        startup.initial_history = InitialHistory::Resumed(ResumedHistory {
            conversation_id: root,
            history: Arc::new(checkpoint.history.clone()),
            history_revision: None,
            rollout_path: None,
        });
        crate::python_tools::PythonTools::install(
            &mut startup,
            specs,
            crate::python_tools::ToolInstallOptions {
                preserve_schemas: engine.sentinel.read().expect("sentinel poisoned").is_some(),
                allow_local_goals: false,
            },
        )?;
    }

    // All root/descendant data and destination bindings validate before staging.
    // Descendants consume their snapshots lazily through the existing boundary.
    if let Some(snapshot) = &checkpoint.root_code_mode {
        engine.interception.stage_code_state(root, snapshot.clone());
    }
    for child in &checkpoint.descendants {
        if let Some(snapshot) = &child.code_mode {
            engine
                .interception
                .stage_code_state(child.thread_id, snapshot.clone());
        }
    }
    let result = async {
        let graph = &engine.agent_graph;
        import(
            engine,
            root,
            checkpoint.history,
            &checkpoint.root_metadata,
            checkpoint.root_memory_mode,
            &checkpoint.interrupted_thread_ids,
            &startup.config.model_provider_id,
        )
        .await?;
        if let Some(checklist) = checkpoint.root_checklist {
            engine
                .store
                .as_any()
                .downcast_ref::<crate::storage::MemoryThreadStore>()
                .context("checkpoint requires the SDK-owned thread store")?
                .restore_checklist(checklist)
                .await;
        }
        if let Some(goal) = checkpoint.root_goal {
            goal.restore(engine, &startup.config).await?;
        }
        for child in checkpoint.descendants {
            import(
                engine,
                child.thread_id,
                child.history,
                &child.metadata,
                child.memory_mode,
                &checkpoint.interrupted_thread_ids,
                &startup.config.model_provider_id,
            )
            .await?;
            if let Some(checklist) = child.checklist {
                engine
                    .store
                    .as_any()
                    .downcast_ref::<crate::storage::MemoryThreadStore>()
                    .context("checkpoint requires the SDK-owned thread store")?
                    .restore_checklist(checklist)
                    .await;
            }
            if let Some(goal) = child.goal {
                goal.restore(engine, &startup.config).await?;
            }
            graph
                .restore_edge(
                    child.thread_id,
                    crate::storage::SpawnEdge {
                        parent: child.parent_thread_id,
                        status: if child.status == "closed" {
                            ThreadSpawnEdgeStatus::Closed
                        } else {
                            ThreadSpawnEdgeStatus::Open
                        },
                        closed_at: child.closed_at,
                    },
                )
                .await;
        }

        startup.initial_history = engine.history(root).await?;

        let native = engine.start_prepared(startup, instructions, None).await?;

        if engine
            .service_config
            .features
            .enabled(codex_core_api::Feature::CodeMode)
            && engine.interception.pending_code_state(root).is_some()
        {
            native
                .current()?
                .thread
                .prepare_code_mode_state()
                .await
                .map_err(anyhow::Error::msg)?;
        }

        if let Some(item) = initial_receipt {
            let state = native.current()?;
            let _mutation = state.mutations.lock().await;
            crate::application_instructions::publish_item(&state.thread, item).await?;
        }
        native
            .response_control()?
            .restore_budget(checkpoint.root_turn_budget);
        Ok(native)
    }
    .await;
    if result.is_err() {
        for id in &ids {
            engine.interception.clear_code_state(*id);
        }
    }
    result
}

fn imported_memory_mode(
    id: ThreadId,
    history: &[RolloutItem],
    captured_memory_mode: Option<ThreadMemoryMode>,
) -> anyhow::Result<ThreadMemoryMode> {
    let latest_memory_mode = history.iter().rev().find_map(|item| match item {
        RolloutItem::SessionMeta(header) if header.meta.id == id => {
            header.meta.memory_mode.as_deref()
        }
        _ => None,
    });
    Ok(match (captured_memory_mode, latest_memory_mode) {
        (Some(mode), _) => mode,
        (None, Some("disabled")) => ThreadMemoryMode::Disabled,
        (None, Some("enabled") | None) => ThreadMemoryMode::Enabled,
        (None, Some(_)) => anyhow::bail!("checkpoint contains an unknown memory mode"),
    })
}

async fn import(
    engine: &EngineState,
    id: ThreadId,
    mut history: Vec<RolloutItem>,
    stored: &StoredThread,
    captured_memory_mode: Option<ThreadMemoryMode>,
    interrupted: &[ThreadId],
    model_provider: &str,
) -> anyhow::Result<()> {
    let meta = validate_history(id, &history)?.clone();
    let memory_mode = imported_memory_mode(id, &history, captured_memory_mode)?;
    engine
        .store
        .create_thread(CreateThreadParams {
            sdk_mcp_source_required: meta.sdk_mcp_source_required,
            creator_user_id: meta.creator_user_id,
            creator_account_id: meta.creator_account_id,
            session_id: meta.session_id,
            thread_id: id,
            extra_config: stored.extra_config.clone(),
            forked_from_id: meta.forked_from_id,
            parent_thread_id: meta.parent_thread_id,
            source: meta.source,
            thread_source: meta.thread_source,
            originator: meta.originator,
            base_instructions: meta
                .base_instructions
                .context("checkpoint lacks base instructions")?,
            dynamic_tools: meta.dynamic_tools.unwrap_or_default(),
            // Capability access belongs to the destination Environment, not saved history.
            selected_capability_roots: Vec::new(),
            multi_agent_version: meta.multi_agent_version,
            history_mode: meta.history_mode,
            history_base: None,
            subagent_history_start_ordinal: meta.subagent_history_start_ordinal,
            initial_window_id: meta
                .context_window
                .map(|window| window.window_id)
                .unwrap_or_else(|| ThreadId::new().to_string()),
            runtime_workspace_roots: meta
                .runtime_workspace_roots
                .map(|roots| roots.into_iter().map(AbsolutePathBuf::try_from).collect())
                .transpose()?,
            metadata: ThreadPersistenceMetadata {
                cwd: Some(meta.cwd),
                model_provider: model_provider.to_owned(),
                memory_mode,
            },
        })
        .await?;
    // create_thread owns the canonical header; retaining a second copy shifts paginated ordinals.
    history.remove(0);
    if interrupted.contains(&id) {
        let turn_id = history.iter().rev().find_map(|item| match item {
            RolloutItem::EventMsg(EventMsg::TurnStarted(event)) => Some(event.turn_id.clone()),
            _ => None,
        });
        history.push(RolloutItem::EventMsg(EventMsg::TurnAborted(
            TurnAbortedEvent {
                turn_id,
                reason: TurnAbortReason::Interrupted,
                error: None,
                started_at: None,
                completed_at: None,
                duration_ms: None,
            },
        )));
    }
    let result = async {
        engine
            .store
            .append_items(AppendThreadItemsParams {
                thread_id: id,
                items: history,
            })
            .await?;
        engine
            .store
            .persist_thread(id, PersistContext::Standard)
            .await?;
        engine
            .store
            .update_thread_metadata(UpdateThreadMetadataParams {
                thread_id: id,
                include_archived: true,
                patch: ThreadMetadataPatch {
                    name: Some(stored.name.clone()),
                    created_at: Some(stored.created_at),
                    updated_at: Some(stored.updated_at),
                    advance_recency_at: Some(stored.recency_at),
                    preview: Some(stored.preview.clone()),
                    first_user_message: stored.first_user_message.clone(),
                    model_provider: Some(model_provider.to_owned()),
                    model: stored.model.clone(),
                    reasoning_effort: Some(stored.reasoning_effort.clone()),
                    approval_mode: Some(stored.approval_mode),
                    permission_profile: Some(stored.permission_profile.clone()),
                    cwd: Some(stored.cwd.clone()),
                    memory_mode: Some(memory_mode),
                    agent_nickname: Some(stored.agent_nickname.clone()),
                    agent_role: Some(stored.agent_role.clone()),
                    agent_path: Some(stored.agent_path.clone()),
                    token_usage: stored.token_usage.clone(),
                    ..Default::default()
                },
            })
            .await?;
        anyhow::Ok(())
    }
    .await;
    let shutdown = engine.store.shutdown_thread(id).await;
    result?;
    shutdown?;
    if stored.archived_at.is_some() {
        engine
            .store
            .archive_thread(ArchiveThreadParams { thread_id: id })
            .await?;
    }
    engine
        .restored_creation_times
        .lock()
        .await
        .insert(id, stored.created_at.into());
    Ok(())
}

#[cfg(test)]
mod code_state_tests {
    use super::*;
    use serde_json::json;

    fn snapshot_value() -> Value {
        json!({
            "format_version": 1,
            "next_cell_id": 3,
            "stored_values": {"record": {"text": "雪", "values": [null, true, 7]}},
            "completed_cells": {
                "1": {
                    "public_cell_id": "g2:1",
                    "pending_initial_yield_items": [{"Text": {"text": "first"}}],
                    "event": {"Completed": {
                        "content_items": [{"Text": {"text": "committed"}}],
                        "error_text": null
                    }}
                },
                "2": {
                    "pending_initial_yield_items": null,
                    "event": {"Terminated": {"content_items": []}}
                }
            }
        })
    }

    fn snapshot(value: Value) -> codex_code_mode::CodeModeSnapshot {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn settled_values_and_terminal_observation_order_round_trip() {
        let value = snapshot_value();
        let state = snapshot(value.clone());
        validate_code_states(4, std::iter::once(&state)).unwrap();
        assert_eq!(serde_json::to_value(state).unwrap(), value);
    }

    #[test]
    fn legacy_checkpoint_cannot_silently_carry_root_or_descendant_vm_state() {
        validate_code_states(2, std::iter::empty()).unwrap();
        let state = snapshot(snapshot_value());
        for root in [Some(&state), None] {
            let child = if root.is_none() { Some(&state) } else { None };
            assert!(validate_code_states(2, root.into_iter().chain(child)).is_err());
        }
    }

    #[test]
    fn invalid_descendant_is_rejected_even_when_root_snapshot_is_valid() {
        let root = snapshot(snapshot_value());
        let mut child = snapshot_value();
        child["next_cell_id"] = json!(2);
        let child = snapshot(child);
        assert!(validate_code_states(4, [&root, &child].into_iter()).is_err());
    }

    #[test]
    fn active_cell_and_foreign_public_identity_are_not_portable() {
        let mut active = snapshot_value();
        active["completed_cells"]["1"]["event"] = json!({"Pending": {
            "content_items": [], "pending_tool_call_ids": ["uncertain-effect"]
        }});
        let active = snapshot(active);
        assert!(validate_code_states(4, std::iter::once(&active)).is_err());

        let mut foreign = snapshot_value();
        foreign["completed_cells"]["1"]["public_cell_id"] = json!("g2:2");
        let foreign = snapshot(foreign);
        assert!(validate_code_states(4, std::iter::once(&foreign)).is_err());
    }

    #[test]
    fn fork_retargets_actor_but_preserves_values_and_current_namespace() {
        let source = ThreadId::new();
        let copied = ThreadId::new();
        let value = snapshot_value();
        let mut metadata = ForkMetadata::capture(
            &json!({
                "source_session_id": source,
                "format_version": 4,
                "root_code_mode": value
            }),
            source,
        )
        .unwrap();
        metadata.retarget(copied);
        metadata.validate_identity(copied).unwrap();
        assert_eq!(
            serde_json::to_value(metadata.code_state().unwrap()).unwrap(),
            value
        );

        let mut exported = json!({"source_session_id": copied, "format_version": 2});
        metadata.overlay(&mut exported, copied).unwrap();
        assert_eq!(exported["format_version"], 4);
        assert_eq!(exported["root_code_mode"], value);

        let mut current = value;
        current["stored_values"]["record"] = json!("destination update");
        exported["root_code_mode"] = current.clone();
        metadata.overlay(&mut exported, copied).unwrap();
        assert_eq!(exported["root_code_mode"], current);
        assert!(metadata.overlay(&mut exported, source).is_err());
    }
}
