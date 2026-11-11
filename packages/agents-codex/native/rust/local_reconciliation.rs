//! Plan a complete, application-confirmed import before the local writer publishes it.

use std::collections::{BTreeMap, HashSet};
use std::fmt;

use anyhow::{Context, Result, ensure};
use codex_history::{ResponseItemEnvelope, RolloutItem};
use codex_protocol::ThreadId;
use codex_protocol::items::{CollabAgentTool, CollabAgentToolCallStatus, TurnItem};
use codex_protocol::models::{
    ContentItemKind, FunctionCallOutputBody, FunctionCallOutputPayload,
    InternalChatMessageMetadataPassthrough, ResponseItem,
};
use codex_protocol::protocol::{EventMsg, SubAgentActivityKind};
use serde::{Deserialize, Serialize};

const APPLIED: &str = "sdk_reconciliation.applied";
const NOT_APPLIED: &str = "sdk_reconciliation.not_applied";

pub(crate) fn invocation_id(item: &ResponseItem) -> Option<&str> {
    match item {
        ResponseItem::FunctionCall { call_id, .. }
        | ResponseItem::CustomToolCall { call_id, .. }
        | ResponseItem::ComputerCall { call_id, .. } => Some(call_id.as_str()),
        ResponseItem::McpApprovalRequest { id: Some(id), .. } => Some(id.as_str()),
        _ => None,
    }
}

pub(crate) fn output_identity(item: &ResponseItem) -> Option<(&str, Option<&str>)> {
    let call = match item {
        ResponseItem::FunctionCallOutput {
            call_id: Some(call),
            ..
        }
        | ResponseItem::CustomToolCallOutput { call_id: call, .. }
        | ResponseItem::ComputerCallOutput { call_id: call, .. }
        | ResponseItem::McpApprovalResponse {
            approval_request_id: call,
            ..
        } => call,
        ResponseItem::ShellCallOutput {
            provider_fields, ..
        } => provider_fields.get("call_id")?.as_str()?,
        _ => return None,
    };
    Some((call, item.turn_id()))
}

pub(crate) fn output_matches_invocation(call: &ResponseItem, result: &ResponseItem) -> bool {
    match (call, result) {
        (
            ResponseItem::FunctionCall {
                call_id: expected, ..
            },
            ResponseItem::FunctionCallOutput {
                call_id: Some(actual),
                ..
            },
        )
        | (
            ResponseItem::CustomToolCall {
                call_id: expected, ..
            },
            ResponseItem::CustomToolCallOutput {
                call_id: actual, ..
            },
        )
        | (
            ResponseItem::ComputerCall {
                call_id: expected, ..
            },
            ResponseItem::ComputerCallOutput {
                call_id: actual, ..
            },
        ) => expected == actual,
        (
            ResponseItem::McpApprovalRequest {
                id: Some(expected),
                provider_fields,
                ..
            },
            ResponseItem::McpApprovalResponse {
                approval_request_id: actual,
                caller,
                ..
            },
        ) => {
            expected.as_str() == actual.as_str() && provider_fields.get("caller") == caller.as_ref()
        }
        (
            ResponseItem::ShellCall {
                provider_fields: call,
                ..
            },
            ResponseItem::ShellCallOutput {
                provider_fields: output,
                ..
            },
        ) => call
            .get("call_id")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|expected| {
                output.get("call_id").and_then(serde_json::Value::as_str) == Some(expected)
            }),
        _ => false,
    }
}

