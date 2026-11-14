//! Core-owned canonical history transactions; no host-language replay state.
use crate::engine::ThreadState;
use anyhow::{Context, ensure};
use codex_history::RolloutItem;
use codex_history::sdk_originals::input_projections;
use codex_protocol::protocol::AgentStatus;
use serde_json::{Value, json};
use std::collections::HashSet;

async fn idle(state: &ThreadState) -> anyhow::Result<()> {
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
        "canonical history requires an idle, open thread"
    );
    if let Some(tools) = state
        .thread
        .thread_extension_data()
        .get::<crate::python_tools::PythonTools>()
    {
        tools.check_idle(&state.thread).await?;
    }
    Ok(())
}

pub async fn snapshot(
    state: &ThreadState,
    limit: Option<usize>,
    for_replay: bool,
) -> anyhow::Result<Value> {
    let _operation = state.engine.operation(false)?;
    let _mutation = state
        .mutations
        .try_lock()
        .context("native mutation is in progress")?;
    idle(&state).await?;
    let (revision, total, items) = if for_replay {
        state.thread.sdk_replay_history_snapshot().await?
    } else {
        state.thread.sdk_history_snapshot(limit).await?
    };
    Ok(json!({"revision": revision, "total": total, "items": items}))
}

/// Read the last effective native handoff view under the ordinary idle permit.
pub async fn chaining_snapshot(state: &ThreadState) -> anyhow::Result<Value> {
    let _operation = state.engine.operation(false)?;
    let _mutation = state.mutations.try_lock()
        .context("native mutation is in progress")?;
    idle(state).await?;
    let items = match state.thread.sdk_chaining_history_projection().await? {
        Some(items) => items,
        None => state.thread.sdk_replay_history_snapshot().await?.2,
    };
    Ok(json!({"items": items}))
}

enum HistoryEdit {
    Replace {
        keep: usize,
        items: Vec<String>,
        allow_rebuild: bool,
    },
    Pop {
        allow_rebuild: bool,
    },
    AppendRecoveredOutput {
        message_id: String,
        text: String,
    },
}

pub async fn replace(
    state: &ThreadState,
    expected: String,
    keep: usize,
    items: Vec<String>,
    allow_rebuild: bool,
) -> anyhow::Result<Value> {
    edit(
        state,
        expected,
        HistoryEdit::Replace {
            keep,
            items,
            allow_rebuild,
        },
    )
    .await
}

pub async fn pop(
    state: &ThreadState,
    expected: String,
    allow_rebuild: bool,
) -> anyhow::Result<Value> {
    edit(state, expected, HistoryEdit::Pop { allow_rebuild }).await
}

/// Append one application-owned assistant message without changing any retained prefix.
pub async fn append_recovered_output(
    state: &ThreadState,
    expected: String,
    message_id: String,
    text: String,
) -> anyhow::Result<Value> {
    ensure!(
        !message_id.is_empty(),
        "recovery message ID must be nonempty"
    );
    edit(
        state,
        expected,
        HistoryEdit::AppendRecoveredOutput { message_id, text },
    )
    .await
}

async fn settled_children(state: &ThreadState) -> anyhow::Result<()> {
    let children = crate::subagents::list(state).await?;
    let mut owned = children
        .iter()
        .map(|child| child.id)
        .collect::<HashSet<_>>();
    owned.insert(state.id);
    let loaded = state.engine.manager.list_thread_ids().await;
    ensure!(
        loaded.contains(&state.id) && loaded.iter().all(|id| owned.contains(id)),
        "recovery append requires an exclusively owned root graph"
    );
    for child in children {
        if !loaded.contains(&child.id) {
            ensure!(
                child.status == "closed",
                "recovery append requires settled stored children"
            );
            continue;
        }
        let thread = state.engine.manager.get_thread(child.id).await?;
        ensure!(
            thread.active_turn_environment_selections().await.is_none()
                && matches!(
                    thread.agent_status().await,
                    AgentStatus::Completed(_)
                        | AgentStatus::Errored(_)
                        | AgentStatus::Interrupted
                        | AgentStatus::Shutdown
                ),
            "recovery append requires settled native children"
        );
        if let Some(tools) = thread
            .thread_extension_data()
            .get::<crate::python_tools::PythonTools>()
        {
            tools.check_idle(&thread).await?;
        }
        ensure!(
            thread.list_background_terminals().await.is_empty(),
            "recovery append requires completed child background execution"
        );
    }
    Ok(())
}

