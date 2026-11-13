//! Plan a complete, application-confirmed import before the local writer publishes it.

use std::collections::{BTreeMap, HashSet};
use std::fmt;

use anyhow::{Context, Result, ensure};
use codex_history::{ResponseItemEnvelope, RolloutItem};
use codex_protocol::items::{CollabAgentTool, CollabAgentToolCallStatus, TurnItem};
use codex_protocol::models::{
    ContentItemKind, FunctionCallOutputBody, FunctionCallOutputPayload,
    InternalChatMessageMetadataPassthrough, ResponseItem,
};
use codex_protocol::protocol::{EventMsg, SubAgentActivityKind};
use codex_protocol::{ThreadId, ToolName};
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
        | ResponseItem::ApplyPatchCallOutput { call_id: call, .. }
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
            ResponseItem::ApplyPatchCall {
                call_id: expected, ..
            },
            ResponseItem::ApplyPatchCallOutput {
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

pub(crate) fn matches_acknowledged_output(
    accepted: &ResponseItem,
    candidate: &ResponseItem,
    native_cancellation: bool,
) -> bool {
    if !native_cancellation {
        return same_acknowledged_output(accepted, candidate);
    }
    let same_owner = matches!(
        (output_identity(accepted), output_identity(candidate)),
        (Some((left_call, Some(left_turn))), Some((right_call, Some(right_turn))))
            if left_call == right_call && left_turn == right_turn
    );
    same_owner
        && matches!(
            (accepted, candidate),
            (
                ResponseItem::FunctionCallOutput { .. },
                ResponseItem::FunctionCallOutput { .. }
            ) | (
                ResponseItem::CustomToolCallOutput { .. },
                ResponseItem::CustomToolCallOutput { .. }
            )
        )
}

pub(crate) fn same_acknowledged_output(left: &ResponseItem, right: &ResponseItem) -> bool {
    if !same_output_payload(left, right) {
        return false;
    }
    let normalize = |item: &ResponseItem| -> Option<serde_json::Value> {
        let mut value = serde_json::to_value(item).ok()?;
        let object = value.as_object_mut()?;
        object.remove("id");
        if let Some(metadata) = object
            .get_mut("internal_chat_message_metadata_passthrough")
            .and_then(serde_json::Value::as_object_mut)
        {
            metadata.remove("create_time");
        }
        Some(value)
    };
    normalize(left)
        .zip(normalize(right))
        .is_some_and(|(left, right)| left == right)
}

#[cfg(test)]
mod acknowledged_original_tests {
    use super::*;
    #[test]
    fn ignores_only_generated_id_and_time() {
        let make = |name: &str, turn: &str, generated: bool| {
            let mut value = serde_json::json!({
                "type":"custom_tool_call_output", "name":name, "call_id":"call",
                "output":"accepted", "internal_chat_message_metadata_passthrough":{"turn_id":turn}
            });
            if generated {
                value["id"] = serde_json::json!("cto_generated");
                value["internal_chat_message_metadata_passthrough"]["create_time"] =
                    serde_json::json!(1.25);
            }
            serde_json::from_value::<ResponseItem>(value).unwrap()
        };
        let accepted = make("original", "turn", false);
        assert!(same_acknowledged_output(
            &accepted,
            &make("original", "turn", true)
        ));
        assert!(!same_acknowledged_output(
            &accepted,
            &make("substitute", "turn", true)
        ));
        assert!(!same_acknowledged_output(
            &accepted,
            &make("original", "foreign", true)
        ));
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
            ResponseItem::ApplyPatchCallOutput {
                status: left_status,
                output: left_output,
                ..
            },
            ResponseItem::ApplyPatchCallOutput {
                status: right_status,
                output: right_output,
                ..
            },
        ) => left_status == right_status && left_output == right_output,
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

pub(crate) fn owns_application_patch(envelope: &codex_history::ResponseItemEnvelope) -> bool {
    matches!(envelope.item, ResponseItem::ApplyPatchCall { .. })
        && envelope
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.sdk_application_tool.as_deref())
            == Some("apply_patch")
}

pub(crate) fn application_patch_receipt(
    invocation: &ResponseItem,
    response: codex_protocol::dynamic_tools::DynamicToolResponse,
    turn: &str,
) -> Result<ResponseItem> {
    use codex_tools::ToolOutput as _;
    let ResponseItem::ApplyPatchCall { call_id, .. } = invocation else {
        anyhow::bail!("Application patch receipt requires its original call");
    };
    let arguments = serde_json::to_string(invocation)?;
    let output = codex_tools::ApplyPatchToolOutput::from_dynamic_response(&arguments, response)
        .map_err(|_| anyhow::anyhow!("Invalid application patch receipt"))?;
    let mut item: ResponseItem = output
        .to_response_item(call_id, &codex_tools::ToolPayload::ApplyPatch { arguments })
        .into();
    item.set_turn_id_if_missing(turn);
    Ok(item)
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
        ResponseItem::ApplyPatchCall { .. } => (
            "apply_patch".to_owned(),
            None,
            serde_json::to_string(invocation)
                .map_err(|_| anyhow::anyhow!("Invalid recorded application patch invocation"))?,
        ),
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
        | ResponseItem::ApplyPatchCallOutput {
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
    index_calls(history, false)
}

pub(crate) fn reconciled_turns(
    history: &[RolloutItem],
    protected: &HashSet<String>,
) -> Result<HashSet<String>> {
    Ok(calls(history)?
        .into_iter()
        .filter_map(|((turn, call_id), call)| {
            (protected.contains(&call_id)
                && call.output.is_some_and(|output| tag(output).is_some()))
            .then_some(turn)
            .flatten()
        })
        .collect())
}

pub(crate) fn validate_automatic_sampling(
    thread: ThreadId,
    history: &[RolloutItem],
    turns: &HashSet<String>,
) -> Result<()> {
    let thread = thread.to_string();
    for turn in turns {
        let receipts: Vec<_> = history
            .iter()
            .filter_map(|row| match row {
                RolloutItem::TurnContext(context) if context.turn_id.as_ref() == Some(turn) => {
                    context.sdk_receipt.as_ref()
                }
                _ => None,
            })
            .collect();
        ensure!(
            !receipts.is_empty()
                && receipts.iter().all(|receipt| receipt
                    .get("version")
                    .and_then(serde_json::Value::as_u64)
                    == Some(1)
                    && receipt.get("thread_id").and_then(serde_json::Value::as_str)
                        == Some(thread.as_str())
                    && receipt
                        .get("provider_effects_possible")
                        .and_then(serde_json::Value::as_bool)
                        == Some(false)),
            "local history cannot exclude provider effects in an interrupted sampling request"
        );
    }
    Ok(())
}

fn completed_hosted_call(item: &ResponseItem) -> bool {
    match item {
        ResponseItem::McpCall {
            provider_fields, ..
        } => {
            provider_fields
                .get("status")
                .and_then(serde_json::Value::as_str)
                == Some("completed")
                && provider_fields
                    .get("output")
                    .and_then(serde_json::Value::as_str)
                    .is_some()
                && provider_fields
                    .get("error")
                    .is_none_or(serde_json::Value::is_null)
        }
        ResponseItem::CodeInterpreterCall {
            status,
            provider_fields,
            ..
        }
        | ResponseItem::ImageGenerationCall {
            status,
            provider_fields,
            ..
        } => {
            status == "completed"
                && provider_fields
                    .get("error")
                    .is_none_or(serde_json::Value::is_null)
        }
        _ => false,
    }
}

pub(crate) fn validate_hosted_effects(
    history: &[RolloutItem],
    turns: &HashSet<String>,
) -> Result<()> {
    let application = calls(history)?;
    let mut hosted = BTreeMap::new();
    let mut active = None;
    for row in history {
        crate::local_storage::observe_turn(&mut active, row);
        if let RolloutItem::ResponseItem(envelope) = row {
            let owner = envelope
                .item
                .turn_id()
                .map(str::to_owned)
                .or_else(|| active.clone());
            if owner.as_ref().is_some_and(|turn| turns.contains(turn)) {
                let (kind, id) = match &envelope.item {
                    ResponseItem::McpCall { id, .. } => ("mcp", id),
                    ResponseItem::CodeInterpreterCall { id, .. } => ("code", id),
                    ResponseItem::ImageGenerationCall { id, .. } => ("image", id),
                    ResponseItem::ShellCall { .. } => {
                        ensure!(
                            is_application_shell_call(envelope),
                            "local history contains unsupported hosted Shell effects"
                        );
                        continue;
                    }
                    ResponseItem::ShellCallOutput { .. } => {
                        ensure!(
                            output_identity(&envelope.item).is_some_and(|(call_id, _)| application
                                .get(&(owner.clone(), call_id.to_owned()))
                                .is_some_and(|call| matches!(
                                    call.invocation,
                                    ResponseItem::ShellCall { .. }
                                ))),
                            "local history contains unsupported hosted Shell effects"
                        );
                        continue;
                    }
                    _ => continue,
                };
                let id = id
                    .as_ref()
                    .filter(|id| !id.as_str().is_empty())
                    .context("hosted call has no retained identity")?;
                hosted.insert((owner, kind, id.as_str()), &envelope.item);
            }
        }
    }
    ensure!(
        hosted.values().all(|item| completed_hosted_call(item)),
        "local history contains unfinished hosted effects; automatic interruption is unsupported"
    );
    ensure!(application.iter().all(|(key, call)| {
        let ResponseItem::McpApprovalRequest { id: Some(id), server_label, name, arguments, provider_fields, .. } = call.invocation else { return true; };
        !key.0.as_ref().is_some_and(|turn| turns.contains(turn))
            || matches!(call.output, Some(ResponseItem::McpApprovalResponse { approve: false, .. }))
            || hosted.iter().any(|((owner, _, _), item)| {
                owner == &key.0 && matches!(item, ResponseItem::McpCall { server_label: actual_server, name: actual_name, arguments: actual_arguments, provider_fields: actual_fields, .. }
                    if server_label == actual_server && name == actual_name && arguments == actual_arguments
                        && actual_fields.get("approval_request_id").and_then(serde_json::Value::as_str) == Some(id.as_str())
                        && actual_fields.get("caller").filter(|value| !value.is_null()) == provider_fields.get("caller").filter(|value| !value.is_null()))
            })
    }), "local history contains an approved hosted MCP call without a retained result; automatic interruption is unsupported");
    Ok(())
}

// A completed model turn does not prove its native commands have exited. Cold
// recovery checks owned command lifetimes, including earlier turns.
pub(crate) fn validate_command_lifetimes(history: &[RolloutItem]) -> Result<()> {
    let application = calls(history)?;
    let terminal_commands: HashSet<_> = history
        .iter()
        .filter_map(|row| match row {
            RolloutItem::EventMsg(EventMsg::ItemCompleted(event)) => match &event.item {
                TurnItem::CommandExecution(item)
                    if !matches!(
                        item.status,
                        codex_protocol::items::CommandExecutionStatus::InProgress
                    ) =>
                {
                    Some((event.turn_id.clone(), item.id.clone()))
                }
                _ => None,
            },
            _ => None,
        })
        .collect();
    ensure!(
        application.iter().all(|(key, call)| {
            match call.invocation {
                ResponseItem::FunctionCall {
                    name, namespace, ..
                } if ToolName::new(namespace.clone(), name).is_default_namespace() => {
                    match name.as_str() {
                        "exec_command" | "shell" | "shell_command" => {
                            call.output.is_some_and(|output| tag(output).is_some())
                                || key.0.as_ref().is_some_and(|turn| {
                                    terminal_commands.contains(&(turn.clone(), key.1.clone()))
                                })
                        }
                        _ => true,
                    }
                }
                _ => true,
            }
        }),
        "local history contains unfinished native execution; automatic interruption is unsupported"
    );
    Ok(())
}

pub(crate) fn validate_native_effects(
    history: &[RolloutItem],
    turns: &HashSet<String>,
) -> Result<()> {
    validate_command_lifetimes(history)?;
    let application = calls(history)?;
    let completed_processes: HashSet<_> = history.iter().filter_map(|row| {
        let RolloutItem::EventMsg(EventMsg::ItemCompleted(event)) = row else { return None; };
        let TurnItem::CommandExecution(item) = &event.item else { return None; };
        if matches!(item.status, codex_protocol::items::CommandExecutionStatus::InProgress)
            || !matches!(item.source, codex_protocol::protocol::ExecCommandSource::UnifiedExecStartup)
            || !application.get(&(Some(event.turn_id.clone()), item.id.clone())).is_some_and(|call|
                matches!(call.invocation, ResponseItem::FunctionCall { name, namespace, .. }
                    if name == "exec_command" && ToolName::new(namespace.clone(), name).is_default_namespace())) {
            return None;
        }
        item.process_id.clone()
    }).collect();
    ensure!(
        application.iter().all(|(key, call)| {
            let ResponseItem::FunctionCall {
                name,
                namespace,
                arguments,
                ..
            } = call.invocation
            else {
                return true;
            };
            name != "write_stdin"
                || !ToolName::new(namespace.clone(), name).is_default_namespace()
                || !key.0.as_ref().is_some_and(|turn| turns.contains(turn))
                || (call.output.is_some()
                    && serde_json::from_str::<serde_json::Value>(arguments)
                        .ok()
                        .and_then(|args| args.get("session_id").and_then(serde_json::Value::as_i64))
                        .and_then(|id| i32::try_from(id).ok())
                        .is_some_and(|id| completed_processes.contains(&id.to_string())))
        }),
        "local history contains unfinished native execution; automatic interruption is unsupported"
    );
    ensure!(
        index_calls(history, true)?.iter().all(|(key, call)| {
            application.contains_key(key)
                || (!matches!(
                    call.invocation,
                    ResponseItem::ShellCall { .. } | ResponseItem::LocalShellCall { .. }
                ) && (key.0.as_ref().is_some_and(|turn| !turns.contains(turn))
                    || call.output.is_some()))
        }),
        "local history contains unknown native tool effects; automatic interruption is unsupported"
    );
    Ok(())
}

fn index_calls(history: &[RolloutItem], include_native: bool) -> Result<Calls<'_>> {
    let mut calls = Calls::new();
    let mut turn = None;
    for row in history {
        crate::local_storage::observe_turn(&mut turn, row);
        let RolloutItem::ResponseItem(envelope) = row else {
            continue;
        };
        let item = &envelope.item;
        let owner = item.turn_id().map(str::to_owned).or_else(|| turn.clone());
        let invocation_id = match item {
            ResponseItem::FunctionCall { call_id, .. }
            | ResponseItem::CustomToolCall { call_id, .. }
            | ResponseItem::ComputerCall { call_id, .. } => Some(call_id.as_str()),
            ResponseItem::McpApprovalRequest { id, .. } => id.as_ref().map(|id| id.as_str()),
            ResponseItem::ApplyPatchCall { call_id, .. }
                if include_native || owns_application_patch(envelope) =>
            {
                Some(call_id.as_str())
            }
            ResponseItem::ShellCall {
                provider_fields, ..
            } if include_native || is_application_shell_call(envelope) => Some(
                provider_fields
                    .get("call_id")
                    .and_then(serde_json::Value::as_str)
                    .context("native Shell call has no retained call identity")?,
            ),
            ResponseItem::LocalShellCall { call_id, .. } if include_native => Some(
                call_id
                    .as_deref()
                    .context("native local Shell call has no retained call identity")?,
            ),
            _ => None,
        };
        if let Some(call_id) = invocation_id {
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
        } else if let Some((call_id, _)) = output_identity(item)
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
    Ok(calls)
}

pub(crate) fn completed_child_turns(
    parent: ThreadId,
    child: ThreadId,
    history: &[RolloutItem],
    followup_turns: &HashSet<String>,
) -> Result<HashSet<String>> {
    let calls = calls(history)?;
    let mut turns = HashSet::new();
    let mut spawn_turns = HashSet::new();
    let mut active = None;
    for row in history {
        crate::local_storage::observe_turn(&mut active, row);
        let (turn, call, spawn) = match row {
            RolloutItem::EventMsg(EventMsg::ItemCompleted(event)) if event.thread_id == parent => {
                match &event.item {
                    TurnItem::SubAgentActivity(item)
                        if matches!(
                            item.kind,
                            SubAgentActivityKind::Started | SubAgentActivityKind::Interacted
                        ) && item.agent_thread_id == child =>
                    {
                        (
                            &event.turn_id,
                            &item.id,
                            item.kind == SubAgentActivityKind::Started,
                        )
                    }
                    TurnItem::CollabAgentToolCall(item)
                        if item.tool == CollabAgentTool::SpawnAgent
                            && item.status == CollabAgentToolCallStatus::Completed
                            && item.sender_thread_id == parent
                            && item.receiver_thread_ids == [child] =>
                    {
                        (&event.turn_id, &item.id, true)
                    }
                    _ => continue,
                }
            }
            // Legacy V2 rollouts persist the completed item's legacy activity
            // in the emitting turn instead of persisting the canonical item.
            RolloutItem::EventMsg(EventMsg::SubAgentActivity(event))
                if matches!(
                    event.kind,
                    SubAgentActivityKind::Started | SubAgentActivityKind::Interacted
                ) && event.agent_thread_id == child =>
            {
                let Some(turn) = active.as_ref() else {
                    continue;
                };
                (
                    turn,
                    &event.event_id,
                    event.kind == SubAgentActivityKind::Started,
                )
            }
            _ => continue,
        };
        if (spawn || followup_turns.contains(turn))
            && calls.get(&(Some(turn.clone()), call.clone())).is_some_and(|entry|
            matches!(entry.invocation, ResponseItem::FunctionCall { name, namespace, .. }
                if name == (if spawn { "spawn_agent" } else { "followup_task" })
                    && matches!(namespace.as_deref(), None | Some("collaboration" | "multi_agent_v1")))
                && matches!(entry.output, Some(ResponseItem::FunctionCallOutput { output, .. })
                    if output.success != Some(false))
                && entry.output.is_some_and(|output| tag(output).is_none())
        ) {
            if spawn {
                spawn_turns.insert(turn.clone());
            }
            turns.insert(turn.clone());
        }
    }
    ensure!(
        spawn_turns.len() <= 1,
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
        }) || tag(item) == Some(receipt.outcome.tag()) && (computer_result_matches(item, &receipt.result)
            || matches!(item, ResponseItem::ApplyPatchCallOutput { status, output, .. }
                if serde_json::from_str::<codex_protocol::models::ApplyPatchResult>(&receipt.result)
                    .is_ok_and(|result| result.status == *status && result.output == *output)))
        || tag(item) == Some(receipt.outcome.tag())
            && matches!(invocation, ResponseItem::ShellCall { .. })
            && shell_reconciliation(invocation, &receipt.result, &receipt.turn_id)
                .is_ok_and(|expected| same_output_payload(item, &expected))
}

fn response(invocation: &ResponseItem, receipt: &Receipt) -> Result<RolloutItem> {
    if matches!(invocation, ResponseItem::ApplyPatchCall { .. }) {
        let result: codex_protocol::models::ApplyPatchResult =
            serde_json::from_str(&receipt.result)
                .context("Application patch reconciliation requires a typed result")?;
        let mut item = application_patch_receipt(
            invocation,
            codex_protocol::dynamic_tools::DynamicToolResponse {
                success: result.status == codex_protocol::models::ApplyPatchStatus::Completed,
                content_items: vec![
                    codex_protocol::dynamic_tools::DynamicToolCallOutputContentItem::InputText {
                        text: receipt.result.clone(),
                    },
                ],
            },
            &receipt.turn_id,
        )?;
        if let ResponseItem::ApplyPatchCallOutput {
            internal_chat_message_metadata_passthrough: Some(metadata),
            ..
        } = &mut item
        {
            metadata.content_item_kinds =
                Some(vec![ContentItemKind(receipt.outcome.tag().to_owned())]);
        }
        return Ok(RolloutItem::ResponseItem(ResponseItemEnvelope::new(item)));
    }
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
            ensure!(
                !matches!(call.invocation, ResponseItem::McpApprovalRequest { .. }),
                "Unresolved Hosted MCP approval requires a live provider decision"
            );
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

    #[test]
    fn cold_interruption_requires_retained_native_effect_results() {
        let row = |item| {
            RolloutItem::ResponseItem(ResponseItemEnvelope::new(
                serde_json::from_value(item).unwrap(),
            ))
        };
        let cases = [
            (
                json!({"type": "apply_patch_call", "call_id": "native", "operation": {"type": "delete_file", "path": "synthetic"}}),
                json!({"type": "apply_patch_call_output", "call_id": "native", "status": "completed", "output": "done"}),
            ),
            (
                json!({"type": "shell_call", "call_id": "native", "action": {"commands": ["synthetic"]}}),
                json!({"type": "shell_call_output", "call_id": "native", "output": []}),
            ),
            (
                json!({"type": "local_shell_call", "call_id": "native", "status": "completed", "action": {"type": "exec", "command": ["synthetic"]}}),
                json!({"type": "function_call_output", "call_id": "native", "output": "done"}),
            ),
        ];
        for (invocation, output) in cases {
            let patch = invocation["type"] == "apply_patch_call";
            let mut history = vec![row(invocation)];
            assert!(
                validate_native_effects(&history, &HashSet::new())
                    .unwrap_err()
                    .to_string()
                    .contains("unknown native tool effects")
            );
            history.push(row(output));
            assert_eq!(
                validate_native_effects(&history, &HashSet::new()).is_ok(),
                patch
            );
        }
        // Application receipts remain the responsibility of the existing planner.
        validate_native_effects(&[invocation("application")], &HashSet::new()).unwrap();
        assert!(
            validate_native_effects(
                &[row(
                    json!({"type": "shell_call", "action": {"commands": ["synthetic"]}})
                )],
                &HashSet::new()
            )
            .is_err()
        );
    }

    #[test]
    fn cold_interruption_requires_terminal_execution_evidence() {
        let row = |item| {
            RolloutItem::ResponseItem(ResponseItemEnvelope::new(
                serde_json::from_value(item).unwrap(),
            ))
        };
        let mut history = vec![
            row(
                json!({"type": "function_call", "name": "exec_command", "call_id": "command", "arguments": "{}", "internal_chat_message_metadata_passthrough": {"turn_id": "turn"}}),
            ),
            row(
                json!({"type": "function_call_output", "call_id": "command", "output": "Process running with session ID 42", "internal_chat_message_metadata_passthrough": {"turn_id": "turn"}}),
            ),
        ];
        let turns = HashSet::from(["turn".to_owned()]);
        assert!(validate_native_effects(&history, &turns).is_err());
        let later = HashSet::from(["another".to_owned()]);
        assert!(validate_native_effects(&history, &later).is_err());
        let completion = |status| {
            RolloutItem::EventMsg(serde_json::from_value(json!({"type": "item_completed", "thread_id": ThreadId::new(), "turn_id": "turn", "item": {"type": "CommandExecution", "id": "command", "command": ["synthetic"], "cwd": "file:///synthetic", "parsed_cmd": [], "source": "unified_exec_startup", "status": status}})).unwrap())
        };
        history.push(completion("in_progress"));
        assert!(validate_native_effects(&history, &turns).is_err());
        history.push(completion("completed"));
        validate_native_effects(&history, &turns).unwrap();
        history.push(row(json!({"type": "function_call", "name": "write_stdin", "call_id": "stdin", "arguments": "{}", "internal_chat_message_metadata_passthrough": {"turn_id": "turn"}})));
        history.push(row(json!({"type": "function_call_output", "call_id": "stdin", "output": "Process exited with code 0", "internal_chat_message_metadata_passthrough": {"turn_id": "turn"}})));
        assert!(validate_native_effects(&history, &turns).is_err());
        // An older poll is safe once the original command has durably exited.
        validate_native_effects(&history, &later).unwrap();
    }

    #[test]
    fn cold_interruption_distinguishes_namespaced_callbacks_and_exact_command_receipts() {
        let row = |item| {
            RolloutItem::ResponseItem(ResponseItemEnvelope::new(
                serde_json::from_value(item).unwrap(),
            ))
        };
        let turns = HashSet::from(["turn".to_owned()]);
        for name in ["exec_command", "write_stdin", "shell", "shell_command"] {
            let history = [
                row(
                    json!({"type": "function_call", "namespace": "crm", "name": name, "call_id": "call", "arguments": "{}", "internal_chat_message_metadata_passthrough": {"turn_id": "turn"}}),
                ),
                row(
                    json!({"type": "function_call_output", "call_id": "call", "output": "done", "internal_chat_message_metadata_passthrough": {"turn_id": "turn"}}),
                ),
            ];
            validate_native_effects(&history, &turns).unwrap();
        }
        for namespace in [None, Some(""), Some("functions")] {
            let invocation = row(
                json!({"type": "function_call", "namespace": namespace, "name": "exec_command", "call_id": "command", "arguments": "{}", "internal_chat_message_metadata_passthrough": {"turn_id": "turn"}}),
            );
            assert!(validate_native_effects(std::slice::from_ref(&invocation), &turns).is_err());
            for (turn, call, accepted) in [
                ("other", "command", false),
                ("turn", "other", false),
                ("turn", "command", true),
            ] {
                let output = row(
                    json!({"type": "function_call_output", "call_id": call, "output": "confirmed absent", "internal_chat_message_metadata_passthrough": {"turn_id": turn, "content_item_kinds": [NOT_APPLIED]}}),
                );
                let history = [invocation.clone(), output];
                assert_eq!(validate_command_lifetimes(&history).is_ok(), accepted);
                assert_eq!(validate_native_effects(&history, &turns).is_ok(), accepted);
                assert_eq!(
                    validate_native_effects(&history, &HashSet::from(["later".to_owned()])).is_ok(),
                    accepted
                );
            }
        }
    }

    #[test]
    fn cold_interruption_accepts_only_polls_with_owned_terminal_process_evidence() {
        let response = |item| {
            RolloutItem::ResponseItem(ResponseItemEnvelope::new(
                serde_json::from_value(item).unwrap(),
            ))
        };
        let command = |namespace| {
            response(
                json!({"type":"function_call","namespace":namespace,"name":"exec_command","call_id":"command","arguments":"{}","internal_chat_message_metadata_passthrough":{"turn_id":"older"}}),
            )
        };
        let terminal = |call, source, process, status| {
            RolloutItem::EventMsg(serde_json::from_value(json!({"type":"item_completed","thread_id":ThreadId::new(),"turn_id":"older","item":{"type":"CommandExecution","id":call,"process_id":process,"command":["synthetic"],"cwd":"file:///synthetic","parsed_cmd":[],"source":source,"status":status}})).unwrap())
        };
        let poll = |arguments| {
            response(
                json!({"type":"function_call","name":"write_stdin","call_id":"poll","arguments":arguments,"internal_chat_message_metadata_passthrough":{"turn_id":"current"}}),
            )
        };
        let history = vec![
            command(None::<&str>),
            terminal("command", "unified_exec_startup", Some("42"), "completed"),
            poll("{\"session_id\":42}"),
            response(
                json!({"type":"function_call_output","call_id":"poll","output":"exited","internal_chat_message_metadata_passthrough":{"turn_id":"current"}}),
            ),
        ];
        let turns = HashSet::from(["current".to_owned()]);
        validate_native_effects(&history, &turns).unwrap();
        for (index, replacement) in [
            (0, command(Some("crm"))),
            (
                1,
                terminal("other", "unified_exec_startup", Some("42"), "completed"),
            ),
            (
                1,
                terminal(
                    "command",
                    "unified_exec_interaction",
                    Some("42"),
                    "completed",
                ),
            ),
            (
                1,
                terminal("command", "unified_exec_startup", Some("43"), "completed"),
            ),
            (
                1,
                terminal("command", "unified_exec_startup", None, "completed"),
            ),
            (
                1,
                terminal("command", "unified_exec_startup", Some("42"), "in_progress"),
            ),
            (2, poll("{\"session_id\":\"42\"}")),
            (2, poll("{\"session_id\":42.5}")),
            (2, poll("{\"session_id\":2147483648}")),
            (2, poll("{}")),
        ] {
            let mut invalid = history.clone();
            invalid[index] = replacement;
            assert!(validate_native_effects(&invalid, &turns).is_err());
        }
        assert!(validate_native_effects(&history[..3], &turns).is_err());
    }

    #[test]
    fn cold_interruption_checks_retained_hosted_types_and_application_shell_ownership() {
        let turns = HashSet::from(["turn".to_owned()]);
        let row = |item| {
            RolloutItem::ResponseItem(ResponseItemEnvelope::new(
                serde_json::from_value(item).unwrap(),
            ))
        };
        for kind in ["code_interpreter_call", "image_generation_call"] {
            for status in ["in_progress", "completed"] {
                let item = json!({"type":kind,"id":"hosted","status":status,"outputs":null,"result":null,"internal_chat_message_metadata_passthrough":{"turn_id":"turn"}});
                assert_eq!(
                    validate_hosted_effects(&[row(item.clone())], &turns).is_ok(),
                    status == "completed"
                );
                for replacement in [json!(null), json!("")] {
                    let mut invalid = item.clone();
                    invalid["id"] = replacement;
                    assert!(validate_hosted_effects(&[row(invalid)], &turns).is_err());
                }
            }
        }
        let mut shell = ResponseItemEnvelope::new(serde_json::from_value(json!({"type":"shell_call","id":"shell","call_id":"shell-call","status":"completed","environment":{"type":"local"},"action":{"commands":["synthetic"]},"internal_chat_message_metadata_passthrough":{"turn_id":"turn"}})).unwrap());
        let output = row(
            json!({"type":"shell_call_output","id":"output","call_id":"shell-call","status":"completed","output":[],"internal_chat_message_metadata_passthrough":{"turn_id":"turn"}}),
        );
        assert!(
            validate_hosted_effects(
                &[RolloutItem::ResponseItem(shell.clone()), output.clone()],
                &turns
            )
            .is_err()
        );
        shell.metadata = Some(codex_history::CodexHarnessMetadata {
            sdk_application_tool: Some("shell".into()),
            ..Default::default()
        });
        validate_hosted_effects(&[RolloutItem::ResponseItem(shell), output.clone()], &turns)
            .unwrap();
        assert!(validate_hosted_effects(&[output], &turns).is_err());
    }

    #[test]
    fn cold_interruption_requires_completed_hosted_mcp_execution() {
        let row = |item| {
            RolloutItem::ResponseItem(ResponseItemEnvelope::new(
                serde_json::from_value(item).unwrap(),
            ))
        };
        let turns = HashSet::from(["turn".to_owned()]);
        let approval = row(
            json!({"type":"mcp_approval_request","id":"approval","server_label":"crm","name":"save","arguments":"{}","internal_chat_message_metadata_passthrough":{"turn_id":"turn"}}),
        );
        let decision = |approve| {
            row(
                json!({"type":"mcp_approval_response","approval_request_id":"approval","approve":approve,"internal_chat_message_metadata_passthrough":{"turn_id":"turn"}}),
            )
        };
        validate_hosted_effects(&[approval.clone(), decision(false)], &turns).unwrap();
        assert!(validate_hosted_effects(&[approval.clone(), decision(true)], &turns).is_err());
        for (status, output, accepted) in [
            ("in_progress", json!(null), false),
            ("completed", json!(null), false),
            ("completed", json!(""), true),
        ] {
            let call = row(
                json!({"type":"mcp_call","id":"provider-call","server_label":"crm","name":"save","arguments":"{}","approval_request_id":"approval","status":status,"output":output,"internal_chat_message_metadata_passthrough":{"turn_id":"turn"}}),
            );
            assert_eq!(
                validate_hosted_effects(std::slice::from_ref(&call), &turns).is_ok(),
                accepted
            );
            assert_eq!(
                validate_hosted_effects(&[approval.clone(), decision(true), call], &turns).is_ok(),
                accepted
            );
        }
        for (turn, approval_id, name) in [
            ("other", "approval", "save"),
            ("turn", "other", "save"),
            ("turn", "approval", "other"),
        ] {
            let call = row(
                json!({"type":"mcp_call","id":"provider-call","server_label":"crm","name":name,"arguments":"{}","approval_request_id":approval_id,"status":"completed","output":"done","internal_chat_message_metadata_passthrough":{"turn_id":turn}}),
            );
            assert!(
                validate_hosted_effects(&[approval.clone(), decision(true), call], &turns).is_err()
            );
        }
    }

    #[test]
    fn cold_interruption_links_followups_without_accepting_messages_or_duplicate_spawns() {
        let parent = ThreadId::new();
        let child = ThreadId::new();
        let activity = |turn: &str, name: &str, kind: &str| {
            vec![
                RolloutItem::ResponseItem(ResponseItemEnvelope::new(serde_json::from_value(json!({"type":"function_call","namespace":"collaboration","name":name,"call_id":turn,"arguments":"{}","internal_chat_message_metadata_passthrough":{"turn_id":turn}})).unwrap())),
                RolloutItem::ResponseItem(ResponseItemEnvelope::new(serde_json::from_value(json!({"type":"function_call_output","call_id":turn,"output":"accepted","internal_chat_message_metadata_passthrough":{"turn_id":turn}})).unwrap())),
                RolloutItem::EventMsg(serde_json::from_value(json!({"type":"item_completed","thread_id":parent,"turn_id":turn,"item":{"type":"SubAgentActivity","id":turn,"kind":kind,"agent_thread_id":child,"agent_path":"/root/child"}})).unwrap()),
            ]
        };
        let mut history = activity("spawn", "spawn_agent", "started");
        history.extend(activity("follow-one", "followup_task", "interacted"));
        history.extend(activity("follow-two", "followup_task", "interacted"));
        history.extend(activity("message", "send_message", "interacted"));
        assert_eq!(
            completed_child_turns(
                parent,
                child,
                &history,
                &HashSet::from(["follow-one".to_owned(), "follow-two".to_owned()])
            )
            .unwrap(),
            HashSet::from([
                "spawn".to_owned(),
                "follow-one".to_owned(),
                "follow-two".to_owned()
            ])
        );
        history.extend(activity("duplicate-spawn", "spawn_agent", "started"));
        assert!(completed_child_turns(parent, child, &history, &HashSet::new()).is_err());
    }

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

#[cfg(test)]
mod acknowledged_cancellation_tests {
    use super::*;
    fn output(call: &str, turn: &str, text: &str) -> ResponseItem {
        serde_json::from_value(serde_json::json!({"type":"function_call_output","call_id":call,"output":text,"internal_chat_message_metadata_passthrough":{"turn_id":turn}})).unwrap()
    }
    #[test]
    fn only_native_cancellation_for_the_same_owned_call_reuses_receipt() {
        let accepted = output("call", "turn", "genuine-first-result");
        let cancelled = output("call", "turn", "aborted by user after 2.0s");
        assert!(!matches_acknowledged_output(&accepted, &cancelled, false));
        assert!(matches_acknowledged_output(&accepted, &cancelled, true));
        assert!(!matches_acknowledged_output(
            &accepted,
            &output("foreign", "turn", "aborted"),
            true
        ));
        assert!(!matches_acknowledged_output(
            &accepted,
            &output("call", "foreign", "aborted"),
            true
        ));
        assert!(matches_acknowledged_output(&accepted, &accepted, false));
    }
}
