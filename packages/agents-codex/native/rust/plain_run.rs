//! Owned one-shot ModelClient execution for the SDK's private plain-run route.

use std::collections::VecDeque;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex as StdMutex, Weak};

use anyhow::{Result, ensure};
use codex_api::{ApiError, ResponsesWebsocketConnect};
use codex_client::{HttpTransport as _, TransportError};
use codex_core::{ModelClient, ResponseEvent, sdk_plain_run};
use codex_core_api::Feature;
use codex_extension_api::{
    ExtensionData, ModelHttpStream, ModelRequestContributor, ModelRequestInput,
    ModelRequestObservation, ModelRequestObservationRoute, ModelRequestObserver,
    ModelResponseInterceptor, ModelToolAdmission, TurnSamplingStop,
};
use codex_login::auth::AgentIdentityAuthPolicy;
use codex_model_provider::WorkspaceRoutingContext;
use codex_otel::SessionTelemetry;
use codex_protocol::{
    ThreadId,
    auth::AuthMode,
    config_types::ReasoningSummary,
    error::{CodexErr, ResponseIntegrityReason},
    models::{
        BaseInstructions, BaseInstructionsProvenance, ContentItem, MessagePhase, ResponseItem,
    },
    openai_models::ReasoningEffort,
    protocol::SessionSource,
};
use codex_utils_stream_parser::strip_citations;
use futures_util::{FutureExt as _, StreamExt as _};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::engine::EngineState;
use crate::plain_websocket::PlainWebSocket;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    input: String,
    instructions: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    reasoning_effort: Option<ReasoningEffort>,
    #[serde(default)]
    observation_retention_all: bool,
    #[serde(default)]
    prefer_buffered_response: bool,
    #[serde(default)]
    fresh_websocket_connector: bool,
}

#[derive(Clone)]
struct Outcome {
    result: std::result::Result<String, String>,
    cleanup_error: Option<String>,
}

struct Joined {
    task: Option<JoinHandle<Outcome>>,
    outcome: Option<Outcome>,
}

pub(crate) struct Run {
    cancel: CancellationToken,
    sampling_stop: Arc<TurnSamplingStop>,
    joined: Mutex<Joined>,
}

impl Drop for Run {
    fn drop(&mut self) {
        self.stop();
    }
}

impl Run {
    pub(crate) fn start(
        engine: Arc<crate::engine::EngineState>,
        request: &str,
    ) -> Result<Arc<Self>> {
        ensure!(
            supported_configuration(&engine),
            "Unsupported plain-run configuration"
        );
        let request: Request = serde_json::from_str(request)?;
        ensure!(
            request
                .model
                .as_ref()
                .is_none_or(|model| !model.trim().is_empty()),
            "Model must not be empty"
        );
        let permit = engine.operation(false)?;
        let cancel = CancellationToken::new();
        let sampling_stop = Arc::new(TurnSamplingStop::default());
        let task_cancel = cancel.clone();
        let task_stop = sampling_stop.clone();
        let task = tokio::spawn(async move {
            let _permit = permit;
            execute(engine, request, task_cancel, task_stop).await
        });
        Ok(Arc::new(Self {
            cancel,
            sampling_stop,
            joined: Mutex::new(Joined {
                task: Some(task),
                outcome: None,
            }),
        }))
    }

    pub(crate) fn stop(&self) {
        self.sampling_stop.request();
        self.cancel.cancel();
    }

    async fn outcome(&self) -> Outcome {
        let mut joined = self.joined.lock().await;
        if let Some(task) = joined.task.as_mut() {
            // Keep the handle in its slot if a JS waiter is cancelled.
            let outcome = match task.await {
                Ok(outcome) => outcome,
                Err(error) => Outcome {
                    result: Err(format!("Plain request owner failed: {error}")),
                    cleanup_error: Some("Plain request owner did not join normally".into()),
                },
            };
            joined.task = None;
            joined.outcome = Some(outcome);
        }
        joined
            .outcome
            .clone()
            .expect("joined plain request outcome")
    }

    pub(crate) async fn wait(&self) -> Result<String, String> {
        self.outcome().await.result
    }

