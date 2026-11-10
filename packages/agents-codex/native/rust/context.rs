use anyhow::ensure;
use codex_protocol::protocol::AgentStatus;
use serde_json::{Value, json};

use crate::engine::ThreadState;
use crate::environment::StrictExecutorWrites;

async fn check_idle(state: &ThreadState) -> anyhow::Result<()> {
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
        "model context requires an idle, open native thread"
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

pub async fn read(state: &ThreadState) -> anyhow::Result<Value> {
    let _mutation = state
        .mutations
        .try_lock()
        .map_err(|_| anyhow::anyhow!("native thread mutation is in progress"))?;
    check_idle(state).await?;
    let snapshot = state.thread.conversation_history_snapshot().await;
    Ok(snapshot_value(state, snapshot.as_ref()))
}

fn snapshot_value(
    state: &ThreadState,
    snapshot: &dyn codex_extension_api::ConversationHistorySnapshot,
) -> Value {
    json!({
        "thread_id": state.id,
        "history_version": snapshot.history_version(),
        "user_message_revision": snapshot.user_message_revision(),
        "guardian_review_context_revision": snapshot.guardian_review_context_revision(),
        "retained_context": snapshot.retained_context(),
        "items": snapshot.items().collect::<Vec<_>>(),
    })
}

// A short-lived SDK transaction owns this lease. Ordinary public native ingress
// shares the engine gate; event readers remain independent of it.
pub struct Change {
    pub state: std::sync::Arc<ThreadState>,
    _permit: tokio::sync::OwnedRwLockWriteGuard<()>,
    snapshot: std::sync::Arc<dyn codex_extension_api::ConversationHistorySnapshot>,
    pub checkpoint: Value,
    settings: codex_protocol::protocol::ThreadSettingsSnapshot,
    instructions: Option<String>,
    sdk_originals: codex_history::sdk_originals::SdkOriginalHistory,
}

pub async fn begin(state: std::sync::Arc<ThreadState>) -> anyhow::Result<Change> {
    use anyhow::Context;
    let permit = state
        .engine
        .context_gate
        .clone()
        .try_write_owned()
        .context("native operations are still in progress")?;
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
    ensure!(
        state.engine.goals.is_none(),
        "supplied compaction does not support goal-backed engines"
    );
    ensure!(
        state.engine.local_checklist_store.is_none(),
        "supplied compaction does not support local storage"
    );
    // Write admission excludes allocation; retained or locked cleanup refuses.
    ensure!(
        !state.has_pending_fork_copy(),
        "supplied compaction requires completed fork cleanup; retry fork() or close()"
    );
    ensure!(
        state.engine.manager.list_thread_ids().await == vec![state.id],
        "application compaction requires an exclusively owned root without native children"
    );
    ensure!(
        crate::subagents::list(&state).await?.is_empty(),
        "application compaction does not migrate native child graphs"
    );
    ensure!(
        state.thread.list_background_terminals().await.is_empty(),
        "application compaction requires completed background execution"
    );
    crate::graph_stop::check_mutation(&state)?;
    if let Some(settlement) = state
        .thread
        .thread_extension_data()
        .get::<crate::turn_settlement::Settlement>()
    {
        ensure!(
            settlement.active().is_none(),
            "native turn settlement is still in progress"
        );
    }
    if let Some(tools) = state
        .thread
        .thread_extension_data()
        .get::<crate::python_tools::PythonTools>()
    {
        tools.check_context_manual_idle()?;
    }
    if let Some(control) = state
        .thread
        .thread_extension_data()
        .get::<crate::native_interception::Control>()
    {
        control.check_context_idle()?;
    }
    if let Some(control) = state
        .thread
        .thread_extension_data()
        .get::<crate::mcp_result_control::McpResultControl>()
    {
        control.check_context_idle()?;
    }
    let mut checkpoint = {
        let _mutation = state
            .mutations
            .try_lock()
            .map_err(|_| anyhow::anyhow!("native thread mutation is in progress"))?;
        check_idle(&state).await?;
        crate::checkpoint::export(&state, None).await?
    };
    // Public checkpoints export defaults only. Internal context replacement
    // must restore the complete current catalog before transferring its revision.
    if let Some(tools) = state
        .thread
        .thread_extension_data()
        .get::<crate::python_tools::PythonTools>()
    {
        checkpoint["managed_tool_specs"] = tools.context_specs()?;
    }
    if let Some(guard) = state
        .thread
        .thread_extension_data()
        .get::<crate::recovery_guard::Guard>()
    {
        checkpoint["root_tool_origins"] = serde_json::to_value(guard.origins())?;
    }
    checkpoint["agent_options"] = json!({});
    let snapshot = state.thread.conversation_history_snapshot().await;
    let sdk_originals = state.thread.sdk_original_history().await;
    let settings = state.thread.thread_settings_snapshot().await;
    let instructions = state.instructions.text()?;
    let history: Vec<codex_history::RolloutItem> =
        serde_json::from_value(checkpoint["history"].clone())?;
    crate::checkpoint::check_context_history(&state, &history).await?;
    ensure!(
        checkpoint["interrupted_thread_ids"]
            .as_array()
            .is_none_or(Vec::is_empty),
        "application compaction requires settled turns"
    );
    Ok(Change {
        state,
        _permit: permit,
        snapshot,
        checkpoint,
        settings,
        instructions,
        sdk_originals,
    })
}

impl Change {
    pub fn context(&self) -> Value {
        snapshot_value(&self.state, self.snapshot.as_ref())
    }

    pub fn fence(&self) {
        self.state
            .engine
            .retired
            .store(true, std::sync::atomic::Ordering::Release);
    }

    pub async fn retire(&self) -> anyhow::Result<Option<String>> {
        self.fence();
        self.state.close_report().await
    }

    pub fn options(&self) -> Value {
        let instruction_files = self
            .state
            .instructions
            .accepted()
            .map(|accepted| accepted.files)
            .unwrap_or_default();
        json!({
            "instructions": self.instructions,
            "instruction_files": instruction_files,
            "settings": self.settings,
        })
    }

    pub async fn validate_candidate(&self, candidate: &ThreadState) -> anyhow::Result<()> {
        use codex_protocol::protocol::ThreadSettingsOverrides;
        // Only a different, private engine can be prepared under the source lease.
        ensure!(
            !std::sync::Arc::ptr_eq(&self.state.engine, &candidate.engine)
                && self.state.id == candidate.id,
            "compaction candidate must own a private engine for the same conversation"
        );
        let _operation = candidate.engine.operation(false)?;
        let _mutation = candidate
            .mutations
            .try_lock()
            .map_err(|_| anyhow::anyhow!("candidate mutation is in progress"))?;
        // Startup options already restore these preferences in the common case.
        // Avoid rewriting an absent tier: native clear normalizes it to "default".
        let before = candidate.thread.thread_settings_snapshot().await;
        let effort = (before.reasoning_effort != self.settings.reasoning_effort)
            .then(|| self.settings.reasoning_effort.clone());
        let service_tier = (before.service_tier != self.settings.service_tier)
            .then(|| self.settings.service_tier.clone());
        if effort.is_some() || service_tier.is_some() {
            candidate
                .thread
                .update_thread_settings(ThreadSettingsOverrides {
                    effort,
                    service_tier,
                    ..Default::default()
                })
                .await?;
        }
        let actual = candidate.thread.thread_settings_snapshot().await;
        ensure!(
            actual == self.settings,
            "compaction cannot carry current thread settings into the restored candidate"
        );
        ensure!(
            candidate.instructions.text()? == self.instructions,
            "compaction cannot carry current thread instructions"
        );
        let source_tools = self
            .state
            .thread
            .thread_extension_data()
            .get::<crate::python_tools::PythonTools>();
        let candidate_tools = candidate
            .thread
            .thread_extension_data()
            .get::<crate::python_tools::PythonTools>();
        match (source_tools, candidate_tools) {
            (Some(source), Some(target)) => {
                target.check_idle(&candidate.thread).await?;
                target.retain_context_revision(&source)?;
            }
            (None, None) => {}
            _ => anyhow::bail!("compaction candidate changed managed tool ownership"),
        }
        let source = self.state.thread.thread_extension_data();
        let target = candidate.thread.thread_extension_data();
        match (
            source.get::<StrictExecutorWrites>(),
            target.get::<StrictExecutorWrites>(),
        ) {
            (Some(source), Some(strict)) => {
                strict.check_pins(&source)?;
                // The restored selection was built from canonical paths.
                // Keep the source's accepted declarations for this Session.
                target.insert((*source).clone());
            }
            (None, None) => {}
            _ => anyhow::bail!("compaction candidate changed strict executor ownership"),
        }
        Ok(())
    }

    pub fn prepare(&self, summary: &str, retained_indices: Vec<u32>) -> anyhow::Result<Value> {
        ensure!(
            !summary.trim().is_empty(),
            "summary must contain non-whitespace text"
        );
        use anyhow::Context;
        use codex_history::{
            CompactedItem, GuardianHistoryCheckpoint, ResponseItemEnvelope, RolloutItem,
        };
        use codex_protocol::models::ResponseItem;
        let live = self.snapshot.items().cloned().collect::<Vec<_>>();
        let mut retained_indices: Vec<usize> = retained_indices
            .into_iter()
            .map(|index| index as usize)
            .collect();
        ensure!(
            retained_indices.iter().all(|index| *index < live.len()),
            "retained indices must be within the current model context"
        );
        retained_indices.extend(live.iter().enumerate().filter_map(|(index, item)| {
            matches!(item, ResponseItem::Message { role, .. } if role == "system" || role == "developer")
                .then_some(index)
        }));
        retained_indices.sort_unstable();
        retained_indices.dedup();
        check_pairs(&live, &retained_indices)?;
        let history: Vec<RolloutItem> = serde_json::from_value(self.checkpoint["history"].clone())?;
        ensure!(
            matches!(history.first(), Some(RolloutItem::SessionMeta(header))
            if header.meta.id == self.state.id && header.meta.history_base.is_none()),
            "supplied compaction requires complete canonical history"
        );
        let mut current = Vec::new();
        let mut review = Vec::new();
        let mut saw_compaction = false;
        for row in &history {
            match row {
                RolloutItem::ResponseItem(item) => {
                    current.push(item.clone());
                    review.push(item.clone());
                }
                RolloutItem::Compacted(item) => {
                    saw_compaction = true;
                    current = item
                        .replacement_history
                        .clone()
                        .context("legacy compaction without original envelopes is unsupported")?;
                    if let Some(items) = &item.guardian_history {
                        review = items.0.clone();
                    }
                }
                RolloutItem::EventMsg(codex_protocol::protocol::EventMsg::ThreadRolledBack(_))
                    if saw_compaction =>
                {
                    anyhow::bail!(
                        "application compaction cannot establish envelope provenance after a rolled-back compaction"
                    )
                }
                _ => {}
            }
        }
        let originals = original_envelopes(&live, &current)?;
        let mut replacement = retained_indices
            .iter()
            .map(|index| originals[*index].clone())
            .collect::<Vec<_>>();
        // Use the same explicit context kind as native compaction. A summary is
        // model context, never a new original user authorization.
        let summary_item: ResponseItem = serde_json::from_value(json!({
            "type": "message", "role": "user",
            "id": format!("msg_{}", codex_protocol::ThreadId::new()),
            "content": [{"type": "input_text", "text": summary}],
            "internal_chat_message_metadata_passthrough": {
                "content_item_kinds": ["compaction.summary"]
            }
        }))?;
        replacement.push(ResponseItemEnvelope::new(summary_item));
        let guardian_history = if self.snapshot.uses_independent_review_history() {
            Some(GuardianHistoryCheckpoint(original_envelopes(
                &self.snapshot.review_items().cloned().collect::<Vec<_>>(),
                &review,
            )?))
        } else {
            None
        };
        let compacted = CompactedItem {
            message: summary.to_owned(),
            replacement_history: Some(replacement),
            sdk_originals: Some(self.sdk_originals.clone()),
            guardian_history,
            retained_context: self.snapshot.retained_context().cloned(),
            // Full canonical history is preserved. Native restore replays its
            // existing origin checkpoints and events, including rolled-back turns.
            mcp_resource_origins: None,
            window_number: None,
            first_window_id: None,
            previous_window_id: None,
            window_id: None,
            compaction_response_id: None,
            latest_token_usage_record: None,
            resume_metadata: None,
        };
        let mut candidate = self.checkpoint.clone();
        candidate["history"]
            .as_array_mut()
            .context("checkpoint lacks history")?
            .push(serde_json::to_value(RolloutItem::Compacted(compacted))?);
        Ok(candidate)
    }
}

// Join the complete native sequence to canonical originals before selecting
// indices. Earliest/latest feasible positions preserve occurrence identity and
// expose ambiguity instead of inventing metadata for duplicate payloads.
fn original_envelopes(
    items: &[codex_protocol::models::ResponseItem],
    source: &[codex_history::ResponseItemEnvelope],
) -> anyhow::Result<Vec<codex_history::ResponseItemEnvelope>> {
    use anyhow::Context;
    let live = items
        .iter()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()?;
    let original = source
        .iter()
        .map(|item| serde_json::to_value(&item.item))
        .collect::<Result<Vec<_>, _>>()?;
    let matches = |i: usize, j: usize| -> bool {
        if live[i] == original[j] {
            return true;
        }
        if !matches!(
            live[i]["type"].as_str(),
            Some("function_call_output" | "custom_tool_call_output")
        ) {
            return false;
        }
        // Native shortens these payloads without changing their envelope
        // metadata. Everything outside output, including IDs, must still match.
        let mut left = live[i].clone();
        let mut right = original[j].clone();
        left.as_object_mut()
            .expect("response item is an object")
            .remove("output");
        right
            .as_object_mut()
            .expect("response item is an object")
            .remove("output");
        left == right
    };
    let mut earliest = Vec::with_capacity(items.len());
    let mut cursor = 0;
    for i in 0..items.len() {
        let j = (cursor..source.len())
            .find(|j| matches(i, *j))
            .context("current context has no ordered canonical original")?;
        earliest.push(j);
        cursor = j + 1;
    }
    let mut latest = vec![0; items.len()];
    cursor = source.len();
    for i in (0..items.len()).rev() {
        let j = (0..cursor)
            .rev()
            .find(|j| matches(i, *j))
            .context("current context has no ordered canonical original")?;
        latest[i] = j;
        cursor = j;
    }
    items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let start = if i == 0 { 0 } else { earliest[i - 1] + 1 };
            let end = if i + 1 == items.len() {
                source.len()
            } else {
                latest[i + 1]
            };
            let metadata = &source[earliest[i]].metadata;
            ensure!(
                (start..end)
                    .filter(|j| matches(i, *j))
                    .all(|j| source[j].metadata == *metadata),
                "original context metadata is ambiguous between ordered occurrences"
            );
            Ok(codex_history::ResponseItemEnvelope {
                item: item.clone(),
                metadata: metadata.clone(),
            })
        })
        .collect()
}

