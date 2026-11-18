//! Native, process-local trace ownership for the import-free portable controller.
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};

const METADATA_BYTES: usize = 4 * 1024 * 1024 - 65_536;
const RETAINED_BYTES: usize = 8 * 1024 * 1024;
const EVENT_BYTES: usize = 4 * 1024 * 1024 - 65_536;
const REPLY_EVENT_BYTES: usize = 8 * 1024 * 1024 - 65_536;
const EXPORT_BYTES: usize = 128 * 1024;
const LIVE_SPANS: usize = 1024;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum TraceCommand {
    Capabilities,
    Start {
        name: String,
        kind: String,
        trace_id: String,
        span_id: String,
        parent: Option<String>,
        metadata: Value,
        disabled: bool,
        include_sensitive_data: bool,
        time: String,
        custom_routes: Vec<String>,
        bounded_routes: Vec<String>,
    },
    End {
        handle: String,
        time: String,
        error: bool,
    },
    Cancel {
        handle: String,
        time: String,
    },
    Shutdown {
        time: String,
    },
}

struct Span {
    handle: String,
    name: String,
    kind: String,
    trace_id: String,
    span_id: String,
    parent: Option<String>,
    parent_span_id: Option<String>,
    depth: usize,
    metadata: Value,
    metadata_bytes: usize,
    disabled: bool,
    sensitive: bool,
    start: String,
    custom: Vec<String>,
    bounded: Vec<String>,
}

#[derive(Default)]
pub(super) struct TraceState {
    spans: HashMap<String, Span>,
    next: u64,
    sequence: u64,
    retained: usize,
    dropped: u64,
    stopped: bool,
}