    pub(crate) async fn close(&self) -> Result<(), String> {
        self.stop();
        match self.outcome().await.cleanup_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

fn supported_configuration(engine: &crate::engine::EngineState) -> bool {
    let config = &engine.service_config;
    crate::telemetry::plain_run_trace_off()
        && engine.manager.auth_manager().auth_mode() == Some(AuthMode::ApiKey)
        && config.base_instructions.is_some()
        && !config.model_provider.is_amazon_bedrock()
        && !config.features.enabled(Feature::ApiKeyModelDiscovery)
        && !config.features.enabled(Feature::UseAgentIdentity)
        && !config.features.enabled(Feature::UnboundedConnectionRetries)
        && !crate::telemetry::export_requested(config)
}

async fn model_info(
    engine: &crate::engine::EngineState,
    model: Option<String>,
) -> codex_protocol::openai_models::ModelInfo {
    let config = &engine.service_config;
    let models = engine.manager.get_models_manager();
    let model = match model.or_else(|| config.model.clone()) {
        Some(model) => model,
        None => {
            models
                .get_default_model(
                    &None,
                    false,
                    codex_models_manager::manager::RefreshStrategy::Offline,
                    config.http_client_factory(),
                )
                .await
        }
    };
    models
        .get_model_info(&model, &config.to_models_manager_config())
        .await
}

pub(crate) async fn supported(engine: &crate::engine::EngineState, model: Option<String>) -> bool {
    supported_configuration(engine) && !model_info(engine, model).await.use_responses_lite
}

#[derive(Serialize)]
struct Observation {
    kind: &'static str,
    payload: String,
}

#[derive(Default)]
struct JournalState {
    entries: VecDeque<Observation>,
    bytes: usize,
    gap: bool,
    request_id: Option<String>,
}

struct Journal {
    all: bool,
    state: StdMutex<JournalState>,
}

impl std::fmt::Debug for Journal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PlainRunJournal")
            .finish_non_exhaustive()
    }
}

impl Journal {
    fn push(&self, kind: &'static str, payload: Value) {
        let payload = payload.to_string();
        let mut state = self.state.lock().expect("plain observations poisoned");
        if !self.all {
            // A source gap precedes a contiguous retained suffix. UTF-8 bytes
            // conservatively bound strings without copying JS retention logic.
            if payload.len() > 65_536 {
                state.entries.clear();
                state.bytes = 0;
                state.gap = true;
                return;
            }
            while state.entries.len() >= 256 || state.bytes + payload.len() > 65_536 {
                if let Some(oldest) = state.entries.pop_front() {
                    state.bytes -= oldest.payload.len();
                    state.gap = true;
                } else {
                    break;
                }
            }
        }
        state.bytes += payload.len();
        state.entries.push_back(Observation { kind, payload });
    }

    fn request_id(&self) -> Option<String> {
        self.state
            .lock()
            .expect("plain observations poisoned")
            .request_id
            .clone()
    }
}

impl ModelRequestObserver for Journal {
    fn observe(&self, observation: ModelRequestObservation) {
        if let ModelRequestObservation::Dispatching(ref dispatch) = observation {
            self.state
                .lock()
                .expect("plain observations poisoned")
                .request_id = Some(dispatch.request_id.clone());
            self.push("model_request_dispatching", observation.to_bridge_value());
        }
        // There is no persisted Core terminal occurrence to link in this route.
    }
}

#[derive(Debug)]
struct Admission {
    thread_id: String,
    turn: ExtensionData,
}

impl ModelToolAdmission for Admission {
    fn thread_id(&self) -> &str {
        &self.thread_id
    }
    fn turn_store(&self) -> &ExtensionData {
        &self.turn
    }
    fn admits(&self, item: &ResponseItem) -> bool {
        matches!(item, ResponseItem::Message { role, .. } if role == "assistant")
            || matches!(item, ResponseItem::Reasoning { .. })
    }
}

#[derive(Debug)]
struct Route {
    endpoint: String,
    websocket: Option<WebSocketRoute>,
    transport: codex_http_client::ReqwestTransport,
    stop: Arc<TurnSamplingStop>,
    cancel: CancellationToken,
}

#[derive(Debug)]
struct WebSocketRoute {
    endpoint: String,
    thread_id: String,
    engine: Weak<EngineState>,
    owner: Arc<PlainWebSocket>,
}

