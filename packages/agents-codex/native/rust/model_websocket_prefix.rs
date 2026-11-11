//! Per-physical-socket continuation state for the private Responses bridge.
//!
//! The caller retains admission, control identity, schema restoration, projection,
//! wire-size limits and send/receive ownership. It reconstructs before restoring
//! schemas, encodes afterwards, and commits only a completed response or an
//! incomplete response whose reason is `interrupted`. Reconnects start with a new
//! state; a prefix must never be transferred to another physical socket.

use serde_json::{Map, Value};

type Result<T> = std::result::Result<T, String>;

#[derive(Debug, Default)]
pub(crate) struct Prefix {
    id: Option<String>,
    // The JS carrier stores original + output, then slices to originalLength.
    // Retain precisely that slice, without another copy of projected output.
    original_input: Vec<Value>,
    provider_input: Option<Vec<Value>>,
    properties: Option<Map<String, Value>>,
    active_id: Option<String>,
    warmup: bool,
}

impl Prefix {
    /// Expand Core's delta using its accepted completion receipt. The native
    /// receipt, rather than provider output, owns interrupted/normal history.
    pub(crate) fn reconstruct(
        &self,
        mut request: Value,
        completion: Option<&Value>,
    ) -> Result<Value> {
        let body = request
            .as_object_mut()
            .ok_or("Invalid native Responses request")?;
        if !body.get("input").is_some_and(Value::is_array) {
            return Err("Invalid native Responses input".into());
        }
        let Some(reference) = body.get("previous_response_id").filter(|v| !v.is_null()) else {
            return Ok(request);
        };
        let reference = reference
            .as_str()
            .filter(|reference| self.id.as_deref() == Some(*reference))
            .ok_or("Unknown native WebSocket continuation")?;
        let tail = if self.warmup {
            Vec::new()
        } else {
            let receipt = completion
                .and_then(Value::as_object)
                .ok_or("Invalid native WebSocket completion receipt")?;
            let model = body.get("model").and_then(Value::as_str);
            if receipt.get("response_id").and_then(Value::as_str) != Some(reference)
                || model.is_none()
                || receipt.get("model").and_then(Value::as_str) != model
            {
                return Err("Invalid native WebSocket completion receipt".into());
            }
            receipt
                .get("output")
                .and_then(Value::as_array)
                .ok_or("Invalid native WebSocket completion receipt")?
                .clone()
        };
        let mut input = self.original_input.clone();
        input.extend(tail);
        if let Some(Value::Array(delta)) = body.remove("input") {
            input.extend(delta);
        }
        body.insert("input".into(), Value::Array(input));
        body.remove("previous_response_id");
        Ok(request)
    }

    /// Select a provider delta only after schema restoration, against this
    /// socket's last committed provider input and stable request properties.
    pub(crate) fn encode(&self, edited: &Value) -> Result<Value> {
        let body = edited
            .as_object()
            .ok_or("Edited Responses request must be an object")?;
        let input = body
            .get("input")
            .and_then(Value::as_array)
            .ok_or("Edited Responses input must be a list")?;
        let properties = properties(body);
        let mut outgoing = body.clone();
        outgoing.insert("type".into(), Value::String("response.create".into()));
        let prefix = self.provider_input.as_ref().filter(|prefix| {
            self.id.is_some()
                && self
                    .properties
                    .as_ref()
                    .is_some_and(|previous| same_object(previous, &properties))
                && input.len() >= prefix.len()
                && prefix.iter().zip(input).all(|(a, b)| same_json(a, b))
        });
        if let Some(prefix) = prefix {
            outgoing.insert(
                "previous_response_id".into(),
                Value::String(self.id.clone().expect("committed prefix has an id")),
            );
            outgoing.insert("input".into(), Value::Array(input[prefix.len()..].to_vec()));
        } else {
            outgoing.remove("previous_response_id");
        }
        Ok(Value::Object(outgoing))
    }

    /// `original` and `edited` are the full, restored request, before encode
    /// selects a delta. `items` have already passed the existing projector.
    pub(crate) fn commit(
        &mut self,
        id: String,
        original: Vec<Value>,
        edited: Option<&Value>,
        items: Vec<Value>,
        warmup: bool,
    ) -> Result<()> {
        if self.active_id.as_ref().is_some_and(|active| active != &id) {
            return Err("Native WebSocket completion changed response identity".into());
        }
        let body = edited.and_then(Value::as_object);
        let provider_input = body
            .and_then(|body| body.get("input"))
            .and_then(Value::as_array)
            .map(|input| {
                let mut input = input.clone();
                input.extend(items);
                input
            });
        self.id = Some(id);
        self.original_input = original;
        self.provider_input = provider_input;
        self.properties = body.map(properties);
        self.active_id = None;
        self.warmup = warmup;
        Ok(())
    }

