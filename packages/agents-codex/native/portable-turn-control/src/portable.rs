use super::ResponseContinuation;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};

pub(crate) const MAX_FRAME: usize = 8 * 1024 * 1024;
const MAX_CALLS: usize = 256;
const MAX_ROUNDS: u32 = 100;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Command {
    Trace { request: super::portable_tracing::TraceCommand },
    History {
        snapshot: Option<String>,
        expected_revision: Option<u32>,
        operation: HistoryOperation,
    },
    Start {
        model: String,
        instructions: String,
        input: Option<UserInput>,
        tools: Vec<Declaration>,
        max_turns: u32,
        snapshot: Option<Snapshot>,
        profiles: Option<Profiles>,
        output_contract: Option<String>,
    },
    Model {
        request_id: u32,
        output: Vec<Value>,
        #[serde(default)]
        provider_metadata: Vec<OutputMetadata>,
    },
    Checkpoint {
        request_id: u32,
        call_id: String,
        claim: bool,
        effective_arguments: Value,
    },
    Approval {
        request_id: u32,
        call_id: String,
        approved: bool,
    },
    Tool {
        request_id: u32,
        call_id: String,
        output: Value,
    },
    Cancel,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum HistoryOperation {
    Read { limit: Option<i64> },
    Append { items: Vec<Value> },
    Pop { count: Option<u32> },
    Clear,
}

enum RestorePurpose {
    Turn,
    History,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum UserInput {
    Text(String),
    Content(Vec<UserContent>),
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum UserContent {
    InputText {
        text: String,
    },
    InputImage {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        image_url: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    InputFile {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file_data: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file_url: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        filename: Option<String>,
    },
}

// References carry model content only. This owner never fetches media or opens paths.
fn https_reference(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("https://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    !authority.is_empty()
        && !value
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || c == '\\')
        && !authority.contains('@')
}

impl UserContent {
    fn valid(&self) -> bool {
        let nonempty = |value: &str| !value.trim().is_empty();
        match self {
            Self::InputText { .. } => true,
            Self::InputImage {
                image_url,
                file_id,
                detail,
            } => {
                detail.as_ref().is_none_or(|detail| {
                    matches!(detail.as_str(), "auto" | "low" | "high" | "original")
                }) && match (image_url, file_id) {
                    (Some(url), None) => {
                        https_reference(url)
                            || url.strip_prefix("data:image/").is_some_and(|data| {
                                data.split_once(";base64,").is_some_and(|(kind, body)| {
                                    !kind.is_empty() && !body.is_empty()
                                })
                            })
                    }
                    (None, Some(id)) => nonempty(id),
                    _ => false,
                }
            }
            Self::InputFile {
                file_id,
                file_data,
                file_url,
                ..
            } => match (file_id, file_data, file_url) {
                (Some(id), None, None) => nonempty(id),
                (None, Some(data), None) => nonempty(data),
                (None, None, Some(url)) => https_reference(url),
                _ => false,
            },
        }
    }
}

impl UserInput {
    fn content(self) -> Result<Vec<Value>, &'static str> {
        match self {
            Self::Text(text) => Ok(vec![json!({"type":"input_text","text":text})]),
            Self::Content(parts) => {
                if parts.is_empty() || !parts.iter().all(UserContent::valid) {
                    return Err("Invalid portable user content");
                }
                parts
                    .into_iter()
                    .map(|part| {
                        serde_json::to_value(part).map_err(|_| "Invalid portable user content")
                    })
                    .collect()
            }
        }
    }
}

fn valid_tool_output(value: &Value) -> bool {
    value.is_string()
        || value.as_array().is_some_and(|parts| {
            !parts.is_empty()
                && parts.iter().all(|part| {
                    serde_json::from_value::<UserContent>(part.clone())
                        .is_ok_and(|part| part.valid())
                })
        })
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    version: u32,
    revision: u32,
    history: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    provider_metadata: Vec<HistoryMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    active_profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    approval: Option<ApprovalCheckpoint>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ProviderMetadata {
    provider: String,
    model: String,
    value: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OutputMetadata {
    output_index: usize,
    metadata: ProviderMetadata,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct HistoryMetadata {
    history_index: usize,
    item: Value,
    metadata: ProviderMetadata,
}

#[derive(Serialize)]
struct InputMetadata {
    input_index: usize,
    item: Value,
    metadata: ProviderMetadata,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Profiles {
    root: String,
    declarations: BTreeMap<String, Profile>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Profile {
    model: String,
    instructions: String,
    tools: Vec<Declaration>,
    handoffs: BTreeMap<String, String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ApprovalCheckpoint {
    request_id: u32,
    call_id: String,
    declaration: Declaration,
    claimed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    effective_arguments: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    output_contract: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    remaining: Vec<(String, Declaration)>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    results: Vec<(String, Value)>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    finish_calls: Vec<(String, Declaration)>,
}

#[derive(Clone, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct Declaration {
    name: String,
    description: String,
    parameters: Value,
    strict: bool,
    #[serde(default)]
    requires_approval: bool,
    #[serde(default)]
    finish_turn: bool,
}

#[derive(Clone, Serialize)]
struct Call {
    call_id: String,
    name: String,
    arguments: String,
    #[serde(skip)]
    requires_approval: bool,
    #[serde(skip)]
    finish_turn: bool,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Effect {
    Trace { result: Value },
    History {
        previous_revision: u32,
        revision: u32,
        pending_approval: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        items: Option<Vec<Value>>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        popped: Vec<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        checkpoint: Option<String>,
    },
    Model {
        request_id: u32,
        body: Value,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        provider_metadata: Vec<InputMetadata>,
        profile: Option<String>,
    },
    Tools {
        request_id: u32,
        calls: Vec<Call>,
        profile: Option<String>,
    },
    Approval {
        request_id: u32,
        revision: u32,
        profile: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        effective_arguments: Option<Value>,
        call: Call,
    },
    Checkpoint {
        snapshot: Snapshot,
    },
    Done {
        text: String,
        profile: Option<String>,
        snapshot: Snapshot,
        tool_output: bool,
    },
}

enum Phase {
    New,
    Model,
    Tools(Batch),
    Approval(Batch),
    Finished,
}

struct Batch {
    issued: HashSet<String>,
    effective_arguments: Option<Value>,
    remaining: Vec<Call>,
    results: Vec<(String, Option<Value>)>,
    finish_calls: Vec<String>,
}

impl Batch {
    fn new(calls: &[Call]) -> Self {
        Self {
            issued: HashSet::new(),
            effective_arguments: None,
            remaining: Vec::new(),
            finish_calls: calls
                .iter()
                .filter(|call| call.finish_turn)
                .map(|call| call.call_id.clone())
                .collect(),
            results: calls
                .iter()
                .map(|call| (call.call_id.clone(), None))
                .collect(),
        }
    }

    fn record(&mut self, id: &str, value: Value) -> Result<(), &'static str> {
        let slot = self
            .results
            .iter_mut()
            .find(|(call_id, _)| call_id == id)
            .map(|(_, slot)| slot)
            .ok_or("Unissued portable tool result")?;
        if slot.is_some() {
            return Err("Duplicate portable tool result");
        }
        *slot = Some(value);
        Ok(())
    }
}

pub(crate) struct PortableTurn {
    tracing: super::portable_tracing::TraceState,
    phase: Phase,
    request_id: u32,
    max_turns: u32,
    revision: u32,
    instructions: Option<Value>,
    model: String,
    tools: Vec<Declaration>,
    profiles: Option<Profiles>,
    profile: Option<String>,
    output_contract: Option<String>,
    history: Vec<Value>,
    provider_metadata: Vec<HistoryMetadata>,
    seen_calls: HashSet<String>,
}

impl Default for PortableTurn {
    fn default() -> Self {
        Self {
            tracing: super::portable_tracing::TraceState::default(),
            phase: Phase::New,
            request_id: 0,
            max_turns: 0,
            revision: 0,
            instructions: None,
            model: String::new(),
            tools: Vec::new(),
            profiles: None,
            profile: None,
            output_contract: None,
            history: Vec::new(),
            provider_metadata: Vec::new(),
            seen_calls: HashSet::new(),
        }
    }
}

impl PortableTurn {
    pub(crate) fn apply(&mut self, command: &[u8]) -> Vec<u8> {
        let reply = serde_json::from_slice(command)
            .map_err(|_| "Invalid portable turn command")
            .and_then(|command| self.transition(command));
        let reply = match reply {
            Ok(effect) => json!({"effect": effect}),
            Err(error) => {
                self.phase = Phase::Finished;
                json!({"error":error})
            }
        };
        let bytes = serde_json::to_vec(&reply).expect("portable turn response is JSON");
        if bytes.len() > MAX_FRAME {
            self.phase = Phase::Finished;
            return b"{\"error\":\"Portable turn response exceeds capacity\"}".to_vec();
        }
        bytes
    }

    fn transition(&mut self, command: Command) -> Result<Option<Effect>, &'static str> {
        match command {
            Command::Trace { request } => self.tracing.apply(request).map(|result| Some(Effect::Trace { result })),
            Command::History {
                snapshot,
                expected_revision,
                operation,
            } if matches!(self.phase, Phase::New) => {
                // History operations terminate without model, tool or approval effects.
                self.phase = Phase::Finished;
                self.history_operation(snapshot, expected_revision, operation)
                    .map(Some)
            }
            Command::Start {
                model,
                instructions,
                input,
                tools,
                max_turns,
                snapshot,
                profiles,
                output_contract,
            } if matches!(self.phase, Phase::New) => {
                if model.trim().is_empty() || !(1..=MAX_ROUNDS).contains(&max_turns) {
                    return Err("Invalid portable turn configuration");
                }
                Self::validate_tools(&tools)?;
                if let Some(graph) = &profiles {
                    if !graph.declarations.contains_key(&graph.root)
                        || graph.declarations.len() > MAX_CALLS
                    {
                        return Err("Invalid portable Agent graph");
                    }
                    for (id, profile) in &graph.declarations {
                        Self::validate_tools(&profile.tools)?;
                        if id.trim().is_empty()
                            || profile.model.trim().is_empty()
                            || profile.tools.len() + profile.handoffs.len() > MAX_CALLS
                            || profile.handoffs.iter().any(|(name, target)| {
                                name.trim().is_empty()
                                    || !graph.declarations.contains_key(target)
                                    || profile.tools.iter().any(|tool| &tool.name == name)
                            })
                        {
                            return Err("Invalid portable Agent profile");
                        }
                    }
                    self.profile = Some(graph.root.clone());
                }
                if output_contract.as_ref().is_some_and(|value| {
                    value.len() != 64
                        || !value
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                }) {
                    return Err("Invalid portable output contract");
                }
                self.output_contract = output_contract;
                self.profiles = profiles;
                self.model = model;
                self.tools = tools;
                self.max_turns = max_turns;
                let approval = if let Some(snapshot) = snapshot {
                    self.restore(snapshot)?
                } else {
                    None
                };
                if !instructions.is_empty() {
                    self.instructions = Some(
                        json!({"type":"message","role":"developer","content":[{"type":"input_text","text":instructions}]}),
                    );
                }
                if let Some(approval) = approval {
                    if input.is_some() {
                        return Err(
                            "Portable session requires a decision for its pending approval",
                        );
                    }
                    let batch = self.restore_approval(approval)?;
                    return self.advance_batch(batch).map(Some);
                }
                let content = input.ok_or("No portable approval is pending")?.content()?;
                self.history
                    .push(json!({"type":"message","role":"user","content":content}));
                self.next_request().map(Some)
            }
            Command::Model {
                request_id,
                output,
                provider_metadata,
            } if request_id == self.request_id && matches!(self.phase, Phase::Model) => {
                self.admit_response(output, provider_metadata).map(Some)
            }
            Command::Checkpoint {
                request_id,
                call_id,
                claim,
                effective_arguments,
            } if request_id == self.request_id => {
                let Phase::Approval(batch) = &self.phase else {
                    return Err("No portable approval is pending");
                };
                let call = batch
                    .remaining
                    .first()
                    .ok_or("No portable approval is pending")?;
                if call.call_id != call_id {
                    return Err("Portable approval belongs to a different tool call");
                }
                if !effective_arguments.is_object()
                    || batch
                        .effective_arguments
                        .as_ref()
                        .is_some_and(|stored| stored != &effective_arguments)
                {
                    return Err("Portable approval requires its validated arguments");
                }
                let declaration = self.approval_declaration(&call.name)?.clone();
                let remaining = batch
                    .remaining
                    .iter()
                    .skip(1)
                    .map(|call| {
                        Ok((
                            call.call_id.clone(),
                            self.approval_declaration(&call.name)?.clone(),
                        ))
                    })
                    .collect::<Result<_, &'static str>>()?;
                let results = batch
                    .results
                    .iter()
                    .filter_map(|(id, result)| {
                        result.as_ref().map(|result| (id.clone(), result.clone()))
                    })
                    .collect();
                let finish_calls = batch
                    .finish_calls
                    .iter()
                    .map(|id| {
                        let name = self
                            .history
                            .iter()
                            .find(|item| item["type"] == "function_call" && item["call_id"] == *id)
                            .and_then(|item| item["name"].as_str())
                            .ok_or("Missing portable finishing call")?;
                        Ok((id.clone(), self.finishing_declaration(name)?.clone()))
                    })
                    .collect::<Result<_, &'static str>>()?;
                let mut snapshot = self.snapshot(Some(ApprovalCheckpoint {
                    request_id,
                    call_id,
                    declaration,
                    claimed: claim,
                    effective_arguments: Some(effective_arguments),
                    output_contract: self.output_contract.clone(),
                    remaining,
                    results,
                    finish_calls,
                }))?;
                snapshot.history = self.history.clone();
                self.revision = snapshot.revision;
                Ok(Some(Effect::Checkpoint { snapshot }))
            }
            Command::Approval {
                request_id,
                call_id,
                approved,
            } if request_id == self.request_id => {
                let phase = std::mem::replace(&mut self.phase, Phase::Finished);
                let Phase::Approval(mut batch) = phase else {
                    return Err("No portable approval is pending");
                };
                if batch
                    .remaining
                    .first()
                    .is_none_or(|call| call.call_id != call_id)
                {
                    return Err("Portable approval belongs to a different tool call");
                }
                let call = batch.remaining.remove(0);
                batch.effective_arguments = None;
                if approved {
                    Ok(Some(self.issue_batch(batch, vec![call])))
                } else {
                    batch.record(&call_id, json!("Tool call denied."))?;
                    self.advance_batch(batch).map(Some)
                }
            }
            Command::Tool {
                request_id,
                call_id,
                output,
            } if request_id == self.request_id => {
                let Phase::Tools(batch) = &mut self.phase else {
                    return Err("No portable tool results are pending");
                };
                if !batch.issued.contains(&call_id) {
                    return Err("Unissued or duplicate portable tool result");
                }
                if !valid_tool_output(&output) {
                    return Err("Invalid portable tool content");
                }
                if batch.finish_calls.contains(&call_id) && !output.is_string() {
                    return Err("Portable finishing tools require text output");
                }
                batch.issued.remove(&call_id);
                batch.record(&call_id, output)?;
                if !batch.issued.is_empty() {
                    return Ok(None);
                }
                let Phase::Tools(batch) = std::mem::replace(&mut self.phase, Phase::Finished)
                else {
                    unreachable!("completed portable tool batch")
                };
                self.advance_batch(batch).map(Some)
            }
            Command::Cancel => {
                self.phase = Phase::Finished;
                Ok(None)
            }
            _ => Err("Unexpected or stale portable turn command"),
        }
    }

    fn validate_tools(tools: &[Declaration]) -> Result<(), &'static str> {
        let mut names = HashSet::new();
        if tools.len() > MAX_CALLS
            || tools.iter().any(|tool| {
                tool.name.is_empty() || !tool.parameters.is_object() || !names.insert(&tool.name)
            })
        {
            return Err("Invalid or duplicate portable function declaration");
        }
        Ok(())
    }

    fn current_profile(&self) -> Option<&Profile> {
        self.profiles
            .as_ref()?
            .declarations
            .get(self.profile.as_ref()?)
    }

    fn approval_declaration(&self, name: &str) -> Result<&Declaration, &'static str> {
        self.current_profile()
            .map_or(self.tools.as_slice(), |profile| &profile.tools)
            .iter()
            .find(|tool| tool.name == name && tool.requires_approval)
            .ok_or("Portable approval requires its original tool declaration")
    }

    fn finishing_declaration(&self, name: &str) -> Result<&Declaration, &'static str> {
        self.current_profile()
            .map_or(self.tools.as_slice(), |profile| &profile.tools)
            .iter()
            .find(|tool| tool.name == name && tool.finish_turn)
            .ok_or("Portable finishing call requires its original tool declaration")
    }

    fn snapshot(&self, approval: Option<ApprovalCheckpoint>) -> Result<Snapshot, &'static str> {
        Ok(Snapshot {
            version: 1,
            revision: self
                .revision
                .checked_add(1)
                .ok_or("Portable session revision exhausted")?,
            history: Vec::new(),
            provider_metadata: self.provider_metadata.clone(),
            active_profile: self.profile.clone(),
            approval,
        })
    }

    fn issue_batch(&mut self, mut batch: Batch, calls: Vec<Call>) -> Effect {
        batch
            .issued
            .extend(calls.iter().map(|call| call.call_id.clone()));
        self.phase = Phase::Tools(batch);
        Effect::Tools {
            request_id: self.request_id,
            calls,
            profile: self.profile.clone(),
        }
    }

    fn advance_batch(&mut self, batch: Batch) -> Result<Effect, &'static str> {
        if let Some(call) = batch.remaining.first().cloned() {
            let effective_arguments = batch.effective_arguments.clone();
            self.phase = Phase::Approval(batch);
            return Ok(Effect::Approval {
                request_id: self.request_id,
                revision: self.revision,
                effective_arguments,
                call,
                profile: self.profile.clone(),
            });
        }
        let text = batch.finish_calls.iter().find_map(|id| {
            batch
                .results
                .iter()
                .find(|(call_id, _)| call_id == id)
                .and_then(|(_, result)| result.as_ref())
        });
        let text = text
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or("Portable finishing tools require text output")
            })
            .transpose()?;
        for (id, result) in batch.results {
            let output = result.ok_or("Incomplete portable tool batch")?;
            self.history
                .push(json!({"type":"function_call_output","call_id":id,"output":output}));
        }
        if let Some(text) = text {
            self.phase = Phase::Finished;
            let mut snapshot = self.snapshot(None)?;
            snapshot.history = std::mem::take(&mut self.history);
            return Ok(Effect::Done {
                tool_output: true,
                text,
                profile: self.profile.clone(),
                snapshot,
            });
        }
        self.next_request()
    }

    fn restore_approval(&mut self, approval: ApprovalCheckpoint) -> Result<Batch, &'static str> {
        if approval.claimed {
            return Err("Portable approval was already claimed and its tool outcome is unknown");
        }
        if approval.output_contract != self.output_contract {
            return Err("Portable approval requires its original output contract");
        }
        if approval.request_id == 0
            || approval.request_id > self.max_turns
            || (approval.request_id == self.max_turns && approval.finish_calls.is_empty())
        {
            return Err("Portable approval exceeds the current request limit");
        }
        let effective_arguments = approval
            .effective_arguments
            .filter(Value::is_object)
            .ok_or("Portable approval has no validated arguments")?;
        let expected_call = approval.call_id.clone();
        let mut declarations = std::iter::once((approval.call_id, approval.declaration))
            .chain(approval.remaining)
            .collect::<BTreeMap<_, _>>();
        let mut results = approval.results.into_iter().collect::<BTreeMap<_, _>>();
        let mut batch = Batch::new(&[]);
        for item in &self.history {
            if item["type"] != "function_call" {
                continue;
            }
            let Some(id) = item["call_id"].as_str() else {
                continue;
            };
            if let Some(output) = results.remove(id) {
                if !valid_tool_output(&output) {
                    return Err("Invalid portable approved tool content");
                }
                batch.results.push((id.to_owned(), Some(output)));
            } else if let Some(declaration) = declarations.remove(id) {
                let name = item["name"]
                    .as_str()
                    .ok_or("Invalid portable approval name")?;
                if self.approval_declaration(name)? != &declaration {
                    return Err("Portable approval requires its original tool declaration");
                }
                let arguments = item["arguments"]
                    .as_str()
                    .filter(|arguments| {
                        serde_json::from_str::<Value>(arguments)
                            .is_ok_and(|value| value.is_object())
                    })
                    .ok_or("Invalid portable approval arguments")?;
                batch.remaining.push(Call {
                    call_id: id.to_owned(),
                    name: name.to_owned(),
                    arguments: arguments.to_owned(),
                    requires_approval: true,
                    finish_turn: declaration.finish_turn,
                });
                batch.results.push((id.to_owned(), None));
            }
        }
        if !declarations.is_empty()
            || !results.is_empty()
            || batch
                .remaining
                .first()
                .is_none_or(|call| call.call_id != expected_call)
        {
            return Err("Portable session has no matching approval call");
        }
        batch.effective_arguments = Some(effective_arguments);
        let mut finishing_ids = HashSet::new();
        for (id, declaration) in approval.finish_calls {
            if !finishing_ids.insert(id.clone())
                || !batch.results.iter().any(|(call_id, _)| call_id == &id)
            {
                return Err("Invalid portable finishing call occurrence");
            }
            let name = self
                .history
                .iter()
                .find(|item| item["type"] == "function_call" && item["call_id"] == id)
                .and_then(|item| item["name"].as_str())
                .ok_or("Missing portable finishing call")?;
            if self.finishing_declaration(name)? != &declaration {
                return Err("Portable finishing call requires its original tool declaration");
            }
        }
        for (id, _) in &batch.results {
            if finishing_ids.contains(id) {
                if batch
                    .results
                    .iter()
                    .find(|(call_id, _)| call_id == id)
                    .and_then(|(_, value)| value.as_ref())
                    .is_some_and(|value| !value.is_string())
                {
                    return Err("Portable finishing tools require text output");
                }
                batch.finish_calls.push(id.clone());
            }
        }
        if batch
            .remaining
            .iter()
            .any(|call| call.finish_turn && !finishing_ids.contains(&call.call_id))
        {
            return Err("Missing portable finishing call ownership");
        }
        self.request_id = approval.request_id;
        Ok(batch)
    }

    fn history_operation(
        &mut self,
        snapshot: Option<String>,
        expected_revision: Option<u32>,
        operation: HistoryOperation,
    ) -> Result<Effect, &'static str> {
        let snapshot = snapshot
            .map(|raw| {
                serde_json::from_str::<Option<Snapshot>>(&raw)
                    .map_err(|_| "Invalid portable history snapshot")
            })
            .transpose()?
            .flatten();
        let pending_approval = if let Some(snapshot) = snapshot {
            self.restore_snapshot(snapshot, RestorePurpose::History)?
                .is_some()
        } else {
            false
        };
        let previous_revision = self.revision;
        if expected_revision.is_some_and(|expected| expected != previous_revision) {
            return Err("Portable history revision changed");
        }
        if let HistoryOperation::Read { limit } = operation {
            let items = match limit {
                Some(limit) if limit <= 0 => Vec::new(),
                Some(limit) => {
                    self.history[self.history.len().saturating_sub(usize::try_from(limit).unwrap_or(usize::MAX))..].to_vec()
                }
                None => self.history.clone(),
            };
            return Ok(Effect::History {
                previous_revision,
                revision: previous_revision,
                pending_approval,
                items: Some(items),
                popped: Vec::new(),
                checkpoint: None,
            });
        }
        if pending_approval {
            return Err(
                "Portable history cannot change while approval or an unknown tool outcome is pending",
            );
        }
        let mut popped = Vec::new();
        let changed = match operation {
            HistoryOperation::Append { items } => {
                let changed = !items.is_empty();
                self.history.extend(items);
                changed
            }
            HistoryOperation::Pop { count } => {
                let count = (count.unwrap_or(1) as usize).min(self.history.len());
                popped = self.history.split_off(self.history.len() - count);
                self.provider_metadata
                    .retain(|entry| entry.history_index < self.history.len());
                count != 0
            }
            HistoryOperation::Clear => {
                let changed = !self.history.is_empty();
                self.history.clear();
                self.provider_metadata.clear();
                changed
            }
            HistoryOperation::Read { .. } => unreachable!("history read returned above"),
        };
        let checkpoint = if changed {
            let mut next = self.snapshot(None)?;
            next.history = self.history.clone();
            let encoded =
                serde_json::to_string(&next).map_err(|_| "Invalid portable history checkpoint")?;
            self.restore_snapshot(next, RestorePurpose::History)?;
            Some(encoded)
        } else {
            None
        };
        Ok(Effect::History {
            previous_revision,
            revision: self.revision,
            pending_approval: false,
            items: None,
            popped,
            checkpoint,
        })
    }

    fn restore(&mut self, snapshot: Snapshot) -> Result<Option<ApprovalCheckpoint>, &'static str> {
        self.restore_snapshot(snapshot, RestorePurpose::Turn)
    }

    fn restore_snapshot(
        &mut self,
        snapshot: Snapshot,
        purpose: RestorePurpose,
    ) -> Result<Option<ApprovalCheckpoint>, &'static str> {
        if snapshot.version != 1 || snapshot.revision == 0 {
            return Err("Unsupported portable session snapshot");
        }
        let mut pending = HashSet::new();
        let mut seen_calls = HashSet::new();
        for item in &snapshot.history {
            match item["type"].as_str() {
                Some("message") if item["role"] == "user" || item["role"] == "assistant" => {
                    let valid = item["content"].as_array().is_some_and(|parts| {
                        parts.iter().all(|part| {
                            if item["role"] == "user" && part["type"] != "input_text" {
                                serde_json::from_value::<UserContent>(part.clone())
                                    .is_ok_and(|part| part.valid())
                            } else {
                                let expected = if item["role"] == "user" {
                                    "input_text"
                                } else {
                                    "output_text"
                                };
                                part["type"] == expected && part["text"].is_string()
                            }
                        })
                    });
                    if !valid {
                        return Err("Invalid portable session message");
                    }
                }
                Some("reasoning") => {}
                Some("function_call") => {
                    let id = item["call_id"]
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .ok_or("Invalid portable session call identifier")?;
                    if !seen_calls.insert(id.to_owned()) || !pending.insert(id) {
                        return Err("Duplicate portable session call");
                    }
                }
                Some("function_call_output") => {
                    let id = item["call_id"]
                        .as_str()
                        .ok_or("Invalid portable session tool output")?;
                    if !pending.remove(id) || !valid_tool_output(&item["output"]) {
                        return Err("Unexpected portable session tool output");
                    }
                }
                _ => return Err("Unsupported portable session history"),
            }
        }
        match &snapshot.approval {
            None if pending.is_empty() => {}
            Some(approval) => {
                let expected = std::iter::once(approval.call_id.as_str())
                    .chain(approval.remaining.iter().map(|(id, _)| id.as_str()))
                    .chain(approval.results.iter().map(|(id, _)| id.as_str()))
                    .collect::<Vec<_>>();
                let unique: HashSet<_> = expected.iter().copied().collect();
                if expected.len() != unique.len() || pending != unique || unique.len() > MAX_CALLS {
                    return Err("Invalid portable approval batch");
                }
            }
            _ => return Err("Portable session has unresolved calls"),
        }
        if let Some(profile) = snapshot.active_profile {
            if matches!(purpose, RestorePurpose::Turn)
                && !self
                    .profiles
                    .as_ref()
                    .is_some_and(|graph| graph.declarations.contains_key(&profile))
            {
                return Err("Portable session requires its current Agent profile");
            }
            self.profile = Some(profile);
        }
        if snapshot.provider_metadata.len() > 4096 {
            return Err("Portable provider metadata exceeds capacity");
        }
        let mut metadata_indexes = HashSet::new();
        for entry in &snapshot.provider_metadata {
            if !metadata_indexes.insert(entry.history_index)
                || snapshot.history.get(entry.history_index) != Some(&entry.item)
                || !Self::valid_provider_metadata(&entry.metadata)
                || !(entry.item["type"] == "reasoning"
                    || entry.item["type"] == "function_call"
                    || (entry.item["type"] == "message" && entry.item["role"] == "assistant"))
            {
                return Err("Portable provider metadata requires its unchanged history occurrence");
            }
        }
        self.seen_calls = seen_calls;
        self.provider_metadata = snapshot.provider_metadata;
        self.revision = snapshot.revision;
        self.history = snapshot.history;
        Ok(snapshot.approval)
    }

    fn next_request(&mut self) -> Result<Effect, &'static str> {
        if self.request_id >= self.max_turns {
            return Err("Portable turn reached its model request limit");
        }
        self.request_id += 1;
        self.phase = Phase::Model;
        let profile = self.current_profile();
        let active_tools = profile.map_or(&self.tools, |active| &active.tools);
        let mut tools: Vec<_> = active_tools
            .iter()
            .map(|tool| {
                json!({
                    "type":"function","name":tool.name,"description":tool.description,
                    "parameters":tool.parameters,"strict":tool.strict,
                })
            })
            .collect();
        let active_instructions = profile.and_then(|active| {
            (!active.instructions.is_empty()).then(|| json!({"type":"message","role":"developer","content":[{"type":"input_text","text":active.instructions}]}))
        });
        if let Some(profile) = profile {
            tools.extend(profile.handoffs.keys().map(|name| {
                json!({"type":"function","name":name,"description":"Transfer to another Agent.",
                    "parameters":{"type":"object","properties":{},"additionalProperties":false},
                    "strict":true})
            }));
        }
        let instructions = if profile.is_some() {
            active_instructions.as_ref()
        } else {
            self.instructions.as_ref()
        };
        let metadata_offset = usize::from(instructions.is_some());
        let provider_metadata = self
            .provider_metadata
            .iter()
            .map(|entry| InputMetadata {
                input_index: metadata_offset + entry.history_index,
                item: entry.item.clone(),
                metadata: entry.metadata.clone(),
            })
            .collect();
        Ok(Effect::Model {
            provider_metadata,
            request_id: self.request_id,
            profile: self.profile.clone(),
            body: json!({
                "model": profile.map_or(self.model.as_str(), |active| active.model.as_str()),
                "input": instructions.into_iter().chain(&self.history).collect::<Vec<_>>(),
                "tools":tools, "parallel_tool_calls":true,
                "tool_choice":"auto", "store":false,
            }),
        })
    }

    fn valid_provider_metadata(metadata: &ProviderMetadata) -> bool {
        !metadata.provider.trim().is_empty()
            && !metadata.model.trim().is_empty()
            && metadata.value.is_object()
    }

    fn append_response(&mut self, output: Vec<Value>, metadata: Vec<OutputMetadata>) {
        let offset = self.history.len();
        self.provider_metadata
            .extend(metadata.into_iter().map(|entry| HistoryMetadata {
                history_index: offset + entry.output_index,
                item: output[entry.output_index].clone(),
                metadata: entry.metadata,
            }));
        self.history.extend(output);
    }

    fn admit_response(
        &mut self,
        output: Vec<Value>,
        provider_metadata: Vec<OutputMetadata>,
    ) -> Result<Effect, &'static str> {
        if self.provider_metadata.len() + provider_metadata.len() > 4096 {
            return Err("Portable provider metadata exceeds capacity");
        }
        let mut metadata_indexes = HashSet::new();
        for entry in &provider_metadata {
            if entry.output_index >= output.len()
                || !metadata_indexes.insert(entry.output_index)
                || !Self::valid_provider_metadata(&entry.metadata)
            {
                return Err("Portable provider metadata requires exact output occurrences");
            }
        }
        let mut calls = Vec::new();
        let mut transfer = None;
        let mut text = String::new();
        for item in &output {
            match item["type"].as_str() {
                Some("message") if item["role"] == "assistant" => {
                    let parts = item["content"]
                        .as_array()
                        .ok_or("Invalid assistant content")?;
                    for part in parts {
                        let chunk = match part["type"].as_str() {
                            Some("output_text") => part["text"].as_str(),
                            Some("refusal") => {
                                return Err("Provider refused portable model response");
                            }
                            _ => None,
                        }
                        .ok_or("Unsupported portable assistant content")?;
                        text.push_str(chunk);
                    }
                }
                Some("reasoning") => {}
                Some("function_call") => {
                    let id = item["call_id"]
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .ok_or("Missing function call identifier")?;
                    let name = item["name"].as_str().ok_or("Missing function name")?;
                    let arguments = item["arguments"]
                        .as_str()
                        .ok_or("Missing function arguments")?;
                    let profile = self.current_profile();
                    let target = profile
                        .and_then(|active| active.handoffs.get(name))
                        .cloned();
                    let active_tools = profile.map_or(&self.tools, |active| &active.tools);
                    let requires_approval = active_tools
                        .iter()
                        .any(|tool| tool.name == name && tool.requires_approval);
                    let finish_turn = active_tools
                        .iter()
                        .any(|tool| tool.name == name && tool.finish_turn);
                    if calls.len() >= MAX_CALLS
                        || !(item["namespace"].is_null() || item["namespace"] == "functions")
                        || !(item["caller"].is_null() || item["caller"] == json!({"type":"direct"}))
                        || !item["encrypted_function_args"].is_null()
                        || !(item["async"].is_null() || item["async"] == false)
                        || (target.is_none() && !active_tools.iter().any(|tool| tool.name == name))
                        || !self.seen_calls.insert(id.to_owned())
                        || item
                            .get("status")
                            .is_some_and(|status| !status.is_null() && status != "completed")
                    {
                        return Err(
                            "Unadvertised, duplicate or unsupported portable function call",
                        );
                    }
                    if let Some(target) = target {
                        if transfer.is_some()
                            || serde_json::from_str::<Value>(arguments).ok() != Some(json!({}))
                        {
                            return Err("Invalid or competing portable Agent handoff");
                        }
                        transfer = Some((id.to_owned(), target));
                        continue;
                    }
                    calls.push(Call {
                        call_id: id.to_owned(),
                        name: name.to_owned(),
                        arguments: arguments.to_owned(),
                        requires_approval,
                        finish_turn,
                    });
                }
                _ => return Err("Unsupported portable model output"),
            }
        }
        let mut continuation = ResponseContinuation::default();
        continuation.require_follow_up(!calls.is_empty() || transfer.is_some());
        if !continuation.complete(None) {
            self.phase = Phase::Finished;
            self.append_response(output, provider_metadata);
            let mut snapshot = self.snapshot(None)?;
            snapshot.history = std::mem::take(&mut self.history);
            return Ok(Effect::Done {
                tool_output: false,
                text,
                profile: self.profile.clone(),
                snapshot,
            });
        }
        if self.request_id >= self.max_turns && !calls.iter().any(|call| call.finish_turn) {
            return Err("Portable turn reached its model request limit");
        }
        if let Some((call_id, target)) = transfer {
            if !calls.is_empty() {
                return Err("Portable handoffs require a dedicated response");
            }
            self.append_response(output, provider_metadata);
            self.history.push(
                json!({"type":"function_call_output","call_id":call_id,"output":"Transferred."}),
            );
            self.profile = Some(target);
            return self.next_request();
        }
        self.append_response(output, provider_metadata);
        let mut batch = Batch::new(&calls);
        let (remaining, automatic) = calls.into_iter().partition(|call| call.requires_approval);
        batch.remaining = remaining;
        if automatic.is_empty() {
            return self.advance_batch(batch);
        }
        Ok(self.issue_batch(batch, automatic))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(turn: &mut PortableTurn, value: Value) -> Value {
        serde_json::from_slice(&turn.apply(&serde_json::to_vec(&value).unwrap())).unwrap()
    }

    fn history_action(snapshot: Value, operation: Value, expected: Option<u32>) -> Value {
        command(
            &mut PortableTurn::default(),
            json!({"type":"history","snapshot":snapshot.to_string(),"operation":operation,"expected_revision":expected}),
        )
    }

    fn history_source() -> Value {
        let mut turn = PortableTurn::default();
        media_start(&mut turn, json!("original question"), Value::Null);
        let message = json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":"original answer"}]});
        command(&mut turn,json!({"type":"model","request_id":1,"output":[message],
            "provider_metadata":[{"output_index":0,"metadata":{"provider":"fixture","model":"fixture","value":{"counter":9007199254740993_u64}}}]}))["effect"]["snapshot"].clone()
    }

    #[test]
    fn history_read_is_passive_and_preserves_normal_profile_admission() {
        let mut snapshot = history_source();
        snapshot["active_profile"] = json!("stored-profile");
        let mut turn = PortableTurn::default();
        let read = command(
            &mut turn,
            json!({"type":"history","snapshot":snapshot.to_string(),"operation":{"type":"read","limit":1}}),
        );
        assert_eq!(read["effect"]["type"], "history");
        assert_eq!(read["effect"]["revision"], snapshot["revision"]);
        assert_eq!(read["effect"]["items"].as_array().unwrap().len(), 1);
        assert!(read["effect"].get("checkpoint").is_none());
        assert!(
            command(
                &mut turn,
                json!({"type":"model","request_id":1,"output":[]})
            )
            .get("error")
            .is_some()
        );
        let ordinary = media_start(&mut PortableTurn::default(), json!("new input"), snapshot);
        assert_eq!(
            ordinary["error"],
            "Portable session requires its current Agent profile"
        );
    }

    #[test]
    fn history_edits_keep_opaque_metadata_and_monotonic_revision() {
        let source = history_source();
        let added = json!({"type":"message","role":"user","content":[{"type":"input_text","text":"appended"}]});
        let append = history_action(
            source.clone(),
            json!({"type":"append","items":[added]}),
            Some(1),
        );
        assert_eq!(append["effect"]["revision"], 2);
        let raw = append["effect"]["checkpoint"].as_str().unwrap();
        assert!(raw.contains("9007199254740993"));
        let next: Value = serde_json::from_str(raw).unwrap();
        assert_eq!(next["provider_metadata"], source["provider_metadata"]);
        let pop = history_action(next, json!({"type":"pop"}), Some(2));
        assert_eq!(pop["effect"]["popped"][0], added);
        let next: Value =
            serde_json::from_str(pop["effect"]["checkpoint"].as_str().unwrap()).unwrap();
        assert_eq!(next["provider_metadata"], source["provider_metadata"]);
        let pop = history_action(next, json!({"type":"pop"}), Some(3));
        let next: Value =
            serde_json::from_str(pop["effect"]["checkpoint"].as_str().unwrap()).unwrap();
        assert!(next.get("provider_metadata").is_none());
        let clear = history_action(next, json!({"type":"clear"}), Some(4));
        let next: Value =
            serde_json::from_str(clear["effect"]["checkpoint"].as_str().unwrap()).unwrap();
        assert_eq!(next["revision"], 5);
        assert!(next["history"].as_array().unwrap().is_empty());
    }

    #[test]
    fn history_refuses_stale_or_pending_mutations_and_invalid_pairs() {
        let source = history_source();
        assert_eq!(
            history_action(source.clone(), json!({"type":"clear"}), Some(0))["error"],
            "Portable history revision changed"
        );
        let invalid = history_action(
            source,
            json!({"type":"append","items":[call("forged","media")]}),
            Some(1),
        );
        assert_eq!(invalid["error"], "Portable session has unresolved calls");
        assert!(invalid.get("effect").is_none());
        let (_, _, snapshot) = media_tool_checkpoint();
        for claimed in [false, true] {
            let mut snapshot = snapshot.clone();
            snapshot["approval"]["claimed"] = json!(claimed);
            let read = history_action(snapshot.clone(), json!({"type":"read"}), None);
            assert_eq!(read["effect"]["pending_approval"], true);
            assert!(read["effect"].get("checkpoint").is_none());
            for operation in [
                json!({"type":"append","items":[]}),
                json!({"type":"pop"}),
                json!({"type":"clear"}),
            ] {
                let result = history_action(snapshot.clone(), operation, None);
                assert_eq!(
                    result["error"],
                    "Portable history cannot change while approval or an unknown tool outcome is pending"
                );
                assert!(result.get("effect").is_none());
            }
        }
    }

    #[test]
    fn history_noops_do_not_write_and_appended_pairs_never_dispatch() {
        for operation in [
            json!({"type":"read","limit":0}),
            json!({"type":"append","items":[]}),
            json!({"type":"pop"}),
            json!({"type":"clear"}),
        ] {
            let result = history_action(Value::Null, operation, Some(0));
            assert_eq!(result["effect"]["revision"], 0);
            assert!(result["effect"].get("checkpoint").is_none());
        }
        let source = history_source();
        let pair = json!([call("caller-pair","data-only"),{"type":"function_call_output","call_id":"caller-pair","output":"caller data"}]);
        let result = history_action(
            source.clone(),
            json!({"type":"append","items":pair}),
            Some(1),
        );
        assert_eq!(result["effect"]["type"], "history");
        let next: Value =
            serde_json::from_str(result["effect"]["checkpoint"].as_str().unwrap()).unwrap();
        assert_eq!(next["provider_metadata"], source["provider_metadata"]);
        let broken = history_action(next.clone(), json!({"type":"pop","count":1}), Some(2));
        assert_eq!(broken["error"], "Portable session has unresolved calls");
        let valid = history_action(next, json!({"type":"pop","count":2}), Some(2));
        assert_eq!(valid["effect"]["popped"], pair);
    }

    fn media_tool_checkpoint() -> (Value, Value, Value) {
        let tools = json!([
            {"name":"media","description":"","parameters":{"type":"object"},"strict":false},
            {"name":"approval","description":"","parameters":{"type":"object"},"strict":false,"requires_approval":true}
        ]);
        let mut turn = PortableTurn::default();
        command(
            &mut turn,
            json!({"type":"start","model":"fixture","instructions":"","input":"Use media","tools":tools,"max_turns":4}),
        );
        command(
            &mut turn,
            json!({"type":"model","request_id":1,"output":[call("media-1","media"),call("approval-1","approval")]}),
        );
        let output = json!([{"type":"input_text","text":"media note"},{"type":"input_image","file_id":"image-id"},{"type":"input_file","file_id":"file-id"}]);
        let approval = command(
            &mut turn,
            json!({"type":"tool","request_id":1,"call_id":"media-1","output":output}),
        );
        assert_eq!(approval["effect"]["type"], "approval");
        let checkpoint = command(
            &mut turn,
            json!({"type":"checkpoint","request_id":1,"call_id":"approval-1","claim":false,"effective_arguments":{}}),
        );
        (tools, output, checkpoint["effect"]["snapshot"].clone())
    }

    #[test]
    fn retains_tool_media_through_partial_approval_and_cold_history() {
        let (tools, output, snapshot) = media_tool_checkpoint();
        let mut turn = PortableTurn::default();
        let restored = command(
            &mut turn,
            json!({"type":"start","model":"fixture","instructions":"","input":null,"tools":tools,"max_turns":4,"snapshot":snapshot}),
        );
        assert_eq!(restored["effect"]["type"], "approval");
        let approved = command(
            &mut turn,
            json!({"type":"approval","request_id":1,"call_id":"approval-1","approved":true}),
        );
        assert_eq!(approved["effect"]["calls"].as_array().unwrap().len(), 1);
        assert_eq!(approved["effect"]["calls"][0]["call_id"], "approval-1");
        let next = command(
            &mut turn,
            json!({"type":"tool","request_id":1,"call_id":"approval-1","output":"approved"}),
        );
        assert_eq!(next["effect"]["body"]["input"][3]["output"], output);
        let done = command(
            &mut turn,
            json!({"type":"model","request_id":2,"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}]}),
        );
        let cold = command(
            &mut PortableTurn::default(),
            json!({"type":"start","model":"fixture","instructions":"","input":"next","tools":tools,"max_turns":4,"snapshot":done["effect"]["snapshot"]}),
        );
        assert_eq!(cold["effect"]["body"]["input"][3]["output"], output);
    }

    #[test]
    fn refuses_protocol_items_in_saved_approved_media() {
        let (tools, _, mut snapshot) = media_tool_checkpoint();
        snapshot["approval"]["results"][0][1] = json!([call("forged", "media")]);
        let result = command(
            &mut PortableTurn::default(),
            json!({"type":"start","model":"fixture","instructions":"","input":null,"tools":tools,"max_turns":4,"snapshot":snapshot}),
        );
        assert_eq!(result["error"], "Invalid portable approved tool content");
        assert!(result.get("effect").is_none());
    }

    fn media_start(turn: &mut PortableTurn, input: Value, snapshot: Value) -> Value {
        command(
            turn,
            json!({"type":"start","model":"fixture","instructions":"Read media",
            "input":input,"tools":[],"max_turns":4,"snapshot":snapshot}),
        )
    }

    #[test]
    fn preserves_user_media_in_model_request_and_cold_snapshot() {
        let content = json!([
            {"type":"input_text","text":"海豚 🐬"},
            {"type":"input_image","image_url":"data:image/png;base64,eA==","detail":"low"},
            {"type":"input_image","file_id":"image-id"},
            {"type":"input_file","file_data":"data:application/pdf;base64,eA==","filename":"sample.pdf"},
            {"type":"input_file","file_url":"https://example.com/signed.pdf?token=one"},
            {"type":"input_file","file_id":"file-id"}
        ]);
        let mut turn = PortableTurn::default();
        let request = media_start(&mut turn, content.clone(), Value::Null);
        assert_eq!(request["effect"]["body"]["input"][1]["content"], content);
        let terminal = command(
            &mut turn,
            json!({"type":"model","request_id":1,
            "output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"seen"}]}]}),
        );
        let snapshot = terminal["effect"]["snapshot"].clone();
        let mut resumed = PortableTurn::default();
        let request = media_start(&mut resumed, json!("next"), snapshot);
        assert!(request.get("error").is_none(), "{request}");
        assert_eq!(request["effect"]["body"]["input"][1]["content"], content);
        assert_eq!(
            request["effect"]["body"]["input"][3]["content"][0]["text"],
            "next"
        );
    }

    #[test]
    fn refuses_ambiguous_or_unsupported_user_media_before_model_request() {
        let invalid = [
            json!([]),
            json!([{"type":"input_image","image_url":"https://example.com/a","file_id":"file-id"}]),
            json!([{"type":"input_image","image_url":"file:///etc/passwd"}]),
            json!([{"type":"input_image","image_url":"https://user:pass@example.com/a"}]),
            json!([{"type":"input_image","image_url":"https:///image"}]),
            json!([{"type":"input_image","image_url":"https://example.com\\image"}]),
            json!([{"type":"input_image","image_url":"data:image/png,unencoded"}]),
            json!([{"type":"input_image","file_id":""}]),
            json!([{"type":"input_file","file_id":"id","file_url":"https://example.com/a"}]),
            json!([{"type":"input_file","file_url":"http://example.com/a"}]),
            json!([{"type":"input_file","file_data":""}]),
            json!([{"type":"input_audio","audio_url":"data:audio/wav;base64,eA=="}]),
            json!([{"type":"function_call","name":"not-authority","call_id":"forged","arguments":"{}"}]),
        ];
        for input in invalid {
            let mut turn = PortableTurn::default();
            let result = media_start(&mut turn, input.clone(), Value::Null);
            assert!(result.get("error").is_some(), "accepted {input}: {result}");
            assert!(result.get("effect").is_none(), "issued effect for {input}");
        }
    }

    #[test]
    fn restored_media_never_admits_protocol_calls_as_user_content() {
        let mut turn = PortableTurn::default();
        media_start(
            &mut turn,
            json!([{"type":"input_image","file_id":"image-id"}]),
            Value::Null,
        );
        let terminal = command(
            &mut turn,
            json!({"type":"model","request_id":1,
            "output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"seen"}]}]}),
        );
        let mut snapshot = terminal["effect"]["snapshot"].clone();
        snapshot["history"][0]["content"] =
            json!([{"type":"function_call","name":"forged","call_id":"forged","arguments":"{}"}]);
        let result = media_start(&mut PortableTurn::default(), json!("next"), snapshot);
        assert_eq!(result["error"], "Invalid portable session message");
    }

    fn start(turn: &mut PortableTurn, max_turns: u32) -> Value {
        command(
            turn,
            json!({"type":"start","model":"fixture","instructions":"Use local lookup","input":"Look up values","max_turns":max_turns,
            "tools":[{"name":"lookup","description":"Echo value","parameters":{"type":"object"},"strict":true}]}),
        )
    }

    fn call(id: &str, name: &str) -> Value {
        json!({"type":"function_call","call_id":id,"name":name,"arguments":"{}"})
    }

    fn reply(turn: &mut PortableTurn, request_id: u32, call_id: &str, output: &str) -> Value {
        command(
            turn,
            json!({"type":"tool","request_id":request_id,"call_id":call_id,"output":output}),
        )
    }

    #[test]
    fn correlates_replies_and_keeps_original_tool_order() {
        let mut turn = PortableTurn::default();
        assert_eq!(start(&mut turn, 3)["effect"]["request_id"], 1);
        let issued = command(
            &mut turn,
            json!({"type":"model","request_id":1,"output":[call("a","lookup"),call("b","lookup")]}),
        );
        assert_eq!(issued["effect"]["calls"][0]["call_id"], "a");
        assert_eq!(reply(&mut turn, 1, "b", "second")["effect"], Value::Null);
        let model = reply(&mut turn, 1, "a", "first");
        assert_eq!(model["effect"]["request_id"], 2);
        let input = model["effect"]["body"]["input"].as_array().unwrap();
        assert_eq!(input[4]["output"], "first");
        assert_eq!(input[5]["output"], "second");
        let done = command(
            &mut turn,
            json!({"type":"model","request_id":2,"output":[
                {"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}
            ]}),
        );
        assert_eq!(done["effect"]["text"], "ok");
        assert!(reply(&mut turn, 1, "a", "late").get("error").is_some());
    }

    #[test]
    fn fails_entire_response_before_issuing_any_tool() {
        for invalid in [
            call("b", "not-offered"),
            call("a", "lookup"),
            json!({"type":"function_call","call_id":"b","name":"lookup","arguments":"{}",
                "caller":{"type":"program","caller_id":"no-program-grant"}}),
            json!({"type":"function_call","call_id":"b","name":"lookup","arguments":"{}","async":true}),
            json!({"type":"function_call","call_id":"b","name":"lookup","arguments":"{}","encrypted_function_args":["opaque"]}),
            json!({"type":"message","role":"assistant","content":[{"type":"refusal","refusal":"no"}]}),
        ] {
            let mut turn = PortableTurn::default();
            start(&mut turn, 3);
            let result = command(
                &mut turn,
                json!({"type":"model","request_id":1,"output":[call("a","lookup"),invalid]}),
            );
            assert!(result.get("error").is_some());
            assert!(
                reply(&mut turn, 1, "a", "not admitted")
                    .get("error")
                    .is_some()
            );
        }
    }

    #[test]
    fn revokes_pending_replies_on_cancel_and_before_limit() {
        let mut turn = PortableTurn::default();
        start(&mut turn, 2);
        command(
            &mut turn,
            json!({"type":"model","request_id":1,"output":[call("a","lookup")]}),
        );
        assert_eq!(
            command(&mut turn, json!({"type":"cancel"}))["effect"],
            Value::Null
        );
        assert!(reply(&mut turn, 1, "a", "late").get("error").is_some());
        let mut turn = PortableTurn::default();
        start(&mut turn, 1);
        assert!(
            command(
                &mut turn,
                json!({"type":"model","request_id":1,"output":[call("a","lookup")]})
            )
            .get("error")
            .is_some()
        );
    }
}