impl ModelRequestContributor for Route {
    fn websocket_connect(&self, url: &str, thread_id: &str) -> Option<ResponsesWebsocketConnect> {
        let route = self.websocket.as_ref()?;
        let matches = route.endpoint == url && route.thread_id == thread_id;
        let endpoint = route.endpoint.clone();
        let engine = route.engine.clone();
        let owner = Arc::clone(&route.owner);
        let stop = Arc::clone(&self.stop);
        let cancel = self.cancel.clone();
        Some(Arc::new(move |request| {
            let (endpoint, engine, owner, stop, cancel) = (
                endpoint.clone(),
                engine.clone(),
                Arc::clone(&owner),
                Arc::clone(&stop),
                cancel.clone(),
            );
            Box::pin(async move {
                if !matches {
                    return Err(ApiError::Transport(TransportError::Build(
                        "Plain WebSocket request route mismatch".into(),
                    )));
                }
                owner.connect(engine, endpoint, request, stop, cancel).await
            })
        }))
    }

    fn http_stream(&self, _url: &str) -> Option<ModelHttpStream> {
        let endpoint = self.endpoint.clone();
        let transport = self.transport.clone();
        let stop = self.stop.clone();
        let cancel = self.cancel.clone();
        Some(Arc::new(move |request| {
            let (endpoint, transport, stop, cancel) = (
                endpoint.clone(),
                transport.clone(),
                stop.clone(),
                cancel.clone(),
            );
            Box::pin(async move {
                // Claim the route even on rejection: never fall back after admission.
                if request.url != endpoint || request.method != http::Method::POST {
                    return Err(TransportError::Build("Plain request route mismatch".into()));
                }
                let send = stop
                    .try_commit(|| transport.stream(request))
                    .ok_or_else(|| {
                        TransportError::Build(
                            "Plain request cancelled before transport admission".into(),
                        )
                    })?;
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => Err(TransportError::Build("Plain request cancelled during opening".into())),
                    result = send => result,
                }
            })
        }))
    }

    fn request(&self, _input: ModelRequestInput<'_>) -> Option<Box<dyn ModelResponseInterceptor>> {
        self.websocket.as_ref()?.owner.interceptor()
    }
}

struct Settlement {
    session_id: ThreadId,
    turn_id: String,
    submission_id: String,
    journal: Arc<Journal>,
    final_output: Option<String>,
    blank_final: bool,
    response_id: Option<String>,
    request_id: Option<String>,
    usage: Value,
    usage_metadata: Value,
    context_window: Value,
    rate_limits: Value,
    api_rate_limits: Value,
    active_item: Option<String>,
    completed: bool,
    fact_budget: codex_protocol::response_facts::ResponseFactBudget,
}

impl Settlement {
    fn new(all: bool) -> Self {
        Self {
            session_id: ThreadId::new(),
            turn_id: ThreadId::new().to_string(),
            submission_id: ThreadId::new().to_string(),
            journal: Arc::new(Journal {
                all,
                state: StdMutex::new(JournalState::default()),
            }),
            final_output: None,
            blank_final: false,
            response_id: None,
            request_id: None,
            usage: Value::Null,
            usage_metadata: Value::Null,
            context_window: Value::Null,
            rate_limits: Value::Null,
            api_rate_limits: Value::Null,
            active_item: None,
            completed: false,
            fact_budget: Default::default(),
        }
    }

    fn response_id(&mut self, id: String) -> Result<()> {
        ensure!(
            self.response_id
                .as_ref()
                .is_none_or(|previous| previous == &id),
            "Model response identity changed"
        );
        self.response_id = Some(id);
        Ok(())
    }

    fn record_api_limits(
        &mut self,
        limits: &codex_protocol::protocol::ApiRateLimits,
    ) -> Result<()> {
        let mut event = json!({"type":"token_count", "api_rate_limits":limits});
        crate::usage::event_to_wire(&mut event)?;
        self.api_rate_limits = event["api_rate_limits"].take();
        self.journal
            .push("api_rate_limits", self.api_rate_limits.clone());
        Ok(())
    }

    fn token_count(&self) -> Value {
        json!({"type":"token_count", "info":self.usage, "rate_limits":self.rate_limits, "api_rate_limits":self.api_rate_limits})
    }
}

fn integrity(reason: ResponseIntegrityReason) -> anyhow::Error {
    CodexErr::Fatal("Unsupported or malformed model response".into())
        .with_response_integrity_reason(reason)
        .into()
}