async fn validate_replacement(
    state: &ThreadState,
    expected: &str,
    keep: Option<usize>,
    items: &[String],
) -> anyhow::Result<usize> {
    let (current_revision, total, _) = state.thread.sdk_history_snapshot(Some(0)).await?;
    ensure!(
        current_revision == expected,
        "canonical history revision conflict"
    );
    let keep = keep.unwrap_or(total);
    ensure!(keep <= total, "history keep exceeds snapshot length");
    let originals = state.thread.sdk_history_projection(None).await?;
    let retained = state.thread.sdk_history_projection(Some(keep)).await?.len();
    let appended = input_projections(items)
        .map_err(|_| anyhow::anyhow!("Invalid canonical history item"))?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    crate::context::check_pairs(&originals, &(0..retained).collect::<Vec<_>>())
        .context("canonical history requires complete tool call/result pairs")?;
    crate::context::check_pairs(&appended, &(0..appended.len()).collect::<Vec<_>>())
        .context("canonical history requires complete tool call/result pairs")?;
    Ok(keep)
}

async fn edit(state: &ThreadState, expected: String, edit: HistoryEdit) -> anyhow::Result<Value> {
    let _operation = state
        .engine
        .context_gate
        .clone()
        .try_write_owned()
        .context("native operations are in progress")?;
    ensure!(
        !state
            .engine
            .closed
            .load(std::sync::atomic::Ordering::Acquire)
            && !state
                .engine
                .retired
                .load(std::sync::atomic::Ordering::Acquire),
        "Codex engine is closed"
    );
    let _mutation = state
        .mutations
        .try_lock()
        .context("native mutation is in progress")?;
    idle(&state).await?;
    if matches!(&edit, HistoryEdit::AppendRecoveredOutput { .. }) {
        settled_children(state).await?;
    } else {
        ensure!(
            state.engine.manager.list_thread_ids().await == vec![state.id],
            "history transactions require an exclusively owned root without native children"
        );
        ensure!(
            crate::subagents::list(&state).await?.is_empty(),
            "history transactions do not rewrite child graphs"
        );
        ensure!(
            state.engine.goals.is_none(),
            "history transactions do not rewrite goal-backed sessions"
        );
    }
    ensure!(
        state.thread.list_background_terminals().await.is_empty(),
        "history transactions require completed background execution"
    );
    let result = match edit {
        HistoryEdit::Replace {
            keep, items, allow_rebuild,
        } => {
            // The Core revision is rechecked under its state lock when replacing below.
            // Validate before durability: neither retained nor appended history may split
            // a client tool call/result pair. Provider-hosted records keep their existing
            // context-validator treatment, including server-side tool-search output.
            let keep = validate_replacement(state, &expected, Some(keep), &items).await?;
            let revision = if allow_rebuild {
                state.thread.sdk_replace_history_allow_rebuild(&expected, keep, items).await
            } else {
                state.thread.sdk_replace_history(&expected, keep, items).await
            };
            revision.map(|revision| json!({"revision": revision}))
        }
        HistoryEdit::AppendRecoveredOutput { message_id, text } => {
            let items = vec![
                json!({
                    "type": "message", "id": message_id, "role": "assistant",
                    "content": [{ "type": "output_text", "text": text }],
                })
                .to_string(),
            ];
            let keep = validate_replacement(state, &expected, None, &items).await?;
            state
                .thread
                .sdk_replace_history(&expected, keep, items)
                .await
                .map(|revision| json!({"revision": revision}))
        }
        HistoryEdit::Pop { allow_rebuild } => state
            .thread
            .sdk_pop_history(&expected, allow_rebuild)
            .await
            .map(|(revision, item, rebuilt_context)| {
                json!({
                    "revision": revision,
                    "item": item,
                    "rebuilt_context": rebuilt_context,
                })
            }),
    };
    match result {
        Ok(value) => Ok(value),
        Err(error)
            if matches!(
                error.details(),
                codex_protocol::error::CodexErrorDetails::Fatal(_)
            ) =>
        {
            // Core entered persistence but cannot prove the final durable/live outcome.
            // Fence admission before releasing the exclusive mutation permit. Cleanup
            // remains retryable through the existing context retirement mechanism.
            state
                .engine
                .retired
                .store(true, std::sync::atomic::Ordering::Release);
            Ok(json!({"outcome": "uncertain"}))
        }
        Err(error) => Err(error.into()),
    }
}