pub(crate) fn check_pairs(
    items: &[codex_protocol::models::ResponseItem],
    indices: &[usize],
) -> anyhow::Result<()> {
    use codex_protocol::models::ResponseItem;
    use std::collections::HashMap;
    let mut calls: HashMap<(&str, &str), usize> = HashMap::new();
    for (index, item) in items.iter().enumerate() {
        let (family, id, is_call) = match item {
            ResponseItem::FunctionCall { call_id, .. } => ("function", Some(call_id), true),
            ResponseItem::LocalShellCall { call_id, .. } => ("function", call_id.as_ref(), true),
            ResponseItem::FunctionCallOutput { call_id, .. } => {
                ("function", call_id.as_ref(), false)
            }
            ResponseItem::ComputerCall { call_id, .. } => ("computer", Some(call_id), true),
            ResponseItem::ComputerCallOutput { call_id, .. } => ("computer", Some(call_id), false),
            ResponseItem::CustomToolCall { call_id, .. } => ("custom", Some(call_id), true),
            ResponseItem::CustomToolCallOutput { call_id, .. } => ("custom", Some(call_id), false),
            ResponseItem::ToolSearchCall {
                call_id, execution, ..
            } if execution != "server" => ("search", call_id.as_ref(), true),
            ResponseItem::ToolSearchOutput {
                call_id, execution, ..
            } if execution != "server" => ("search", call_id.as_ref(), false),
            _ => continue,
        };
        let Some(id) = id else {
            anyhow::bail!("application compaction cannot preserve an unidentified tool pair");
        };
        let key = (family, id.as_str());
        if is_call {
            ensure!(
                calls.insert(key, index).is_none(),
                "application compaction requires nonoverlapping resolved tool calls"
            );
        } else {
            let Some(call) = calls.remove(&key) else {
                anyhow::bail!(
                    "application compaction requires resolved tool calls in their original family"
                );
            };
            ensure!(
                indices.binary_search(&call).is_ok() == indices.binary_search(&index).is_ok(),
                "retain both original tool call and result, or neither"
            );
        }
    }
    ensure!(
        calls.is_empty(),
        "application compaction requires resolved tool calls in their original family"
    );
    Ok(())
}