fn error_json(error: &anyhow::Error) -> Value {
    let fallback;
    let native = if let Some(error) = error.downcast_ref::<CodexErr>() {
        error
    } else {
        fallback = CodexErr::Fatal(error.to_string());
        &fallback
    };
    let event = native.to_error_event(None);
    let mut value = serde_json::to_value(&event).expect("serializable native error");
    if let Some(reason) = event.response_integrity_reason {
        value["_sdk_response_integrity_reason"] = json!(reason);
    }
    value["_sdk_provider_error"] = crate::provider_error::Receipt::capture(native).to_json();
    value
}

async fn execute(
    engine: Arc<EngineState>,
    request: Request,
    cancel: CancellationToken,
    stop: Arc<TurnSamplingStop>,
) -> Outcome {
    let mut state = Settlement::new(request.observation_retention_all);
    let websocket = engine
        .service_config
        .model_provider
        .supports_websockets
        .then(|| Arc::new(PlainWebSocket::new(request.fresh_websocket_connector)));
    let collecting = prepare_and_collect(
        &engine,
        request,
        &cancel,
        stop,
        websocket.as_ref(),
        &mut state,
    );
    let (collected, websocket_cleanup_error) = if let Some(websocket) = &websocket {
        let result = AssertUnwindSafe(collecting).catch_unwind().await;
        // The collection future owns the ModelClient and its cached socket.
        let cleanup_error = websocket.join().await.err();
        match result {
            Ok(result) => (result, cleanup_error),
            Err(panic) => std::panic::resume_unwind(panic),
        }
    } else {
        (collecting.await, None)
    };
    let (result, cleanup_error) = match collected {
        Ok(outcome) => outcome,
        Err(error) => (Err(error), None),
    };
    let cleanup_error = cleanup_error.or(websocket_cleanup_error);
    let error = result.err().map(|error| error_json(&error));
    let journal = state
        .journal
        .state
        .lock()
        .expect("plain observations poisoned");
    let dto = json!({
        "sessionId":state.session_id.to_string(), "turnId":state.turn_id, "submissionId":state.submission_id,
        "events":journal.entries, "eventsGap":journal.gap,
        "finalOutput":if state.blank_final { Some("") } else { state.final_output.as_deref() },
        "usage":state.usage, "usageMetadata":state.usage_metadata,
        "responseId":state.response_id, "requestId":state.request_id, "dispatchRequestId":journal.request_id,
        "modelContextWindow":state.context_window, "rateLimits":state.rate_limits, "apiRateLimits":state.api_rate_limits,
        "error":error,
    });
    let result = match &cleanup_error {
        Some(error) => Err(error.clone()),
        None => Ok(dto.to_string()),
    };
    Outcome {
        result,
        cleanup_error,
    }
}

