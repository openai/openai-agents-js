//! Restore only the captured managed schemas admitted by this tool owner.
//!
//! Generation.specs owns immutable schema metadata, without callback authority.
//! Live declarations use weak receipts. Published search schemas also keep their
//! metadata for canonical history, which can outlive an executor or step.
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, Weak};

use anyhow::{Result, ensure};
use codex_protocol::ThreadId;
use codex_tools::{ResponsesApiNamespaceTool, ToolSpec};
use serde_json::Value;

use super::{Generation, PythonTools, functions};

static MARKER: LazyLock<String> =
    LazyLock::new(|| format!("\n[agents-schema:{}/", ThreadId::new()));

struct Receipt {
    generation: Weak<Generation>,
    historical: Option<Arc<Generation>>,
}

#[derive(Default)]
pub(super) struct Receipts(Mutex<HashMap<String, Receipt>>);

impl Receipts {
    pub(super) fn description(original: &str, token: &str, slot: usize) -> String {
        format!("{original}{}{token}/{slot}]", MARKER.as_str())
    }

    pub(super) fn register(&self, generation: &Arc<Generation>) {
        let Some(token) = &generation.schema_token else {
            return;
        };
        let mut receipts = self.0.lock().expect("tool schema receipts poisoned");
        receipts.retain(|_, receipt| receipt.generation.strong_count() > 0);
        receipts.insert(
            token.clone(),
            Receipt {
                generation: Arc::downgrade(generation),
                historical: None,
            },
        );
    }

    fn restore(&self, request: &mut Value) -> Result<()> {
        // Validate the entire request before exposing any restored fields.
        let mut restored = request.clone();
        if let Some(tools) = restored.get_mut("tools").and_then(Value::as_array_mut) {
            self.declarations(tools, "functions")?;
        }
        if let Some(input) = restored.get_mut("input").and_then(Value::as_array_mut) {
            for item in input {
                if matches!(
                    item.get("type").and_then(Value::as_str),
                    Some("additional_tools" | "tool_search_output")
                ) && let Some(tools) = item.get_mut("tools").and_then(Value::as_array_mut)
                {
                    self.declarations(tools, "functions")?;
                }
            }
        }
        *request = restored;
        Ok(())
    }

    pub(super) fn retain_search_schema(&self, generation: &Arc<Generation>) {
        let mut receipts = self.0.lock().expect("tool schema receipts poisoned");
        if let Some(token) = &generation.schema_token
            && let Some(receipt) = receipts.get_mut(token)
        {
            // This metadata contains no callback, tool owner, or dispatch handle.
            receipt.historical = Some(generation.clone());
        }
    }

    fn declarations(&self, tools: &mut [Value], namespace: &str) -> Result<()> {
        for tool in tools {
            match tool.get("type").and_then(Value::as_str) {
                Some("namespace") => {
                    let name = tool
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    if let Some(children) = tool.get_mut("tools").and_then(Value::as_array_mut) {
                        self.declarations(children, &name)?;
                    }
                }
                Some("function") => self.function(tool, namespace)?,
                Some("custom")
                    if namespace == "functions"
                        && tool.get("name").and_then(Value::as_str) == Some("exec") =>
                {
                    self.code_mode_description(tool)?;
                }
                _ => {}
            }
        }
        Ok(())
    }

