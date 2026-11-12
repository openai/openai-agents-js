//! Exact usage at JS transport boundaries. Core stored history stays numeric.

use codex_protocol::protocol::TokenUsage;
use serde_json::Value;

const MAX_SAFE: i64 = 9_007_199_254_740_991;

pub(crate) fn exact_counter(value: i64) -> Value {
    if (-MAX_SAFE..=MAX_SAFE).contains(&value) {
        Value::from(value)
    } else {
        Value::String(value.to_string())
    }
}

pub(crate) fn exact_usage(usage: &TokenUsage) -> serde_json::Value {
    serde_json::json!({
        "input_tokens": exact_counter(usage.input_tokens),
        "cached_input_tokens": exact_counter(usage.cached_input_tokens),
        "cache_write_input_tokens": exact_counter(usage.cache_write_input_tokens),
        "output_tokens": exact_counter(usage.output_tokens),
        "reasoning_output_tokens": exact_counter(usage.reasoning_output_tokens),
        "total_tokens": exact_counter(usage.total_tokens),
    })
}

const COUNTERS: [&str; 6] = [
    "input_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
];

fn counter_to_wire(value: &mut Value) -> anyhow::Result<()> {
    *value = if let Some(count) = value.as_i64() {
        exact_counter(count)
    } else if let Some(count) = value.as_u64() {
        // Values above i64::MAX are also above JavaScript's safe integer range.
        Value::String(count.to_string())
    } else {
        anyhow::bail!("Invalid integer usage counter");
    };
    Ok(())
}

type CounterVisitor = fn(&mut Value) -> anyhow::Result<()>;

fn counter_from_wire(value: &mut Value) -> anyhow::Result<()> {
    let count = if let Some(text) = value.as_str() {
        let count: i64 = text
            .parse()
            .map_err(|_| anyhow::anyhow!("Invalid i64 usage counter"))?;
        anyhow::ensure!(count.to_string() == text, "Noncanonical usage counter");
        count
    } else if let Some(count) = value.as_i64() {
        anyhow::ensure!(
            (-MAX_SAFE..=MAX_SAFE).contains(&count),
            "Unsafe numeric checkpoint usage counter; its original integer cannot be recovered"
        );
        count
    } else {
        anyhow::bail!("Invalid integer usage counter");
    };
    *value = Value::from(count);
    Ok(())
}

fn received_counter_from_wire(value: &mut Value) -> anyhow::Result<()> {
    counter_from_wire(value)?;
    anyhow::ensure!(
        value.as_i64().is_some_and(|count| count >= 0),
        "Received response usage counters must be nonnegative"
    );
    Ok(())
}

fn visit_usage(value: &mut Value, counter: CounterVisitor) -> anyhow::Result<()> {
    if value.is_null() {
        return Ok(());
    }
    anyhow::ensure!(value.is_object(), "Usage must be an object");
    for key in COUNTERS {
        if let Some(value) = value.get_mut(key) {
            counter(value)?;
        }
    }
    Ok(())
}

fn visit_record(value: &mut Value, counter: CounterVisitor) -> anyhow::Result<()> {
    anyhow::ensure!(value.is_object(), "Token usage record must be an object");
    for group in ["usage", "turn_token_usage", "thread_token_usage"] {
        if let Some(usage) = value.get_mut(group) {
            visit_usage(usage, counter)?;
        }
    }
    Ok(())
}