async fn prepare_and_collect(
    engine: &Arc<EngineState>,
    request: Request,
    cancel: &CancellationToken,
    stop: Arc<TurnSamplingStop>,
    websocket: Option<&Arc<PlainWebSocket>>,
    state: &mut Settlement,
) -> Result<(Result<()>, Option<String>)> {
    let config = &engine.service_config;
    let model = model_info(engine, request.model.clone()).await;
    ensure!(
        !model.use_responses_lite,
        "Responses Lite is not supported by the plain-run route"
    );
    if cancel.is_cancelled() {
        return Err(CodexErr::TurnAborted.into());
    }
    state.context_window = model
        .usable_context_window()
        .map(crate::usage::exact_counter)
        .unwrap_or(Value::Null);
    let auth = engine.manager.auth_manager();
    let provider = config.model_provider.clone();
    let api = provider.to_api_provider(auth.auth_mode())?;
    let no_redirects = provider.has_request_routing_overrides()
        || api
            .headers
            .contains_key(codex_model_provider::ACCOUNT_ROUTING_HEADER);
    let (transport, _) = engine
        .responses_transport(no_redirects)
        .map_err(|error| anyhow::anyhow!(error.reason))?;
    let thread_id = state.session_id.to_string();
    let websocket_route = if let Some(owner) = websocket {
        Some(WebSocketRoute {
            endpoint: api.websocket_url_for_path("/responses")?.to_string(),
            thread_id: thread_id.clone(),
            engine: Arc::downgrade(engine),
            owner: Arc::clone(owner),
        })
    } else {
        None
    };
    let route = Arc::new(Route {
        endpoint: api.url_for_path("/responses"),
        websocket: websocket_route,
        transport,
        stop: stop.clone(),
        cancel: cancel.clone(),
    });
    let admission = Arc::new(Admission {
        thread_id,
        turn: ExtensionData::new(state.turn_id.clone()),
    });
    admission
        .turn
        .insert(ModelRequestObservationRoute(state.journal.clone()));
    let originator = codex_login::default_client::originator().value;
    let client = ModelClient::new(
        Some(auth),
        AgentIdentityAuthPolicy::JwtOnly,
        state.session_id,
        provider,
        SessionSource::Exec,
        originator.clone(),
        config.model_verbosity.clone(),
        config.features.enabled(Feature::ContentItemKinds),
        config.features.enabled(Feature::ReasoningEffortOverride),
        config.features.enabled(Feature::EnableRequestCompression),
        config.features.enabled(Feature::RuntimeMetrics),
        None,
        config
            .features
            .enabled(Feature::ConcurrentReasoningSummaries),
        None,
        config.http_client_factory(),
        WorkspaceRoutingContext::new(api.base_url),
        vec![route],
    );
    let mut session = client.new_session();
    let mut prompt = sdk_plain_run::prompt(
        vec![
            crate::application_instructions::publication(&request.instructions),
            ResponseItem::Message {
                id: None,
                role: "user".into(),
                content: vec![ContentItem::InputText {
                    text: request.input,
                }],
                phase: None,
                internal_chat_message_metadata_passthrough: None,
            },
        ],
        BaseInstructions {
            text: config
                .base_instructions
                .clone()
                .ok_or_else(|| anyhow::anyhow!("Missing SDK base instructions"))?,
            provenance: Some(BaseInstructionsProvenance::Custom),
        },
        Default::default(),
        stop.clone(),
        admission,
        request.prefer_buffered_response,
    );
    let selected_effort = request
        .reasoning_effort
        .clone()
        .or(config.model_reasoning_effort.clone());
    let metadata = sdk_plain_run::metadata(
        config,
        &model,
        selected_effort.clone(),
        engine.installation_id.clone(),
        state.session_id.to_string(),
        state.turn_id.clone(),
    );
    let telemetry = SessionTelemetry::new(
        state.session_id,
        &model.slug,
        &model.slug,
        None,
        None,
        None,
        originator,
        false,
        "sdk".into(),
        SessionSource::Exec,
    );
    let trace = sdk_plain_run::InferenceTraceContext::disabled();
    let max_retries = config.model_provider.stream_max_retries();
    let mut retries = 0;
    loop {
        let opened = {
            let opening = session.stream(
                &prompt,
                &model,
                &telemetry,
                selected_effort.clone(),
                config
                    .model_reasoning_summary
                    .unwrap_or(ReasoningSummary::Auto),
                config.service_tier.clone(),
                &metadata,
                &trace,
            );
            tokio::pin!(opening);
            tokio::select! {
                biased;
                opened = &mut opening => opened,
                _ = cancel.cancelled() => return Err(CodexErr::TurnAborted.into()),
            }
        };
        let result = match opened {
            Ok(mut stream) => {
                // Synchronously acquire every Core task before the next await.
                let (mapper, producer, producer_stop) = sdk_plain_run::take_tasks(&mut stream);
                let result = collect(&mut stream, cancel, state, &mut prompt.input).await;
                if let Some(stop) = producer_stop {
                    let _ = stop.send(());
                }
                drop(stream);
                // Join both attempt owners before retrying or publishing settlement.
                let mapper_joined = match mapper {
                    Some(task) => task.await.is_ok(),
                    None => false,
                };
                let producer_joined = match producer {
                    Some(task) => task.await.is_ok(),
                    None => request.prefer_buffered_response,
                };
                if !mapper_joined || !producer_joined {
                    stop.request();
                    return Ok((
                        result,
                        Some("Plain response mapper/API producer did not join normally".into()),
                    ));
                }
                result
            }
            Err(error) => Err(error.into()),
        };
        let Err(error) = result else {
            stop.request();
            return Ok((Ok(()), None));
        };
        let Some(native) = error.downcast_ref::<CodexErr>() else {
            stop.request();
            return Ok((Err(error), None));
        };
        if let Some(limits) = native.api_rate_limits() {
            state.record_api_limits(limits)?;
        }
        // Match Core's bounded sampling retry policy and absolute Retry-After.
        // Only completed native items enter subsequent prompts; unfinished text
        // remains observable but never becomes retry conversation history.
        if matches!(
            native.details(),
            codex_protocol::error::CodexErrorDetails::ContentFilter
        ) {
            prompt
                .input
                .push(sdk_plain_run::content_filter_guidance(&model));
        }
        let next_retry = retries + 1;
        let Some(delay) = native.retry_delay(next_retry) else {
            stop.request();
            return Ok((Err(error), None));
        };
        let retry_after = native.retry_after().map(|advice| advice.deadline());
        if retries >= max_retries {
            if let Some(websocket) = websocket
                && sdk_plain_run::switch_to_http(&mut session, &telemetry, &model)
            {
                websocket.clear_dispatch();
            } else {
                stop.request();
                return Ok((Err(error), None));
            }
            if let Some(retry_at) = retry_after {
                wait_for_retry(retry_at, cancel, &stop).await?;
            }
            state.journal.push(
                "warning",
                json!({
                    "message": format!("Falling back from WebSockets to HTTPS transport. {native:#}")
                }),
            );
            retries = 0;
        } else {
            retries = next_retry;
            let now = tokio::time::Instant::now();
            let retry_at = retry_after.unwrap_or(now + delay);
            codex_client::record_retry!(
                retries,
                retry_at.saturating_duration_since(now),
                codex_client::RetryOperation::Sampling
            );
            wait_for_retry(retry_at, cancel, &stop).await?;
        }
        state.active_item = None;
        state.final_output = None;
        state.blank_final = false;
        state.response_id = None;
        state.request_id = None;
        state.usage = Value::Null;
        state.usage_metadata = Value::Null;
        state.completed = false;
    }
}