    // Code Mode renders nested tools as TypeScript in its exec description.
    // Preserve Core's existing representation, which has no function parameter
    // JSON slot, while removing our private identity from owned nested tools.
    fn code_mode_description(&self, tool: &mut Value) -> Result<()> {
        let Some(description) = tool.get("description").and_then(Value::as_str) else {
            return Ok(());
        };
        let mut remaining = description;
        let mut restored = String::with_capacity(description.len());
        while let Some((prefix, rest)) = remaining.split_once(MARKER.as_str()) {
            let (reference, after) = rest
                .split_once(']')
                .ok_or_else(|| anyhow::anyhow!("Invalid nested managed schema reference"))?;
            let (token, slot) = reference
                .split_once('/')
                .and_then(|(token, slot)| slot.parse::<usize>().ok().map(|slot| (token, slot)))
                .ok_or_else(|| anyhow::anyhow!("Invalid nested managed schema reference"))?;
            let generation = self
                .0
                .lock()
                .expect("tool schema receipts poisoned")
                .get(token)
                .and_then(|receipt| receipt.generation.upgrade())
                .ok_or_else(|| anyhow::anyhow!("Nested managed schema reference is unavailable"))?;
            let originals = functions(&generation.specs);
            let (namespace, source) = originals
                .get(slot)
                .ok_or_else(|| anyhow::anyhow!("Invalid nested managed schema slot"))?;
            // A marker is not its own grant. Check its exact generated header
            // and original description before stripping it from Core's prompt.
            let name = codex_tools::code_mode_name_for_tool_name(&codex_tools::ToolName::new(
                namespace.map(|namespace| namespace.name.clone()),
                source.name.clone(),
            ));
            let global = codex_code_mode::normalize_code_mode_identifier(&name);
            let heading = if global == name {
                format!("### `{name}`")
            } else {
                format!("### `{global}` (`{name}`)")
            };
            // Core trims the rendered description after appending our marker,
            // so only leading whitespace in the original is discarded. For an
            // empty original, MARKER also consumes Core's heading newline.
            let description = source.description.trim_start();
            let expected = if description.is_empty() {
                heading
            } else {
                format!("{heading}\n{description}")
            };
            ensure!(
                prefix.ends_with(&expected),
                "Nested managed schema declaration does not match its native owner"
            );
            restored.push_str(prefix);
            remaining = after;
        }
        restored.push_str(remaining);
        tool["description"] = Value::String(restored);
        Ok(())
    }

    fn function(&self, tool: &mut Value, namespace: &str) -> Result<()> {
        let Some(description) = tool.get("description").and_then(Value::as_str) else {
            return Ok(());
        };
        let Some((_, suffix)) = description.rsplit_once(MARKER.as_str()) else {
            return Ok(());
        };
        let (token, slot) = suffix
            .split_once(']')
            .and_then(|(receipt, _)| receipt.split_once('/'))
            .and_then(|(token, slot)| slot.parse::<usize>().ok().map(|slot| (token, slot)))
            .ok_or_else(|| anyhow::anyhow!("Invalid managed tool schema reference"))?;
        let generation = self
            .0
            .lock()
            .expect("tool schema receipts poisoned")
            .get(token)
            .and_then(|receipt| receipt.generation.upgrade())
            .ok_or_else(|| anyhow::anyhow!("Managed tool schema reference is unavailable"))?;
        let entry = generation
            .entries
            .get(slot)
            .ok_or_else(|| anyhow::anyhow!("Invalid managed tool schema slot"))?;
        let (projected, projected_namespace) = match &entry.spec {
            ToolSpec::Function(function) => (function, "functions"),
            ToolSpec::Namespace(ns) => {
                let Some(ResponsesApiNamespaceTool::Function(function)) = ns.tools.first() else {
                    anyhow::bail!("Invalid managed tool namespace schema");
                };
                (function, ns.name.as_str())
            }
            _ => anyhow::bail!("Invalid managed tool declaration"),
        };
        let augmented = codex_tools::augment_tool_spec_for_code_mode(entry.spec.clone(), None);
        let augmented_description = match &augmented {
            ToolSpec::Function(function) => function.description.as_str(),
            ToolSpec::Namespace(ns) => match ns.tools.first() {
                Some(ResponsesApiNamespaceTool::Function(function)) => {
                    function.description.as_str()
                }
                _ => unreachable!("validated namespace function"),
            },
            _ => unreachable!("validated function"),
        };
        ensure!(
            namespace == projected_namespace
                && tool.get("name").and_then(Value::as_str) == Some(projected.name.as_str())
                && (description == projected.description || description == augmented_description)
                && tool.get("parameters") == Some(&serde_json::to_value(&projected.parameters)?),
            "Managed tool schema declaration does not match its native owner"
        );
        let originals = functions(&generation.specs);
        let (_, original) = originals
            .get(slot)
            .ok_or_else(|| anyhow::anyhow!("Original managed tool declaration is unavailable"))?;
        let restored_description =
            description.replacen(&projected.description, &original.description, 1);
        tool["description"] = Value::String(restored_description);
        tool["parameters"] = original.input_schema.clone();
        Ok(())
    }
}

