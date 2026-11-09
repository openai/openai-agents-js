//! Restore only the captured managed schemas admitted by this tool owner.
//!
//! Generation.specs owns immutable schema metadata, without callback authority.
//! Live declarations use weak receipts. Published search schemas also keep their
//! metadata for canonical history, which can outlive an executor or step.
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, Weak};

use anyhow::{Result, ensure};
use codex_extension_api::{PreparedRequestData, PreparedToolPresentation};
use codex_protocol::ThreadId;
use codex_tools::{ResponsesApiNamespaceTool, ToolSpec};
use serde_json::Value;

use super::{Entry, Generation, PythonTools, functions};
use codex_protocol::dynamic_tools::{DynamicToolNamespaceTool, DynamicToolSpec};

static MARKER: LazyLock<String> =
    LazyLock::new(|| format!("\n[agents-schema:{}/", ThreadId::new()));

struct Receipt {
    generation: Weak<Generation>,
    historical: Option<Arc<Generation>>,
}

struct ManagedSchema {
    generation: Arc<Generation>,
    slot: usize,
}

/// One clean callback view plus its private original presentation owners.
/// This metadata never supplies executors or changes the live tool generation.
pub(super) struct PreparedSchemas {
    pub(super) data: PreparedRequestData,
    original: Vec<PreparedToolPresentation>,
    managed: Vec<Option<ManagedSchema>>,
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

    pub(super) fn prepared(&self, mut data: PreparedRequestData) -> Result<PreparedSchemas> {
        let original = data.tools.clone();
        let mut managed = Vec::with_capacity(data.tools.len());
        for tool in &mut data.tools {
            let owner = self.resolve(
                &serde_json::json!({
                    "name":tool.name, "description":tool.description, "parameters":tool.parameters,
                }),
                tool.namespace.as_deref().unwrap_or("functions"),
            )?;
            if let Some(owner) = &owner {
                let originals = functions(&owner.generation.specs);
                tool.description = originals[owner.slot].1.description.clone();
                // Core's projection omits raw JSON Schema keywords.
                tool.parameters = originals[owner.slot].1.input_schema.clone();
            }
            managed.push(owner);
        }
        Ok(PreparedSchemas {
            data,
            original,
            managed,
        })
    }

    pub(super) fn reconcile_prepared(
        &self,
        captured: &PreparedSchemas,
        data: &mut PreparedRequestData,
    ) -> Result<Option<Arc<Generation>>> {
        ensure!(
            data.tools.len() == captured.data.tools.len(),
            "Prepared tool count changed"
        );
        let token = ThreadId::new().to_string();
        let mut entries = Vec::new();
        let mut specs = Vec::new();
        for (index, tool) in data.tools.iter_mut().enumerate() {
            // Only this runtime's actual private syntax is reserved. Ordinary
            // documentation that mentions agents-schema is still plain text.
            ensure!(
                !tool.description.contains(MARKER.as_str()),
                "Prepared description contains a reserved schema reference"
            );
            let Some(owner) = &captured.managed[index] else {
                continue;
            };
            let public = &captured.data.tools[index];
            let description_changed = tool.description != public.description;
            let parameters_changed = tool.parameters != public.parameters;
            if !parameters_changed {
                // Return the unchanged declaration in Core's original form.
                tool.parameters = captured.original[index].parameters.clone();
            }
            if !description_changed && !parameters_changed {
                tool.description = captured.original[index].description.clone();
                continue;
            }
            let original_entry = &owner.generation.entries[owner.slot];
            let originals = functions(&owner.generation.specs);
            let (namespace, original) = originals[owner.slot];
            let mut raw = original.clone();
            raw.description = tool.description.clone();
            if parameters_changed {
                raw.input_schema = tool.parameters.clone();
            }
            let mut projected = original_entry.spec.clone();
            let function = match &mut projected {
                ToolSpec::Function(function) => function,
                ToolSpec::Namespace(namespace) => match namespace.tools.first_mut() {
                    Some(ResponsesApiNamespaceTool::Function(function)) => function,
                    _ => anyhow::bail!("Invalid managed prepared namespace"),
                },
                _ => anyhow::bail!("Invalid managed prepared function"),
            };
            // Core validates the native projection. This captured sampling
            // receipt restores the exact raw schema only after tool identity
            // and projected declaration checks succeed at serialization.
            if parameters_changed {
                function.parameters = serde_json::from_value(tool.parameters.clone())
                    .map_err(|_| anyhow::anyhow!("Invalid prepared schema projection"))?;
                tool.parameters = serde_json::to_value(&function.parameters)
                    .map_err(|_| anyhow::anyhow!("Invalid prepared schema projection"))?;
            }
            function.description = Self::description(&tool.description, &token, entries.len());
            tool.description = function.description.clone();
            entries.push(Entry {
                name: original_entry.name.clone(),
                spec: projected,
                exposure: original_entry.exposure,
            });
            specs.push(match namespace {
                None => DynamicToolSpec::Function(raw),
                Some(namespace) => {
                    let mut namespace = namespace.clone();
                    namespace.tools = vec![DynamicToolNamespaceTool::Function(raw)];
                    DynamicToolSpec::Namespace(namespace)
                }
            });
        }
        if entries.is_empty() {
            return Ok(None);
        }
        let generation = Arc::new(Generation {
            manual_slots: None,
            id: 0,
            schema_token: Some(token),
            entries,
            specs,
            defaults: Vec::new(),
            terminal_slots: Default::default(),
        });
        // Register only presentation metadata. No executable plan, current
        // generation, search-history retention, or application policy changes.
        self.register(&generation);
        Ok(Some(generation))
    }