const MEMORY_INPUT_ADMITTED: &str = "sandbox_memory_input_admitted";
const MEMORY_TERMINAL_PROFILE: &str = "sandbox_memory_terminal_profile";

fn sampling_receipt(context: &codex_protocol::protocol::TurnContextItem) -> bool {
    context.sdk_receipt.as_ref().is_some_and(|receipt| {
        receipt.get("version").and_then(Value::as_u64) == Some(1)
            && receipt
                .get("thread_id")
                .and_then(Value::as_str)
                .is_some_and(|id| !id.is_empty())
            && receipt.get("model").is_some_and(Value::is_string)
            && receipt.get("approval_policy").is_some()
    })
}

/// Only memory eligibility changes; the exact sampling context remains intact.
pub async fn record_memory_input_admission(
    state: &ThreadState,
    turn_id: &str,
) -> anyhow::Result<Value> {
    let _operation = state.engine.operation(false)?;
    let (_, total, items) = state.thread.sdk_replay_history_snapshot().await?;
    ensure!(
        total <= 256,
        "Native sandbox memory supports at most 256 original records"
    );
    drop(items);
    let history = crate::subagents::read_history(state, None).await?;
    let mut context = history
        .iter()
        .rev()
        .find_map(|item| match item {
            RolloutItem::TurnContext(context)
                if context.turn_id.as_deref() == Some(turn_id) && sampling_receipt(context) =>
            {
                Some(context.clone())
            }
            _ => None,
        })
        .context("Memory input admission requires an exact captured sampling receipt")?;
    ensure!(
        context
            .sdk_receipt
            .as_ref()
            .and_then(|receipt| receipt.get("thread_id"))
            .and_then(Value::as_str)
            == Some(state.id.to_string().as_str()),
        "Memory admission must belong to this native thread"
    );
    let receipt = context
        .sdk_receipt
        .as_mut()
        .and_then(Value::as_object_mut)
        .context("Memory input admission requires an object sampling receipt")?;
    let terminal = serde_json::to_value(crate::agent_profiles::active(&state.thread).await?)?;
    receipt.insert(MEMORY_INPUT_ADMITTED.to_owned(), Value::Bool(true));
    receipt.insert(MEMORY_TERMINAL_PROFILE.to_owned(), terminal.clone());
    state
        .thread
        .append_rollout_items(&[RolloutItem::TurnContext(context)])
        .await?;
    state.thread.flush_rollout().await?;
    Ok(terminal)
}

/// Unproven input remains outside memory, including after ordinary resume/fork.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct MemoryScope {
    source: codex_protocol::agent_profile::AgentProfileReceipt,
    profiles: Vec<String>,
}

pub async fn memory_snapshot(
    state: &ThreadState,
    turn_id: &str,
    scope_json: Option<&str>,
) -> anyhow::Result<Value> {
    let _operation = state.engine.operation(false)?;
    let _mutation = state
        .mutations
        .try_lock()
        .context("native mutation is in progress")?;
    idle(state).await?;
    memory_snapshot_values(state, turn_id, scope_json, None).await
}