// Called only for a serialized native EventMsg, never arbitrary tool data.
fn visit_event(message: &mut Value, counter: CounterVisitor) -> anyhow::Result<()> {
    if let Some(snapshot) = message.get_mut("model_attempt") {
        visit_model_attempt(snapshot, counter)?;
    }
    if message["type"] == "_sdk_model_attempt"
        && let Some(data) = message.get_mut("data")
    {
        visit_model_attempt(data, counter)?;
    }
    match message.get("type").and_then(Value::as_str) {
        Some("raw_response_completed") => {
            if let Some(usage) = message.get_mut("token_usage") {
                visit_usage(usage, counter)?;
            }
        }
        Some("token_count") => {
            if let Some(info) = message.get_mut("info") {
                for key in ["total_token_usage", "last_token_usage"] {
                    if let Some(usage) = info.get_mut(key) {
                        visit_usage(usage, counter)?;
                    }
                }
                if let Some(window) = info.get_mut("model_context_window") {
                    if !window.is_null() {
                        counter(window)?;
                    }
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn visit_model_attempt(snapshot: &mut Value, counter: CounterVisitor) -> anyhow::Result<()> {
    let Some(usage) = snapshot.get_mut("usage") else {
        return Ok(());
    };
    for name in ["requests", "requests_without_token_usage"] {
        if let Some(count) = usage.get_mut(name) {
            counter(count)?;
        }
    }
    if let Some(tokens) = usage.get_mut("token_usage") {
        visit_usage(tokens, counter)?;
    }
    Ok(())
}

pub(crate) fn model_attempt_to_wire(snapshot: &mut Value) -> anyhow::Result<()> {
    visit_model_attempt(snapshot, counter_to_wire)
}

pub(crate) fn event_to_wire(message: &mut Value) -> anyhow::Result<()> {
    visit_event(message, counter_to_wire)?;
    if message["type"] == "token_count"
        && let Some(limits) = message.get_mut("api_rate_limits")
    {
        for window in ["requests", "tokens", "project_tokens"] {
            for field in ["limit", "remaining"] {
                if let Some(count) = limits
                    .get_mut(window)
                    .and_then(|window| window.get_mut(field))
                    && !count.is_null()
                {
                    counter_to_wire(count)?;
                }
            }
        }
    }
    Ok(())
}

fn visit_history(
    history: &mut Value,
    counter: CounterVisitor,
    received_counter: CounterVisitor,
) -> anyhow::Result<()> {
    let items = history
        .as_array_mut()
        .ok_or_else(|| anyhow::anyhow!("History must be an array"))?;
    for item in items {
        match item.get("type").and_then(Value::as_str) {
            Some("response_observation_record") => {
                if let Some(usage) = item
                    .get_mut("payload")
                    .and_then(|payload| payload.get_mut("usage"))
                {
                    visit_usage(usage, received_counter)?;
                }
            }
            Some("token_usage_record") => {
                if let Some(record) = item.get_mut("payload") {
                    visit_record(record, counter)?;
                }
            }
            Some("compacted") => {
                if let Some(record) = item
                    .get_mut("payload")
                    .and_then(|payload| payload.get_mut("latest_token_usage_record"))
                {
                    if !record.is_null() {
                        visit_record(record, counter)?;
                    }
                }
            }
            Some("event_msg") => {
                if let Some(message) = item.get_mut("payload") {
                    visit_event(message, counter)?;
                }
            }
            _ => {}
        }
    }
    Ok(())
}

pub(crate) fn history_to_wire(history: &[codex_history::RolloutItem]) -> anyhow::Result<Value> {
    let mut value = serde_json::to_value(history)?;
    history_usage_to_wire(&mut value)?;
    Ok(value)
}

fn history_usage_to_wire(history: &mut Value) -> anyhow::Result<()> {
    visit_history(history, counter_to_wire, counter_to_wire)
}

pub(crate) fn history_from_wire(history: &mut Value) -> anyhow::Result<()> {
    visit_history(history, counter_from_wire, received_counter_from_wire)
}

fn visit_checkpoint(
    checkpoint: &mut Value,
    visit: fn(&mut Value) -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    if let Some(history) = checkpoint.get_mut("history") {
        visit(history)?;
    }
    if let Some(descendants) = checkpoint.get_mut("descendants") {
        let descendants = descendants
            .as_array_mut()
            .ok_or_else(|| anyhow::anyhow!("Checkpoint descendants must be an array"))?;
        for descendant in descendants {
            if let Some(history) = descendant.get_mut("history") {
                visit(history)?;
            }
        }
    }
    Ok(())
}

// These transport views never change Core's stored or internal checkpoint format.
pub(crate) fn checkpoint_to_wire(checkpoint: &mut Value) -> anyhow::Result<()> {
    visit_checkpoint(checkpoint, history_usage_to_wire)
}

pub(crate) fn checkpoint_from_wire(checkpoint: &mut Value) -> anyhow::Result<()> {
    visit_checkpoint(checkpoint, history_from_wire)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn restored_response_observations_reject_negative_counts_in_root_and_descendants() {
        for key in COUNTERS {
            for value in [json!(-1), json!("-9007199254740993")] {
                let history = json!([{
                    "type": "response_observation_record",
                    "payload": { "usage": { (key): value } }
                }]);
                for mut checkpoint in [
                    json!({"history": history}),
                    json!({"descendants": [{"history": history}]}),
                ] {
                    let error = checkpoint_from_wire(&mut checkpoint).unwrap_err();
                    assert_eq!(
                        error.to_string(),
                        "Received response usage counters must be nonnegative"
                    );
                }
            }
        }
    }

    #[test]
    fn response_observation_usage_roundtrips_exact_optional_counters() -> anyhow::Result<()> {
        let mut history = json!([
            {"type":"response_observation_record","payload":{"id":"o","usage":{"input_tokens":i64::MAX,"cached_input_tokens":0}}},
            {"type":"response_observation_record","payload":{"id":"missing","usage":null}},
            {"type":"response_item","payload":{"arguments":{"type":"response_observation_record","usage":{"input_tokens":i64::MAX}}}}
        ]);
        let original = history.clone();
        history_usage_to_wire(&mut history)?;
        assert_eq!(
            history[0]["payload"]["usage"]["input_tokens"],
            i64::MAX.to_string()
        );
        assert_eq!(history[0]["payload"]["usage"]["cached_input_tokens"], 0);
        assert!(
            history[0]["payload"]["usage"]
                .get("output_tokens")
                .is_none()
        );
        assert!(history[1]["payload"]["usage"].is_null());
        assert_eq!(history[2], original[2]);
        history_from_wire(&mut history)?;
        assert_eq!(history, original);
        Ok(())
    }

    #[test]
    fn typed_child_usage_preserves_large_counts() {
        let mut usage = TokenUsage::default();
        usage.input_tokens = 9_007_199_254_740_993;
        usage.total_tokens = i64::MAX;
        let wire = exact_usage(&usage);
        assert_eq!(wire["input_tokens"], "9007199254740993");
        assert_eq!(wire["total_tokens"], i64::MAX.to_string());
        assert_eq!(wire["output_tokens"], json!(0));
        assert_eq!(
            exact_counter(9_007_199_254_740_991),
            json!(9_007_199_254_740_991_i64)
        );
        assert_eq!(
            exact_counter(-9_007_199_254_740_993),
            json!("-9007199254740993")
        );
    }

    #[test]
    fn history_conversion_changes_only_typed_usage_slots() -> anyhow::Result<()> {
        let mut history = json!([
            {"type":"token_usage_record", "payload": {"turn_id":"t", "turn_token_usage": {"input_tokens": 9_007_199_254_740_993_i64, "total_tokens": i64::MAX}}},
            {"type":"event_msg", "payload": {"type":"raw_response_completed", "token_usage": {"input_tokens": 1, "total_tokens": i64::MAX}}},
            {"type":"response_item", "payload": {"type":"function_call", "arguments": {"type":"token_usage_record", "turn_token_usage":{"input_tokens": i64::MAX}}}},
            {"type":"response_item", "payload": {"type":"function_call_output", "output": {"type":"raw_response_completed", "token_usage":{"input_tokens": i64::MAX}}}},
            {"type":"turn_context", "payload": {"total_tokens": i64::MAX}}
        ]);
        let original = history.clone();
        history_usage_to_wire(&mut history)?;
        assert_eq!(
            history[0]["payload"]["turn_token_usage"]["input_tokens"],
            "9007199254740993"
        );
        assert_eq!(
            history[1]["payload"]["token_usage"]["input_tokens"],
            json!(1)
        );
        assert_eq!(
            history[1]["payload"]["token_usage"]["total_tokens"],
            i64::MAX.to_string()
        );
        for index in 2..5 {
            assert_eq!(history[index], original[index]);
        }
        assert_eq!(
            original[0]["payload"]["turn_token_usage"]["input_tokens"],
            json!(9_007_199_254_740_993_i64)
        );
        let roundtrip: Value = serde_json::from_str(&serde_json::to_string(&history)?)?;
        assert_eq!(roundtrip, history);
        Ok(())
    }

    #[test]
    fn token_count_snapshots_are_exact_and_missing_usage_stays_null() -> anyhow::Result<()> {
        let mut event = json!({"type":"token_count", "info": {"total_token_usage":{"total_tokens": i64::MAX}, "last_token_usage":{"output_tokens":0}, "model_context_window": i64::MAX}});
        event_to_wire(&mut event)?;
        assert_eq!(
            event["info"]["total_token_usage"]["total_tokens"],
            i64::MAX.to_string()
        );
        assert_eq!(event["info"]["last_token_usage"]["output_tokens"], json!(0));
        assert_eq!(event["info"]["model_context_window"], i64::MAX.to_string());
        let mut missing = json!({"type":"token_count", "info":null});
        event_to_wire(&mut missing)?;
        assert!(missing["info"].is_null());
        assert!(visit_usage(&mut json!({"input_tokens":1.5}), counter_to_wire).is_err());
        Ok(())
    }
    fn complete_record() -> anyhow::Result<codex_protocol::protocol::TokenUsageRecord> {
        fn sample(offset: i64) -> TokenUsage {
            TokenUsage {
                input_tokens: 9_007_199_254_740_993 + offset,
                cached_input_tokens: 9_007_199_254_740_995 + offset,
                cache_write_input_tokens: 9_007_199_254_740_997 + offset,
                output_tokens: 9_007_199_254_740_999 + offset,
                reasoning_output_tokens: 9_007_199_254_741_001 + offset,
                total_tokens: 9_007_199_254_741_003 + offset,
                ..TokenUsage::default()
            }
        }
        Ok(serde_json::from_value(json!({
            "thread_id": "00000000-0000-7000-8000-000000000001",
            "session_id": "00000000-0000-7000-8000-000000000002",
            "turn_id": "turn",
            "root_turn_id": "turn",
            "response_id": "response",
            "usage": sample(0),
            "turn_token_usage": sample(20),
            "thread_token_usage": sample(40)
        }))?)
    }

    fn complete_history() -> anyhow::Result<Vec<codex_history::RolloutItem>> {
        let record = complete_record()?;
        // Deserialize the actual native compacted type, not a parallel test schema.
        let compacted: codex_history::RolloutItem = serde_json::from_value(json!({
            "type": "compacted", "payload": {
                "message": "retained usage",
                "latest_token_usage_record": record.clone()
            }
        }))?;
        Ok(vec![
            codex_history::RolloutItem::TokenUsageRecord(record),
            compacted,
        ])
    }

    fn assert_complete_wire_record(record: &Value, original: &Value) {
        // Independent contract list: do not use the production COUNTERS table here.
        for group in ["usage", "turn_token_usage", "thread_token_usage"] {
            for field in [
                "input_tokens",
                "cached_input_tokens",
                "cache_write_input_tokens",
                "output_tokens",
                "reasoning_output_tokens",
                "total_tokens",
            ] {
                let expected = original[group][field]
                    .as_i64()
                    .expect("native i64")
                    .to_string();
                assert_eq!(
                    record[group][field].as_str(),
                    Some(expected.as_str()),
                    "{group}.{field}"
                );
            }
        }
    }

    #[test]
    fn complete_direct_and_compacted_records_roundtrip_in_both_checkpoint_containers()
    -> anyhow::Result<()> {
        let native = complete_history()?;
        let original = serde_json::to_value(&native)?;
        let mut checkpoint = json!({
            "history": original.clone(),
            "root_metadata": {"history": null},
            "descendants": [{"history": original.clone(), "metadata": {"history": null}}]
        });
        let canonical = checkpoint.clone();
        checkpoint_to_wire(&mut checkpoint)?;
        for history in [
            &checkpoint["history"],
            &checkpoint["descendants"][0]["history"],
        ] {
            assert_complete_wire_record(&history[0]["payload"], &original[0]["payload"]);
            assert_complete_wire_record(
                &history[1]["payload"]["latest_token_usage_record"],
                &original[0]["payload"],
            );
        }
        let serialized = serde_json::to_string(&checkpoint)?;
        assert!(serialized.contains("\"input_tokens\":\"9007199254740993\""));
        let mut stored: Value = serde_json::from_str(&serialized)?;
        checkpoint_from_wire(&mut stored)?;
        assert_eq!(stored, canonical);
        for history in [&stored["history"], &stored["descendants"][0]["history"]] {
            let decoded: Vec<codex_history::RolloutItem> = serde_json::from_value(history.clone())?;
            assert_eq!(serde_json::to_value(decoded)?, original);
        }
        // The observational export must use the same complete record traversal.
        let observed = history_to_wire(&native)?;
        assert_complete_wire_record(&observed[0]["payload"], &original[0]["payload"]);
        assert_complete_wire_record(
            &observed[1]["payload"]["latest_token_usage_record"],
            &original[0]["payload"],
        );
        assert_eq!(serde_json::to_value(&native)?, original);
        Ok(())
    }

    #[test]
    fn safe_and_i64_boundary_counters_are_exact_and_ambiguous_numbers_refused() -> anyhow::Result<()>
    {
        for (count, expected) in [
            (0, json!(0)),
            (9_007_199_254_740_991, json!(9_007_199_254_740_991_i64)),
            (-9_007_199_254_740_991, json!(-9_007_199_254_740_991_i64)),
            (9_007_199_254_740_992, json!("9007199254740992")),
            (9_007_199_254_740_993, json!("9007199254740993")),
            (-9_007_199_254_740_992, json!("-9007199254740992")),
            (i64::MAX, json!("9223372036854775807")),
            (i64::MIN, json!("-9223372036854775808")),
        ] {
            assert_eq!(exact_counter(count), expected);
            let mut wire = expected;
            counter_from_wire(&mut wire)?;
            assert_eq!(wire, json!(count));
            if !(-MAX_SAFE..=MAX_SAFE).contains(&count) {
                assert!(counter_from_wire(&mut json!(count)).is_err());
            }
        }
        for bad in [
            json!(""),
            json!("00"),
            json!("-0"),
            json!("+1"),
            json!("1.0"),
            json!("1e3"),
            json!(" 1"),
            json!("1 "),
            json!("9223372036854775808"),
            json!("-9223372036854775809"),
            json!(1.5),
            json!(true),
            Value::Null,
            json!([]),
            json!({}),
        ] {
            assert!(counter_from_wire(&mut bad.clone()).is_err(), "{bad}");
        }
        Ok(())
    }

    #[test]
    fn every_record_group_refuses_malformed_wire_at_both_locations() -> anyhow::Result<()> {
        let history = serde_json::to_value(complete_history()?)?;
        for record_path in ["/0/payload", "/1/payload/latest_token_usage_record"] {
            for group in ["usage", "turn_token_usage", "thread_token_usage"] {
                for field in [
                    "input_tokens",
                    "cached_input_tokens",
                    "cache_write_input_tokens",
                    "output_tokens",
                    "reasoning_output_tokens",
                    "total_tokens",
                ] {
                    for bad in [
                        json!(9_007_199_254_740_992_i64),
                        json!("01"),
                        json!("9223372036854775808"),
                        json!(1.25),
                        json!(false),
                        json!({}),
                    ] {
                        let mut wire = history.clone();
                        history_usage_to_wire(&mut wire)?;
                        *wire
                            .pointer_mut(&format!("{record_path}/{group}/{field}"))
                            .expect("typed field") = bad;
                        assert!(
                            history_from_wire(&mut wire).is_err(),
                            "{record_path}/{group}/{field}"
                        );
                    }
                }
            }
        }
        Ok(())
    }

    #[test]
    fn event_usage_and_nullable_compacted_records_roundtrip_without_touching_application_data()
    -> anyhow::Result<()> {
        let mut history = json!([
            {"type":"event_msg","payload":{"type":"raw_response_completed","token_usage":{"input_tokens":9_007_199_254_740_993_i64}}},
            {"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":i64::MAX},"last_token_usage":{"input_tokens":7},"model_context_window":i64::MAX}}},
            {"type":"event_msg","payload":{"type":"token_count","info":null}},
            {"type":"compacted","payload":{"message":"none","latest_token_usage_record":null}},
            {"type":"compacted","payload":{"message":"absent"}},
            {"type":"compacted","payload":{"replacement_history":[{"arguments":{"type":"token_usage_record","usage":{"input_tokens":i64::MAX},"total_tokens":1.5}}]}},
            {"type":"response_item","payload":{"arguments":{"$serde_json::private::Number":"9007199254740993","thread_token_usage":{"input_tokens":i64::MAX}}}}
        ]);
        let original = history.clone();
        history_usage_to_wire(&mut history)?;
        assert_eq!(
            history[0]["payload"]["token_usage"]["input_tokens"],
            "9007199254740993"
        );
        assert_eq!(
            history[1]["payload"]["info"]["model_context_window"],
            i64::MAX.to_string()
        );
        assert_eq!(
            history[1]["payload"]["info"]["last_token_usage"]["input_tokens"],
            json!(7)
        );
        for index in 2..history.as_array().expect("history").len() {
            assert_eq!(history[index], original[index]);
        }
        let serialized = serde_json::to_string(&history)?;
        let raw: &serde_json::value::RawValue = serde_json::from_str(&serialized)?;
        let mut stored = crate::checkpoint_json_value(raw, 0)?;
        history_from_wire(&mut stored)?;
        assert_eq!(stored, original);
        Ok(())
    }

    #[test]
    fn safe_records_and_required_record_groups_keep_native_validation() -> anyhow::Result<()> {
        let mut record = complete_record()?;
        record.usage = TokenUsage::default();
        record.turn_token_usage = TokenUsage::default();
        record.thread_token_usage = TokenUsage::default();
        record.usage.input_tokens = 17;
        record.turn_token_usage.input_tokens = 24;
        record.thread_token_usage.input_tokens = 33;
        let native = vec![codex_history::RolloutItem::TokenUsageRecord(record)];
        let canonical = serde_json::to_value(&native)?;
        let wire = history_to_wire(&native)?;
        assert_eq!(wire, canonical);
        let mut stored: Value = serde_json::from_str(&serde_json::to_string(&wire)?)?;
        history_from_wire(&mut stored)?;
        let decoded: Vec<codex_history::RolloutItem> = serde_json::from_value(stored)?;
        assert_eq!(serde_json::to_value(decoded)?, canonical);
        for record_path in ["/0/payload", "/1/payload/latest_token_usage_record"] {
            for group in ["usage", "turn_token_usage", "thread_token_usage"] {
                let mut wire = history_to_wire(&complete_history()?)?;
                wire.pointer_mut(record_path)
                    .expect("record")
                    .as_object_mut()
                    .expect("record object")
                    .remove(group);
                history_from_wire(&mut wire)?;
                // The converter does not replace Core's required-field validation.
                assert!(serde_json::from_value::<Vec<codex_history::RolloutItem>>(wire).is_err());
            }
        }
        let mut safe_string = json!("7");
        counter_from_wire(&mut safe_string)?;
        assert_eq!(safe_string, json!(7));
        Ok(())
    }
    #[test]
    fn model_attempt_snapshots_keep_exact_tokens_in_live_and_history_slots() -> anyhow::Result<()> {
        let original = json!({"type":"task_complete", "model_attempt":{
            "owner_attempt_id":"original", "terminal_attempt_id":"original",
            "usage":{"requests":1,"requests_without_token_usage":0,
                "token_usage":{"input_tokens":9_007_199_254_740_993_i64,"total_tokens":i64::MAX}}}});
        let mut live = original.clone();
        event_to_wire(&mut live)?;
        assert_eq!(
            live["model_attempt"]["usage"]["token_usage"]["input_tokens"],
            "9007199254740993"
        );
        visit_event(&mut live, counter_from_wire)?;
        assert_eq!(live, original);
        let mut notice =
            json!({"type":"_sdk_model_attempt", "data":original["model_attempt"].clone()});
        event_to_wire(&mut notice)?;
        assert_eq!(
            notice["data"]["usage"]["token_usage"]["total_tokens"],
            i64::MAX.to_string()
        );
        visit_event(&mut notice, counter_from_wire)?;
        assert_eq!(notice["data"], original["model_attempt"]);
        Ok(())
    }
}
