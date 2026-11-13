//! Ordinary MCP capture under its native question and writer owners.
use crate::engine::ThreadState;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::sync::Arc;

async fn current(
    state: &ThreadState,
) -> Result<Option<(Arc<codex_mcp::McpBinding>, codex_core::CapturedMcpApproval)>> {
    if state.engine.local_checklist_store.is_some()
        || !crate::subagents::list(state).await?.is_empty()
        || !crate::checkpoint::capture_code_states(state)
            .await?
            .is_empty()
    {
        return Ok(None);
    }
    let Some((source, captured)) = state.pending_root_mcp_approval().await.ok().flatten() else {
        return Ok(None);
    };
    if !crate::native_interception::native_mcp_checkpoint_source(source.data()) {
        return Ok(None);
    }
    let Some(store) = state
        .engine
        .store
        .as_any()
        .downcast_ref::<crate::storage::MemoryThreadStore>()
    else {
        return Ok(None);
    };
    if !store.native_mcp_capture_ready(state.id, &captured).await? {
        return Ok(None);
    }
    let tools = state
        .thread
        .thread_extension_data()
        .get::<crate::python_tools::PythonTools>()
        .context("Native MCP continuation requires its current Agent catalog")?;
    let history = state.engine.load_checkpoint_history(state.id).await?;
    if tools
        .native_mcp_continuation(&captured.checkpoint_data(), &serde_json::to_value(history)?)
        .is_err()
    {
        return Ok(None);
    }
    Ok(Some((source.binding().clone(), captured)))
}

pub(crate) async fn ready(state: &ThreadState) -> Result<bool> {
    Ok(current(state).await?.is_some())
}

pub(crate) async fn capture(state: &ThreadState) -> Result<Option<Value>> {
    let _reply_gate = state.native_question_gate.lock().await;
    let Some((binding, captured)) = current(state).await? else {
        return Ok(None);
    };
    let data = captured.checkpoint_data();
    let usage_owner = state
        .thread
        .thread_extension_data()
        .get::<crate::turn_settlement::Settlement>()
        .context("Native MCP continuation lost its current turn owner")?
        .admission_ready(&data.turn_id)?;
    let mut saved = crate::checkpoint::export_native_mcp(state, &captured).await?;
    let claim = match captured.claim_for_suspension(&binding).await {
        Ok(claim) => claim,
        Err(_) => return Ok(None),
    };
    let store = state
        .engine
        .store
        .as_any()
        .downcast_ref::<crate::storage::MemoryThreadStore>()
        .context("Native MCP continuation requires portable memory storage")?;
    match store.begin_native_mcp_capture(state.id, &claim).await {
        Ok(true) => {}
        Ok(false) => {
            claim.rollback().await;
            return Ok(None);
        }
        Err(error) => {
            claim.rollback().await;
            return Err(error);
        }
    }
    let outcome = state.thread.suspend_turn_and_shutdown().await;
    let suspended = match &outcome {
        Ok(codex_protocol::turn_input::SuspendTurnOutcome::Suspended { turn_id }) => {
            Some(turn_id.as_str())
        }
        _ => None,
    };
    if let Some(turn) = suspended {
        if let Some(control) = state
            .thread
            .thread_extension_data()
            .get::<crate::native_interception::Control>()
        {
            control.seal_request_attempts(turn);
        }
    }
    let preserved = store.finish_manual_capture(state.id, suspended).await;
    if suspended.is_none() {
        claim.rollback().await;
        outcome?;
        preserved?;
        return Ok(None);
    }
    drop(claim);
    let result: Result<Value> = async {
        ensure!(
            preserved? && suspended == Some(data.turn_id.as_str()),
            "Core did not preserve the native MCP call"
        );
        let tools = state
            .thread
            .thread_extension_data()
            .get::<crate::python_tools::PythonTools>()
            .context("Native MCP continuation lost its catalog")?;
        let mut history = state.engine.load_checkpoint_history(state.id).await?;
        tools.restore_schema_history(&mut history)?;
        crate::checkpoint::redact_executor_observations(&mut history);
        let history = serde_json::to_value(history)?;
        let frame = tools.native_mcp_continuation(&data, &history)?;
        saved["history"] = history;
        let root = serde_json::to_value(state.id)?;
        saved["interrupted_thread_ids"]
            .as_array_mut()
            .context("Checkpoint lacks interrupted threads")?
            .retain(|id| *id != root);
        saved["agent_options"] = json!({});
        crate::usage::checkpoint_to_wire(&mut saved)?;
        let mut value = json!({"checkpoint": saved, "manual_continuation": frame});
        if let Some(owner) = usage_owner {
            if let Some(snapshot) = owner.model_attempt_snapshot()? {
                let mut snapshot = serde_json::to_value(snapshot)?;
                crate::usage::model_attempt_to_wire(&mut snapshot)?;
                value["model_attempt"] = snapshot;
            }
        }
        Ok(value)
    }
    .await;
    state.retire_suspended().await;
    outcome?;
    Ok(Some(result?))
}
