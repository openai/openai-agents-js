//! Exact callback ownership for Decisions response accounting.

use std::sync::{Arc, Mutex};

use codex_core::AuxiliaryResponse;
use codex_protocol::ThreadId;
use codex_protocol::protocol::{
    ReceivedResponseUsage, ResponseObservation, ResponseObservationStatus, TokenUsage,
};
use napi::Result;
use napi_derive::napi;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{RuntimeOwned, engine, input_error, native_error, python_tools};

enum Callback {
    Tool(python_tools::PendingKey),
    Step(python_tools::StepReply),
    Completion(python_tools::CompletionReply),
    Prepared {
        generation: String,
        request_id: String,
    },
    Interception {
        nonce: u64,
        owner: crate::native_interception::CapturedTurnStop,
    },
}

struct Authority {
    thread: String,
    turn: String,
    instance: Option<String>,
    callback: Callback,
}

impl Authority {
    fn parse(raw: &str, root: &codex_core_api::CodexThread) -> Result<Self> {
        let value: Value = serde_json::from_str(raw)
            .map_err(|_| input_error("Invalid decision callback authority"))?;
        if value["type"] == "_sdk_native_interception" {
            let nonce = value["nonce"]
                .as_str()
                .ok_or_else(|| input_error("Invalid decision callback authority"))?;
            let nonce = crate::native_id(nonce)?;
            let owner = root
                .thread_extension_data()
                .get::<crate::native_interception::Control>()
                .and_then(|control| control.capture_decision_owner(nonce))
                .ok_or_else(|| input_error("Expired decision callback authority"))?;
            let (thread, turn) = owner
                .decision_ids()
                .ok_or_else(|| input_error("Expired decision callback authority"))?;
            return Ok(Self {
                thread: thread.to_owned(),
                turn: turn.to_owned(),
                instance: None,
                callback: Callback::Interception { nonce, owner },
            });
        }
        if value.get("_sdk_python_tool").is_some() {
            let key: python_tools::PendingKey = serde_json::from_value(value)
                .map_err(|_| input_error("Invalid decision callback authority"))?;
            return Ok(Self {
                thread: key.reply.thread.clone(),
                turn: key.turn.clone(),
                instance: key.reply.instance.clone(),
                callback: Callback::Tool(key),
            });
        }
        let invalid = || input_error("Invalid decision callback authority");
        let thread = value["thread"].as_str().ok_or_else(invalid)?.to_owned();
        let turn = value["turn_id"].as_str().ok_or_else(invalid)?.to_owned();
        let instance = value["instance"].as_str().map(str::to_owned);
        let request = json!({
            "thread":thread, "instance":instance, "turn_id":turn,
            "generation":value["generation"], "request_id":value["request_id"],
        });
        let callback = if value["type"] == "_sdk_prepare_request" {
            if instance.is_some() {
                return Err(invalid());
            }
            Callback::Prepared {
                generation: value["generation"].as_str().ok_or_else(invalid)?.to_owned(),
                request_id: value["request_id"].as_str().ok_or_else(invalid)?.to_owned(),
            }
        } else if value["type"] == "_sdk_before_complete" {
            Callback::Completion(serde_json::from_value(request).map_err(|_| invalid())?)
        } else if value["type"] == "_sdk_select_step" {
            Callback::Step(serde_json::from_value(request).map_err(|_| invalid())?)
        } else {
            return Err(invalid());
        };
        Ok(Self {
            thread,
            turn,
            instance,
            callback,
        })
    }

    fn check(&self, tools: Option<&Arc<python_tools::PythonTools>>, root: &str) -> Result<()> {
        if let Callback::Interception { nonce, owner } = &self.callback {
            return if owner.decision_pending(*nonce) {
                Ok(())
            } else {
                Err(input_error("Expired decision callback authority"))
            };
        }
        let tools = tools.ok_or_else(|| input_error("Decision requires a managed callback"))?;
        match &self.callback {
            Callback::Tool(key) => tools
                .owner(root, key)
                .ok_or_else(|| input_error("Expired decision callback authority"))?
                .check_pending(&key.reply.thread, key)
                .map_err(native_error),
            callback => {
                let owner = tools
                    .exact_owner(root, &self.thread, &self.instance)
                    .ok_or_else(|| input_error("Expired decision callback authority"))?;
                let active = match callback {
                    Callback::Step(reply) => owner.check_step(&self.thread, reply),
                    Callback::Completion(reply) => owner.check_completion(reply),
                    Callback::Prepared {
                        generation,
                        request_id,
                    } => owner.check_prepared_authority(
                        &self.thread,
                        &self.turn,
                        generation,
                        request_id,
                    ),
                    Callback::Tool(_) | Callback::Interception { .. } => unreachable!(),
                }
                .map_err(native_error)?;
                if !active {
                    return Err(input_error("Expired decision callback authority"));
                }
                Ok(())
            }
        }
    }
    fn check_thread(&self, thread: &codex_core_api::CodexThread) -> Result<()> {
        if let Callback::Interception { owner, .. } = &self.callback {
            if !owner.decision_registered(thread.thread_extension_data()) {
                return Err(input_error("Expired decision callback authority"));
            }
        }
        Ok(())
    }
}