impl PythonTools {
    /// Called only after the existing provider carrier admits the native request.
    pub(crate) fn restore_schema_request(&self, request: &mut Value) -> Result<()> {
        self.schema_receipts.restore(request)
    }

    /// Export plain historical schemas through the existing portable checkpoint.
    pub(crate) fn restore_schema_history(
        &self,
        history: &mut [codex_history::RolloutItem],
    ) -> Result<()> {
        for item in history {
            if let codex_history::RolloutItem::ResponseItem(envelope) = item
                && let codex_protocol::models::ResponseItem::ToolSearchOutput { tools, .. } =
                    &mut envelope.item
            {
                self.schema_receipts.declarations(tools, "functions")?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_protocol::dynamic_tools::{DynamicToolFunctionSpec, DynamicToolSpec};
    use codex_tools::{ToolExposure, ToolName, dynamic_tool_to_responses_api_tool};
    use serde_json::json;

    fn admitted(receipts: &Receipts, minimum: usize) -> Arc<Generation> {
        admitted_named(receipts, minimum, "lookup", "Look up a record.")
    }

    fn admitted_named(
        receipts: &Receipts,
        minimum: usize,
        name: &str,
        description: &str,
    ) -> Arc<Generation> {
        let original = DynamicToolFunctionSpec {
            name: name.to_owned(),
            description: description.to_owned(),
            input_schema: json!({
                "type":"object","properties":{"key":{"type":"string","minLength":minimum}},
                "required":["key"],"additionalProperties":false
            }),
            defer_loading: false,
        };
        let mut projected = dynamic_tool_to_responses_api_tool(&original).unwrap();
        let token = ThreadId::new().to_string();
        projected.description = Receipts::description(&original.description, &token, 0);
        let generation = Arc::new(Generation {
            id: 0,
            schema_token: Some(token),
            entries: vec![super::super::Entry {
                name: ToolName::new(None, original.name.clone()),
                spec: ToolSpec::Function(projected),
                exposure: ToolExposure::Direct,
            }],
            specs: vec![DynamicToolSpec::Function(original)],
            defaults: vec![0],
        });
        receipts.register(&generation);
        generation
    }

    fn request(generation: &Generation) -> Value {
        json!({"tools":[&generation.entries[0].spec],"input":[]})
    }

    #[test]
    fn only_the_owning_live_generation_restores_exact_captured_constraints() {
        let left = Receipts::default();
        let right = Receipts::default();
        let first = admitted(&left, 3);
        let second = admitted(&right, 8);
        let wire = request(&first);
        assert!(left.restore(&mut request(&second)).is_err());
        let mut invalid = wire.clone();
        invalid["tools"][0]["name"] = json!("other");
        let unchanged = invalid.clone();
        assert!(left.restore(&mut invalid).is_err());
        assert_eq!(invalid, unchanged);
        let mut actual = wire.clone();
        left.restore(&mut actual).unwrap();
        assert_eq!(actual["tools"][0]["description"], "Look up a record.");
        assert_eq!(
            actual["tools"][0]["parameters"]["properties"]["key"]["minLength"],
            3
        );
        drop(first);
        let mut expired = wire.clone();
        assert!(left.restore(&mut expired).is_err());
        assert_eq!(expired, wire);
    }

    #[test]
    fn same_projected_schema_still_changes_lite_reference_and_uses_its_leased_owner() {
        let receipts = Receipts::default();
        let first = admitted(&receipts, 3);
        let second = admitted(&receipts, 8);
        let mut wire = json!({
            "tools": [],
            "input": [
                {"type":"message","role":"user","content":[]},
                {"type":"additional_tools","tools":[&first.entries[0].spec]},
                {"type":"additional_tools","tools":[&second.entries[0].spec]}
            ]
        });
        assert_ne!(
            wire["input"][1]["tools"][0]["description"],
            wire["input"][2]["tools"][0]["description"]
        );
        receipts.restore(&mut wire).unwrap();
        assert_eq!(wire["tools"], json!([]));
        assert_eq!(
            wire["input"][1]["tools"][0]["parameters"]["properties"]["key"]["minLength"],
            3
        );
        assert_eq!(
            wire["input"][2]["tools"][0]["parameters"]["properties"]["key"]["minLength"],
            8
        );
    }

    #[test]
    fn code_mode_strips_matching_nested_markers_and_keeps_native_representation() {
        let owner = Receipts::default();
        let other = Receipts::default();
        let live = admitted(&owner, 3);
        let ToolSpec::Function(projected) = &live.entries[0].spec else {
            panic!("expected a function");
        };
        let rendered = format!(
            "Run JavaScript code.\n\n### `lookup`\n{}\n\nexec tool declaration:\n```ts\nlookup(args: {{key: string}}): Promise<unknown>;\n```",
            projected.description
        );
        let wire = json!({"tools":[{"type":"custom","name":"exec","description":rendered,"format":{"type":"text"}}]});
        let mut invalid = wire.clone();
        assert!(other.restore(&mut invalid).is_err());
        assert_eq!(invalid, wire);
        let mut actual = wire.clone();
        owner.restore(&mut actual).unwrap();
        assert_eq!(
            actual["tools"][0]["description"],
            "Run JavaScript code.\n\n### `lookup`\nLook up a record.\n\nexec tool declaration:\n```ts\nlookup(args: {key: string}): Promise<unknown>;\n```"
        );
        drop(live);
        assert!(owner.restore(&mut invalid).is_err());
        assert_eq!(invalid, wire);
    }

    #[test]
    fn direct_function_keeps_native_code_mode_declaration() {
        let owner = Receipts::default();
        let live = admitted(&owner, 3);
        let spec = codex_tools::augment_tool_spec_for_code_mode(live.entries[0].spec.clone(), None);
        let ToolSpec::Function(function) = spec else {
            panic!("function");
        };
        let mut wire = json!({"tools":[{"type":"function", "name":function.name,
            "description":function.description, "parameters": function.parameters}]});
        owner.restore(&mut wire).unwrap();
        assert_eq!(
            wire["tools"][0]["parameters"]["properties"]["key"]["minLength"],
            3
        );
        let description = wire["tools"][0]["description"].as_str().unwrap();
        assert!(description.contains("declare const tools:"));
        assert!(!description.contains("[agents-schema:"));
    }

    #[test]
    fn code_mode_matches_normalized_headings_and_trimmed_descriptions() {
        for description in ["\n  Look up a record.\n ", "   \n ", ""] {
            let owner = Receipts::default();
            let live = admitted_named(&owner, 3, "record-lookup", description);
            let ToolSpec::Function(projected) = &live.entries[0].spec else {
                panic!("expected a function");
            };
            let rendered = format!(
                "Run JavaScript code.\n\n### `record_lookup` (`record-lookup`)\n{}\n\nexec tool declaration:\n```ts\nrecord_lookup(args: {{key: string}}): Promise<unknown>;\n```",
                projected.description.trim()
            );
            let mut wire = json!({"tools":[{"type":"custom","name":"exec","description":rendered,"format":{"type":"text"}}]});
            owner.restore(&mut wire).unwrap();
            let actual = wire["tools"][0]["description"].as_str().unwrap();
            assert!(actual.contains("### `record_lookup` (`record-lookup`)"));
            assert!(actual.contains("record_lookup(args: {key: string})"));
            assert!(!actual.contains("[agents-schema:"));
        }
    }
}