pub(crate) fn same_output_payload(left: &ResponseItem, right: &ResponseItem) -> bool {
    match (left, right) {
        (
            ResponseItem::FunctionCallOutput { output: left, .. },
            ResponseItem::FunctionCallOutput { output: right, .. },
        )
        | (
            ResponseItem::CustomToolCallOutput { output: left, .. },
            ResponseItem::CustomToolCallOutput { output: right, .. },
        ) => serde_json::to_value(left)
            .ok()
            .zip(serde_json::to_value(right).ok())
            .is_some_and(|(left, right)| left == right),
        (
            ResponseItem::ComputerCallOutput {
                output: left,
                acknowledged_safety_checks: left_checks,
                ..
            },
            ResponseItem::ComputerCallOutput {
                output: right,
                acknowledged_safety_checks: right_checks,
                ..
            },
        ) => left == right && left_checks == right_checks,
        (
            ResponseItem::McpApprovalResponse {
                approval_request_id: left_id,
                approve: left,
                reason: left_reason,
                caller: left_caller,
                ..
            },
            ResponseItem::McpApprovalResponse {
                approval_request_id: right_id,
                approve: right,
                reason: right_reason,
                caller: right_caller,
                ..
            },
        ) => {
            left_id == right_id
                && left == right
                && left_reason == right_reason
                && left_caller == right_caller
        }
        (
            ResponseItem::ShellCallOutput {
                provider_fields: left,
                ..
            },
            ResponseItem::ShellCallOutput {
                provider_fields: right,
                ..
            },
        ) => {
            left.get("output")
                .zip(right.get("output"))
                .is_some_and(|(left, right)| left == right)
                && left.get("max_output_length") == right.get("max_output_length")
        }
        _ => false,
    }
}

pub(crate) fn computer_receipt(
    invocation: &ResponseItem,
    response: codex_protocol::dynamic_tools::DynamicToolResponse,
    turn: &str,
) -> Result<ResponseItem> {
    use codex_tools::ToolOutput as _;
    let ResponseItem::ComputerCall { call_id, .. } = invocation else {
        anyhow::bail!("Computer reconciliation requires its original call");
    };
    let arguments = serde_json::to_string(invocation)
        .map_err(|_| anyhow::anyhow!("Invalid original computer call"))?;
    let output = codex_tools::ComputerToolOutput::from_dynamic_response(&arguments, response)
        .map_err(|_| {
            anyhow::anyhow!(
                "Computer reconciliation requires a valid screenshot and safety acknowledgements"
            )
        })?;
    let mut item: ResponseItem = output
        .to_response_item(call_id, &codex_tools::ToolPayload::Computer { arguments })
        .into();
    let ResponseItem::ComputerCallOutput {
        internal_chat_message_metadata_passthrough,
        ..
    } = &mut item
    else {
        unreachable!("validated computer output has the native computer shape");
    };
    *internal_chat_message_metadata_passthrough = Some(InternalChatMessageMetadataPassthrough {
        turn_id: Some(turn.to_owned()),
        ..Default::default()
    });
    Ok(item)
}

pub(crate) fn shell_receipt(
    invocation: &ResponseItem,
    response: codex_protocol::dynamic_tools::DynamicToolResponse,
    turn: &str,
) -> Result<ResponseItem> {
    use codex_tools::ToolOutput as _;
    let ResponseItem::ShellCall {
        provider_fields, ..
    } = invocation
    else {
        anyhow::bail!("Shell reconciliation requires its original call");
    };
    ensure!(
        provider_fields
            .get("container_id")
            .is_none_or(serde_json::Value::is_null)
            && provider_fields
                .get("environment")
                .filter(|value| !value.is_null())
                .is_none_or(|environment| {
                    environment.get("type").and_then(serde_json::Value::as_str) == Some("local")
                }),
        "Shell reconciliation requires an application-owned local call"
    );
    let call_id = provider_fields
        .get("call_id")
        .and_then(serde_json::Value::as_str)
        .context("Shell reconciliation requires its original call ID")?;
    let arguments = serde_json::to_string(invocation)
        .map_err(|_| anyhow::anyhow!("Invalid original shell call"))?;
    let output = codex_tools::ApplicationShellOutput::from_dynamic_response(&arguments, response)
        .map_err(|_| {
        anyhow::anyhow!("Shell reconciliation requires valid structured output")
    })?;
    let mut item: ResponseItem = output
        .to_response_item(call_id, &codex_tools::ToolPayload::Shell { arguments })
        .into();
    let ResponseItem::ShellCallOutput {
        internal_chat_message_metadata_passthrough,
        ..
    } = &mut item
    else {
        unreachable!("validated shell output has the native shell shape");
    };
    *internal_chat_message_metadata_passthrough = Some(InternalChatMessageMetadataPassthrough {
        turn_id: Some(turn.to_owned()),
        ..Default::default()
    });
    Ok(item)
}