    fn resolve(&self, tool: &Value, namespace: &str) -> Result<Option<ManagedSchema>> {
        let Some(description) = tool.get("description").and_then(Value::as_str) else {
            return Ok(None);
        };
        let Some((_, suffix)) = description.rsplit_once(MARKER.as_str()) else {
            return Ok(None);
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
        Ok(Some(ManagedSchema { generation, slot }))
    }

    fn function(&self, tool: &mut Value, namespace: &str) -> Result<()> {
        let Some(ManagedSchema { generation, slot }) = self.resolve(tool, namespace)? else {
            return Ok(());
        };
        let description = tool
            .get("description")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("Invalid managed tool description"))?;
        let projected = match &generation.entries[slot].spec {
            ToolSpec::Function(function) => function,
            ToolSpec::Namespace(namespace) => match namespace.tools.first() {
                Some(ResponsesApiNamespaceTool::Function(function)) => function,
                _ => unreachable!("resolved namespace function"),
            },
            _ => unreachable!("resolved function"),
        };
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
            manual_slots: None,
            id: 0,
            schema_token: Some(token),
            entries: vec![super::super::Entry {
                name: ToolName::new(None, original.name.clone()),
                spec: ToolSpec::Function(projected),
                exposure: ToolExposure::Direct,
            }],
            specs: vec![DynamicToolSpec::Function(original)],
            defaults: vec![0],
            terminal_slots: Default::default(),
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

#[cfg(test)]
mod prepared_tests {
    use super::*;
    use codex_protocol::dynamic_tools::DynamicToolFunctionSpec;
    use codex_tools::{ToolExposure, ToolName, dynamic_tool_to_responses_api_tool};
    use serde_json::json;

    fn fixture(receipts: &Receipts) -> (Arc<Generation>, PreparedRequestData) {
        let raw = DynamicToolFunctionSpec {
            name: "lookup".into(),
            description: "Original description.".into(),
            input_schema: json!({"type":"object","properties":{"key":{"type":"string","minLength":3}},"required":["key"],"additionalProperties":false}),
            defer_loading: false,
        };
        let token = ThreadId::new().to_string();
        let mut projected = dynamic_tool_to_responses_api_tool(&raw).unwrap();
        projected.description = Receipts::description(&raw.description, &token, 0);
        let data = PreparedRequestData {
            instructions: "original".into(),
            input: Vec::new(),
            tools: vec![PreparedToolPresentation {
                namespace: None,
                name: projected.name.clone(),
                kind: "function".into(),
                strict: projected.strict,
                defer_loading: projected.defer_loading,
                description: projected.description.clone(),
                parameters: serde_json::to_value(&projected.parameters).unwrap(),
            }],
        };
        let generation = Arc::new(Generation {
            manual_slots: None,
            id: 7,
            schema_token: Some(token),
            entries: vec![Entry {
                name: ToolName::plain("lookup"),
                spec: ToolSpec::Function(projected),
                exposure: ToolExposure::Direct,
            }],
            specs: vec![DynamicToolSpec::Function(raw)],
            defaults: vec![0],
            terminal_slots: Default::default(),
        });
        receipts.register(&generation);
        (generation, data)
    }
    fn wire(data: &PreparedRequestData) -> Value {
        json!({"tools":data.tools.iter().map(|tool|json!({"type":"function","name":tool.name,"description":tool.description,"parameters":serde_json::to_value(serde_json::from_value::<codex_tools::JsonSchema>(tool.parameters.clone()).unwrap()).unwrap()})).collect::<Vec<_>>()})
    }
    #[test]
    fn field_intent_retains_raw_schema_until_parameters_actually_change() {
        for (description_changed, parameters_changed) in
            [(false, false), (true, false), (false, true), (true, true)]
        {
            let receipts = Receipts::default();
            let (original, data) = fixture(&receipts);
            let view = receipts.prepared(data).unwrap();
            assert_eq!(view.data.tools[0].description, "Original description.");
            assert!(!view.data.tools[0].description.contains(MARKER.as_str()));
            assert_eq!(
                view.data.tools[0].parameters,
                functions(&original.specs)[0].1.input_schema
            );
            let mut edited = view.data.clone();
            if description_changed {
                edited.tools[0].description = "Edited description.".into();
            }
            if parameters_changed {
                edited.tools[0].parameters = json!({"type":"object","properties":{"key":{"type":"string","enum":["allowed","wider"]}},"required":["key"],"additionalProperties":false});
            }
            let returned_parameters = edited.tools[0].parameters.clone();
            let metadata = receipts.reconcile_prepared(&view, &mut edited).unwrap();
            if parameters_changed {
                let projected_parameters: codex_tools::JsonSchema =
                    serde_json::from_value(returned_parameters.clone()).unwrap();
                assert_eq!(
                    edited.tools[0].parameters,
                    serde_json::to_value(projected_parameters).unwrap()
                );
            } else {
                assert_eq!(edited.tools[0].parameters, view.original[0].parameters);
            }
            assert_eq!(
                metadata.is_some(),
                description_changed || parameters_changed
            );
            let mut request = wire(&edited);
            receipts.restore(&mut request).unwrap();
            assert_eq!(
                request["tools"][0]["description"],
                if description_changed {
                    "Edited description."
                } else {
                    "Original description."
                }
            );
            if parameters_changed {
                assert_eq!(request["tools"][0]["parameters"], returned_parameters);
            } else {
                assert_eq!(
                    request["tools"][0]["parameters"],
                    functions(&original.specs)[0].1.input_schema
                );
            }
            if let Some(metadata) = metadata {
                let mut stale = wire(&edited);
                drop(metadata);
                assert!(receipts.restore(&mut stale).is_err());
            }
        }
    }
    #[test]
    fn partial_parameter_edits_keep_original_raw_keywords() {
        let receipts = Receipts::default();
        let (original, data) = fixture(&receipts);
        let view = receipts.prepared(data).unwrap();
        assert_eq!(
            view.data.tools[0].parameters["properties"]["key"]["minLength"],
            json!(3)
        );
        let mut edited = view.data.clone();
        edited.tools[0].parameters["properties"]["key"]["maxLength"] = json!(9);
        let expected = edited.tools[0].parameters.clone();
        let _metadata = receipts.reconcile_prepared(&view, &mut edited).unwrap();
        let mut request = wire(&edited);
        receipts.restore(&mut request).unwrap();
        assert_eq!(request["tools"][0]["parameters"], expected);
        assert_eq!(
            functions(&original.specs)[0].1.input_schema["properties"]["key"]["maxLength"],
            Value::Null
        );
    }
    #[test]
    fn managed_schema_projection_keeps_immutable_identity_for_core() {
        let receipts = Receipts::default();
        let (_original, data) = fixture(&receipts);
        let view = receipts.prepared(data).unwrap();
        let mut edited = view.data.clone();
        edited.tools[0].parameters["properties"]["key"]["unknown_null_key"] = Value::Null;
        edited.tools[0].name = "renamed".into();
        edited.tools[0].namespace = Some("changed_namespace".into());
        edited.tools[0].kind = "changed_kind".into();
        edited.tools[0].strict = !edited.tools[0].strict;
        edited.tools[0].defer_loading = Some(true);
        let submitted = edited.tools[0].clone();
        let _metadata = receipts.reconcile_prepared(&view, &mut edited).unwrap();
        assert_ne!(edited.tools[0].parameters, submitted.parameters);
        assert!(
            edited.tools[0].parameters["properties"]["key"]
                .get("unknown_null_key")
                .is_none()
        );
        assert_eq!(edited.tools[0].name, submitted.name);
        assert_eq!(edited.tools[0].namespace, submitted.namespace);
        assert_eq!(edited.tools[0].kind, submitted.kind);
        assert_eq!(edited.tools[0].strict, submitted.strict);
        assert_eq!(edited.tools[0].defer_loading, submitted.defer_loading);
    }
    #[test]
    fn prepared_receipts_remain_strict_and_only_actual_private_syntax_is_reserved() {
        let receipts = Receipts::default();
        let (_original, data) = fixture(&receipts);
        let private = data.tools[0].description.clone();
        let view = receipts.prepared(data).unwrap();
        let mut forged = view.data.clone();
        forged.tools[0].description = private;
        assert!(receipts.reconcile_prepared(&view, &mut forged).is_err());
        let mut edited = view.data.clone();
        edited.tools[0].description = "Docs mention [agents-schema:example] syntax.".into();
        let _metadata = receipts.reconcile_prepared(&view, &mut edited).unwrap();
        let mut request = wire(&edited);
        request["tools"][0]["parameters"]["properties"]["key"]["type"] = json!("number");
        let before = request.clone();
        assert!(receipts.restore(&mut request).is_err());
        assert_eq!(request, before);
    }
}