async fn wait_for_retry(
    deadline: tokio::time::Instant,
    cancel: &CancellationToken,
    stop: &TurnSamplingStop,
) -> Result<()> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            stop.request();
            Err(CodexErr::TurnAborted.into())
        }
        _ = tokio::time::sleep_until(deadline) => Ok(()),
    }
}

async fn collect(
    stream: &mut codex_core::ResponseStream,
    cancel: &CancellationToken,
    state: &mut Settlement,
    history: &mut Vec<ResponseItem>,
) -> Result<()> {
    let mut output = crate::response_integrity::SupportedOutput::default();
    loop {
        let event = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(CodexErr::TurnAborted.into()),
            event = stream.next() => event,
        };
        let Some(event) = event else {
            break;
        };
        ensure!(!state.completed, "Received model event after completion");
        let event = event?;
        if let Some(reason) = output.rejection_reason(&event) {
            return Err(integrity(reason));
        }
        match event {
            ResponseEvent::ResponseObserved(observation) => {
                if let Some(id) = &observation.response_id {
                    state.response_id(id.clone())?;
                }
                if let Some(id) = &observation.upstream_request_id {
                    state.request_id = Some(id.clone());
                }
                state
                    .journal
                    .push("response_observed", serde_json::to_value(observation)?);
            }
            ResponseEvent::ResponseFact(received) => {
                use codex_protocol::response_facts::{
                    ReceivedResponseFact, ResponseFact, ResponseFactRecord,
                };
                // This route never requests probability capture. Match Core's
                // record_response_fact policy for unsolicited provider facts.
                if matches!(
                    received.fact,
                    ResponseFact::TextProbabilities { .. } | ResponseFact::MalformedProbabilities
                ) {
                    continue;
                }
                let mut record = ResponseFactRecord {
                    id: ThreadId::new().to_string(),
                    thread_id: state.session_id,
                    turn_id: state.turn_id.clone(),
                    request_id: state.journal.request_id(),
                    response_id: state.response_id.clone(),
                    received,
                };
                let marker = ResponseFactRecord {
                    id: record.id.clone(),
                    thread_id: record.thread_id,
                    turn_id: record.turn_id.clone(),
                    request_id: record.request_id.clone(),
                    response_id: None,
                    received: ReceivedResponseFact {
                        upstream_request_id: None,
                        fact: ResponseFact::CaptureTruncated,
                    },
                };
                let marker_bytes = serde_json::to_vec(&marker)?.len();
                ensure!(
                    marker_bytes <= codex_protocol::response_facts::RESPONSE_FACT_BYTES,
                    "Native fact identity exceeds retention budget"
                );
                let overhead = serde_json::to_vec(&record)?.len()
                    - serde_json::to_vec(&record.received.fact)?.len();
                let fact =
                    std::mem::replace(&mut record.received.fact, ResponseFact::CaptureTruncated);
                if let Some(fact) = state
                    .fact_budget
                    .capture_retained(fact, overhead, marker_bytes)
                {
                    if matches!(fact, ResponseFact::CaptureTruncated) {
                        record = marker;
                    } else {
                        record.received.fact = fact;
                    }
                    state
                        .journal
                        .push("response_fact", serde_json::to_value(record)?);
                }
            }
            ResponseEvent::Created { response_id } => {
                if let Some(id) = response_id {
                    state.response_id(id)?;
                }
            }
            ResponseEvent::OutputItemAdded(item) => match &item {
                ResponseItem::Message { id, role, .. } if role == "assistant" => {
                    state.active_item = id.as_ref().map(|id| id.as_str().to_owned());
                }
                ResponseItem::Reasoning { .. } => {}
                _ => return Err(integrity(ResponseIntegrityReason::UndecodableOutputItem)),
            },
            ResponseEvent::OutputTextDelta(delta) => {
                let item_id = state
                    .active_item
                    .as_ref()
                    .ok_or_else(|| integrity(ResponseIntegrityReason::UndecodableOutputItem))?;
                state
                    .journal
                    .push("output_text_delta", json!({"itemId":item_id,"delta":delta}));
            }
            ResponseEvent::OutputItemDone(item) => {
                match &item {
                    ResponseItem::Message {
                        role,
                        content,
                        phase,
                        ..
                    } if role == "assistant" => {
                        let mut text = String::new();
                        for part in content {
                            match part {
                                ContentItem::OutputText { text: part, .. }
                                | ContentItem::InputText { text: part } => text.push_str(&part),
                                _ => {
                                    return Err(integrity(
                                        ResponseIntegrityReason::UndecodableOutputItem,
                                    ));
                                }
                            }
                        }
                        // Separate Session blank-answer and Core visible-message projections.
                        let blank = !content.is_empty() && text.trim().is_empty();
                        if !blank || matches!(phase, Some(MessagePhase::FinalAnswer)) {
                            state.blank_final = blank;
                        }
                        state.final_output.get_or_insert_with(String::new);
                        let (visible, _) = strip_citations(&text);
                        if !visible.trim().is_empty() {
                            state.final_output = Some(visible);
                        }
                        state.active_item = None;
                    }
                    ResponseItem::Reasoning { .. } => {}
                    _ => return Err(integrity(ResponseIntegrityReason::UndecodableOutputItem)),
                }
                history.push(item);
            }
            ResponseEvent::Completed {
                response_id,
                token_usage,
                usage_metadata,
                end_turn,
            } => {
                if end_turn == Some(false) {
                    return Err(integrity(
                        ResponseIntegrityReason::MissingSupportedTerminalOutput,
                    ));
                }
                state.response_id(response_id)?;
                state.completed = true;
                if let Some(usage) = token_usage {
                    let exact = crate::usage::exact_usage(&usage);
                    state.usage = json!({"total_token_usage":exact,"last_token_usage":exact,"model_context_window":state.context_window});
                }
                state.usage_metadata = serde_json::to_value(usage_metadata)?;
                state.journal.push("token_count", state.token_count());
            }
            ResponseEvent::RateLimits(limits) => {
                state.rate_limits = serde_json::to_value(limits)?;
                state.journal.push("token_count", state.token_count());
            }
            ResponseEvent::ApiRateLimits(limits) => state.record_api_limits(&limits)?,
            ResponseEvent::ServerModel(_)
            | ResponseEvent::ServerReasoningIncluded(_)
            | ResponseEvent::ReasoningSummaryDelta { .. }
            | ResponseEvent::ReasoningSummaryDone { .. }
            | ResponseEvent::ReasoningContentDelta { .. }
            | ResponseEvent::ReasoningSummaryPartAdded { .. }
            | ResponseEvent::ModelsEtag(_)
            | ResponseEvent::ModelVerifications(_)
            | ResponseEvent::TurnModerationMetadata(_)
            | ResponseEvent::SafetyBuffering(_) => {}
            _ => return Err(integrity(ResponseIntegrityReason::UndecodableOutputItem)),
        }
    }
    ensure!(state.completed, "Model response ended without completion");
    if state.final_output.is_none() {
        return Err(integrity(
            ResponseIntegrityReason::MissingSupportedTerminalOutput,
        ));
    }
    Ok(())
}