// Both callers retain their separate admission guards for this read-only projection.
async fn memory_snapshot_values(
    state: &ThreadState,
    turn_id: &str,
    scope_json: Option<&str>,
    pending: Option<&crate::python_tools::PendingMemoryOwner>,
) -> anyhow::Result<Value> {
    let scope: Option<MemoryScope> = scope_json
        .map(|raw| {
            ensure!(
                raw.len() <= 64 * 1024,
                "Memory scope exceeds its native bound"
            );
            Ok::<_, anyhow::Error>(serde_json::from_str(raw)?)
        })
        .transpose()?;
    if let Some(proof) = pending {
        ensure!(
            scope.as_ref().map(|scope| &scope.source) == proof.profile.as_ref(),
            "Pending memory requires its exact native profile scope"
        );
        ensure!(
            crate::agent_profiles::active(&state.thread).await?.as_ref() == proof.profile.as_ref(),
            "Pending memory profile changed"
        );
    }
    let opening = match &scope {
        Some(scope) => Some(
            crate::agent_profiles::memory_scope(&state.thread, &scope.source, &scope.profiles)
                .await?,
        ),
        None => None,
    };
    let (revision, total, items, sources) = if scope.is_some() {
        let (revision, total, items, sources) = state.thread.sdk_memory_history_snapshot().await?;
        (revision, total, items, Some(sources))
    } else {
        let (revision, total, items) = state.thread.sdk_replay_history_snapshot().await?;
        (revision, total, items, None)
    };
    ensure!(
        total <= 256,
        "Native sandbox memory supports at most 256 original records"
    );
    let history = crate::subagents::read_history(state, None).await?;
    let mut admitted = HashSet::new();
    let mut terminal_profile = None;
    for item in &history {
        match item {
            RolloutItem::TurnContext(context)
                if sampling_receipt(context)
                    && context
                        .sdk_receipt
                        .as_ref()
                        .and_then(|receipt| receipt.get(MEMORY_INPUT_ADMITTED))
                        .and_then(Value::as_bool)
                        == Some(true) =>
            {
                if let Some(turn) = &context.turn_id {
                    admitted.insert(turn.clone());
                    if turn == turn_id {
                        if let Some(value) = context
                            .sdk_receipt
                            .as_ref()
                            .and_then(|receipt| receipt.get(MEMORY_TERMINAL_PROFILE))
                        {
                            let source: Option<codex_protocol::agent_profile::AgentProfileReceipt> =
                                serde_json::from_value(value.clone())?;
                            // Retained continuations may settle the same turn again.
                            // Only the newest native settlement proof owns its export.
                            terminal_profile = Some(source);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    if let Some(proof) = pending {
        let pending_turn = proof.key.turn.as_str();
        ensure!(
            pending_turn == turn_id,
            "Pending memory turn changed"
        );
        ensure!(
            history.iter().any(|item| matches!(item,
                RolloutItem::TurnContext(context)
                    if context.turn_id.as_deref() == Some(pending_turn)
                        && sampling_receipt(context)
                        && context.sdk_receipt.as_ref().and_then(|receipt| receipt.get("thread_id"))
                            .and_then(Value::as_str) == Some(state.id.to_string().as_str())
            )),
            "Pending memory requires its exact captured sampling receipt"
        );
        // The retained native approval proves this current prefix; no rollout state is written.
        admitted.insert(pending_turn.to_owned());
    }
    ensure!(
        admitted.contains(turn_id),
        "Native sandbox memory requires proven input admission"
    );
    if pending.is_none() {
        if let Some(scope) = &scope {
            ensure!(
                terminal_profile.flatten().as_ref() == Some(&scope.source),
                "Memory requires its exact native terminal profile proof"
            );
        }
    }
    let mut selected = Vec::new();
    let mut input_sources = std::collections::HashMap::new();
    let mut producers =
        std::collections::HashMap::<&str, std::collections::HashMap<u64, usize>>::new();
    if let (Some(opening), Some(sources)) = (&opening, &sources) {
        crate::agent_profiles::validate_restored(opening, &history)?;
        for source in sources {
            if let Some(profile) = &source.profile {
                ensure!(
                    source.graph.as_deref() == Some(opening.fingerprint.as_str()),
                    "Memory producer belongs to another Agent graph"
                );
                producers
                    .entry(profile.profile_id.as_str())
                    .or_default()
                    .insert(profile.epoch, 0usize);
            }
        }
        // Validate only the bounded set of output producers retained by this query.
        for item in &history {
            if let RolloutItem::ResponseItem(row) = item {
                if let Some(metadata) = &row.metadata {
                    if let Some(value) = &metadata.sdk_agent_profile {
                        let profile = crate::agent_profiles::profile_receipt(value)?;
                        if let Some(count) = producers
                            .get_mut(profile.profile_id.as_str())
                            .and_then(|epochs| epochs.get_mut(&profile.epoch))
                        {
                            ensure!(
                                metadata.sdk_agent_graph.as_deref()
                                    == Some(opening.fingerprint.as_str()),
                                "Memory producer has a conflicting graph receipt"
                            );
                            *count += 1;
                        }
                    }
                }
            }
        }
        ensure!(
            producers
                .values()
                .flat_map(|epochs| epochs.values())
                .all(|count| *count == 1),
            "Memory producer requires a unique accepted Agent envelope"
        );
    }
    for (index, raw) in items.into_iter().enumerate() {
        let item: Value = serde_json::from_str(&raw)?;
        let turn = item
            .get("internal_chat_message_metadata_passthrough")
            .and_then(|metadata| metadata.get("turn_id"))
            .and_then(Value::as_str);
        let Some(turn) = turn.and_then(|turn| admitted.get(turn)).map(String::as_str) else {
            continue;
        };
        if let (Some(scope), Some(opening), Some(sources)) = (&scope, &opening, &sources) {
            let source = sources
                .get(index)
                .context("Memory source alignment changed")?;
            if !source.projected || source.inherited {
                continue;
            }
            let profile = if let Some(profile) = &source.profile {
                profile
            } else if item.get("type").and_then(Value::as_str) == Some("message")
                && item.get("role").and_then(Value::as_str) == Some("user")
            {
                if !input_sources.contains_key(turn) {
                    input_sources.insert(
                        turn,
                        crate::agent_profiles::operation_source(opening, &history, turn)?,
                    );
                }
                input_sources.get(turn).expect("captured input source")
            } else {
                // Historical/caller context has no generated-output receipt. It
                // cannot silently become a different resource's memory input.
                continue;
            };
            if !scope.profiles.contains(&profile.profile_id) {
                continue;
            }
        }
        selected.push(raw);
    }
    if scope.is_some() {
        let mut fold = codex_history::sdk_originals::SdkOriginalSnapshotFold::new(
            selected.len(),
            selected.len(),
        );
        for raw in &selected {
            fold.begin_item().map_err(anyhow::Error::msg)?;
            fold.write_item(raw.as_bytes())
                .map_err(anyhow::Error::msg)?;
            fold.end_item().map_err(anyhow::Error::msg)?;
        }
        let (revision, total, items) = fold.finish().map_err(anyhow::Error::msg)?;
        Ok(json!({"revision":revision,"total":total,"items":items}))
    } else {
        Ok(json!({"revision":revision,"total":total,"items":selected}))
    }
}

pub async fn pending_memory_snapshot(
    state: &ThreadState,
    request_json: &str,
    scope_json: Option<&str>,
) -> anyhow::Result<Value> {
    ensure!(
        request_json.len() <= 64 * 1024,
        "Pending memory owner exceeds its native bound"
    );
    let key: crate::python_tools::PendingKey = serde_json::from_str(request_json)?;
    let _operation = state.engine.operation(false)?;
    let _mutation = state
        .mutations
        .try_lock()
        .context("native mutation is in progress")?;
    let tools = state
        .thread
        .thread_extension_data()
        .get::<crate::python_tools::PythonTools>()
        .context("Pending memory requires its live managed function owner")?;
    let proof = tools.pending_memory_owner(&state.id.to_string(), &key)?;
    let mut snapshot = memory_snapshot_values(state, &key.turn, scope_json, Some(&proof)).await?;
    let items = snapshot["items"]
        .as_array()
        .context("Invalid native memory snapshot")?;
    let mut selected = Vec::with_capacity(items.len());
    let mut removed = 0;
    for raw in items {
        let item: Value =
            serde_json::from_str(raw.as_str().context("Invalid native memory record")?)?;
        let turn = item
            .get("internal_chat_message_metadata_passthrough")
            .and_then(|value| value.get("turn_id"))
            .and_then(Value::as_str);
        if item.get("type").and_then(Value::as_str) == Some("function_call")
            && item.get("call_id").and_then(Value::as_str) == Some(key.call.as_str())
            && turn == Some(key.turn.as_str())
        {
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .context("Pending memory call is unavailable")?;
            let namespace = item
                .get("namespace")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let arguments: Value = serde_json::from_str(
                item.get("arguments")
                    .and_then(Value::as_str)
                    .context("Pending memory call is unavailable")?,
            )?;
            ensure!(
                codex_tools::ToolName::new(namespace, name.to_owned()).with_default_namespace()
                    == proof.name.clone().with_default_namespace()
                    && arguments == proof.arguments,
                "Pending memory call changed"
            );
            removed += 1;
        } else {
            selected.push(raw.clone());
        }
    }
    ensure!(
        removed == 1,
        "Pending memory requires one exact native call occurrence"
    );
    ensure!(
        crate::agent_profiles::active(&state.thread).await?.as_ref() == proof.profile.as_ref(),
        "Pending memory profile changed"
    );
    tools.check_pending_memory_owner(&state.id.to_string(), &proof)?;
    snapshot["items"] = Value::Array(selected);
    snapshot["pending_tool_name"] = json!(proof.name.to_string());
    Ok(snapshot)
}