struct Captured {
    response: Mutex<Option<AuxiliaryResponse>>,
    completion_id: String,
    thread_id: String,
    turn_id: String,
}

#[napi(js_name = "_DecisionCall")]
pub struct NativeDecisionCall {
    state: RuntimeOwned<Captured>,
}

pub(crate) async fn capture(
    inner: RuntimeOwned<engine::ThreadState>,
    request: String,
) -> Result<NativeDecisionCall> {
    let _operation = inner.engine.operation(false).map_err(native_error)?;
    let authority = Authority::parse(&request, &inner.thread)?;
    let tools = inner
        .thread
        .thread_extension_data()
        .get::<python_tools::PythonTools>();
    let root = inner.id.to_string();
    authority.check(tools.as_ref(), &root)?;
    let id = ThreadId::from_string(&authority.thread)
        .map_err(|_| input_error("Invalid decision callback authority"))?;
    let thread = if id == inner.id {
        Arc::clone(&inner.thread)
    } else {
        inner
            .engine
            .manager
            .get_thread(id)
            .await
            .map_err(native_error)?
    };
    authority.check(tools.as_ref(), &root)?;
    authority.check_thread(&thread)?;
    let response = thread
        .capture_auxiliary_response(&authority.turn)
        .await
        .ok_or_else(|| input_error("Expired decision callback authority"))?;
    authority.check(tools.as_ref(), &root)?;
    authority.check_thread(&thread)?;
    let completion_id = response.completion_id().to_owned();
    Ok(NativeDecisionCall {
        state: RuntimeOwned::new(Arc::new(Captured {
            response: Mutex::new(Some(response)),
            completion_id,
            thread_id: authority.thread.clone(),
            turn_id: authority.turn.clone(),
        })),
    })
}

#[derive(Deserialize)]
struct Metadata {
    request_id: Option<String>,
    model: Option<String>,
    usage: Option<Value>,
}

#[napi]
impl NativeDecisionCall {
    #[napi(getter, js_name = "thread_id")]
    pub fn thread_id(&self) -> String {
        self.state.thread_id.clone()
    }
    #[napi(getter, js_name = "turn_id")]
    pub fn turn_id(&self) -> String {
        self.state.turn_id.clone()
    }
    #[napi(getter, js_name = "completion_id")]
    pub fn completion_id(&self) -> String {
        self.state.completion_id.clone()
    }

    #[napi]
    pub async fn commit(&self, metadata_json: String) -> Result<Option<String>> {
        let metadata: Metadata = serde_json::from_str(&metadata_json)
            .map_err(|_| input_error("Invalid decision response metadata"))?;
        let state = self.state.clone();
        let response = state
            .response
            .lock()
            .map_err(native_error)?
            .take()
            .ok_or_else(|| input_error("Decision response was already committed"))?;
        let usage = metadata
            .usage
            .and_then(|value| serde_json::from_value::<TokenUsage>(value).ok());
        let observed = usage.as_ref().map(|usage| ReceivedResponseUsage {
            input_tokens: Some(usage.input_tokens),
            cached_input_tokens: Some(usage.cached_input_tokens),
            cache_write_input_tokens: Some(usage.cache_write_input_tokens),
            output_tokens: Some(usage.output_tokens),
            reasoning_output_tokens: Some(usage.reasoning_output_tokens),
            total_tokens: Some(usage.total_tokens),
        });
        let result = response
            .commit(
                ResponseObservation {
                    response_id: None,
                    upstream_request_id: metadata.request_id,
                    status: ResponseObservationStatus::Completed,
                    incomplete_reason: None,
                    usage: observed,
                },
                usage,
                None,
                metadata.model,
            )
            .await;
        // The host must consume the completion event before surfacing this error.
        Ok(result.err().map(|error| error.to_string()))
    }
}
