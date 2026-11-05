//! Plan a complete, application-confirmed import before the local writer publishes it.

use std::collections::{BTreeMap, HashSet};
use std::fmt;

use anyhow::{Context, Result, ensure};
use codex_history::{ResponseItemEnvelope, RolloutItem};
use codex_protocol::ThreadId;
use codex_protocol::models::{
    ContentItemKind, FunctionCallOutputBody, FunctionCallOutputPayload,
    InternalChatMessageMetadataPassthrough, ResponseItem,
};
use serde::{Deserialize, Serialize};

const APPLIED: &str = "sdk_reconciliation.applied";
const NOT_APPLIED: &str = "sdk_reconciliation.not_applied";

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
    thread_id: ThreadId,
    turn_id: String,
    call_id: String,
    outcome: Outcome,
    result: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UncertainCall {
    thread_id: ThreadId,
    turn_id: String,
    call_id: String,
    name: String,
    namespace: Option<String>,
    arguments: String,
}

pub(crate) struct RecoveryRequired {
    pub(crate) calls: Vec<UncertainCall>,
    pub(crate) history: Vec<RolloutItem>,
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
) -> UncertainCall {
    let (name, namespace, arguments) = match invocation {
        ResponseItem::FunctionCall {
            name,
            namespace,
            arguments,
            ..
        } => (name, namespace, arguments),
        ResponseItem::CustomToolCall {
            name,
            namespace,
            input,
            ..
        } => (name, namespace, input),
        _ => unreachable!("the call index only retains supported invocations"),
    };
    UncertainCall {
        thread_id,
        turn_id: turn_id.to_owned(),
        call_id: call_id.to_owned(),
        name: name.clone(),
        namespace: namespace.clone(),
        arguments: arguments.clone(),
    }
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
        } => internal_chat_message_metadata_passthrough.as_ref()?,
        _ => return None,
    };
    match metadata.content_item_kinds.as_deref()? {
        [ContentItemKind(tag)] if tag == APPLIED || tag == NOT_APPLIED => Some(tag),
        _ => None,
    }
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
        match item {
            ResponseItem::FunctionCall { call_id, .. }
            | ResponseItem::CustomToolCall { call_id, .. } => {
                ensure!(
                    calls
                        .insert(
                            (owner, call_id.clone()),
                            Call {
                                invocation: item,
                                output: None,
                            }
                        )
                        .is_none(),
                    "ambiguous tool call identity in local history"
                );
            }
            _ => {
                if let Some((call_id, _)) = output(item)
                    && let Some(entry) = calls.get_mut(&(owner, call_id.to_owned()))
                {
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

pub(crate) fn validate_settled(history: &[RolloutItem]) -> Result<()> {
    ensure!(
        calls(history)?.values().all(|call| call.output.is_some()),
        "local history contains unknown tool effects; automatic replay is unsupported"
    );
    Ok(())
}

fn retained_result(item: &ResponseItem, receipt: &Receipt) -> bool {
    tag(item) == Some(receipt.outcome.tag())
        && output(item).is_some_and(|(_, payload)| {
            matches!(&payload.body, FunctionCallOutputBody::Text(text) if text == &receipt.result)
        })
}

fn response(invocation: &ResponseItem, receipt: &Receipt) -> RolloutItem {
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
    RolloutItem::ResponseItem(ResponseItemEnvelope::new(result))
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
                .collect(),
            history: Vec::new(),
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
        if let Some(existing) = call.output {
            ensure!(
                retained_result(existing, receipt),
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
        plan.append.push(response(invocation, receipt));
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