fn metadata(value: &Value, depth: usize) -> Result<(), &'static str> {
    if depth > 64 {
        return Err("Tracing metadata exceeds maximum depth");
    }
    match value {
        Value::Array(values) => {
            for value in values {
                metadata(value, depth + 1)?;
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                if key.len() > 256 {
                    return Err("Tracing key exceeds 256 UTF-8 bytes");
                }
                metadata(value, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn timestamp(value: &str) -> Result<(), &'static str> {
    if value.is_empty()
        || value.len() > 39
        || !value.bytes().all(|c| c.is_ascii_digit())
        || value.parse::<u128>().is_err()
    {
        return Err("Invalid native trace timestamp");
    }
    Ok(())
}

fn identity(value: &str, bytes: usize) -> bool {
    value.len() == bytes
        && value.bytes().all(|c| c.is_ascii_hexdigit())
        && value.bytes().any(|c| c != b'0')
}

fn routes(custom: &[String], bounded: &[String]) -> Result<(), &'static str> {
    let mut seen = HashSet::new();
    if custom.len() + bounded.len() > 64 {
        return Err("Too many trace processor routes");
    }
    for route in custom.iter().chain(bounded) {
        if route.is_empty() || route.len() > 64 || !seen.insert(route) {
            return Err("Invalid trace processor route");
        }
    }
    Ok(())
}

impl Span {
    fn context(&self) -> Value {
        json!({"handle":self.handle,"trace_id":self.trace_id,"span_id":self.span_id,
            "parent_span_id":self.parent_span_id,"disabled":self.disabled,
            "include_sensitive_data":self.sensitive})
    }

    fn event(&self, sequence: u64, end: Option<&str>, error: bool, bounded: bool) -> Value {
        let mut event = json!({"sequence":sequence,
            "processor_ids":if bounded { &self.bounded } else { &self.custom },
            "lifecycle":if end.is_some() { "end" } else { "start" },
            "trace_id":self.trace_id,"span_id":self.span_id,
            "parent_span_id":self.parent_span_id,"name":self.name,"kind":self.kind,
            "start_time_unix_nanos":self.start,"end_time_unix_nanos":end,
            "attributes":{},"outcome":if end.is_none() { "unset" } else if error { "error" } else { "ok" },
            "dropped_attributes_count":0});
        let mut attributes = Map::new();
        let mut used = serde_json::to_vec(&event)
            .expect("native trace event")
            .len()
            + 20;
        let mut dropped = 0u64;
        // One admitted native value supplies both projections. Strings retain
        // their value; every other metadata shape retains compact JSON.
        for (key, value) in self.metadata.as_object().expect("admitted metadata") {
            let key = format!("sdk.metadata.{key}");
            let value = value
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| serde_json::to_string(value).expect("admitted metadata"));
            let cost = serde_json::to_vec(&(&key, &value))
                .expect("metadata pair")
                .len()
                .saturating_sub(2)
                + usize::from(!attributes.is_empty());
            if bounded && used.saturating_add(cost) > EXPORT_BYTES {
                dropped = dropped.saturating_add(1);
                continue;
            }
            used = used.saturating_add(cost);
            attributes.insert(key, Value::String(value));
        }
        event["attributes"] = Value::Object(attributes);
        event["dropped_attributes_count"] = json!(dropped);
        event
    }
}

impl TraceState {
    fn push_event(&mut self, events: &mut Vec<Value>, used: &mut usize, event: Value) {
        let bytes = serde_json::to_vec(&event)
            .expect("native trace event")
            .len();
        if bytes > EVENT_BYTES || used.saturating_add(bytes) > REPLY_EVENT_BYTES {
            self.dropped = self.dropped.saturating_add(1);
        } else {
            *used += bytes;
            events.push(event);
        }
    }

    fn emit(
        &mut self,
        span: &Span,
        end: Option<&str>,
        error: bool,
        events: &mut Vec<Value>,
        used: &mut usize,
    ) {
        if span.disabled {
            return;
        }
        self.sequence = self.sequence.saturating_add(1);
        if !span.custom.is_empty() {
            self.push_event(events, used, span.event(self.sequence, end, error, false));
        }
        if !span.bounded.is_empty() {
            self.push_event(events, used, span.event(self.sequence, end, error, true));
        }
    }

    fn descendant(&self, key: &str, parent: &str) -> bool {
        let mut current = Some(key);
        for _ in 0..=64 {
            let Some(key) = current else { return false };
            if key == parent {
                return true;
            }
            current = self.spans.get(key).and_then(|span| span.parent.as_deref());
        }
        false
    }

    fn finish(
        &mut self,
        parent: Option<&str>,
        time: &str,
        error: bool,
        events: &mut Vec<Value>,
        used: &mut usize,
    ) {
        let mut keys = self
            .spans
            .iter()
            .filter(|(key, _)| parent.is_none_or(|parent| self.descendant(key, parent)))
            .map(|(key, span)| (span.depth, key.clone()))
            .collect::<Vec<_>>();
        keys.sort_by(|a, b| b.cmp(a));
        for (_, key) in keys {
            if let Some(span) = self.spans.remove(&key) {
                self.retained = self.retained.saturating_sub(span.metadata_bytes);
                let end = if time.parse::<u128>().unwrap() < span.start.parse::<u128>().unwrap() {
                    &span.start
                } else {
                    time
                };
                self.emit(&span, Some(end), error, events, used);
            }
        }
    }

    pub(super) fn apply(&mut self, command: TraceCommand) -> Result<Value, &'static str> {
        let mut events = Vec::new();
        let mut used = 0;
        let mut context = Value::Null;
        match command {
            TraceCommand::Capabilities => {
                return Ok(json!({"version":1,"events":[],
                "metadata_bytes":METADATA_BYTES,"export_bytes":EXPORT_BYTES,
                "retained_bytes":RETAINED_BYTES,"live_spans":LIVE_SPANS}));
            }
            TraceCommand::Start {
                name,
                kind,
                trace_id,
                span_id,
                parent,
                metadata: data,
                disabled,
                include_sensitive_data,
                time,
                custom_routes,
                bounded_routes,
            } => {
                if self.stopped {
                    return Err("Native Worker tracing has shut down");
                }
                timestamp(&time)?;
                if name.len() > 1024 || kind.is_empty() || kind.len() > 64 {
                    return Err("Invalid native trace name or kind");
                }
                if !identity(&trace_id, 32) || !identity(&span_id, 16) {
                    return Err("Invalid native trace identity");
                }
                let trace_id = trace_id.to_ascii_lowercase();
                let span_id = span_id.to_ascii_lowercase();
                routes(&custom_routes, &bounded_routes)?;
                if !data.is_object() {
                    return Err("Tracing metadata must be an object");
                }
                let bytes = serde_json::to_vec(&data)
                    .map_err(|_| "Invalid tracing metadata")?
                    .len();
                if bytes > METADATA_BYTES {
                    return Err("Tracing metadata exceeds native annotation limit");
                }
                metadata(&data, 0)?;
                if self.spans.len() >= LIVE_SPANS
                    || self.retained.saturating_add(bytes) > RETAINED_BYTES
                {
                    return Err("Native trace retention capacity exceeded");
                }
                if self
                    .spans
                    .values()
                    .any(|span| span.trace_id == trace_id && span.span_id == span_id)
                {
                    return Err("Native trace identity is already active");
                }
                let (depth, parent_span_id, blocked, sensitive) = if let Some(key) = &parent {
                    let old = self
                        .spans
                        .get(key)
                        .ok_or("Native tracing parent is closed or unknown")?;
                    if old.trace_id != trace_id {
                        return Err("Native trace parent belongs to another trace");
                    }
                    (
                        old.depth + 1,
                        Some(old.span_id.clone()),
                        old.disabled,
                        old.sensitive,
                    )
                } else {
                    (0, None, false, true)
                };
                if depth > 64 {
                    return Err("Native trace ancestry exceeds maximum depth");
                }
                let next = self
                    .next
                    .checked_add(1)
                    .ok_or("Native trace handles exhausted")?;
                let handle = format!("worker_trace_{next}");
                let span = Span {
                    handle: handle.clone(),
                    name,
                    kind,
                    trace_id,
                    span_id,
                    parent,
                    parent_span_id,
                    depth,
                    metadata: data,
                    metadata_bytes: bytes,
                    disabled: disabled || blocked,
                    sensitive: include_sensitive_data && sensitive,
                    start: time,
                    custom: custom_routes,
                    bounded: bounded_routes,
                };
                context = span.context();
                self.emit(&span, None, false, &mut events, &mut used);
                self.next = next;
                self.retained += bytes;
                self.spans.insert(handle, span);
            }
            TraceCommand::End {
                handle,
                time,
                error,
            } => {
                timestamp(&time)?;
                self.finish(Some(&handle), &time, error, &mut events, &mut used);
            }
            TraceCommand::Cancel { handle, time } => {
                timestamp(&time)?;
                self.finish(Some(&handle), &time, true, &mut events, &mut used);
            }
            TraceCommand::Shutdown { time } => {
                timestamp(&time)?;
                self.finish(None, &time, true, &mut events, &mut used);
                self.stopped = true;
            }
        }
        Ok(
            json!({"version":1,"span":context,"events":events,"sequence":self.sequence,
            "dropped_records":self.dropped,"active_spans":self.spans.len(),
            "retained_bytes":self.retained}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn start(parent: Option<&str>, trace: &str, span: &str, data: Value) -> TraceCommand {
        serde_json::from_value(json!({"op":"start","name":"native","kind":"custom",
            "trace_id":trace,"span_id":span,"parent":parent,"metadata":data,
            "disabled":false,"include_sensitive_data":false,"time":"1",
            "custom_routes":["full"],"bounded_routes":["export"]}))
        .unwrap()
    }
    const TRACE: &str = "11111111111111111111111111111111";
    #[test]
    fn full_and_bounded_share_one_native_admission() {
        let mut state = TraceState::default();
        let reply = state
            .apply(start(
                None,
                TRACE,
                "1111111111111111",
                json!({"large":"x".repeat(160*1024),"small":{"x":[null,false,"海豚 🐬"]}}),
            ))
            .unwrap();
        let full = &reply["events"][0];
        let bounded = &reply["events"][1];
        assert_eq!(
            full["attributes"]["sdk.metadata.large"]
                .as_str()
                .unwrap()
                .len(),
            160 * 1024
        );
        assert!(bounded["attributes"].get("sdk.metadata.large").is_none());
        assert!(bounded["attributes"].get("sdk.metadata.small").is_some());
        assert_eq!(bounded["dropped_attributes_count"], 1);
        assert!(serde_json::to_vec(bounded).unwrap().len() <= EXPORT_BYTES);
    }
    #[test]
    fn parentage_and_cancellation_are_native_and_cannot_reopen() {
        let mut state = TraceState::default();
        let root = state
            .apply(start(None, TRACE, "1111111111111111", json!({})))
            .unwrap();
        let key = root["span"]["handle"].as_str().unwrap();
        let child = state
            .apply(start(Some(key), TRACE, "2222222222222222", json!({})))
            .unwrap();
        assert_eq!(child["span"]["parent_span_id"], "1111111111111111");
        let ended = state
            .apply(TraceCommand::Cancel {
                handle: key.into(),
                time: "2".into(),
            })
            .unwrap();
        assert_eq!(ended["active_spans"], 0);
        assert_eq!(ended["events"][0]["span_id"], "2222222222222222");
        assert!(
            state
                .apply(start(Some(key), TRACE, "3333333333333333", json!({})))
                .is_err()
        );
        assert!(
            state
                .apply(TraceCommand::End {
                    handle: key.into(),
                    time: "3".into(),
                    error: false
                })
                .unwrap()["events"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn metadata_and_ancestry_refuse_before_state_changes() {
        let mut state = TraceState::default();
        assert!(
            state
                .apply(start(
                    None,
                    TRACE,
                    "1111111111111111",
                    json!({"x".repeat(257):0})
                ))
                .is_err()
        );
        assert!(state.spans.is_empty());
        let root = state
            .apply(start(None, TRACE, "1111111111111111", json!({})))
            .unwrap();
        let key = root["span"]["handle"].as_str().unwrap();
        assert!(
            state
                .apply(start(
                    Some(key),
                    "22222222222222222222222222222222",
                    "2222222222222222",
                    json!({})
                ))
                .is_err()
        );
        assert_eq!(state.spans.len(), 1);
    }
}