#[cfg(test)]
mod computer_pair_tests {
    use super::check_pairs;
    use codex_protocol::models::ResponseItem;
    use serde_json::json;

    fn pair() -> Vec<ResponseItem> {
        vec![
            serde_json::from_value(json!({"type":"computer_call","id":"cu","call_id":"device","actions":[{"type":"wait"}]})).unwrap(),
            serde_json::from_value(json!({"type":"computer_call_output","call_id":"device","output":{"type":"computer_screenshot","image_url":"data:image/png;base64,aA=="},"acknowledged_safety_checks":[]})).unwrap(),
        ]
    }

    #[test]
    fn computer_compaction_retains_both_original_items_or_neither() {
        let items = pair();
        check_pairs(&items, &[]).unwrap();
        check_pairs(&items, &[0, 1]).unwrap();
        for indices in [&[0][..], &[1][..]] {
            assert!(
                check_pairs(&items, indices)
                    .unwrap_err()
                    .to_string()
                    .contains("retain both original")
            );
        }
    }

    #[test]
    fn computer_compaction_requires_original_identity_and_family() {
        let mut items = pair();
        assert!(check_pairs(&items[1..], &[0]).is_err());
        assert!(check_pairs(&items[..1], &[]).is_err());
        items[1] = serde_json::from_value(
            json!({"type":"function_call_output","call_id":"device","output":"not a screenshot"}),
        )
        .unwrap();
        assert!(
            check_pairs(&items, &[0, 1])
                .unwrap_err()
                .to_string()
                .contains("original family")
        );
    }
}