fn shell_reconciliation(
    invocation: &ResponseItem,
    result: &str,
    turn: &str,
) -> Result<ResponseItem> {
    shell_receipt(
        invocation,
        codex_protocol::dynamic_tools::DynamicToolResponse {
            content_items: vec![
                codex_protocol::dynamic_tools::DynamicToolCallOutputContentItem::InputText {
                    text: result.to_owned(),
                },
            ],
            success: true,
        },
        turn,
    )
}

fn computer_reconciliation(
    invocation: &ResponseItem,
    result: &str,
    turn: &str,
) -> Result<ResponseItem> {
    computer_receipt(
        invocation,
        codex_protocol::dynamic_tools::DynamicToolResponse {
            content_items: vec![
                codex_protocol::dynamic_tools::DynamicToolCallOutputContentItem::InputText {
                    text: result.to_owned(),
                },
            ],
            success: true,
        },
        turn,
    )
}

fn computer_result_matches(item: &ResponseItem, result: &str) -> bool {
    let ResponseItem::ComputerCallOutput {
        output,
        acknowledged_safety_checks,
        ..
    } = item
    else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(result) else {
        return false;
    };
    value.get("output") == Some(output)
        && match value.get("acknowledged_safety_checks") {
            Some(serde_json::Value::Array(checks)) => checks == acknowledged_safety_checks,
            None => acknowledged_safety_checks.is_empty(),
            _ => false,
        }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Outcome {
    Applied,
    NotApplied,
}

impl Outcome {
    fn tag(self) -> &'static str {
        match self {
            Self::Applied => APPLIED,
            Self::NotApplied => NOT_APPLIED,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Receipt {
    pub(crate) thread_id: ThreadId,
    turn_id: String,
    call_id: String,
    outcome: Outcome,
    result: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UncertainCall {
    thread_id: ThreadId,
    pub(crate) turn_id: String,
    call_id: String,
    name: String,
    namespace: Option<String>,
    arguments: String,
}

pub(crate) struct RecoveryRequired {
    pub(crate) calls: Vec<UncertainCall>,
    pub(crate) history: Vec<RolloutItem>,
    pub(crate) descendants: Vec<(ThreadId, Vec<RolloutItem>)>,
}

impl fmt::Display for RecoveryRequired {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("local history contains unknown tool effects; reconciliation required")
    }
}

impl fmt::Debug for RecoveryRequired {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

impl std::error::Error for RecoveryRequired {}

fn uncertain_call(
    thread_id: ThreadId,
    turn_id: &str,
    call_id: &str,
    invocation: &ResponseItem,
) -> Result<UncertainCall> {
    let (name, namespace, arguments) = match invocation {
        ResponseItem::FunctionCall {
            name,
            namespace,
            arguments,
            ..
        } => (name.clone(), namespace.clone(), arguments.clone()),
        ResponseItem::CustomToolCall {
            name,
            namespace,
            input,
            ..
        } => (name.clone(), namespace.clone(), input.clone()),
        ResponseItem::ComputerCall { .. } => (
            "computer".to_owned(),
            None,
            serde_json::to_string(invocation)
                .map_err(|_| anyhow::anyhow!("Invalid recorded computer invocation"))?,
        ),
        ResponseItem::ShellCall { .. } => (
            "shell".to_owned(),
            None,
            serde_json::to_string(invocation)
                .map_err(|_| anyhow::anyhow!("Invalid recorded shell invocation"))?,
        ),
        _ => unreachable!("the call index only retains supported invocations"),
    };
    Ok(UncertainCall {
        thread_id,
        turn_id: turn_id.to_owned(),
        call_id: call_id.to_owned(),
        name,
        namespace,
        arguments,
    })
}

struct Call<'a> {
    invocation: &'a ResponseItem,
    output: Option<&'a ResponseItem>,
}

type Calls<'a> = BTreeMap<(Option<String>, String), Call<'a>>;

fn output(item: &ResponseItem) -> Option<(&str, &FunctionCallOutputPayload)> {
    match item {
        ResponseItem::FunctionCallOutput {
            call_id: Some(call_id),
            output,
            ..
        }
        | ResponseItem::CustomToolCallOutput {
            call_id, output, ..
        } => Some((call_id, output)),
        _ => None,
    }
}

fn tag(item: &ResponseItem) -> Option<&str> {
    let metadata = match item {
        ResponseItem::FunctionCallOutput {
            internal_chat_message_metadata_passthrough,
            ..
        }
        | ResponseItem::CustomToolCallOutput {
            internal_chat_message_metadata_passthrough,
            ..
        }
        | ResponseItem::ComputerCallOutput {
            internal_chat_message_metadata_passthrough,
            ..
        }
        | ResponseItem::ShellCallOutput {
            internal_chat_message_metadata_passthrough,
            ..
        } => internal_chat_message_metadata_passthrough.as_ref()?,
        _ => return None,
    };
    match metadata.content_item_kinds.as_deref()? {
        [ContentItemKind(tag)] if tag == APPLIED || tag == NOT_APPLIED => Some(tag),
        _ => None,
    }
}

pub(crate) fn is_application_shell_call(row: &ResponseItemEnvelope) -> bool {
    matches!(row.item, ResponseItem::ShellCall { .. })
        && row
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.sdk_application_tool.as_deref())
            == Some("shell")
}

fn calls(history: &[RolloutItem]) -> Result<Calls<'_>> {
    let mut calls = Calls::new();
    let mut turn = None;
    for row in history {
        crate::local_storage::observe_turn(&mut turn, row);
        let RolloutItem::ResponseItem(envelope) = row else {
            continue;
        };
        let item = &envelope.item;
        let owner = item.turn_id().map(str::to_owned).or_else(|| turn.clone());
        match invocation_id(item) {
            Some(call_id) => {
                ensure!(
                    calls
                        .insert(
                            (owner, call_id.to_owned()),
                            Call {
                                invocation: item,
                                output: None,
                            }
                        )
                        .is_none(),
                    "ambiguous tool call identity in local history"
                );
            }
            ResponseItem::ShellCall {
                provider_fields, ..
            } => {
                let Some(call_id) = provider_fields
                    .get("call_id")
                    .and_then(serde_json::Value::as_str)
                else {
                    continue;
                };
                if !is_application_shell_call(envelope) {
                    continue;
                }
                let call_id = provider_fields
                    .get("call_id")
                    .and_then(serde_json::Value::as_str)
                    .context("recorded shell call has no valid call ID")?;
                ensure!(
                    calls
                        .insert(
                            (owner, call_id.to_owned()),
                            Call {
                                invocation: item,
                                output: None
                            }
                        )
                        .is_none(),
                    "ambiguous tool call identity in local history"
                );
            }
            _ => {
                if let Some((call_id, _)) = output_identity(item)
                    && let Some(entry) = calls.get_mut(&(owner, call_id.to_owned()))
                {
                    ensure!(
                        output_matches_invocation(entry.invocation, item),
                        "tool output kind does not match recorded invocation"
                    );
                    ensure!(
                        entry
                            .output
                            .is_none_or(|prior| { tag(prior).is_none() && tag(item).is_none() })
                            || entry.output == Some(item),
                        "reconciliation conflicts with a retained result"
                    );
                    entry.output = Some(item);
                }
            }
        }
    }
    Ok(calls)
}

pub(crate) fn completed_spawn_turns(
    parent: ThreadId,
    child: ThreadId,
    history: &[RolloutItem],
) -> Result<HashSet<String>> {
    let calls = calls(history)?;
    let mut turns = HashSet::new();
    let mut active = None;
    for row in history {
        crate::local_storage::observe_turn(&mut active, row);
        let (turn, call) = match row {
            RolloutItem::EventMsg(EventMsg::ItemCompleted(event)) if event.thread_id == parent => {
                match &event.item {
                    TurnItem::SubAgentActivity(item)
                        if item.kind == SubAgentActivityKind::Started
                            && item.agent_thread_id == child =>
                    {
                        (&event.turn_id, &item.id)
                    }
                    TurnItem::CollabAgentToolCall(item)
                        if item.tool == CollabAgentTool::SpawnAgent
                            && item.status == CollabAgentToolCallStatus::Completed
                            && item.sender_thread_id == parent
                            && item.receiver_thread_ids == [child] =>
                    {
                        (&event.turn_id, &item.id)
                    }
                    _ => continue,
                }
            }
            // Legacy V2 rollouts persist the completed item's legacy activity
            // in the emitting turn instead of persisting the canonical item.
            RolloutItem::EventMsg(EventMsg::SubAgentActivity(event))
                if event.kind == SubAgentActivityKind::Started
                    && event.agent_thread_id == child =>
            {
                let Some(turn) = active.as_ref() else {
                    continue;
                };
                (turn, &event.event_id)
            }
            _ => continue,
        };
        if calls.get(&(Some(turn.clone()), call.clone())).is_some_and(|entry|
            matches!(entry.invocation, ResponseItem::FunctionCall { name, namespace, .. }
                if name == "spawn_agent" && matches!(namespace.as_deref(), None | Some("collaboration" | "multi_agent_v1")))
                && matches!(entry.output, Some(ResponseItem::FunctionCallOutput { output, .. })
                    if output.success != Some(false))
                && entry.output.is_some_and(|output| tag(output).is_none())
        ) {
            turns.insert(turn.clone());
        }
    }
    ensure!(
        turns.len() <= 1,
        "descendant has ambiguous completed spawn history"
    );
    Ok(turns)
}

pub(crate) fn validate_settled(history: &[RolloutItem]) -> Result<()> {
    ensure!(
        calls(history)?.values().all(|call| call.output.is_some()),
        "local history contains unknown tool effects; automatic replay is unsupported"
    );
    Ok(())
}

fn retained_result(invocation: &ResponseItem, item: &ResponseItem, receipt: &Receipt) -> bool {
    tag(item) == Some(receipt.outcome.tag())
        && output(item).is_some_and(|(_, payload)| {
            matches!(&payload.body, FunctionCallOutputBody::Text(text) if text == &receipt.result)
        }) || tag(item) == Some(receipt.outcome.tag()) && computer_result_matches(item, &receipt.result)
        || tag(item) == Some(receipt.outcome.tag())
            && matches!(invocation, ResponseItem::ShellCall { .. })
            && shell_reconciliation(invocation, &receipt.result, &receipt.turn_id)
                .is_ok_and(|expected| same_output_payload(item, &expected))
}

fn response(invocation: &ResponseItem, receipt: &Receipt) -> Result<RolloutItem> {
    if matches!(
        invocation,
        ResponseItem::ComputerCall { .. } | ResponseItem::ShellCall { .. }
    ) {
        let mut result = if matches!(invocation, ResponseItem::ComputerCall { .. }) {
            computer_reconciliation(invocation, &receipt.result, &receipt.turn_id)?
        } else {
            shell_reconciliation(invocation, &receipt.result, &receipt.turn_id)?
        };
        if let ResponseItem::ComputerCallOutput {
            internal_chat_message_metadata_passthrough: Some(metadata),
            ..
        }
        | ResponseItem::ShellCallOutput {
            internal_chat_message_metadata_passthrough: Some(metadata),
            ..
        } = &mut result
        {
            metadata.content_item_kinds =
                Some(vec![ContentItemKind(receipt.outcome.tag().to_owned())]);
        }
        return Ok(RolloutItem::ResponseItem(ResponseItemEnvelope::new(result)));
    }
    let output = FunctionCallOutputPayload::from_text(receipt.result.clone());
    let metadata = Some(InternalChatMessageMetadataPassthrough {
        turn_id: Some(receipt.turn_id.clone()),
        content_item_kinds: Some(vec![ContentItemKind(receipt.outcome.tag().to_owned())]),
        ..Default::default()
    });
    let result = match invocation {
        ResponseItem::FunctionCall {
            name, namespace, ..
        } => ResponseItem::FunctionCallOutput {
            id: None,
            call_id: Some(receipt.call_id.clone()),
            name: Some(name.clone()),
            namespace: namespace.clone(),
            output,
            internal_chat_message_metadata_passthrough: metadata,
        },
        ResponseItem::CustomToolCall { name, .. } => ResponseItem::CustomToolCallOutput {
            id: None,
            call_id: receipt.call_id.clone(),
            name: Some(name.clone()),
            output,
            internal_chat_message_metadata_passthrough: metadata,
        },
        _ => unreachable!("the call index only retains supported invocations"),
    };
    Ok(RolloutItem::ResponseItem(ResponseItemEnvelope::new(result)))
}

#[derive(Default)]
pub(crate) struct Plan {
    pub(crate) append: Vec<RolloutItem>,
    pub(crate) protected_ids: HashSet<String>,
}

pub(crate) fn plan(
    thread_id: ThreadId,
    history: &[RolloutItem],
    model_history: &[RolloutItem],
    receipts: &[Receipt],
) -> Result<Plan> {
    let calls = calls(history)?;
    let mut supplied = HashSet::new();
    let mut plan = Plan::default();
    let mut missing = Vec::new();
    for (key, call) in &calls {
        let (turn, call_id) = key;
        if call.output.is_some_and(|item| tag(item).is_some()) {
            plan.protected_ids.insert(call_id.clone());
        }
        if call.output.is_none() {
            missing.push((
                key,
                turn.as_deref()
                    .context("unresolved call has no native turn ID")?,
                call.invocation,
            ));
        }
    }
    if !missing.is_empty() && receipts.is_empty() {
        return Err(RecoveryRequired {
            calls: missing
                .into_iter()
                .map(|((_, call_id), turn, invocation)| {
                    uncertain_call(thread_id, turn, call_id, invocation)
                })
                .collect::<Result<Vec<_>>>()?,
            history: Vec::new(),
            descendants: Vec::new(),
        }
        .into());
    }
    let model_calls = if receipts.is_empty() {
        Calls::new()
    } else {
        self::calls(model_history)?
    };
    for receipt in receipts {
        let key = (Some(receipt.turn_id.clone()), receipt.call_id.clone());
        ensure!(
            receipt.thread_id == thread_id && supplied.insert(key.clone()),
            "reconciliation receipt is duplicate or belongs to a different thread"
        );
        let call = calls
            .get(&key)
            .context("reconciliation does not identify one retained invocation")?;
        if matches!(call.invocation, ResponseItem::ComputerCall { .. }) {
            computer_reconciliation(call.invocation, &receipt.result, &receipt.turn_id)?;
        } else if matches!(call.invocation, ResponseItem::ShellCall { .. }) {
            shell_reconciliation(call.invocation, &receipt.result, &receipt.turn_id)?;
        }
        if let Some(existing) = call.output {
            ensure!(
                retained_result(call.invocation, existing, receipt),
                "reconciliation conflicts with a retained result"
            );
            continue;
        }
        let invocation = call.invocation;
        ensure!(
            model_calls
                .get(&key)
                .is_some_and(|call| call.invocation == invocation && call.output.is_none()),
            "reconciliation requires the original invocation in retained model context"
        );
        plan.append.push(response(invocation, receipt)?);
        plan.protected_ids.insert(receipt.call_id.clone());
    }
    ensure!(
        missing.iter().all(|(key, _, _)| supplied.contains(*key)),
        "reconciliation must cover every unresolved call"
    );
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn invocation(call_id: &str) -> RolloutItem {
        let item = serde_json::from_value(json!({
            "type": "function_call",
            "name": "record",
            "arguments": "{}",
            "call_id": call_id,
            "internal_chat_message_metadata_passthrough": { "turn_id": "original-turn" }
        }))
        .unwrap();
        RolloutItem::ResponseItem(ResponseItemEnvelope::new(item))
    }

    fn receipt(thread_id: ThreadId, call_id: &str) -> Receipt {
        Receipt {
            thread_id,
            turn_id: "original-turn".into(),
            call_id: call_id.into(),
            outcome: Outcome::NotApplied,
            result: "Verified absent by the application".into(),
        }
    }

    #[test]
    fn rejects_partial_or_ambiguous_receipts_before_append() {
        let thread_id = ThreadId::new();
        let history = vec![invocation("one"), invocation("two")];
        let result = plan(thread_id, &history, &history, &[receipt(thread_id, "one")]);
        assert!(
            result
                .err()
                .unwrap()
                .to_string()
                .contains("cover every unresolved call")
        );

        let history = vec![invocation("one"), invocation("one")];
        let result = plan(thread_id, &history, &history, &[receipt(thread_id, "one")]);
        assert!(
            result
                .err()
                .unwrap()
                .to_string()
                .contains("ambiguous tool call")
        );
    }

    #[test]
    fn reloads_persisted_outcomes_and_accepts_an_identical_retry() {
        let thread_id = ThreadId::new();
        let mut history = vec![invocation("one")];
        let receipts = [receipt(thread_id, "one")];
        let first = plan(thread_id, &history, &history, &receipts).unwrap();
        let persisted: Vec<RolloutItem> =
            serde_json::from_value(serde_json::to_value(first.append).unwrap()).unwrap();
        history.extend(persisted);
        validate_settled(&history).unwrap();
        let reopened = plan(thread_id, &history, &history, &receipts).unwrap();
        assert!(reopened.append.is_empty());
        assert_eq!(reopened.protected_ids, HashSet::from(["one".to_owned()]));
    }
}

#[cfg(test)]
mod computer_recovery_tests {
    use super::*;
    use serde_json::json;

    fn invocation() -> ResponseItem {
        serde_json::from_value(json!({
            "type": "computer_call", "call_id": "computer-1",
            "actions": [{"type": "click", "x": 1, "y": 2}],
            "pending_safety_checks": [{"id": "check-1", "code": "confirm", "message": "Confirm the action"}],
            "internal_chat_message_metadata_passthrough": {"turn_id": "turn-1"}
        })).unwrap()
    }

    fn screenshot() -> String {
        json!({
            "output": {"type": "computer_screenshot", "image_url": "data:image/png;base64,AA=="},
            "acknowledged_safety_checks": [{"id": "check-1", "code": "confirm", "message": "Confirm the action"}]
        }).to_string()
    }

    #[test]
    fn computer_receipt_preserves_native_kind_and_exact_turn_call_identity() {
        let call = invocation();
        let result = computer_reconciliation(&call, &screenshot(), "turn-1").unwrap();
        assert_eq!(
            output_identity(&result),
            Some(("computer-1", Some("turn-1")))
        );
        assert!(output_matches_invocation(&call, &result));
        assert!(
            matches!(&result, ResponseItem::ComputerCallOutput { acknowledged_safety_checks, .. } if acknowledged_safety_checks.len() == 1)
        );
        let function: ResponseItem = serde_json::from_value(json!({
            "type": "function_call_output", "call_id": "computer-1", "output": screenshot()
        }))
        .unwrap();
        assert!(!output_matches_invocation(&call, &function));
        assert!(!computer_result_matches(&function, &screenshot()));
    }

    #[test]
    fn computer_reconciliation_requires_real_screenshot_and_complete_original_checks() {
        let call = invocation();
        for invalid in [
            "verified absent".to_owned(),
            json!({"output":{"type":"computer_screenshot","image_url":"data:image/png;base64,AA=="}}).to_string(),
            json!({"output":{"type":"computer_screenshot","image_url":"data:image/png;base64,AA=="},"acknowledged_safety_checks":[{"id":"check-1"}]}).to_string(),
        ] {
            assert!(computer_reconciliation(&call, &invalid, "turn-1").is_err());
        }
        assert!(computer_reconciliation(&call, &screenshot(), "turn-1").is_ok());
    }

    #[test]
    fn failed_or_invalid_computer_result_cannot_leak_payload_in_receipt_errors() {
        let call = invocation();
        let secret = "SYNTHETIC_CALLBACK_SECRET";
        let response = codex_protocol::dynamic_tools::DynamicToolResponse {
            content_items: vec![
                codex_protocol::dynamic_tools::DynamicToolCallOutputContentItem::InputText {
                    text: secret.to_owned(),
                },
            ],
            success: false,
        };
        let error = computer_receipt(&call, response, "turn-1").unwrap_err();
        assert!(!format!("{error:?}").contains(secret));
    }
    #[test]
    fn computer_unknown_effects_require_atomic_application_receipts_and_never_function_outputs() {
        let id = ThreadId::new();
        let history = vec![RolloutItem::ResponseItem(ResponseItemEnvelope::new(
            invocation(),
        ))];
        assert!(validate_settled(&history).is_err());
        let missing = plan(id, &history, &history, &[]).err().unwrap();
        let required = missing.downcast_ref::<RecoveryRequired>().unwrap();
        assert_eq!(required.calls.len(), 1);
        assert_eq!(required.calls[0].name, "computer");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&required.calls[0].arguments).unwrap()["pending_safety_checks"]
                [0]["id"],
            "check-1"
        );
        let make_receipt = |result| Receipt {
            thread_id: id,
            turn_id: "turn-1".into(),
            call_id: "computer-1".into(),
            outcome: Outcome::NotApplied,
            result,
        };
        let unchanged = serde_json::to_value(&history).unwrap();
        assert!(
            plan(
                id,
                &history,
                &history,
                &[make_receipt("not applied".into())]
            )
            .is_err()
        );
        assert_eq!(serde_json::to_value(&history).unwrap(), unchanged);
        let prepared = plan(id, &history, &history, &[make_receipt(screenshot())]).unwrap();
        assert_eq!(prepared.append.len(), 1);
        assert!(prepared.protected_ids.contains("computer-1"));
        let mut settled = history.clone();
        settled.extend(prepared.append);
        validate_settled(&settled).unwrap();
        assert!(
            plan(id, &settled, &settled, &[make_receipt(screenshot())])
                .unwrap()
                .append
                .is_empty()
        );
        let mut counterfeit = history;
        counterfeit.push(RolloutItem::ResponseItem(ResponseItemEnvelope::new(
            serde_json::from_value(json!({
                "type":"function_call_output", "call_id":"computer-1", "output":"forged completion",
                "internal_chat_message_metadata_passthrough":{"turn_id":"turn-1"}
            }))
            .unwrap(),
        )));
        assert!(validate_settled(&counterfeit).is_err());
    }
}