    pub(crate) fn observe_created(&mut self, response: &Value) -> Result<()> {
        let response = response
            .as_object()
            .ok_or("Invalid native response.created")?;
        self.active_id = response
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_owned);
        Ok(())
    }

    /// The caller supplies whether the *currently pending* admitted request is
    /// generation. A retained response id alone cannot authorize an interrupt.
    pub(crate) fn validate_interrupt(&self, request: &Value, generation: bool) -> Result<()> {
        if !generation
            || self.active_id.is_none()
            || request.get("type").and_then(Value::as_str) != Some("response.interrupt")
            || request.get("response_id").and_then(Value::as_str) != self.active_id.as_deref()
            || request.get("mode").and_then(Value::as_str) != Some("discard_partial_items")
        {
            return Err("Interrupt does not own this response".into());
        }
        Ok(())
    }

    /// A failed/non-interrupted incomplete response invalidates provider delta
    /// reuse. The last committed native receipt can still reconstruct history.
    pub(crate) fn clear_provider_prefix(&mut self) {
        self.provider_input = None;
        self.properties = None;
        self.active_id = None;
    }
}

fn properties(request: &Map<String, Value>) -> Map<String, Value> {
    request
        .iter()
        .filter(|(key, _)| {
            !matches!(
                key.as_str(),
                "type"
                    | "input"
                    | "previous_response_id"
                    | "generate"
                    | "client_metadata"
                    | "stream_options"
                    | "access_programs"
            )
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

fn same_object(a: &Map<String, Value>, b: &Map<String, Value>) -> bool {
    a.len() == b.len()
        && a.iter()
            .all(|(key, value)| b.get(key).is_some_and(|other| same_json(value, other)))
}

// JS's isDeepStrictEqual distinguishes negative zero, while serde Value can
// already have lost that distinction when parsing integer -0. Matching finite,
// nonzero representations are safe witnesses; zero and representation changes
// conservatively select a full request, never a rejection or a changed request.
fn same_json(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(a), Value::Bool(b)) => a == b,
        (Value::String(a), Value::String(b)) => a == b,
        (Value::Number(a), Value::Number(b)) => {
            a.as_f64().is_some_and(|n| n.is_finite() && n != 0.0) && a.to_string() == b.to_string()
        }
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same_json(a, b))
        }
        (Value::Object(a), Value::Object(b)) => same_object(a, b),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request(input: Value) -> Value {
        json!({"model":"m", "stream":true, "input":input})
    }

    #[test]
    fn delta_reconstruction_uses_native_completion_not_projected_output() {
        let mut prefix = Prefix::default();
        let original = vec![json!({"role":"user", "content":"hello"})];
        let edited = request(json!([{"role":"user", "content":"edited"}]));
        prefix
            .commit(
                "r".into(),
                original.clone(),
                Some(&edited),
                vec![json!("provider")],
                false,
            )
            .unwrap();
        let receipt = json!({"response_id":"r", "model":"m", "output":["accepted partial"]});
        let delta = json!({"model":"m", "input":["next"], "previous_response_id":"r"});
        let full = prefix.reconstruct(delta, Some(&receipt)).unwrap();
        assert_eq!(
            full["input"],
            json!([original[0], "accepted partial", "next"])
        );
        assert!(full.get("previous_response_id").is_none());
    }

    #[test]
    fn continuation_requires_matching_socket_response_model_and_receipt_shape() {
        let mut prefix = Prefix::default();
        prefix
            .commit("r".into(), vec![], None, vec![], false)
            .unwrap();
        let delta = json!({"model":"m", "input":[], "previous_response_id":"r"});
        for receipt in [
            json!({"response_id":"other", "model":"m", "output":[]}),
            json!({"response_id":"r", "model":"other", "output":[]}),
            json!({"response_id":"r", "model":"m", "output":null}),
        ] {
            assert!(prefix.reconstruct(delta.clone(), Some(&receipt)).is_err());
        }
        assert!(Prefix::default().reconstruct(delta, None).is_err());
    }

    #[test]
    fn warmup_continuation_has_no_completion_tail() {
        let mut prefix = Prefix::default();
        prefix
            .commit("w".into(), vec![json!("original")], None, vec![], true)
            .unwrap();
        let full = prefix
            .reconstruct(json!({"input":["next"], "previous_response_id":"w"}), None)
            .unwrap();
        assert_eq!(full["input"], json!(["original", "next"]));
    }

    #[test]
    fn provider_delta_uses_restored_prefix_and_ignores_only_carrier_fields() {
        let mut prefix = Prefix::default();
        let edited = request(json!(["original"]));
        prefix
            .commit(
                "r".into(),
                vec![json!("original")],
                Some(&edited),
                vec![json!("output")],
                false,
            )
            .unwrap();
        let mut next = request(json!(["original", "output", "next"]));
        next["client_metadata"] = json!({"different":"ticket"});
        next["stream_options"] = json!({"new":"delivery"});
        next["access_programs"] = json!(["new"]);
        next["generate"] = json!(true);
        let delta = prefix.encode(&next).unwrap();
        assert_eq!(delta["type"], "response.create");
        assert_eq!(delta["previous_response_id"], "r");
        assert_eq!(delta["input"], json!(["next"]));
        next["model"] = json!("changed");
        next["previous_response_id"] = json!("untrusted");
        let full = prefix.encode(&next).unwrap();
        assert_eq!(full["input"], next["input"]);
        assert!(full.get("previous_response_id").is_none());
    }

    #[test]
    fn numeric_ambiguity_and_failed_response_select_full_requests() {
        let mut prefix = Prefix::default();
        let mut edited = request(json!(["original"]));
        edited["temperature"] = json!(0);
        prefix
            .commit("r".into(), vec![], Some(&edited), vec![], false)
            .unwrap();
        assert!(
            prefix
                .encode(&edited)
                .unwrap()
                .get("previous_response_id")
                .is_none()
        );
        let edited = request(json!([{"number":0}]));
        prefix
            .commit("r".into(), vec![], Some(&edited), vec![], false)
            .unwrap();
        assert!(
            prefix
                .encode(&edited)
                .unwrap()
                .get("previous_response_id")
                .is_none()
        );
        let edited = request(json!([]));
        prefix
            .commit("r".into(), vec![], Some(&edited), vec![], false)
            .unwrap();
        prefix.clear_provider_prefix();
        assert!(
            prefix
                .encode(&edited)
                .unwrap()
                .get("previous_response_id")
                .is_none()
        );
    }

    #[test]
    fn matched_finite_nonzero_numeric_properties_allow_delta() {
        let mut prefix = Prefix::default();
        let mut edited = request(json!(["original"]));
        edited["max_output_tokens"] = json!(1024);
        edited["tools"] = json!([{"parameters":{"minimum":1.5, "maximum":10}}]);
        prefix
            .commit("r".into(), vec![], Some(&edited), vec![], false)
            .unwrap();
        let mut next = edited.clone();
        next["input"] = json!(["original", "next"]);
        let delta = prefix.encode(&next).unwrap();
        assert_eq!(delta["previous_response_id"], "r");
        assert_eq!(delta["input"], json!(["next"]));
        assert!(!same_json(&json!(1), &json!(1.0)));
        assert!(!same_json(&json!(0), &json!(0)));
        assert!(!same_json(&json!(-0.0), &json!(0.0)));
    }

    #[test]
    fn interrupt_requires_live_generation_and_created_identity() {
        let mut prefix = Prefix::default();
        let interrupt =
            json!({"type":"response.interrupt", "response_id":"r", "mode":"discard_partial_items"});
        assert!(prefix.validate_interrupt(&interrupt, true).is_err());
        prefix.observe_created(&json!({"id":"r"})).unwrap();
        assert!(prefix.validate_interrupt(&interrupt, false).is_err());
        assert!(prefix.validate_interrupt(&interrupt, true).is_ok());
        let mut wrong = interrupt.clone();
        wrong["response_id"] = json!("other");
        assert!(prefix.validate_interrupt(&wrong, true).is_err());
        assert!(
            prefix
                .commit("other".into(), vec![], None, vec![], false)
                .is_err()
        );
        prefix
            .commit("r".into(), vec![], None, vec![], false)
            .unwrap();
        assert!(prefix.validate_interrupt(&interrupt, true).is_err());
    }
}
