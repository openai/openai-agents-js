//! Node ownership and asynchronous boundaries for the unchanged Codex runtime.

#![recursion_limit = "256"]

use codex_otel::sdk_trace::FutureExt as _;
use napi::bindgen_prelude::Either;
use napi_derive::napi;
use opentelemetry::trace::TraceContextExt as _;

mod agent_profiles;
mod application_instructions;
mod auth;
mod canonical_rules;
mod checkpoint;
mod commands;
mod config;
mod context;
mod custom_storage;
mod engine;
mod environment;
mod extensions;
mod goals;
mod graph_stop;
mod initial_messages;
mod local_reconciliation;
mod local_storage;
mod mcp_result_control;
mod mcp_roster;
mod model_websocket;
mod native_agents;
mod native_interception;
mod node_runtime;
mod ops;
mod options;
mod project_search;
mod provider_error;
mod provider_transports;
mod python_tools;
mod realtime_adapter;
mod recovery_guard;
mod response_control;
mod response_integrity;
mod storage;
mod subagents;
mod telemetry;
mod turn_settlement;
mod usage;
mod verification;

use std::{collections::BTreeMap, sync::Arc};

use codex_http_client::{ByteStream, HttpTransport, ReqwestTransport, TransportError};
use serde_json::{Value, value::RawValue};

// Preserve JSON syntax before serde's arbitrary-precision visitor can interpret
// a literal object as one of its private number/raw-value markers.
fn checkpoint_json_value(raw: &RawValue, depth: usize) -> serde_json::Result<Value> {
    match raw.get().as_bytes().first() {
        Some(b'{' | b'[') if depth >= 127 => {
            Err(serde::de::Error::custom("recursion limit exceeded"))
        }
        Some(b'{') => {
            let fields: BTreeMap<String, &RawValue> = serde_json::from_str(raw.get())?;
            fields
                .into_iter()
                .map(|(key, value)| Ok((key, checkpoint_json_value(value, depth + 1)?)))
                .collect::<Result<_, _>>()
                .map(Value::Object)
        }
        Some(b'[') => {
            let values: Vec<&RawValue> = serde_json::from_str(raw.get())?;
            values
                .into_iter()
                .map(|value| checkpoint_json_value(value, depth + 1))
                .collect::<Result<_, _>>()
                .map(Value::Array)
        }
        _ => serde_json::from_str(raw.get()),
    }
}

fn checkpoint_wire_value(payload_json: &str) -> anyhow::Result<Value> {
    let mut raw = checkpoint_json_value(serde_json::from_str(payload_json)?, 0)?;
    usage::checkpoint_from_wire(&mut raw)?;
    Ok(raw)
}

fn native_error(error: impl std::fmt::Display) -> napi::Error {
    napi::Error::new(napi::Status::GenericFailure, error.to_string())
}

fn instruction_history(history_json: &str) -> napi::Result<Vec<codex_history::RolloutItem>> {
    let mut history =
        checkpoint_json_value(serde_json::from_str(history_json).map_err(native_error)?, 0)
            .map_err(native_error)?;
    usage::history_from_wire(&mut history).map_err(native_error)?;
    application_instructions::decode(history).map_err(native_error)
}

#[napi(js_name = "_read_session_instructions")]
pub fn _read_session_instructions(history_json: String) -> napi::Result<String> {
    application_instructions::latest(&instruction_history(&history_json)?)
        .map_err(native_error)?
        .map(|accepted| accepted.text)
        .ok_or_else(|| input_error("Checkpoint has no accepted application instructions"))
}

#[napi(js_name = "_agent_profiles_fingerprint")]
pub fn _agent_profiles_fingerprint(roster_json: String, root_id: String) -> napi::Result<String> {
    agent_profiles::fingerprint(&roster_json, &root_id).map_err(input_error)
}

#[napi(js_name = "_agent_profiles_restore_source")]
pub fn _agent_profiles_restore_source(
    roster_json: String,
    root_id: String,
    history_json: String,
) -> napi::Result<String> {
    let opening = agent_profiles::OpeningProfiles {
        fingerprint: agent_profiles::fingerprint(&roster_json, &root_id).map_err(input_error)?,
        root_id,
        roster: serde_json::from_str(&roster_json).map_err(input_error)?,
    };
    let source = agent_profiles::restore_source(&opening, &instruction_history(&history_json)?)
        .map_err(input_error)?;
    serde_json::to_string(&source).map_err(native_error)
}

#[napi(js_name = "_agent_profiles_operation_source")]
pub fn _agent_profiles_operation_source(
    roster_json: String,
    root_id: String,
    history_json: String,
    turn_id: String,
) -> napi::Result<String> {
    let opening = agent_profiles::OpeningProfiles {
        fingerprint: agent_profiles::fingerprint(&roster_json, &root_id).map_err(input_error)?,
        root_id,
        roster: serde_json::from_str(&roster_json).map_err(input_error)?,
    };
    let source =
        agent_profiles::operation_source(&opening, &instruction_history(&history_json)?, &turn_id)
            .map_err(input_error)?;
    serde_json::to_string(&source).map_err(native_error)
}

/// Pinned command metadata only: this opens no engine or model service.
#[napi(js_name = "_embedded_commands")]
pub fn _embedded_commands() -> napi::Result<String> {
    serde_json::to_string(&commands::catalog()).map_err(native_error)
}

/// Native history preflight before Agent.session acquires an engine/provider.
#[napi(js_name = "_validate_application_instructions")]
pub fn _validate_application_instructions(
    history_json: String,
    instructions: Option<String>,
) -> napi::Result<bool> {
    application_instructions::validate(
        &instruction_history(&history_json)?,
        instructions.as_deref().unwrap_or(""),
    )
    .map(|accepted| accepted.is_some())
    .map_err(native_error)
}

/// Pure declaration preflight before Agent.session acquires runtime resources.
#[napi(js_name = "_validate_python_tool_declarations")]
pub fn _validate_python_tool_declarations(specs_json: String) -> napi::Result<()> {
    let specs: Vec<codex_protocol::dynamic_tools::DynamicToolSpec> =
        serde_json::from_str(&specs_json).map_err(input_error)?;
    python_tools::validate_declarations(&specs).map_err(input_error)
}

fn input_error(error: impl std::fmt::Display) -> napi::Error {
    napi::Error::new(napi::Status::InvalidArg, error.to_string())
}

fn native_id(value: &str) -> napi::Result<u64> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|ch| ch.is_ascii_digit())
    {
        return Err(input_error(
            "Native identity must be a canonical unsigned decimal string",
        ));
    }
    value
        .parse()
        .map_err(|_| input_error("Native identity is out of range"))
}

// Capture transport input on the JS thread, before another JS callback can mutate the Buffer.
pub struct NativeBuffer(Vec<u8>);

impl napi::bindgen_prelude::TypeName for NativeBuffer {
    fn type_name() -> &'static str {
        "Buffer"
    }

    fn value_type() -> napi::ValueType {
        napi::ValueType::Object
    }
}

impl napi::bindgen_prelude::ValidateNapiValue for NativeBuffer {}

impl napi::bindgen_prelude::FromNapiValue for NativeBuffer {
    unsafe fn from_napi_value(
        env: napi::sys::napi_env,
        value: napi::sys::napi_value,
    ) -> napi::Result<Self> {
        let buffer = unsafe {
            <napi::bindgen_prelude::Buffer as napi::bindgen_prelude::FromNapiValue>::from_napi_value(
                env, value,
            )?
        };
        Ok(Self(buffer.to_vec()))
    }
}

// Native finalizers may run after napi has retired its current runtime.
// Retain the originating handle instead of looking up a newer or empty runtime.
struct RuntimeOwned<T> {
    value: Option<Arc<T>>,
    runtime: tokio::runtime::Handle,
}

impl<T> RuntimeOwned<T> {
    fn new(value: Arc<T>) -> Self {
        Self {
            value: Some(value),
            runtime: tokio::runtime::Handle::current(),
        }
    }
}

// A current() snapshot can outlive the wrapper's slot while close runs on Tokio.
impl<T> Clone for RuntimeOwned<T> {
    fn clone(&self) -> Self {
        Self {
            value: Some(Arc::clone(self)),
            runtime: self.runtime.clone(),
        }
    }
}

impl<T> std::ops::Deref for RuntimeOwned<T> {
    type Target = Arc<T>;

    fn deref(&self) -> &Self::Target {
        self.value.as_ref().expect("native owner already dropped")
    }
}

impl<T> Drop for RuntimeOwned<T> {
    fn drop(&mut self) {
        let _entered = self.runtime.enter();
        drop(self.value.take());
    }
}

// Only an empty owner is created on Node; physical clients stay lazy in Core.
#[napi(js_name = "_ProviderHttpTransports")]
pub struct ProviderHttpTransports {
    inner: RuntimeOwned<provider_transports::ProviderTransports>,
    environment: usize,
}

impl ProviderHttpTransports {
    fn for_engine(
        &self,
        env: &napi::Env,
        engine: &RuntimeOwned<engine::EngineState>,
    ) -> napi::Result<Arc<provider_transports::ProviderTransports>> {
        if self.environment != env.raw() as usize || self.inner.runtime.id() != engine.runtime.id()
        {
            return Err(native_error(
                "Provider transports belong to another Node runtime",
            ));
        }
        self.inner.check_open().map_err(native_error)?;
        Ok(Arc::clone(&self.inner))
    }
}

#[napi]
impl ProviderHttpTransports {
    // Drops cached handles only. Core exposes no asynchronous transport drain.
    #[napi]
    pub fn close(&self) {
        let _entered = self.inner.runtime.enter();
        self.inner.close();
    }
}

#[napi(js_name = "_create_provider_http_transports")]
pub fn create_provider_http_transports(
    env: napi::Env,
    engine: &Engine,
) -> napi::Result<ProviderHttpTransports> {
    let engine = engine.current()?;
    let _permit = engine.operation(false).map_err(native_error)?;
    Ok(ProviderHttpTransports {
        inner: RuntimeOwned {
            value: Some(Arc::new(provider_transports::ProviderTransports::default())),
            runtime: engine.runtime.clone(),
        },
        environment: env.raw() as usize,
    })
}

#[napi(js_name = "Engine")]
pub struct Engine {
    inner: Arc<std::sync::Mutex<EngineOwner>>,
    startup_warnings: Vec<String>,
}

struct EngineOwner {
    live: Option<RuntimeOwned<engine::EngineState>>,
    // A receiver holds no Environment/Engine. Keep it across cancelled or timed
    // out closes so retry cannot report completion before the senders drop.
    remote_drain:
        Option<tokio::sync::watch::Receiver<codex_exec_server::EnvironmentConnectionState>>,
    // Completion diagnostics survive a cancelled or timed-out remote drain.
    close_diagnostic: Option<String>,
}

impl Engine {
    fn new(state: engine::EngineState) -> Self {
        if let Some(store) = state
            .store
            .as_any()
            .downcast_ref::<storage::MemoryThreadStore>()
        {
            store.bind_fork_boundary(&state.interception);
        }
        let startup_warnings = state.startup_warnings.clone();
        let state = Arc::new(state);
        state.interception.bind_engine(Arc::downgrade(&state));
        Self {
            inner: Arc::new(std::sync::Mutex::new(EngineOwner {
                live: Some(RuntimeOwned::new(state)),
                remote_drain: None,
                close_diagnostic: None,
            })),
            startup_warnings,
        }
    }

    fn current(&self) -> napi::Result<RuntimeOwned<engine::EngineState>> {
        Self::current_owner(&self.inner)
    }

    async fn start_native_thread(
        &self,
        options_json: &str,
        specs_json: &str,
        initial_messages_json: Option<&str>,
    ) -> anyhow::Result<NativeThread> {
        let inner = self
            .current()
            .map_err(|error| anyhow::anyhow!(error.reason))?;
        let options: options::ThreadOptions = config::decode(serde_json::from_str(options_json)?)?;
        let initial_messages = initial_messages_json
            .map(initial_messages::Batch::capture)
            .transpose()?;
        if initial_messages.is_some() {
            options.validate_initial_messages()?;
        }
        let specs = serde_json::from_str(specs_json)?;
        let _context_operation = inner.operation(false)?;
        match initial_messages {
            Some(batch) => {
                inner
                    .start_with_initial_messages(options, specs, Some(batch))
                    .await
            }
            None => inner.start_with_tools(options, specs).await,
        }
    }

    fn current_owner(
        owner: &std::sync::Mutex<EngineOwner>,
    ) -> napi::Result<RuntimeOwned<engine::EngineState>> {
        owner
            .lock()
            .map_err(native_error)?
            .live
            .as_ref()
            .cloned()
            .ok_or_else(|| native_error("Codex engine is closed"))
    }
}

#[napi]
impl Engine {
    #[napi(js_name = "_sentinel_bind")]
    pub fn _sentinel_bind(
        &self,
        env: napi::Env,
        base: String,
        grant: String,
        excluded_base: Option<String>,
        shared_transports: Option<&ProviderHttpTransports>,
    ) -> napi::Result<()> {
        let inner = self.current()?;
        let _permit = inner.operation(false).map_err(native_error)?;
        let mut binding = inner.sentinel.write().expect("sentinel poisoned");
        if binding.is_some() || grant.is_empty() {
            return Err(native_error("Sentinel already bound or empty"));
        }
        if let Some(shared) = shared_transports {
            if inner
                .transport_binding_sealed
                .load(std::sync::atomic::Ordering::Acquire)
            {
                return Err(native_error(
                    "Provider transports must bind before root startup",
                ));
            }
            let shared = shared.for_engine(&env, &inner)?;
            inner
                .provider_http_transports
                .set(shared)
                .map_err(|_| native_error("Provider transports already bound"))?;
        }
        *binding = Some((base, grant, excluded_base));
        Ok(())
    }

    #[napi(js_name = "_sentinel_admit")]
    pub async fn _sentinel_admit(
        &self,
        provider_id: String,
        metadata: String,
    ) -> napi::Result<String> {
        let inner = self.current()?;
        (async move {
            let _permit = inner.operation(false).map_err(native_error)?;
            let meta = serde_json::from_str(&metadata).map_err(native_error)?;
            native_interception::sentinel_admit(&inner, &provider_id, &meta)
                .await
                .map_err(native_error)
        })
        .await
    }

    #[napi(js_name = "_sentinel_restore_schemas")]
    pub async fn _sentinel_restore_schemas(
        &self,
        provider_id: String,
        ticket: String,
        body: String,
    ) -> napi::Result<String> {
        let inner = self.current()?;
        let _permit = inner.operation(false).map_err(native_error)?;
        let meta = serde_json::from_str(&ticket).map_err(native_error)?;
        let mut body = serde_json::from_str(&body).map_err(native_error)?;
        native_interception::sentinel_restore_schemas(&inner, &provider_id, &meta, &mut body)
            .await
            .map_err(native_error)?;
        serde_json::to_string(&body).map_err(native_error)
    }

    #[napi(js_name = "_sentinel_open")]
    pub async fn _sentinel_open(
        &self,
        provider_id: String,
        headers: String,
    ) -> napi::Result<model_websocket::NativeModelWebSocket> {
        let inner = self.current()?;
        (async move {
            let _permit = inner.operation(false).map_err(native_error)?;
            let route = inner.sentinel_route(&provider_id, &headers)?;
            model_websocket::sentinel_open(route, &headers).await
        })
        .await
    }

    #[napi(js_name = "_sentinel_websocket_failed")]
    pub async fn _sentinel_websocket_failed(
        &self,
        provider_id: String,
        ticket: String,
        oversized: bool,
    ) -> napi::Result<()> {
        let inner = self.current()?;
        (async move {
            let _permit = inner.operation(false).map_err(native_error)?;
            let ticket = serde_json::from_str(&ticket).map_err(native_error)?;
            native_interception::sentinel_failed(
                &inner,
                &provider_id,
                &ticket,
                native_interception::SentinelFailure::WebSocket { oversized },
            )
            .map_err(native_error)
        })
        .await
    }

    #[napi(js_name = "_sentinel_stream")]
    pub async fn _sentinel_stream(
        &self,
        provider_id: String,
        headers: String,
        body: NativeBuffer,
        ticket: String,
        request: &ModelHttpRequest,
    ) -> napi::Result<NativeModelResponse> {
        let body = body.0;
        let inner = self.current()?;
        let cancelled = request.cancelled.clone();
        let work = async {
            let ticket = serde_json::from_str(&ticket).map_err(native_error)?;
            let (status, headers, body) = sentinel_stream_dispatch(
                &inner,
                &provider_id,
                &headers,
                body.into(),
                &ticket,
                None,
            )
            .await?;
            Ok(NativeModelResponse {
                inner: RuntimeOwned::new(Arc::new(tokio::sync::Mutex::new(body))),
                cancelled: cancelled.clone(),
                status: status.as_u16(),
                headers: headers
                    .iter()
                    .map(|(n, v)| {
                        (
                            n.to_string(),
                            String::from_utf8_lossy(v.as_bytes()).into_owned(),
                        )
                    })
                    .collect(),
            })
        };
        tokio::select! {
            biased;
            _ = cancelled.cancelled() => Err(napi::Error::from_reason("Native model request cancelled")),
            result = work => result,
        }
    }

    #[napi(js_name = "restore_checkpoint")]
    pub async fn restore_checkpoint(
        &self,
        payload_json: String,
        options_json: String,
        specs_json: Option<String>,
        fresh_manual: Option<bool>,
    ) -> napi::Result<NativeThread> {
        let payload_json = payload_json.as_str();
        let options_json = options_json.as_str();
        let specs_json = specs_json.as_deref();

        let inner = self.current()?;
        let raw = checkpoint_wire_value(payload_json).map_err(native_error)?;
        let mut options: options::ThreadOptions =
            config::decode(serde_json::from_str(options_json).map_err(native_error)?)
                .map_err(native_error)?;
        options
            .validate_instruction_json(&raw["history"])
            .map_err(native_error)?;
        let specs = specs_json
            .map(serde_json::from_str)
            .transpose()
            .map_err(native_error)?;
        let specs = checkpoint::restore_specs(&raw, &mut options, specs).map_err(input_error)?;
        let payload = serde_json::from_value(raw).map_err(native_error)?;
        (async move {
            let _context_operation = inner.operation(false).map_err(native_error)?;
            checkpoint::restore(
                &inner,
                payload,
                options,
                specs,
                fresh_manual.unwrap_or(false),
            )
            .await
            .map_err(native_error)
        })
        .await
    }
    #[napi(getter, js_name = "startup_warnings")]
    pub fn startup_warnings(&self) -> Vec<String> {
        self.startup_warnings.clone()
    }

    #[napi(js_name = "start_replaceable_thread")]
    pub async fn start_replaceable_thread(
        &self,
        options_json: String,
        specs_json: String,
    ) -> napi::Result<NativeThread> {
        Box::pin(self.start_native_thread(&options_json, &specs_json, None))
            .await
            .map_err(native_error)
    }

    // A distinct private initializer fails closed against an older native addon.
    #[napi(js_name = "_start_seeded_replaceable_thread")]
    pub async fn start_seeded_replaceable_thread(
        &self,
        options_json: String,
        specs_json: String,
        initial_messages_json: String,
    ) -> napi::Result<NativeThread> {
        self.start_native_thread(&options_json, &specs_json, Some(&initial_messages_json))
            .await
            .map_err(native_error)
    }

    #[napi(js_name = "_start_local_resume")]
    pub async fn start_local_resume(
        &self,
        options_json: String,
        specs_json: String,
    ) -> napi::Result<Either<NativeThread, String>> {
        match self
            .start_native_thread(&options_json, &specs_json, None)
            .await
        {
            Ok(thread) => Ok(Either::A(thread)),
            Err(error) => match error.downcast::<local_reconciliation::RecoveryRequired>() {
                Ok(hold) => {
                    let history = usage::history_to_wire(&hold.history).map_err(native_error)?;
                    let snapshot = serde_json::json!({ "calls": hold.calls, "history": history });
                    Ok(Either::B(snapshot.to_string()))
                }
                Err(error) => Err(native_error(error)),
            },
        }
    }

    #[napi(getter, js_name = "_private_reuse_ready")]
    pub fn private_reuse_ready(&self) -> napi::Result<bool> {
        Ok(self.current()?.private_reuse_ready())
    }

    #[napi(js_name = "_private_start_thread")]
    pub async fn private_start_thread(
        &self,
        config_json: String,
        runtime_json: String,
        origin: String,
        grant: String,
        options_json: String,
        specs_json: String,
    ) -> napi::Result<Option<NativeThread>> {
        let current = self.current()?;
        let _operation = current.operation(false).map_err(native_error)?;
        let options = config::decode(serde_json::from_str(&options_json).map_err(native_error)?)
            .map_err(native_error)?;
        let specs = serde_json::from_str(&specs_json).map_err(native_error)?;
        current
            .private_start_with_tools(&config_json, &runtime_json, &origin, &grant, options, specs)
            .await
            .map_err(native_error)
    }

    #[napi(js_name = "close")]
    pub async fn close(&self) -> napi::Result<()> {
        if let Some(diagnostic) = self.close_owned().await? {
            return Err(native_error(diagnostic));
        }
        Ok(())
    }

    #[napi(js_name = "_close_report")]
    pub async fn _close_report(&self) -> napi::Result<Option<String>> {
        self.close_owned().await
    }
}

impl Engine {
    async fn close_owned(&self) -> napi::Result<Option<String>> {
        Self::close_owner(Arc::clone(&self.inner)).await
    }

    async fn close_owner(
        owner: Arc<std::sync::Mutex<EngineOwner>>,
    ) -> napi::Result<Option<String>> {
        (async move {
            let deadline = tokio::time::Instant::now() + engine::CLOSE_TIMEOUT;
            let current = owner.lock().map_err(native_error)?.live.as_ref().cloned();
            if let Some(inner) = current {
                let _context_operation = inner.operation(true).map_err(native_error)?;
                let diagnostic = inner.close_report().await.map_err(native_error)?;
                // Shutdown has completed; release retained native thread slots before draining.
                inner.release_native_threads();
                let mut state = owner.lock().map_err(native_error)?;
                if state.live.is_some() {
                    state.close_diagnostic = diagnostic;
                    state.remote_drain = inner
                        .manager
                        .environment_manager()
                        .get_environment(codex_exec_server::REMOTE_ENVIRONMENT_ID)
                        .and_then(|environment| environment.subscribe_connection_state());
                    state.live.take();
                }
            }
            // Drop every local live owner before waiting. Concurrent closers each
            // own a receiver, and never hold the slot mutex across the await.
            let drain = owner.lock().map_err(native_error)?.remote_drain.clone();
            if let Some(mut receiver) = drain {
                tokio::time::timeout_at(deadline, async {
                    while receiver.changed().await.is_ok() {}
                })
                .await
                .map_err(|_| native_error("Codex environment shutdown timed out"))?;
                owner.lock().map_err(native_error)?.remote_drain.take();
            }
            Ok(owner.lock().map_err(native_error)?.close_diagnostic.clone())
        })
        .await
    }
}

// The shared slot is the sole finalization owner. Private context leases may
// retain it after a JavaScript wrapper disappears; aliases never initiate close.
impl Drop for EngineOwner {
    fn drop(&mut self) {
        if let Some(inner) = self.live.take() {
            inner.runtime.clone().spawn(async move {
                let _ = inner.close().await;
            });
        }
    }
}

#[napi(js_name = "NativeThread")]
pub struct NativeThread {
    inner: Arc<std::sync::Mutex<NativeThreadOwner>>,
    id: String,
    rollout_path: Option<String>,
    fork_source: Option<std::sync::Weak<engine::ThreadState>>,
}

struct NativeThreadOwner {
    live: Option<RuntimeOwned<engine::ThreadState>>,
    interception_reader: tokio_util::sync::CancellationToken,
    mcp_result_reader: tokio_util::sync::CancellationToken,
    resource_requests_stop: tokio_util::sync::CancellationToken,
}

/// A private single-use bridge receipt. Keep the reservation through native
/// settlement and SDK callback cleanup; release it only when both have joined.
#[napi(js_name = "_NativePolicyStop")]
pub struct NativePolicyStop {
    receipt: tokio::sync::Mutex<
        Option<(
            RuntimeOwned<engine::ThreadState>,
            native_interception::HeldPolicyStop,
        )>,
    >,
}
#[napi]
impl NativePolicyStop {
    #[napi]
    pub async fn finish(&self) -> napi::Result<()> {
        let (state, receipt) = self
            .receipt
            .lock()
            .await
            .take()
            .ok_or_else(|| native_error("Native policy stop already consumed"))?;
        let _operation = state.engine.operation(false).map_err(native_error)?;
        receipt
            .finish(&state.engine.manager)
            .await
            .map_err(native_error)
    }
}

#[napi(js_name = "_NativeGraphStop")]
pub struct NativeGraphStop {
    receipt: Arc<tokio::sync::Mutex<Option<GraphStopReceipt>>>,
}

struct GraphStopReceipt {
    state: RuntimeOwned<engine::ThreadState>,
    request: graph_stop::Request,
    started: bool,
}

#[napi]
impl NativeGraphStop {
    #[napi]
    pub async fn settle(&self) -> napi::Result<()> {
        let receipt = Arc::clone(&self.receipt);
        tokio::spawn(async move {
            let mut slot = receipt.lock().await;
            let current = slot
                .as_mut()
                .ok_or_else(|| native_error("Native graph stop already released"))?;
            if std::mem::replace(&mut current.started, true) {
                return Err(native_error("Native graph stop already settled"));
            }
            let result = current.request.settle(&current.state).await;
            if result.is_err() {
                // Preserve the failed fence immediately, before SDK cleanup.
                slot.take();
            }
            result.map_err(native_error)
        })
        .await
        .map_err(native_error)?
    }

    #[napi]
    pub fn release(&self, success: bool) -> napi::Result<()> {
        if let Some(mut current) = self.receipt.try_lock().map_err(native_error)?.take() {
            if success {
                if !current.started {
                    return Err(native_error("Native graph stop has not settled"));
                }
                current.request.complete();
            }
        }
        Ok(())
    }
}

impl NativeThreadOwner {
    // Call only after completed thread or engine shutdown, including a retained
    // diagnostic. Incomplete shutdown leaves the slot live for retry.
    fn release(&mut self) {
        self.interception_reader.cancel();
        self.mcp_result_reader.cancel();
        self.resource_requests_stop.cancel();
        // Engine shutdown need not join the JS event reader. Settle this
        // owner's receipts while the slot still identifies the right state;
        // the reader's later finally may find the slot already empty.
        if let Some(inner) = self.live.as_ref() {
            inner
                .finish_child_event_reader()
                .expect("native child state unavailable during owner release");
        }
        self.live.take();
    }
}

impl NativeThread {
    fn new(state: Arc<engine::ThreadState>) -> Self {
        let id = state.id.to_string();
        let rollout_path = state
            .thread
            .rollout_path()
            .map(|p| p.to_string_lossy().into_owned());
        let inner = Arc::new(std::sync::Mutex::new(NativeThreadOwner {
            live: Some(RuntimeOwned::new(Arc::clone(&state))),
            interception_reader: tokio_util::sync::CancellationToken::new(),
            mcp_result_reader: tokio_util::sync::CancellationToken::new(),
            resource_requests_stop: tokio_util::sync::CancellationToken::new(),
        }));
        state.engine.register_native_thread(&inner);
        Self {
            inner,
            id,
            rollout_path,
            fork_source: None,
        }
    }

    fn live(&self) -> napi::Result<Option<RuntimeOwned<engine::ThreadState>>> {
        Ok(self
            .inner
            .lock()
            .map_err(native_error)?
            .live
            .as_ref()
            .cloned())
    }

    fn current(&self) -> napi::Result<RuntimeOwned<engine::ThreadState>> {
        let inner = self
            .live()?
            .ok_or_else(|| native_error("Codex thread is closed"))?;
        inner.instructions.check_usable().map_err(native_error)?;
        Ok(inner)
    }

    fn native_interception(&self) -> napi::Result<Option<Arc<native_interception::Control>>> {
        self.live()?
            .map(|inner| {
                inner
                    .thread
                    .thread_extension_data()
                    .get::<native_interception::Control>()
                    .ok_or_else(|| native_error("native interception was not initialized"))
            })
            .transpose()
    }

    fn mcp_result_control(
        &self,
    ) -> napi::Result<Option<Arc<mcp_result_control::McpResultControl>>> {
        self.live()?
            .map(|inner| {
                inner
                    .thread
                    .thread_extension_data()
                    .get::<mcp_result_control::McpResultControl>()
                    .ok_or_else(|| native_error("native MCP result control was not initialized"))
            })
            .transpose()
    }

    fn response_control(&self) -> napi::Result<Arc<response_control::ResponseControl>> {
        self.current()?
            .thread
            .thread_extension_data()
            .get::<response_control::ResponseControl>()
            .ok_or_else(|| native_error("native response control was not initialized"))
    }

    async fn close_owned(&self, selected_environment: bool) -> napi::Result<Option<String>> {
        self.close_owned_mode(selected_environment, false).await
    }

    async fn close_owned_mode(
        &self,
        selected_environment: bool,
        retire_private: bool,
    ) -> napi::Result<Option<String>> {
        self.inner
            .lock()
            .map_err(native_error)?
            .resource_requests_stop
            .cancel();
        let Some(inner) = self.live()? else {
            return Ok(None);
        };
        let _context_operation = inner.engine.operation(true).map_err(native_error)?;
        let ack_error = if selected_environment {
            inner
                .close_selected_environment()
                .await
                .map_err(native_error)?
        } else {
            inner.close_report().await.map_err(native_error)?
        };
        // A completed diagnostic does not leave a live thread. Shutdown failure
        // returns above, retaining the existing incomplete-close retry path.
        if retire_private && ack_error.is_none() {
            inner
                .engine
                .retire_private_thread(&inner)
                .await
                .map_err(native_error)?;
            inner.engine.retire_private_registration(&self.inner);
        }
        self.inner.lock().map_err(native_error)?.release();
        Ok(ack_error)
    }
}

// A prospective replacement remains owned before native construction starts.
#[napi(js_name = "_ContextChange")]
pub struct ContextChange {
    change: tokio::sync::Mutex<Option<RuntimeOwned<context::Change>>>,
    candidate: std::sync::Mutex<Option<Arc<std::sync::Mutex<EngineOwner>>>>,
    prospective: std::sync::Mutex<Option<RuntimeOwned<codex_core_api::EnvironmentManager>>>,
    remote_drain: std::sync::Mutex<
        Option<tokio::sync::watch::Receiver<codex_exec_server::EnvironmentConnectionState>>,
    >,
    creation_started: std::sync::atomic::AtomicBool,
    candidate_events_stop: tokio_util::sync::CancellationToken,
    candidate_events_remaining: std::sync::Mutex<Option<usize>>,
    candidate_publication_stop: tokio_util::sync::CancellationToken,
}

#[napi]
impl ContextChange {
    #[napi]
    pub async fn context(&self) -> napi::Result<String> {
        serde_json::to_string(
            &self
                .change
                .lock()
                .await
                .as_ref()
                .ok_or_else(|| native_error("context change is released"))?
                .context(),
        )
        .map_err(native_error)
    }

    #[napi]
    pub async fn options(&self) -> napi::Result<String> {
        serde_json::to_string(
            &self
                .change
                .lock()
                .await
                .as_ref()
                .ok_or_else(|| native_error("context change is released"))?
                .options(),
        )
        .map_err(native_error)
    }

    #[napi]
    pub async fn prepare(
        &self,
        summary: String,
        retained_indices: Vec<u32>,
    ) -> napi::Result<String> {
        let mut checkpoint = self
            .change
            .lock()
            .await
            .as_ref()
            .ok_or_else(|| native_error("context change is released"))?
            .prepare(&summary, retained_indices)
            .map_err(native_error)?;
        usage::checkpoint_to_wire(&mut checkpoint).map_err(native_error)?;
        serde_json::to_string(&checkpoint).map_err(native_error)
    }

    #[napi(js_name = "createCandidateEngine")]
    pub async fn create_candidate_engine(
        &self,
        api_key: Option<String>,
        mcp_servers_json: Option<String>,
    ) -> napi::Result<Engine> {
        if self
            .creation_started
            .swap(true, std::sync::atomic::Ordering::AcqRel)
        {
            return Err(native_error(
                "context change already owns a candidate creation",
            ));
        }
        let locked = self.change.lock().await;
        let change = locked
            .as_ref()
            .ok_or_else(|| native_error("context change is released"))?;
        let mut config: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(&change.state.engine.config_json).map_err(native_error)?;
        if let Some(servers) = mcp_servers_json {
            let servers: serde_json::Map<String, serde_json::Value> =
                serde_json::from_str(&servers).map_err(native_error)?;
            config.insert("mcp_servers".into(), serde_json::Value::Object(servers));
        }
        // Context admission excludes native children and pins the current root.
        // Validate its actual model before acquiring a destination Environment.
        let initial_models = checkpoint::InitialModels {
            root_model: Some(
                change
                    .state
                    .thread
                    .config_snapshot()
                    .await
                    .collaboration_mode
                    .model()
                    .to_owned(),
            ),
            descendant_models: Vec::new(),
        };
        let runtime = environment::context_candidate_runtime(
            &change.state.thread,
            &change.state.engine.runtime_json,
        )
        .await
        .map_err(native_error)?;
        let mut state = engine::EngineState::new_owned(
            serde_json::to_string(&config).map_err(native_error)?,
            runtime,
            true,
            api_key,
            Some(&self.prospective),
            initial_models,
        )
        .await
        .map_err(native_error)?;
        state.application_apps = change.state.engine.application_apps.clone();
        let engine = Engine::new(state);
        *self.candidate.lock().map_err(native_error)? = Some(Arc::clone(&engine.inner));
        self.prospective.lock().map_err(native_error)?.take();
        Ok(engine)
    }

    #[napi(js_name = "validateCandidate")]
    pub async fn validate_candidate(&self, candidate: &NativeThread) -> napi::Result<()> {
        let state = candidate.current()?;
        let engine = self
            .candidate
            .lock()
            .map_err(native_error)?
            .clone()
            .ok_or_else(|| native_error("context change has no candidate engine"))?;
        let expected = Engine::current_owner(&engine)?;
        if !Arc::ptr_eq(&state.engine, &expected) {
            return Err(native_error("context change does not own candidate thread"));
        }
        self.change
            .lock()
            .await
            .as_ref()
            .ok_or_else(|| native_error("context change is released"))?
            .validate_candidate(&state)
            .await
            .map_err(native_error)
    }

    #[napi]
    pub async fn retire(&self) -> napi::Result<Option<String>> {
        self.change
            .lock()
            .await
            .as_ref()
            .ok_or_else(|| native_error("context change is released"))?
            .retire()
            .await
            .map_err(native_error)
    }

    #[napi]
    pub async fn fence(&self) {
        if let Some(change) = self.change.lock().await.as_ref() {
            change.fence();
        }
    }

    #[napi]
    pub async fn release(&self) {
        self.change.lock().await.take();
    }

    #[napi(js_name = "publishCandidateMcpServers")]
    pub async fn publish_candidate_mcp_servers(
        &self,
        candidate: &NativeThread,
        servers_json: String,
        policies_json: Option<String>,
        interception_rules_json: Option<String>,
    ) -> napi::Result<String> {
        {
            let state = candidate.current()?;
            let engine = self
                .candidate
                .lock()
                .map_err(native_error)?
                .clone()
                .ok_or_else(|| native_error("context change has no candidate engine"))?;
            let expected = Engine::current_owner(&engine)?;
            if !Arc::ptr_eq(&state.engine, &expected) {
                return Err(native_error(
                    "context change does not own candidate publication",
                ));
            }
        }
        tokio::select! {
            biased;
            _ = self.candidate_publication_stop.cancelled() => Err(native_error("candidate MCP publication cancelled")),
            receipt = candidate._replace_mcp_servers(servers_json, policies_json, interception_rules_json, None, None, None, None, None, None) => receipt,
        }
    }

    #[napi(js_name = "nextCandidateEvent")]
    pub async fn next_candidate_event(
        &self,
        candidate: &NativeThread,
    ) -> napi::Result<Option<String>> {
        let state = candidate.current()?;
        {
            let engine = self
                .candidate
                .lock()
                .map_err(native_error)?
                .clone()
                .ok_or_else(|| native_error("context change has no candidate engine"))?;
            let expected = Engine::current_owner(&engine)?;
            if !Arc::ptr_eq(&state.engine, &expected) {
                return Err(native_error(
                    "context change does not own candidate event reader",
                ));
            }
        }
        let event = loop {
            if self.candidate_events_stop.is_cancelled() {
                // Freeze one finite suffix for this sole reader. Core counts
                // queued events; one extra slot covers its retained native future.
                let exhausted = {
                    let mut remaining = self
                        .candidate_events_remaining
                        .lock()
                        .map_err(native_error)?;
                    let remaining = remaining
                        .get_or_insert_with(|| state.thread.queued_event_count().saturating_add(1));
                    let exhausted = *remaining == 0;
                    *remaining = remaining.saturating_sub(1);
                    exhausted
                };
                // This candidate is private and idle: its sole reader has no
                // competing discovery, child reader, or terminal settlement.
                // Only under these preconditions can Pending mean no ready event.
                // Poll the existing reader before EOF. Disabling cooperative
                // budget for this one bounded poll avoids mistaking a Tokio
                // fairness yield for an empty reader; no new task is spawned.
                let ready = tokio::select! {
                    biased;
                    event = tokio::task::unconstrained(state.next_session_event()) => Some(event),
                    _ = std::future::ready(()) => None,
                };
                if let Some(event) = ready {
                    if exhausted {
                        return Err(native_error("Compaction startup events did not quiesce"));
                    }
                    break event;
                }
                if state.thread.queued_event_count() != 0 {
                    return Err(native_error("Compaction startup event drain is incomplete"));
                }
                return Ok(None);
            }
            tokio::select! {
                biased;
                event = state.next_session_event() => break event,
                _ = self.candidate_events_stop.cancelled() => {},
            }
        };
        let value = event.map_err(native_error)?;
        serde_json::to_string(&value)
            .map(Some)
            .map_err(native_error)
    }

    #[napi(js_name = "stopCandidateEvents")]
    pub async fn stop_candidate_events(&self) {
        self.candidate_events_stop.cancel();
    }

    #[napi(js_name = "cleanupCandidate")]
    pub async fn cleanup_candidate(&self) -> napi::Result<Option<String>> {
        self.candidate_events_stop.cancel();
        self.candidate_publication_stop.cancel();
        // Serialize cleanup with construction, retaining every incomplete phase.
        let _change = self.change.lock().await;
        let candidate = self.candidate.lock().map_err(native_error)?.clone();
        let diagnostic = if let Some(candidate) = candidate {
            let diagnostic = Engine::close_owner(candidate).await?;
            self.candidate.lock().map_err(native_error)?.take();
            diagnostic
        } else {
            None
        };
        let prospective = self.prospective.lock().map_err(native_error)?.take();
        if let Some(environment) = prospective {
            let receiver = environment
                .get_environment(codex_exec_server::REMOTE_ENVIRONMENT_ID)
                .and_then(|remote| remote.subscribe_connection_state());
            *self.remote_drain.lock().map_err(native_error)? = receiver;
            drop(environment);
        }
        let drain = self.remote_drain.lock().map_err(native_error)?.clone();
        if let Some(mut receiver) = drain {
            tokio::time::timeout(engine::CLOSE_TIMEOUT, async {
                while receiver.changed().await.is_ok() {}
            })
            .await
            .map_err(|_| native_error("candidate environment shutdown timed out"))?;
            self.remote_drain.lock().map_err(native_error)?.take();
        }
        Ok(diagnostic)
    }
}

#[napi(js_name = "_RealtimeCleanup")]
pub struct RealtimeCleanup {
    inner: RuntimeOwned<codex_core::RealtimeConversationCleanup>,
    owner: std::sync::Weak<std::sync::Mutex<NativeThreadOwner>>,
}

#[napi]
impl RealtimeCleanup {
    #[napi]
    pub async fn close(&self, generation: String) -> napi::Result<()> {
        {
            let owner = self
                .owner
                .upgrade()
                .ok_or_else(|| native_error("Native thread shutdown cannot be verified"))?;
            if owner.lock().map_err(native_error)?.live.is_some() {
                return Err(native_error(
                    "Realtime cleanup requires confirmed native thread shutdown",
                ));
            }
        }
        self.inner.close(&generation).await.map_err(native_error)
    }
}

#[napi]
impl NativeThread {
    #[napi(js_name = "_fork_settled")]
    pub async fn _fork_settled(&self) -> napi::Result<NativeThread> {
        let source = self.current()?;
        retain_writer_operation(async move {
            source
                .engine
                .fork_settled(&source)
                .await
                .map_err(native_error)
        })
        .await
    }

    #[napi(js_name = "_discard_fork")]
    pub async fn _discard_fork(&self) -> napi::Result<Option<String>> {
        let source = self
            .fork_source
            .as_ref()
            .and_then(std::sync::Weak::upgrade)
            .ok_or_else(|| native_error("This thread is not an owned temporary fork"))?;
        let id = codex_protocol::ThreadId::from_string(&self.id).map_err(native_error)?;
        retain_writer_operation(async move {
            source
                .discard_fork_copy(Some(id))
                .await
                .map_err(native_error)
        })
        .await
    }

    #[napi(js_name = "_read_model_context")]
    pub async fn _read_model_context(&self) -> napi::Result<String> {
        let state = self.current()?;
        let _operation = state.engine.operation(false).map_err(native_error)?;
        let snapshot = context::read(&state).await.map_err(native_error)?;
        serde_json::to_string(&snapshot).map_err(native_error)
    }

    #[napi(js_name = "_begin_context_change")]
    pub async fn _begin_context_change(&self) -> napi::Result<ContextChange> {
        let state = self.current()?;
        let change = context::begin(Arc::clone(&state))
            .await
            .map_err(native_error)?;
        Ok(ContextChange {
            change: tokio::sync::Mutex::new(Some(RuntimeOwned::new(Arc::new(change)))),
            candidate: std::sync::Mutex::new(None),
            prospective: std::sync::Mutex::new(None),
            remote_drain: std::sync::Mutex::new(None),
            creation_started: std::sync::atomic::AtomicBool::new(false),
            candidate_events_stop: tokio_util::sync::CancellationToken::new(),
            candidate_events_remaining: std::sync::Mutex::new(None),
            candidate_publication_stop: tokio_util::sync::CancellationToken::new(),
        })
    }

    #[napi(js_name = "_application_instructions")]
    pub fn _application_instructions(&self) -> napi::Result<Option<String>> {
        let _admission_state = self.current()?;
        let _admission = _admission_state
            .engine
            .operation(false)
            .map_err(native_error)?;
        self.current()?.instructions.text().map_err(native_error)
    }

    #[napi(js_name = "_enable_native_interception")]
    pub fn _enable_native_interception(&self, timeout: f64, scope: String) -> napi::Result<bool> {
        let _admission_state = self.current()?;
        let _admission = _admission_state
            .engine
            .operation(false)
            .map_err(native_error)?;
        let scope = scope.as_str();

        let scope = serde_json::from_value(serde_json::json!(scope)).map_err(native_error)?;
        self.native_interception()?
            .ok_or_else(|| native_error("Codex thread is closed"))?
            .enable(timeout, scope)
            .map_err(native_error)?;
        // This entered native channel owns physical payload receipts, even
        // before it has delivered its first notice to the reader.
        Ok(true)
    }

    #[napi(js_name = "_configure_native_interception")]
    pub fn _configure_native_interception(&self, rules_json: String) -> napi::Result<()> {
        let _admission_state = self.current()?;
        let _admission = _admission_state
            .engine
            .operation(false)
            .map_err(native_error)?;
        let rules = serde_json::from_str(&rules_json).map_err(input_error)?;
        self.native_interception()?
            .ok_or_else(|| native_error("Codex thread is closed"))?
            .configure_tools(rules)
            .map_err(input_error)
    }

    #[napi(js_name = "_revoke_native_interception")]
    pub fn _revoke_native_interception(&self) -> napi::Result<()> {
        if let Some(control) = self.native_interception()? {
            control.revoke();
        }
        self.inner
            .lock()
            .map_err(native_error)?
            .interception_reader
            .cancel();
        Ok(())
    }

    #[napi(js_name = "_next_native_interception")]
    pub async fn _next_native_interception(&self) -> napi::Result<String> {
        let control = self
            .native_interception()?
            .ok_or_else(|| native_error("Codex thread is closed"))?;
        let cancelled = self
            .inner
            .lock()
            .map_err(native_error)?
            .interception_reader
            .clone();
        tokio::select! {
            biased;
            _ = cancelled.cancelled() => Ok("null".into()),
            notice = control.next_wire() => Ok(notice.unwrap_or_else(|| "null".into())),
        }
    }

    #[napi(js_name = "_resolve_native_interception")]
    pub fn _resolve_native_interception(&self, nonce: String, reply: String) -> napi::Result<bool> {
        let _admission_state = self.current()?;
        let _admission = _admission_state
            .engine
            .operation(false)
            .map_err(native_error)?;
        let reply = reply.as_str();

        let nonce = crate::native_id(&nonce)?;

        // A missing live slot means successful shutdown has already revoked
        // the control. Never retain the old thread just to reject a stale nonce.
        Ok(self
            .native_interception()?
            .is_some_and(|control| control.resolve(nonce, reply)))
    }

    #[napi(js_name = "_hold_native_interception_for_stop")]
    pub fn hold_native_interception_for_stop(
        &self,
        nonce: String,
    ) -> napi::Result<Option<NativePolicyStop>> {
        let state = self.current()?;
        let _operation = state.engine.operation(false).map_err(native_error)?;
        let nonce = crate::native_id(&nonce)?;
        Ok(self
            .native_interception()?
            .and_then(|control| control.hold_for_stop(nonce))
            .map(|receipt| NativePolicyStop {
                receipt: tokio::sync::Mutex::new(Some((state, receipt))),
            }))
    }

    #[napi(js_name = "_check_native_interception")]
    pub fn _check_native_interception(&self, nonce: String) -> napi::Result<bool> {
        let _admission_state = self.current()?;
        let _admission = _admission_state
            .engine
            .operation(false)
            .map_err(native_error)?;
        let nonce = crate::native_id(&nonce)?;
        Ok(self
            .native_interception()?
            .is_some_and(|control| control.can_enter(nonce)))
    }

    #[napi(js_name = "_release_native_interception")]
    pub fn _release_native_interception(&self, nonce: String) -> napi::Result<bool> {
        let nonce = crate::native_id(&nonce)?;

        Ok(self
            .native_interception()?
            .is_some_and(|control| control.release(nonce)))
    }

    #[napi(js_name = "_handoff_native_interception")]
    pub fn _handoff_native_interception(&self, nonce: String) -> napi::Result<bool> {
        let _admission_state = self.current()?;
        let _admission = _admission_state
            .engine
            .operation(false)
            .map_err(native_error)?;
        let nonce = crate::native_id(&nonce)?;

        Ok(self
            .native_interception()?
            .is_some_and(|control| control.handoff(nonce)))
    }

    #[napi(js_name = "_finish_native_interception_reader")]
    pub fn _finish_native_interception_reader(&self) -> napi::Result<()> {
        if let Some(control) = self.native_interception()? {
            control.reader_finished();
        }
        Ok(())
    }

    #[napi(js_name = "_enable_native_mcp_results")]
    pub fn _enable_native_mcp_results(&self, timeout: f64) -> napi::Result<()> {
        let _admission_state = self.current()?;
        let _admission = _admission_state
            .engine
            .operation(false)
            .map_err(native_error)?;
        self.mcp_result_control()?
            .ok_or_else(|| native_error("Codex thread is closed"))?
            .enable(timeout)
            .map_err(native_error)
    }

    #[napi(js_name = "_revoke_native_mcp_results")]
    pub fn _revoke_native_mcp_results(&self) -> napi::Result<()> {
        if let Some(control) = self.mcp_result_control()? {
            control.revoke_family();
        }
        self.inner
            .lock()
            .map_err(native_error)?
            .mcp_result_reader
            .cancel();
        Ok(())
    }

    #[napi(js_name = "_take_native_mcp_result_failure")]
    pub fn _take_native_mcp_result_failure(
        &self,
        turn_id: String,
        aborted: Option<bool>,
    ) -> napi::Result<bool> {
        let control = self
            .mcp_result_control()?
            .ok_or_else(|| native_error("Codex thread is closed"))?;
        Ok(if aborted.unwrap_or(false) {
            control.take_settled_failure(&turn_id)
        } else {
            control.take_unresolved(&turn_id)
        })
    }

    #[napi(js_name = "_next_native_mcp_result")]
    pub async fn _next_native_mcp_result(&self) -> napi::Result<String> {
        let control = self
            .mcp_result_control()?
            .ok_or_else(|| native_error("Codex thread is closed"))?;
        let cancelled = self
            .inner
            .lock()
            .map_err(native_error)?
            .mcp_result_reader
            .clone();
        tokio::select! {
            biased;
            _ = cancelled.cancelled() => Ok("null".into()),
            notice = control.next() => Ok(notice.unwrap_or_else(|| "null".into())),
        }
    }

    #[napi(js_name = "_handoff_native_mcp_result")]
    pub fn _handoff_native_mcp_result(&self, nonce: String) -> napi::Result<bool> {
        let _admission_state = self.current()?;
        let _admission = _admission_state
            .engine
            .operation(false)
            .map_err(native_error)?;
        let nonce = crate::native_id(&nonce)?;

        Ok(self
            .mcp_result_control()?
            .and_then(|control| control.owner(nonce))
            .is_some_and(|owner| owner.handoff(nonce)))
    }

    #[napi(js_name = "_release_native_mcp_result")]
    pub fn _release_native_mcp_result(&self, nonce: String) -> napi::Result<bool> {
        let nonce = crate::native_id(&nonce)?;

        Ok(self
            .mcp_result_control()?
            .is_some_and(|control| control.release_family(nonce)))
    }

    #[napi(js_name = "_resolve_native_mcp_result")]
    pub fn _resolve_native_mcp_result(
        &self,
        nonce: String,
        turn_id: String,
        call_id: String,
        reply: String,
    ) -> napi::Result<bool> {
        let _admission_state = self.current()?;
        let _admission = _admission_state
            .engine
            .operation(false)
            .map_err(native_error)?;
        let turn_id = turn_id.as_str();
        let call_id = call_id.as_str();
        let reply = reply.as_str();

        let nonce = crate::native_id(&nonce)?;

        Ok(self
            .mcp_result_control()?
            .and_then(|control| control.owner(nonce))
            .is_some_and(|owner| owner.resolve(nonce, turn_id, call_id, reply)))
    }

    #[napi(js_name = "_check_native_mcp_result")]
    pub fn _check_native_mcp_result(
        &self,
        nonce: String,
        turn_id: String,
        call_id: String,
    ) -> napi::Result<bool> {
        let _admission_state = self.current()?;
        let _admission = _admission_state
            .engine
            .operation(false)
            .map_err(native_error)?;
        let nonce = crate::native_id(&nonce)?;
        Ok(self
            .mcp_result_control()?
            .and_then(|control| control.owner(nonce))
            .is_some_and(|owner| owner.check_pending(nonce, &turn_id, &call_id)))
    }

    #[napi(js_name = "_fail_native_mcp_result")]
    pub fn _fail_native_mcp_result(
        &self,
        nonce: String,
        turn_id: String,
        call_id: String,
    ) -> napi::Result<bool> {
        let _admission_state = self.current()?;
        let _admission = _admission_state
            .engine
            .operation(false)
            .map_err(native_error)?;
        let nonce = crate::native_id(&nonce)?;
        Ok(self
            .mcp_result_control()?
            .and_then(|control| control.owner(nonce))
            .is_some_and(|owner| owner.fail_pending(nonce, &turn_id, &call_id)))
    }

    #[napi(js_name = "_read_goal")]
    pub async fn _read_goal(&self) -> napi::Result<String> {
        let inner = self.current()?;
        let _operation = inner.engine.operation(false).map_err(native_error)?;
        let _mutation = inner.mutations.lock().await;
        inner.engine.operation(false).map_err(native_error)?;
        graph_stop::check_mutation(&inner).map_err(native_error)?;
        let value = goals::read(&inner).await.map_err(native_error)?;
        serde_json::to_string(&value).map_err(native_error)
    }

    #[napi(js_name = "_set_paused_goal")]
    pub async fn _set_paused_goal(
        &self,
        objective: String,
        token_budget: Option<String>,
    ) -> napi::Result<String> {
        let inner = self.current()?;
        let _operation = inner.engine.operation(false).map_err(native_error)?;
        let _mutation = inner.mutations.lock().await;
        inner.engine.operation(false).map_err(native_error)?;
        inner.instructions.check_usable().map_err(native_error)?;
        graph_stop::check_mutation(&inner).map_err(native_error)?;
        let token_budget = token_budget
            .map(|budget| budget.parse::<i64>())
            .transpose()
            .map_err(input_error)?;
        let value = goals::set_paused(&inner, &objective, token_budget)
            .await
            .map_err(native_error)?;
        Ok(value.to_string())
    }

    // The Session owns callback settlement and holds its state gate during capture.

    #[napi(js_name = "_export_checkpoint")]
    pub async fn _export_checkpoint(
        &self,
        request_json: Option<String>,
        closing: bool,
        probe: Option<bool>,
    ) -> napi::Result<String> {
        let request_json = request_json.as_deref();

        let request = request_json
            .map(serde_json::from_str)
            .transpose()
            .map_err(native_error)?;
        let inner = self.current()?;
        (async move {
            let _context_operation = inner.engine.operation(false).map_err(native_error)?;
            let probing = probe.unwrap_or(false);
            if probing && (closing || request.is_some()) {
                return Err(native_error(
                    "Checkpoint probe requires idle nonclosing capture",
                ));
            }
            let _mutation = if probing {
                match inner.mutations.try_lock() {
                    Ok(guard) => guard,
                    Err(_) => {
                        return serde_json::to_string(&checkpoint::Probe::<String>::NotReady {
                            reason: checkpoint::ProbeRefusal::NativeBusy,
                        })
                        .map_err(native_error);
                    }
                }
            } else {
                inner.mutations.lock().await
            };
            if probing {
                let envelope = match checkpoint::probe(&inner).await.map_err(native_error)? {
                    checkpoint::Probe::Snapshot { mut snapshot } => {
                        if let Some(guard) = inner
                            .thread
                            .thread_extension_data()
                            .get::<recovery_guard::Guard>()
                        {
                            snapshot["root_tool_origins"] =
                                serde_json::to_value(guard.origins()).map_err(native_error)?;
                        }
                        snapshot["agent_options"] = serde_json::json!({});
                        checkpoint::Probe::Snapshot {
                            snapshot: serde_json::to_string(&snapshot).map_err(native_error)?,
                        }
                    }
                    checkpoint::Probe::NotReady { reason } => {
                        checkpoint::Probe::NotReady { reason }
                    }
                };
                return serde_json::to_string(&envelope).map_err(native_error);
            }
            if !closing {
                graph_stop::check_mutation(&inner).map_err(native_error)?;
            }
            let mut state = checkpoint::export(&inner, request.as_ref())
                .await
                .map_err(native_error)?;
            if let Some(guard) = inner
                .thread
                .thread_extension_data()
                .get::<recovery_guard::Guard>()
            {
                state["root_tool_origins"] =
                    serde_json::to_value(guard.origins()).map_err(native_error)?;
            }
            // Do not export connection credentials; restore binds current configuration.
            state["agent_options"] = serde_json::json!({});
            usage::checkpoint_to_wire(&mut state).map_err(native_error)?;
            serde_json::to_string(&state).map_err(native_error)
        })
        .await
    }

    fn python_callback_operation(&self, receipt_json: &str, operation: &str) -> bool {
        let Ok(receipt) = serde_json::from_str::<Value>(receipt_json) else {
            return false;
        };
        let Ok(inner) = self.current() else {
            return false;
        };
        inner
            .thread
            .thread_extension_data()
            .get::<python_tools::PythonTools>()
            .is_some_and(|tools| {
                tools.callback_operation(&inner.id.to_string(), &receipt, operation)
            })
    }
    #[napi(js_name = "_enter_python_callback")]
    pub fn enter_python_callback(&self, receipt_json: String) -> bool {
        self.python_callback_operation(&receipt_json, "enter")
    }
    #[napi(js_name = "_python_callback_cancelled")]
    pub fn python_callback_cancelled(&self, receipt_json: String) -> bool {
        self.python_callback_operation(&receipt_json, "cancelled")
    }
    #[napi(js_name = "_release_python_callback")]
    pub fn release_python_callback(&self, receipt_json: String) -> bool {
        self.python_callback_operation(&receipt_json, "release")
    }

    // Recheck after caller-owned checkpoint storage has settled, immediately
    // before invoking the JavaScript effect. A raw native interrupt may have raced it.
    #[napi(js_name = "_check_python_tool")]
    pub fn _check_python_tool(&self, request_json: String) -> napi::Result<bool> {
        let _admission_state = self.current()?;
        let _admission = _admission_state
            .engine
            .operation(false)
            .map_err(native_error)?;
        let request: Value = serde_json::from_str(&request_json).map_err(native_error)?;
        let inner = self.current()?;
        if request
            .get("_sdk_python_tool")
            .and_then(|reply| reply.get("manual_grant"))
            .is_some_and(|grant| !grant.is_null())
        {
            let tools = inner
                .thread
                .thread_extension_data()
                .get::<python_tools::PythonTools>()
                .ok_or_else(|| native_error("manual reply requires current tools"))?;
            if tools.has_restored_manual() {
                let key: python_tools::PendingKey =
                    serde_json::from_value(request.clone()).map_err(native_error)?;
                return tools
                    .check_restored_manual(&inner.id.to_string(), &key)
                    .map(|()| true)
                    .map_err(native_error);
            }
            // A live manual grant continues through normal exact root/child
            // pending admission below. Presence of a grant no longer implies restore.
        }
        let key: python_tools::PendingKey =
            serde_json::from_value(request).map_err(native_error)?;
        let root = inner
            .thread
            .thread_extension_data()
            .get::<python_tools::PythonTools>()
            .ok_or_else(|| native_error("managed tool owner is unavailable"))?;
        let owner = root
            .owner(&inner.id.to_string(), &key)
            .ok_or_else(|| native_error("managed child tool owner has expired"))?;
        owner
            .admit_callback(&key.reply.thread, &key)
            .map_err(native_error)
    }
    #[napi(js_name = "_native_question_pending")]
    pub async fn _native_question_pending(&self, question_id: String) -> napi::Result<bool> {
        let inner = self.current()?;
        let _context_operation = inner.engine.operation(false).map_err(native_error)?;
        Ok(inner.native_question_pending(&question_id).await)
    }

    #[napi(js_name = "_native_url_pending")]
    pub async fn _native_url_pending(&self, question_id: String) -> napi::Result<bool> {
        let inner = self.current()?;
        let _context_operation = inner.engine.operation(false).map_err(native_error)?;
        Ok(inner.native_url_pending(&question_id).await)
    }

    #[napi(js_name = "_native_url_completion_status")]
    pub async fn _native_url_completion_status(
        &self,
        question_id: String,
    ) -> napi::Result<Option<bool>> {
        let inner = self.current()?;
        let _context_operation = inner.engine.operation(false).map_err(native_error)?;
        Ok(inner.native_url_completion_status(&question_id).await)
    }

    #[napi(js_name = "_cancel_native_url_completion")]
    pub async fn _cancel_native_url_completion(&self, question_id: String) -> napi::Result<bool> {
        let inner = self.current()?;
        let _context_operation = inner.engine.operation(false).map_err(native_error)?;
        inner
            .cancel_native_url_completion(&question_id)
            .await
            .map_err(native_error)
    }

    #[napi(js_name = "_respond_owned_native_question")]
    pub async fn _respond_owned_native_question(
        &self,
        question_id: String,
        response_json: String,
    ) -> napi::Result<bool> {
        let inner = self.current()?;
        let _context_operation = inner.engine.operation(false).map_err(native_error)?;
        inner
            .respond_owned_native_question(&question_id, &response_json)
            .await
            .map_err(input_error)
    }

    /// Only negative retirement uses Core's queue without a captured grant.
    #[napi(js_name = "_respond_native_question")]
    pub async fn _respond_native_question(&self, response_json: String) -> napi::Result<()> {
        let inner = self.current()?;
        let operation = ops::native_question_retirement(&response_json).map_err(input_error)?;
        let _context_operation = inner.engine.operation(false).map_err(native_error)?;
        // A paused MCP publication owns mutations. Replies must reach Core's queue
        // without waiting for that publication to finish.
        inner.thread.submit(operation).await.map_err(native_error)?;
        Ok(())
    }

    #[napi(js_name = "_pending_manual_tools")]
    pub fn _pending_manual_tools(&self, owner_json: String) -> napi::Result<String> {
        let owner: python_tools::ManualOwner =
            serde_json::from_str(&owner_json).map_err(native_error)?;
        let inner = self.current()?;
        let Some(_operation) = inner.engine.manual_observation() else {
            return Ok("[]".to_owned());
        };
        let root = inner
            .thread
            .thread_extension_data()
            .get::<python_tools::PythonTools>()
            .ok_or_else(|| native_error("manual requests require managed tools"))?;
        let events = match root.exact_owner(&inner.id.to_string(), &owner.thread, &owner.instance) {
            Some(tools) => tools.pending_manual_tools(&owner),
            None => Vec::new(),
        };
        // Keep each original event intact for the existing exact-u64 decoder;
        // an object-array JSON parse would round receipt fields in JavaScript.
        let events = events
            .iter()
            .map(serde_json::to_string)
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(native_error)?;
        serde_json::to_string(&events).map_err(native_error)
    }

    #[napi(js_name = "_manual_tool_current")]
    pub fn _manual_tool_current(&self, request_json: String) -> napi::Result<bool> {
        let key: python_tools::PendingKey =
            serde_json::from_str(&request_json).map_err(native_error)?;
        let inner = self.current()?;
        let Some(_operation) = inner.engine.manual_observation() else {
            return Ok(false);
        };
        let root = inner
            .thread
            .thread_extension_data()
            .get::<python_tools::PythonTools>()
            .ok_or_else(|| native_error("manual requests require managed tools"))?;
        Ok(root
            .owner(&inner.id.to_string(), &key)
            .is_some_and(|owner| owner.manual_tool_current(&key.reply.thread, &key)))
    }

    #[napi(getter, js_name = "id")]
    pub fn id(&self) -> String {
        self.id.clone()
    }

    #[napi(getter, js_name = "rollout_path")]
    pub fn rollout_path(&self) -> Option<String> {
        self.rollout_path.clone()
    }

    // Capture only the media manager while the thread is live. The returned
    // capability can join transport shutdown after the thread/Engine retire.
    #[napi(js_name = "_realtime_cleanup")]
    pub fn realtime_cleanup(&self) -> napi::Result<RealtimeCleanup> {
        let inner = self.current()?;
        let _operation = inner.engine.operation(false).map_err(native_error)?;
        Ok(RealtimeCleanup {
            inner: RuntimeOwned {
                value: Some(Arc::new(inner.thread.realtime_cleanup())),
                runtime: inner.runtime.clone(),
            },
            owner: Arc::downgrade(&self.inner),
        })
    }

    #[napi(js_name = "_realtime_adapter")]
    pub fn _realtime_adapter(
        &self,
        generation: String,
    ) -> napi::Result<realtime_adapter::NativeRealtimeAdapter> {
        if generation.is_empty() {
            return Err(input_error("Realtime generation must not be empty"));
        }
        let inner = self.current()?;
        Ok(realtime_adapter::NativeRealtimeAdapter::new(
            &inner, generation,
        ))
    }

    #[napi(js_name = "_prepare_realtime")]
    pub async fn _prepare_realtime(
        &self,
        params_json: String,
        adapter: Option<&realtime_adapter::NativeRealtimeAdapter>,
    ) -> napi::Result<String> {
        let params: Value = serde_json::from_str(&params_json).map_err(input_error)?;
        let generation = params
            .get("generation")
            .and_then(Value::as_str)
            .ok_or_else(|| input_error("Missing Realtime generation"))?;
        let inner = self.current()?;
        let _operation = inner.engine.operation(false).map_err(native_error)?;
        let _mutation = inner.mutations.lock().await;
        let adapter = adapter
            .map(|adapter| adapter.attach(&inner, generation))
            .transpose()
            .map_err(input_error)?;
        let result = ops::prepare_realtime(&inner.thread, params, adapter)
            .await
            .map_err(native_error)?;
        serde_json::to_string(&result).map_err(native_error)
    }

    #[napi(js_name = "call")]
    pub async fn call(&self, operation: String, params_json: String) -> napi::Result<String> {
        let params: Value = serde_json::from_str(&params_json).map_err(native_error)?;
        let inner = self.current()?;
        let _operation = inner.engine.operation(false).map_err(native_error)?;
        // Preparation reserves the immutable config/declaration source while
        // every SDK publication uses this same native mutation lane.
        let _source_mutation = if operation == "realtime_conversation_prepare_sdk"
            || (operation == "realtime_conversation_update_sdk"
                && params
                    .get("profile")
                    .is_some_and(|profile| !profile.is_null()))
        {
            Some(inner.mutations.lock().await)
        } else {
            None
        };
        let value = match operation.as_str() {
            "realtime_tool_selection_sdk"
            | "realtime_conversation_start_sdk"
            | "realtime_conversation_prepare_sdk"
            | "realtime_conversation_activate_sdk"
            | "realtime_conversation_update_sdk"
            | "realtime_conversation_audio_sdk"
            | "realtime_conversation_audio_commit_sdk"
            | "realtime_conversation_delete_item_sdk"
            | "realtime_conversation_input_sdk"
            | "realtime_conversation_response_sdk"
            | "realtime_conversation_text_sdk"
            | "realtime_conversation_complete_sdk"
            | "realtime_conversation_fail_sdk"
            | "realtime_conversation_interrupt_sdk"
            | "realtime_conversation_hosted_mcp_approval_sdk"
            | "realtime_conversation_close_sdk" => {
                ops::realtime_sdk(&inner.thread, &operation, params)
                    .await
                    .map_err(native_error)?
            }
            "list_subagents" => {
                if !params.as_object().is_some_and(|params| params.is_empty()) {
                    return Err(native_error(
                        "list_subagents takes an empty parameters object",
                    ));
                }
                serde_json::to_value(subagents::list(&inner).await.map_err(native_error)?)
                    .map_err(native_error)?
            }
            "call_mcp_app_tool"
            | "mcp_app_tool_metadata"
            | "list_mcp_resources"
            | "list_mcp_resource_templates"
            | "read_mcp_resource"
            | "list_mcp_prompts"
            | "get_mcp_prompt" => {
                #[derive(serde::Deserialize)]
                #[serde(deny_unknown_fields)]
                struct McpRequest {
                    server: String,
                    params: Value,
                }
                let request: McpRequest = serde_json::from_value(params).map_err(input_error)?;
                let _mutation = inner.mutations.lock().await;
                graph_stop::check_mutation(&inner).map_err(native_error)?;
                let tools = inner
                    .thread
                    .thread_extension_data()
                    .get::<python_tools::PythonTools>()
                    .ok_or_else(|| input_error("MCP operations require a managed Session"))?;
                tools.check_idle(&inner.thread).await.map_err(input_error)?;
                if tools.has_restored_manual() {
                    return Err(input_error("MCP operations require a settled open Session"));
                }
                let config = inner.thread.config().await;
                let selected = config
                    .mcp_servers
                    .get()
                    .get(&request.server)
                    .filter(|server| server.enabled && !mcp_roster::enterprise(server))
                    .ok_or_else(|| {
                        input_error("MCP operations require an enabled ordinary MCP server")
                    })?;
                if selected.sdk_turn_scoped_stdio {
                    return Err(input_error(
                        "idle MCP operations require session-lifetime MCP stdio",
                    ));
                }
                let cancelled = self
                    .inner
                    .lock()
                    .map_err(native_error)?
                    .resource_requests_stop
                    .clone();
                let request = async {
                    match operation.as_str() {
                        "call_mcp_app_tool" | "mcp_app_tool_metadata" => {
                            #[derive(serde::Deserialize)]
                            #[serde(deny_unknown_fields)]
                            struct ToolParams {
                                name: String,
                                arguments: serde_json::Map<String, Value>,
                            }
                            let params: ToolParams =
                                serde_json::from_value(request.params).map_err(input_error)?;
                            if !selected.is_local_environment()
                                || !selected
                                    .enabled_tools
                                    .as_ref()
                                    .is_some_and(|names| names.contains(&params.name))
                                || selected
                                    .disabled_tools
                                    .as_ref()
                                    .is_some_and(|names| names.contains(&params.name))
                                || !selected.tools.get(&params.name).is_some_and(|tool| {
                                    matches!(
                                        tool.approval_mode,
                                        Some(codex_config::AppToolApproval::Approve)
                                    )
                                })
                            {
                                return Err(input_error(
                                    "MCP App actions require an explicitly selected preapproved ordinary local tool",
                                ));
                            }
                            if operation == "mcp_app_tool_metadata" {
                                let (_, snapshot) = inner
                                    .thread
                                    .mcp_server_status_snapshot(
                                        &request.server,
                                        codex_mcp::McpSnapshotDetail::ToolsAndAuthOnly,
                                    )
                                    .await
                                    .map_err(|_| {
                                        input_error("MCP App tool metadata is unavailable")
                                    })?;
                                if snapshot.tools_errors.contains_key(&request.server) {
                                    return Err(input_error(
                                        "MCP App tool metadata is unavailable",
                                    ));
                                }
                                let tool = snapshot
                                    .tools_by_server
                                    .get(&request.server)
                                    .and_then(|tools| tools.get(&params.name))
                                    .ok_or_else(|| {
                                        input_error("MCP App originating tool is unavailable")
                                    })?;
                                return Ok(tool.meta.clone().unwrap_or(Value::Null));
                            }
                            let result = inner
                                .thread
                                .call_mcp_tool(
                                    &request.server,
                                    &params.name,
                                    Some(Value::Object(params.arguments)),
                                    None,
                                )
                                .await
                                .map_err(|error| native_error(format!("{error:#}")))?;
                            serde_json::to_value(result).map_err(native_error)
                        }
                        "read_mcp_resource" => inner
                            .thread
                            .read_mcp_resource(
                                &request.server,
                                serde_json::from_value(request.params).map_err(input_error)?,
                            )
                            .await
                            .map_err(|error| native_error(format!("{error:#}"))),
                        "list_mcp_resources" => inner
                            .thread
                            .list_mcp_resources(
                                &request.server,
                                Some(serde_json::from_value(request.params).map_err(input_error)?),
                            )
                            .await
                            .map_err(|error| native_error(format!("{error:#}"))),
                        "list_mcp_prompts" => {
                            if !request
                                .params
                                .as_object()
                                .is_some_and(|params| params.is_empty())
                            {
                                return Err(input_error("list_mcp_prompts takes empty parameters"));
                            }
                            inner
                                .thread
                                .list_mcp_prompts(&request.server)
                                .await
                                .map_err(|error| native_error(format!("{error:#}")))
                        }
                        "get_mcp_prompt" => {
                            #[derive(serde::Deserialize)]
                            #[serde(deny_unknown_fields)]
                            struct PromptParams {
                                name: String,
                                arguments: Option<std::collections::HashMap<String, String>>,
                            }
                            let params: PromptParams =
                                serde_json::from_value(request.params).map_err(input_error)?;
                            inner
                                .thread
                                .get_mcp_prompt(&request.server, &params.name, params.arguments)
                                .await
                                .map_err(|error| native_error(format!("{error:#}")))
                        }
                        _ => inner
                            .thread
                            .list_mcp_resource_templates(
                                &request.server,
                                Some(serde_json::from_value(request.params).map_err(input_error)?),
                            )
                            .await
                            .map_err(|error| native_error(format!("{error:#}"))),
                    }
                };
                tokio::select! {
                    biased;
                    _ = cancelled.cancelled() => return Err(native_error(if matches!(operation.as_str(), "list_mcp_prompts" | "get_mcp_prompt") {
                        "Session closed during MCP prompt operation"
                    } else {
                        "Session closed during MCP resource operation"
                    })),
                    result = request => result?,
                }
            }
            "set_instructions" => {
                #[derive(serde::Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Instructions {
                    instructions: Option<String>,
                }
                let value: Instructions = serde_json::from_value(params).map_err(native_error)?;
                let _mutation = inner.mutations.lock().await;
                graph_stop::check_mutation(&inner).map_err(native_error)?;
                inner.instructions.check_usable().map_err(native_error)?;
                use codex_protocol::protocol::AgentStatus;
                if inner
                    .thread
                    .active_turn_environment_selections()
                    .await
                    .is_some()
                    || matches!(
                        inner.thread.agent_status().await,
                        AgentStatus::Running | AgentStatus::Shutdown | AgentStatus::NotFound
                    )
                {
                    return Err(native_error(
                        "application instructions require an idle, open native thread",
                    ));
                }
                if let Some(tools) = inner
                    .thread
                    .thread_extension_data()
                    .get::<python_tools::PythonTools>()
                {
                    tools
                        .check_idle(&inner.thread)
                        .await
                        .map_err(native_error)?;
                    if tools.has_restored_manual() {
                        return Err(native_error(
                            "application instructions cannot change during a sealed manual continuation",
                        ));
                    }
                }
                application_instructions::publish(
                    &inner.thread,
                    value.instructions.unwrap_or_default(),
                )
                .await
                .map_err(native_error)?;
                Value::Null
            }
            _ => {
                return Err(native_error(format!(
                    "unknown native operation: {operation}"
                )));
            }
        };
        serde_json::to_string(&value).map_err(native_error)
    }

    #[napi(js_name = "_submit")]
    pub async fn _submit(&self, params_json: String) -> napi::Result<String> {
        let params_json = params_json.as_str();

        let params: Value = serde_json::from_str(params_json).map_err(input_error)?;
        let context = params
            .get("tracing_context")
            .and_then(Value::as_str)
            .map(codex_otel::sdk_trace::context)
            .transpose()
            .map_err(input_error)?
            .unwrap_or_default();
        let inner = self.current()?;
        (async move {
            let _context_operation = inner.engine.operation(false).map_err(native_error)?;
            let result = match graph_stop::submit(&inner, &params).await {
                Ok(()) => {
                    if inner
                        .thread
                        .thread_extension_data()
                        .get::<python_tools::PythonTools>()
                        .is_none()
                        && !inner.instructions.managed()
                    {
                        return Err(native_error(
                            "managed submit requires an SDK-owned startup or replaceable tool session",
                        ));
                    }
                    ops::submit_replaceable(&inner, params).await
                }
                Err(error) => Err(error),
            }
            .map_err(|error| {
                if error.is::<ops::PreAdmissionError>() {
                    input_error(error)
                } else {
                    native_error(error)
                }
            })?;
            serde_json::to_string(&result).map_err(native_error)
        })
        .with_context(codex_otel::sdk_trace::explicit_submission_context(context))
        .await
    }

    #[napi(js_name = "_submit_realtime_tools")]
    pub async fn _submit_realtime_tools(&self, params_json: String) -> napi::Result<String> {
        let params: Value = serde_json::from_str(&params_json).map_err(input_error)?;
        let context = params
            .get("tracing_context")
            .and_then(Value::as_str)
            .map(codex_otel::sdk_trace::context)
            .transpose()
            .map_err(input_error)?
            .unwrap_or_default();
        let inner = self.current()?;
        (async move {
            let _context_operation = inner.engine.operation(false).map_err(native_error)?;
            let attachment = params
                .get("expected_root_turn_id")
                .is_some_and(|root| !root.is_null());
            let admission = if attachment {
                Ok(())
            } else {
                graph_stop::submit(&inner, &params).await
            };
            let result = match admission {
                Ok(()) => ops::submit_realtime_tools(&inner, params).await,
                Err(error) => Err(error),
            }
            .map_err(|error| {
                if error.is::<ops::PreAdmissionError>() {
                    input_error(error)
                } else {
                    native_error(error)
                }
            })?;
            serde_json::to_string(&result).map_err(native_error)
        })
        .with_context(codex_otel::sdk_trace::explicit_submission_context(context))
        .await
    }

    #[napi(js_name = "_validate_hosted_search_model")]
    pub async fn _validate_hosted_search_model(&self) -> napi::Result<()> {
        let inner = self.current()?;
        let _context_operation = inner.engine.operation(false).map_err(native_error)?;
        let current = inner.thread.config_snapshot().await;
        if let Some(hosted) = inner
            .thread
            .thread_extension_data()
            .get::<codex_extension_api::HostedModelTools>()
        {
            inner
                .engine
                .validate_hosted_tools_model(current.collaboration_mode.model(), &hosted)
                .await
                .map_err(input_error)?;
        }
        inner
            .engine
            .validate_hosted_search_model(current.collaboration_mode.model())
            .await
            .map_err(input_error)
    }

    #[napi(js_name = "_configure_agent_profiles")]
    pub async fn _configure_agent_profiles(
        &self,
        roster_json: String,
        root_id: String,
    ) -> napi::Result<String> {
        let inner = self.current()?;
        let _operation = inner.engine.operation(false).map_err(native_error)?;
        let _mutation = inner.mutations.lock().await;
        graph_stop::check_mutation(&inner).map_err(input_error)?;
        let receipt = agent_profiles::configure(&inner, &roster_json, &root_id)
            .await
            .map_err(native_error)?;
        serde_json::to_string(&receipt).map_err(native_error)
    }

    #[napi(js_name = "_active_agent_profile")]
    pub async fn _active_agent_profile(&self) -> napi::Result<String> {
        let inner = self.current()?;
        let _operation = inner.engine.operation(false).map_err(native_error)?;
        let receipt = agent_profiles::active(&inner.thread)
            .await
            .map_err(native_error)?;
        serde_json::to_string(&receipt).map_err(native_error)
    }

    #[napi(js_name = "_activate_agent_profile")]
    pub async fn _activate_agent_profile(
        &self,
        target: String,
        expected_json: String,
    ) -> napi::Result<String> {
        let expected = serde_json::from_str(&expected_json).map_err(input_error)?;
        let inner = self.current()?;
        let _operation = inner.engine.operation(false).map_err(native_error)?;
        let _mutation = inner.mutations.lock().await;
        graph_stop::check_mutation(&inner).map_err(input_error)?;
        let receipt = agent_profiles::activate(&inner, &target, expected)
            .await
            .map_err(native_error)?;
        serde_json::to_string(&receipt).map_err(native_error)
    }

    #[napi(js_name = "_update_model_settings")]
    pub async fn _update_model_settings(&self, settings_json: String) -> napi::Result<bool> {
        let params = serde_json::from_str(&settings_json).map_err(input_error)?;
        let settings = ops::model_settings(params).map_err(input_error)?;
        let inner = self.current()?;
        let _context_operation = inner.engine.operation(false).map_err(native_error)?;
        let _mutation = inner.mutations.lock().await;
        graph_stop::check_mutation(&inner).map_err(input_error)?;
        let tools = inner
            .thread
            .thread_extension_data()
            .get::<python_tools::PythonTools>()
            .ok_or_else(|| input_error("model updates require a managed Session"))?;
        tools.check_idle(&inner.thread).await.map_err(input_error)?;
        if let Some(model) = &settings.model {
            if let Some(hosted) = inner
                .thread
                .thread_extension_data()
                .get::<codex_extension_api::HostedModelTools>()
            {
                inner
                    .engine
                    .validate_hosted_tools_model(model, &hosted)
                    .await
                    .map_err(input_error)?;
            }
            inner
                .engine
                .validate_hosted_search_model(model)
                .await
                .map_err(input_error)?;
        }
        if agent_profiles::update_active(&inner.thread, Some(&settings), None, None)
            .await
            .map_err(native_error)?
        {
            return Ok(true);
        }
        inner
            .engine
            .validate_request_controls(&inner.thread, &settings)
            .await
            .map_err(input_error)?;
        inner
            .thread
            .update_thread_settings(settings)
            .await
            .map_err(|error| {
                if matches!(
                    error.details(),
                    codex_protocol::error::CodexErrorDetails::InvalidRequest(_)
                ) {
                    input_error(error)
                } else {
                    native_error(error)
                }
            })?;
        Ok(true)
    }

    #[napi(js_name = "_compact")]
    pub async fn _compact(
        &self,
        trace_json: Option<String>,
        tracing_context: Option<String>,
    ) -> napi::Result<String> {
        let trace = resolve_trace_json(trace_json.as_deref(), tracing_context.as_deref())
            .map_err(input_error)?;
        let context = tracing_context
            .as_deref()
            .map(codex_otel::sdk_trace::context)
            .transpose()
            .map_err(input_error)?
            .unwrap_or_default();
        (async {
            let inner = self.current()?;
            // Serialize admission with startup/engine close, then thread mutations.
            // These guards end with the enqueue receipt, before the SDK waits for
            // the internal compaction run or its model response.
            let _lifecycle = inner.engine.lifecycle.lock().await;
            let _context_operation = inner.engine.operation(false).map_err(native_error)?;
            let _mutation = inner.mutations.lock().await;
            inner.engine.operation(false).map_err(native_error)?;
            inner.instructions.check_usable().map_err(native_error)?;
            if inner.is_closed() {
                return Err(native_error("Codex thread is closed"));
            }
            graph_stop::check_mutation(&inner).map_err(input_error)?;
            let tools = inner
                .thread
                .thread_extension_data()
                .get::<python_tools::PythonTools>()
                .ok_or_else(|| input_error("compact requires a managed Session"))?;
            tools.check_idle(&inner.thread).await.map_err(input_error)?;
            if let Some(store) = &inner.engine.local_checklist_store {
                store
                    .check_failure(Some(inner.id))
                    .await
                    .map_err(native_error)?;
            }
            inner.engine.operation(false).map_err(native_error)?;
            inner.instructions.check_usable().map_err(native_error)?;
            if inner.is_closed() {
                return Err(native_error("Codex thread is closed"));
            }
            graph_stop::check_mutation(&inner).map_err(input_error)?;
            let turn_id = inner
                .thread
                .submit_with_trace(codex_protocol::protocol::Op::Compact, trace)
                .await
                .map_err(native_error)?;
            serde_json::to_string(&serde_json::json!({"status": "started", "turn_id": turn_id}))
                .map_err(native_error)
        })
        .with_context(codex_otel::sdk_trace::explicit_submission_context(context))
        .await
    }

    #[napi(js_name = "_execute_command")]
    pub async fn _execute_command(
        &self,
        name: String,
        arguments: String,
        trace_json: Option<String>,
        tracing_context: Option<String>,
    ) -> napi::Result<String> {
        let trace = resolve_trace_json(trace_json.as_deref(), tracing_context.as_deref())
            .map_err(input_error)?;
        let context = tracing_context
            .as_deref()
            .map(codex_otel::sdk_trace::context)
            .transpose()
            .map_err(input_error)?
            .unwrap_or_default();
        (async {
            commands::validate_arguments(&name, &arguments).map_err(input_error)?;
            if name == "compact" {
                return self
                    ._compact(trace_json.clone(), tracing_context.clone())
                    .await;
            }
            let inner = self.current()?;
            let _lifecycle = inner.engine.lifecycle.lock().await;
            let _context_operation = inner.engine.operation(false).map_err(native_error)?;
            let _mutation = inner.mutations.lock().await;
            inner.engine.operation(false).map_err(native_error)?;
            inner.instructions.check_usable().map_err(native_error)?;
            if inner.is_closed() {
                return Err(native_error("Codex thread is closed"));
            }
            graph_stop::check_mutation(&inner).map_err(input_error)?;
            let receipt = match name.as_str() {
                "rename" => {
                    let stored = commands::rename(&inner, &arguments)
                        .await
                        .map_err(native_error)?;
                    serde_json::json!({"session_id": stored.thread_id, "name": stored.name})
                }
                "stop" => {
                    let operation = commands::stop(&inner).await.map_err(native_error)?;
                    serde_json::json!({"session_id": inner.id, "operation_id": operation})
                }
                "review" => {
                    commands::check_review(&inner).await.map_err(input_error)?;
                    let turn = commands::review(&inner, &arguments, trace)
                        .await
                        .map_err(native_error)?;
                    serde_json::json!({"status": "started", "turn_id": turn})
                }
                _ => return Err(input_error("Unsupported embedded command")),
            };
            serde_json::to_string(&receipt).map_err(native_error)
        })
        .with_context(codex_otel::sdk_trace::explicit_submission_context(context))
        .await
    }

    #[napi(js_name = "_check_step")]
    pub fn _check_step(&self, response_json: String) -> napi::Result<bool> {
        let response: python_tools::StepReply =
            serde_json::from_str(&response_json).map_err(input_error)?;
        let Some(inner) = self.live()? else {
            return Ok(false);
        };
        let tools = inner
            .thread
            .thread_extension_data()
            .get::<python_tools::PythonTools>()
            .ok_or_else(|| input_error("Step selection requires a managed Session"))?;
        let Some(owner) =
            tools.exact_owner(&inner.id.to_string(), &response.thread, &response.instance)
        else {
            return Ok(false);
        };
        owner
            .check_step(&response.thread, &response)
            .map_err(input_error)
    }

    #[napi(js_name = "_stop_step")]
    pub fn _stop_step(&self, response_json: String) -> napi::Result<bool> {
        let response: python_tools::StepReply =
            serde_json::from_str(&response_json).map_err(input_error)?;
        let Some(inner) = self.live()? else {
            return Ok(false);
        };
        let tools = inner
            .thread
            .thread_extension_data()
            .get::<python_tools::PythonTools>()
            .ok_or_else(|| input_error("Step selection requires a managed Session"))?;
        let Some(owner) =
            tools.exact_owner(&inner.id.to_string(), &response.thread, &response.instance)
        else {
            return Ok(false);
        };
        let thread = response.thread.clone();
        owner.stop_step(&thread, response).map_err(input_error)
    }

    #[napi(js_name = "_reply_child_step")]
    pub fn _reply_child_step(&self, response_json: String) -> napi::Result<bool> {
        let response: python_tools::StepReply =
            serde_json::from_str(&response_json).map_err(input_error)?;
        let Some(inner) = self.live()? else {
            return Ok(false);
        };
        let tools = inner
            .thread
            .thread_extension_data()
            .get::<python_tools::PythonTools>()
            .ok_or_else(|| input_error("Step selection requires a managed Session"))?;
        let Some(owner) =
            tools.exact_owner(&inner.id.to_string(), &response.thread, &response.instance)
        else {
            return Ok(false);
        };
        let thread = response.thread.clone();
        owner
            .reply_child_step(&thread, response)
            .map_err(input_error)
    }

    #[napi(js_name = "_check_tool_completion")]
    pub fn _check_tool_completion(&self, response_json: String) -> napi::Result<bool> {
        let response: python_tools::CompletionReply =
            serde_json::from_str(&response_json).map_err(input_error)?;
        let Some(inner) = self.live()? else {
            return Ok(false);
        };
        let Some(tools) = inner
            .thread
            .thread_extension_data()
            .get::<python_tools::PythonTools>()
        else {
            return Ok(false);
        };
        let Some(owner) =
            tools.exact_owner(&inner.id.to_string(), &response.thread, &response.instance)
        else {
            return Ok(false);
        };
        owner.check_tool_completion(&response).map_err(input_error)
    }

    #[napi(js_name = "_reply_tool_completion")]
    pub fn _reply_tool_completion(&self, response_json: String) -> napi::Result<bool> {
        let response: python_tools::CompletionReply =
            serde_json::from_str(&response_json).map_err(input_error)?;
        let Some(inner) = self.live()? else {
            return Ok(false);
        };
        let Some(tools) = inner
            .thread
            .thread_extension_data()
            .get::<python_tools::PythonTools>()
        else {
            return Ok(false);
        };
        let Some(owner) =
            tools.exact_owner(&inner.id.to_string(), &response.thread, &response.instance)
        else {
            return Ok(false);
        };
        owner.reply_tool_completion(response).map_err(input_error)
    }

    #[napi(js_name = "_reply_prepared_request")]
    pub fn _reply_prepared_request(&self, response_json: String) -> napi::Result<()> {
        let inner = self.current()?;
        let response: python_tools::prepared_requests::Reply = serde_json::from_str(&response_json)
            .map_err(|_| input_error("Invalid prepared request reply"))?;
        let tools = inner
            .thread
            .thread_extension_data()
            .get::<python_tools::PythonTools>()
            .ok_or_else(|| input_error("Prepared request requires managed Session"))?;
        tools
            .reply_prepared(&inner.id.to_string(), response)
            .map_err(input_error)
    }

    #[napi(js_name = "_reply_step")]
    pub fn _reply_step(&self, response_json: String) -> napi::Result<()> {
        let inner = self.current()?;
        let response: python_tools::StepReply =
            serde_json::from_str(&response_json).map_err(input_error)?;
        let tools = inner
            .thread
            .thread_extension_data()
            .get::<python_tools::PythonTools>()
            .ok_or_else(|| input_error("Step selection requires a managed Session"))?;
        let owner = tools
            .exact_owner(&inner.id.to_string(), &response.thread, &response.instance)
            .ok_or_else(|| input_error("Expired step selection owner"))?;
        let thread = response.thread.clone();
        owner.reply_step(&thread, response).map_err(input_error)
    }

    #[napi(js_name = "_reply_compaction")]
    pub fn _reply_compaction(&self, response_json: String) -> napi::Result<()> {
        let inner = self.current()?;
        let response: python_tools::context_callbacks::CompactionReply =
            serde_json::from_str(&response_json).map_err(input_error)?;
        let tools = inner
            .thread
            .thread_extension_data()
            .get::<python_tools::PythonTools>()
            .ok_or_else(|| input_error("Model callbacks require a managed Session"))?;
        let owner = tools
            .exact_owner(
                &inner.id.to_string(),
                &response.owner.thread,
                &response.owner.instance,
            )
            .ok_or_else(|| input_error("Expired model callback owner"))?;
        owner.reply_compaction(response).map_err(input_error)
    }

    #[napi(js_name = "_reply_model_context")]
    pub fn _reply_model_context(&self, response_json: String) -> napi::Result<()> {
        let inner = self.current()?;
        let response: python_tools::context_callbacks::ContextReply =
            serde_json::from_str(&response_json).map_err(input_error)?;
        let tools = inner
            .thread
            .thread_extension_data()
            .get::<python_tools::PythonTools>()
            .ok_or_else(|| input_error("Model callbacks require a managed Session"))?;
        let owner = tools
            .exact_owner(
                &inner.id.to_string(),
                &response.owner.thread,
                &response.owner.instance,
            )
            .ok_or_else(|| input_error("Expired model callback owner"))?;
        owner.reply_model_context(response).map_err(input_error)
    }

    #[napi(js_name = "_reply_natural_completion")]
    pub fn _reply_natural_completion(&self, response_json: String) -> napi::Result<()> {
        let inner = self.current()?;
        let response: python_tools::context_callbacks::CompletionReply =
            serde_json::from_str(&response_json).map_err(input_error)?;
        let tools = inner
            .thread
            .thread_extension_data()
            .get::<python_tools::PythonTools>()
            .ok_or_else(|| input_error("Model callbacks require a managed Session"))?;
        let owner = tools
            .exact_owner(
                &inner.id.to_string(),
                &response.owner.thread,
                &response.owner.instance,
            )
            .ok_or_else(|| input_error("Expired model callback owner"))?;
        owner
            .reply_natural_completion(response)
            .map_err(input_error)
    }

    #[napi(js_name = "_replace_tools")]
    pub async fn _replace_tools(
        &self,
        generation: String,
        specs_json: String,
        default_slots_json: Option<String>,
        terminal_slots_json: Option<String>,
    ) -> napi::Result<String> {
        let generation = crate::native_id(&generation)?;
        let specs_json = specs_json.as_str();
        let terminal = terminal_slots_json
            .map(|json| serde_json::from_str::<python_tools::TerminalSlots>(&json))
            .transpose()
            .map_err(input_error)?;

        let specs = serde_json::from_str(specs_json).map_err(native_error)?;
        let defaults = default_slots_json
            .map(|json| serde_json::from_str(&json))
            .transpose()
            .map_err(input_error)?;
        let inner = self.current()?;
        (async move {
            let _context_operation = inner.engine.operation(false).map_err(native_error)?;
            let _mutation = inner.mutations.lock().await;
            graph_stop::check_mutation(&inner).map_err(native_error)?;
            let tools = inner
                .thread
                .thread_extension_data()
                .get::<python_tools::PythonTools>()
                .ok_or_else(|| native_error("replace_tools requires a replaceable tool session"))?;
            tools
                .replace(&inner.thread, generation, specs, defaults, terminal)
                .await
                .map(|generation| generation.to_string())
                .map_err(native_error)
        })
        .await
    }

    // Private SDK ingress for replacing the active MCP catalog.
    #[napi(js_name = "_replace_mcp_servers")]
    pub async fn _replace_mcp_servers(
        &self,
        servers_json: String,
        policies_json: Option<String>,
        interception_rules_json: Option<String>,
        tool_generation: Option<String>,
        specs_json: Option<String>,
        startup_boundary: Option<String>,
        cancel_on_resource_close: Option<bool>,
        terminal_slots_json: Option<String>,
        default_slots_json: Option<String>,
    ) -> napi::Result<String> {
        let servers_json = servers_json.as_str();
        if startup_boundary
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 128)
        {
            return Err(input_error("invalid native publication boundary"));
        }

        let servers = serde_json::from_str(servers_json)
            .map_err(|_| crate::input_error("invalid MCP servers JSON"))?;
        let servers =
            mcp_roster::decode(servers).map_err(|err| crate::input_error(err.to_string()))?;
        let selection: Option<mcp_result_control::Selection> = policies_json
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(input_error)?;
        if let Some(selection) = &selection {
            selection.validate(&servers).map_err(input_error)?;
        }
        let rules: Option<Vec<native_interception::ToolRule>> = interception_rules_json
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(input_error)?;
        let pre_count = selection
            .as_ref()
            .map(|s| s.pre_policy.values().map(Vec::len).sum::<usize>())
            .unwrap_or(0);
        if rules
            .as_ref()
            .map(|rules| {
                rules
                    .iter()
                    .filter(|rule| rule.generation.is_some())
                    .count()
            })
            .unwrap_or(0)
            != pre_count
        {
            return Err(input_error(
                "MCP pre-policy rules do not match selected callbacks",
            ));
        }
        let terminal = terminal_slots_json
            .map(|json| serde_json::from_str::<python_tools::TerminalSlots>(&json))
            .transpose()
            .map_err(input_error)?;
        if terminal.is_some() && tool_generation.is_none() {
            return Err(input_error(
                "Terminal replacement requires a function catalog",
            ));
        }
        let defaults = default_slots_json
            .map(|json| serde_json::from_str::<Vec<usize>>(&json))
            .transpose()
            .map_err(input_error)?;
        if defaults.is_some() && tool_generation.is_none() {
            return Err(input_error("Default tool slots require a function update"));
        }
        let function_update = match (tool_generation, specs_json) {
            (Some(generation), Some(specs)) => Some((
                native_id(&generation)?,
                serde_json::from_str(&specs).map_err(input_error)?,
            )),
            (None, None) => None,
            _ => {
                return Err(input_error(
                    "Combined MCP update requires generation and specs together",
                ));
            }
        };
        let inner = self.current()?;
        if inner.engine.local_checklist_store.is_some() {
            return Err(input_error(
                "local storage does not support native MCP roster replacement",
            ));
        }
        let operation = async move {
            let _context_operation = inner.engine.operation(false).map_err(native_error)?;
            let _mutation = inner.mutations.lock().await;
            graph_stop::check_mutation(&inner).map_err(native_error)?;
            let control = inner
                .thread
                .thread_extension_data()
                .get::<mcp_result_control::McpResultControl>()
                .ok_or_else(|| native_error("native MCP result control was not initialized"))?;
            if let Some(selection) = &selection {
                control
                    .check_selection(selection.generation)
                    .map_err(input_error)?;
            }
            let interception = inner
                .thread
                .thread_extension_data()
                .get::<native_interception::Control>()
                .ok_or_else(|| native_error("native interception owner was not initialized"))?;
            let captured = inner
                .thread
                .captured_agent_profile()
                .await
                .map_err(native_error)?;
            let captured_policy = captured
                .as_ref()
                .map(|captured| {
                    captured
                        .profile
                        .data
                        .get::<native_interception::ProfileMcpPolicy>()
                        .ok_or_else(|| {
                            native_error("Managed Agent MCP source has no captured policy")
                        })
                })
                .transpose()?;
            if rules.is_none()
                && (interception.has_mcp_policy()
                    || captured_policy
                        .as_ref()
                        .is_some_and(|policy| policy.has_pre_policy()))
            {
                return Err(input_error(
                    "MCP policy replacement requires current compiled rules",
                ));
            }
            let function_update = if let Some((generation, specs)) = function_update {
                let tools = inner
                    .thread
                    .thread_extension_data()
                    .get::<python_tools::PythonTools>()
                    .ok_or_else(|| {
                        input_error("replace_tools requires a replaceable tool session")
                    })?;
                // Reject busy families before opening a publication that must
                // retire the owner on an uncertain failure.
                tools.check_idle(&inner.thread).await.map_err(input_error)?;
                tools.check_family_idle().map_err(input_error)?;
                Some((tools, generation, specs))
            } else {
                None
            };
            let mut publication = if let Some(rules) = rules {
                let selection = selection
                    .as_ref()
                    .ok_or_else(|| input_error("MCP pre-policy requires a selection"))?;
                native_interception::McpPublication::begin_with_profile(
                    &inner.engine.interception,
                    interception,
                    rules,
                    selection.generation,
                    captured_policy.as_deref(),
                )
                .map_err(input_error)?
            } else {
                None
            };
            let mut function_generation = None;
            let mut functions_published = false;
            if let Some((tools, generation, specs)) = function_update {
                if publication.is_none() {
                    return Err(input_error(
                        "Combined update requires an old or new MCP pre-policy",
                    ));
                }
                // An uncertain function publication cannot reopen the old policy.
                let published = tools
                    .replace(&inner.thread, generation, specs, defaults, terminal)
                    .await
                    .map_err(native_error)?;
                function_generation = Some(published.to_string());
                functions_published = true;
            }
            // A returned error precedes Core publication. A receipt can instead
            // report published but unready; that is not a rollback.
            let mut receipt = match mcp_roster::replace(&inner.thread, servers).await {
                Ok(receipt) => receipt,
                Err(error) => {
                    if !functions_published {
                        if let Some(guard) = publication.take() {
                            guard.rollback();
                        }
                        return Err(input_error(error.to_string()));
                    }
                    return Err(native_error(error));
                }
            };
            if receipt["result"]["publication"] == "published" {
                if let Some(selection) = selection {
                    receipt["result"]["policy_generation"] = selection.generation.into();
                    control.publish_selection(selection);
                }
                if let Some(guard) = publication.take() {
                    if receipt["result"]["ready"] != true
                        && receipt["result"]["deferred_until_turn"] != true
                    {
                        return Err(native_error("MCP policy publication was not ready"));
                    }
                    guard.commit().map_err(native_error)?;
                }
                // Function replacement may have captured the preceding roster.
                // Rebind only after the new roster and callback policies commit.
                agent_profiles::refresh_active_mcp(&inner.thread)
                    .await
                    .map_err(native_error)?;
                if let Some(id) = startup_boundary {
                    inner
                        .request_publication_boundary(id)
                        .map_err(native_error)?;
                }
            } else if !functions_published {
                if let Some(guard) = publication.take() {
                    guard.rollback();
                }
            }
            if functions_published {
                receipt["result"]["tools_generation"] = serde_json::json!(function_generation);
            }
            serde_json::to_string(&receipt).map_err(native_error)
        };
        if cancel_on_resource_close.unwrap_or(false) {
            let cancelled = self
                .inner
                .lock()
                .map_err(native_error)?
                .resource_requests_stop
                .clone();
            tokio::select! {
                biased;
                _ = cancelled.cancelled() => Err(native_error("Session closed during MCP resource activation")),
                result = operation => result,
            }
        } else {
            operation.await
        }
    }

    #[napi(js_name = "_cancel_child_callback")]
    pub async fn _cancel_child_callback(&self, request_json: String) -> napi::Result<bool> {
        let _admission_state = self.current()?;
        let _admission = _admission_state
            .engine
            .operation(false)
            .map_err(native_error)?;
        let key: python_tools::PendingKey =
            serde_json::from_str(&request_json).map_err(native_error)?;
        let inner = self.current()?;
        let root = inner
            .thread
            .thread_extension_data()
            .get::<python_tools::PythonTools>()
            .ok_or_else(|| native_error("managed tools unavailable"))?;
        let Some(owner) = root.owner(&inner.id.to_string(), &key) else {
            return Ok(false);
        };
        if key.reply.instance.is_none() {
            return Ok(false);
        }
        let child_id =
            codex_protocol::ThreadId::from_string(&key.reply.thread).map_err(native_error)?;
        let thread = inner
            .engine
            .manager
            .get_thread(child_id)
            .await
            .map_err(native_error)?;
        if !thread
            .thread_extension_data()
            .get::<python_tools::PythonTools>()
            .is_some_and(|current| Arc::ptr_eq(&current, &owner))
        {
            return Ok(false);
        }
        // The callback has ended even when queued input prevents an interrupt.
        // Retire only its own sender so the native executor can finish, without
        // cancelling work Core already accepted for this child or another turn.
        drop(
            owner
                .take_reply(&key.reply.thread, &key)
                .map_err(native_error)?,
        );
        ops::interrupt_if_no_pending_input(&thread, key.turn.clone())
            .await
            .map_err(native_error)
    }

    #[napi(js_name = "_respond_python_tool")]
    pub async fn _respond_python_tool(&self, response_json: String) -> napi::Result<bool> {
        let response: python_tools::Reply =
            serde_json::from_str(&response_json).map_err(native_error)?;
        let inner = self.current()?;
        (async move {
            let _context_operation = inner.engine.operation(false).map_err(native_error)?;
            // Suspension cannot seal while an acknowledged real receipt is
            // still in flight between removal from pending and writer flush.
            let _mutation = Arc::clone(&inner.mutations).lock_owned().await;
            let Some(tools) = inner
                .thread
                .thread_extension_data()
                .get::<python_tools::PythonTools>()
            else {
                return Ok(false);
            };
            let python_tools::Reply {
                request,
                response,
                start_response,
            } = response;
            {
                let Some(tools) = tools.owner(&inner.id.to_string(), &request) else {
                    return Ok(false);
                };
                let Some(native_media) = tools.native_media(&request) else {
                    return Ok(false);
                };
                inner
                    .engine
                    .validate_tool_media(
                        &request.reply.thread,
                        &request.turn,
                        false,
                        None,
                        native_media.as_ref(),
                        &response,
                    )
                    .await
                    .map_err(native_error)?;
                // Rejected media must leave the exact live sender parked until the
                // owning host failure requests stop. Taking it before validation
                // could wake Core before that fatal failure is recorded.
                let Some(sender) = tools
                    .take_reply(&request.reply.thread, &request)
                    .map_err(native_error)?
                else {
                    return Ok(false);
                };
                if let Some(store) = &inner.engine.local_checklist_store {
                    let receipt_thread =
                        codex_protocol::ThreadId::from_string(&request.reply.thread)
                            .map_err(native_error)?;
                    store
                        .commit_sdk_receipt(
                            receipt_thread,
                            &request,
                            python_tools::PythonOutput(response.clone()).receipt(&request),
                        )
                        .await
                        .map_err(native_error)?;
                }
                if let Some(store) = &inner.engine.custom_store {
                    let id = codex_protocol::ThreadId::from_string(&request.reply.thread)
                        .map_err(native_error)?;
                    store
                        .receipt(
                            id,
                            python_tools::PythonOutput(response.clone()).receipt(&request),
                        )
                        .await
                        .map_err(native_error)?;
                }
                let sent = sender
                    .send(python_tools::ToolReply {
                        response: response.clone(),
                        start_response,
                    })
                    .is_ok();
                if sent {
                    tools.record_manual_receipt(&request, response);
                }
                Ok(sent)
            }
        })
        .await
    }

    #[napi(js_name = "_configure_manual_tools")]
    pub fn _configure_manual_tools(
        &self,
        slots_json: String,
        terminal_slots_json: Option<String>,
    ) -> napi::Result<()> {
        let _admission_state = self.current()?;
        let _admission = _admission_state
            .engine
            .operation(false)
            .map_err(native_error)?;
        let inner = self.current()?;
        let slots: Vec<python_tools::ManualSlot> =
            serde_json::from_str(&slots_json).map_err(native_error)?;
        inner
            .thread
            .thread_extension_data()
            .get::<python_tools::PythonTools>()
            .ok_or_else(|| native_error("manual tools require a managed session"))?
            .configure_manual(slots)
            .map_err(native_error)?;
        if let Some(config) = terminal_slots_json {
            let config: python_tools::TerminalSlots =
                serde_json::from_str(&config).map_err(input_error)?;
            inner
                .thread
                .thread_extension_data()
                .get::<python_tools::PythonTools>()
                .ok_or_else(|| input_error("terminal tools require a managed session"))?
                .configure_terminal(config)
                .map_err(input_error)?;
        }
        Ok(())
    }

    #[napi(js_name = "_manual_checkpoint_config_supported")]
    pub async fn _manual_checkpoint_config_supported(&self) -> napi::Result<bool> {
        let _admission_state = self.current()?;
        let _admission = _admission_state
            .engine
            .operation(false)
            .map_err(native_error)?;
        let inner = self.current()?;
        let config = inner.thread.config().await;
        Ok(inner.engine.local_checklist_store.is_none()
            && !config.features.enabled(codex_core_api::Feature::CodeMode)
            && !config.agents_enabled)
    }

    #[napi(js_name = "_begin_manual_checkpoint_wait")]
    pub fn _begin_manual_checkpoint_wait(
        &self,
        validated_requests_json: String,
    ) -> napi::Result<String> {
        let keys: Vec<python_tools::PendingKey> =
            serde_json::from_str(&validated_requests_json).map_err(native_error)?;
        let inner = self.current()?;
        if inner.engine.local_checklist_store.is_some() {
            return Err(input_error(
                "local storage cannot suspend portable manual checkpoints",
            ));
        }
        let _operation = inner.engine.operation(false).map_err(native_error)?;
        inner
            .thread
            .thread_extension_data()
            .get::<python_tools::PythonTools>()
            .ok_or_else(|| native_error("manual checkpoint requires managed tools"))?
            .begin_manual_wait(&inner.id.to_string(), &keys)
            .map_err(native_error)
    }

    #[napi(js_name = "_wait_manual_checkpoint_progress")]
    pub async fn _wait_manual_checkpoint_progress(&self, token: String) -> napi::Result<()> {
        // This observation owns no writer or mutation guard. End, retirement,
        // or close must be able to release it even if N-API starts it late.
        let Ok(inner) = self.current() else {
            return Ok(());
        };
        let tools = inner
            .thread
            .thread_extension_data()
            .get::<python_tools::PythonTools>()
            .ok_or_else(|| native_error("manual checkpoint requires managed tools"))?;
        tools
            .wait_manual_progress(&token)
            .await
            .map_err(native_error)
    }

    #[napi(js_name = "_end_manual_checkpoint_wait")]
    pub fn _end_manual_checkpoint_wait(&self, token: String) -> napi::Result<()> {
        // ThreadStop retires a wait if close won before JavaScript's finally.
        let Ok(inner) = self.current() else {
            return Ok(());
        };
        inner
            .thread
            .thread_extension_data()
            .get::<python_tools::PythonTools>()
            .ok_or_else(|| native_error("manual checkpoint requires managed tools"))?
            .end_manual_wait(&token)
            .map_err(native_error)
    }

    #[napi(js_name = "_manual_checkpoint_ready")]
    pub async fn _manual_checkpoint_ready(
        &self,
        validated_requests_json: String,
    ) -> napi::Result<bool> {
        let keys: Vec<python_tools::PendingKey> =
            serde_json::from_str(&validated_requests_json).map_err(native_error)?;
        let inner = self.current()?;
        let control = self.response_control()?;
        let _operation = inner.engine.operation(false).map_err(native_error)?;
        let _mutation = inner.mutations.lock().await;
        graph_stop::check_mutation(&inner).map_err(native_error)?;
        if !control.supports_manual_checkpoint() {
            return Err(native_error(
                "manual checkpoint requires a portable uncontrolled native session",
            ));
        }
        let tools = inner
            .thread
            .thread_extension_data()
            .get::<python_tools::PythonTools>()
            .ok_or_else(|| native_error("manual checkpoint requires managed tools"))?;
        let first = keys
            .first()
            .ok_or_else(|| native_error("no pending manual requests"))?;
        let first = serde_json::to_value(first).map_err(native_error)?;
        // Validate permanent root-history errors before any transient child.
        let history = checkpoint::capture(&inner.engine, inner.id, &mut Vec::new())
            .await
            .map_err(native_error)?
            .0;
        checkpoint::check_manual_root_history(&inner, &history)
            .await
            .map_err(native_error)?;
        let history = serde_json::to_value(history).map_err(native_error)?;
        let candidate = tools
            .seal_manual(&inner.id.to_string(), &keys, &history)
            .map_err(native_error)?;
        let Some(graph) = checkpoint::manual_graph(&inner)
            .await
            .map_err(native_error)?
        else {
            return Ok(false);
        };
        let saved = checkpoint::export(&inner, (!tools.has_restored_manual()).then_some(&first))
            .await
            .map_err(native_error)?;
        // Run the frame validator first. Permanent invalid/duplicate history
        // must fail even while another unrelated callback is not ready.
        let checked = tools
            .seal_manual(&inner.id.to_string(), &keys, &saved["history"])
            .map_err(native_error)?;
        checkpoint::check_manual_portability(&inner, &saved)
            .await
            .map_err(native_error)?;
        graph.check(&inner, &saved).await.map_err(native_error)?;
        if candidate.is_none() || checked.is_none() {
            return Ok(false);
        }
        if tools.has_restored_manual() {
            return Ok(true);
        }
        let store = inner
            .engine
            .store
            .as_any()
            .downcast_ref::<storage::MemoryThreadStore>()
            .ok_or_else(|| native_error("manual checkpoint requires portable native storage"))?;
        store
            .manual_sampling_ready(inner.id, &keys)
            .await
            .map_err(native_error)
    }

    #[napi(js_name = "_seal_manual_checkpoint")]
    pub async fn _seal_manual_checkpoint(
        &self,
        validated_requests_json: String,
    ) -> napi::Result<String> {
        let keys: Vec<python_tools::PendingKey> =
            serde_json::from_str(&validated_requests_json).map_err(native_error)?;
        let inner = self.current()?;
        if inner.engine.local_checklist_store.is_some() {
            return Err(input_error(
                "local storage cannot suspend portable manual checkpoints",
            ));
        }
        let control = self.response_control()?;
        // Once entered, keep native operation + mutation ownership through
        // either finishing the lease or retiring the incomplete writer.
        // JavaScript waiter cancellation must never strand a native writer.
        retain_writer_operation(async move {
            let _operation = inner.engine.operation(false).map_err(native_error)?;
            let _mutation = inner.mutations.lock().await;
            graph_stop::check_mutation(&inner).map_err(native_error)?;
            if !control.supports_manual_checkpoint() {
                return Err(native_error(
                    "manual checkpoint requires a portable uncontrolled native session",
                ));
            }
            let tools = inner
                .thread
                .thread_extension_data()
                .get::<python_tools::PythonTools>()
                .ok_or_else(|| native_error("manual checkpoint requires managed tools"))?;
            let restored = tools.has_restored_manual();
            let first = keys
                .first()
                .ok_or_else(|| native_error("no pending manual requests"))?;
            let first = serde_json::to_value(first).map_err(native_error)?;
            let history = checkpoint::capture(&inner.engine, inner.id, &mut Vec::new())
                .await
                .map_err(native_error)?
                .0;
            checkpoint::check_manual_root_history(&inner, &history)
                .await
                .map_err(native_error)?;
            let history = serde_json::to_value(history).map_err(native_error)?;
            // Busy children cannot hide an already malformed root frame.
            tools
                .seal_manual(&inner.id.to_string(), &keys, &history)
                .map_err(native_error)?;
            let Some(graph) = checkpoint::manual_graph(&inner)
                .await
                .map_err(native_error)?
            else {
                return Ok(serde_json::json!({"status":"not_ready"}).to_string());
            };
            let mut saved = if restored {
                checkpoint::export_restored_manual(&inner).await
            } else {
                checkpoint::export(&inner, Some(&first)).await
            }
            .map_err(native_error)?;
            let Some(mut frame) = tools
                .seal_manual(&inner.id.to_string(), &keys, &saved["history"])
                .map_err(native_error)?
            else {
                return Ok(serde_json::json!({"status":"not_ready"}).to_string());
            };
            checkpoint::check_manual_portability(&inner, &saved)
                .await
                .map_err(native_error)?;
            let store = inner
                .engine
                .store
                .as_any()
                .downcast_ref::<storage::MemoryThreadStore>()
                .ok_or_else(|| {
                    native_error("manual checkpoint requires portable native storage")
                })?;
            let raw_prefix = if restored {
                None
            } else {
                let raw = inner
                    .engine
                    .load_checkpoint_history(inner.id)
                    .await
                    .map_err(native_error)?;
                let mut projected = raw.clone();
                tools
                    .restore_schema_history(&mut projected)
                    .map_err(native_error)?;
                // Compare portable projections. The store lease below still
                // verifies the exact unredacted writer prefix.
                checkpoint::redact_executor_observations(&mut projected);
                if serde_json::to_value(projected).map_err(native_error)? != saved["history"] {
                    return Ok(serde_json::json!({"status":"not_ready"}).to_string());
                }
                Some(serde_json::to_value(raw).map_err(native_error)?)
            };
            graph.check(&inner, &saved).await.map_err(native_error)?;
            if let Some(raw_prefix) = raw_prefix
                && !store
                    .begin_manual_capture(inner.id, keys, &raw_prefix)
                    .await
                    .map_err(native_error)?
            {
                return Ok(serde_json::json!({"status":"not_ready"}).to_string());
            }
            let finalize: napi::Result<String> = async {
                if restored {
                    tools.retire_manual();
                } else {
                    // Core refuses even idle loaded descendants. Only after the
                    // store lease commits may eligible writers be retired.
                    // Always finish that lease, including retirement failures.
                    let outcome: napi::Result<_> = async {
                        graph.check(&inner, &saved).await.map_err(native_error)?;
                        let retired = graph.retire(&inner).await.map_err(native_error)?;
                        let suspension = inner
                            .thread
                            .suspend_turn_and_shutdown()
                            .await
                            .map_err(native_error)?;
                        Ok((retired, suspension))
                    }
                    .await;
                    let suspended = match &outcome {
                        Ok((
                            _,
                            codex_protocol::turn_input::SuspendTurnOutcome::Suspended { turn_id },
                        )) => Some(turn_id.as_str()),
                        _ => None,
                    };
                    // Finish on every native outcome before inspecting success.
                    let committed = store.finish_manual_capture(inner.id, suspended).await;
                    let valid = committed.map_err(native_error)?;
                    let (retired, suspension) = outcome?;
                    match suspension {
                        codex_protocol::turn_input::SuspendTurnOutcome::Suspended { turn_id }
                            if turn_id == frame.turn_id && valid => {}
                        _ => {
                            return Err(native_error(
                                "native manual suspension refused or changed turn",
                            ));
                        }
                    }
                    saved["history"] = serde_json::to_value(
                        inner
                            .engine
                            .load_checkpoint_history(inner.id)
                            .await
                            .map_err(native_error)?,
                    )
                    .map_err(native_error)?;
                    frame = tools
                        .finish_manual_capture(frame, &mut saved["history"])
                        .map_err(native_error)?;
                    retired.check(&inner, &saved).await.map_err(native_error)?;
                    // Leave ordinary close able to clean children on every
                    // incomplete-commit error before setting the closed flag.
                    inner.retire_suspended().await;
                }
                if restored {
                    graph.check(&inner, &saved).await.map_err(native_error)?;
                }
                let mut history: Vec<codex_history::RolloutItem> =
                    serde_json::from_value(saved["history"].take()).map_err(native_error)?;
                tools
                    .restore_schema_history(&mut history)
                    .map_err(native_error)?;
                checkpoint::redact_executor_observations(&mut history);
                saved["history"] = serde_json::to_value(history).map_err(native_error)?;
                saved["agent_options"] = serde_json::json!({});
                usage::checkpoint_to_wire(&mut saved).map_err(native_error)?;
                serde_json::to_string(
                    &serde_json::json!({"checkpoint":saved, "manual_continuation":frame}),
                )
                .map_err(native_error)
            }
            .await;
            match finalize {
                Ok(frame) => Ok(frame),
                // The caller must close the incomplete Session on this result.
                // Pre-commit errors above remain ordinary native exceptions;
                // callers must leave their Session and grants usable there.
                Err(_) => Ok(serde_json::json!({
                    "status":"failed", "committed":true,
                    "message":"Manual checkpoint capture failed after native commitment"
                })
                .to_string()),
            }
        })
        .await
    }

    #[napi(js_name = "_restore_manual_continuation")]
    pub async fn _restore_manual_continuation(
        &self,
        continuation_json: String,
        tracing_context: Option<String>,
    ) -> napi::Result<String> {
        let context = tracing_context
            .as_deref()
            .map(codex_otel::sdk_trace::context)
            .transpose()
            .map_err(input_error)?
            .unwrap_or_default();
        (async {
            let frame: python_tools::Continuation =
                serde_json::from_str(&continuation_json).map_err(native_error)?;
            let inner = self.current()?;
            let control = self.response_control()?;
            let _operation = inner.engine.operation(false).map_err(native_error)?;
            let _mutation = inner.mutations.lock().await;
            if !control.supports_manual_checkpoint() {
                return Err(native_error(
                    "manual continuation requires a portable uncontrolled native session",
                ));
            }
            let tools = inner
                .thread
                .thread_extension_data()
                .get::<python_tools::PythonTools>()
                .ok_or_else(|| native_error("manual continuation requires managed tools"))?;
            let saved = checkpoint::export(&inner, None)
                .await
                .map_err(native_error)?;
            let graph = checkpoint::manual_graph(&inner)
                .await
                .map_err(native_error)?
                .ok_or_else(|| native_error("manual restore contains a busy descendant"))?;
            checkpoint::check_manual_portability(&inner, &saved)
                .await
                .map_err(native_error)?;
            graph.check(&inner, &saved).await.map_err(native_error)?;
            let events = tools
                .restore_manual(&inner, frame, &saved["history"])
                .await
                .map_err(native_error)?;
            serde_json::to_string(&events).map_err(native_error)
        })
        .with_context(codex_otel::sdk_trace::explicit_submission_context(context))
        .await
    }

    #[napi(js_name = "_respond_manual_continuation")]
    pub async fn _respond_manual_continuation(
        &self,
        request_and_output_json: String,
    ) -> napi::Result<()> {
        let response: python_tools::Reply =
            serde_json::from_str(&request_and_output_json).map_err(native_error)?;
        let python_tools::Reply {
            request, response, ..
        } = response;
        let inner = self.current()?;
        let _operation = inner.engine.operation(false).map_err(native_error)?;
        let _mutation = inner.mutations.lock().await;
        let tools = inner
            .thread
            .thread_extension_data()
            .get::<python_tools::PythonTools>()
            .ok_or_else(|| native_error("manual continuation requires managed tools"))?;
        let model = tools
            .restored_media_model(&inner.id.to_string(), &request)
            .map_err(native_error)?;
        inner
            .engine
            .validate_tool_media(
                &request.reply.thread,
                &request.turn,
                true,
                Some(&model),
                None,
                &response,
            )
            .await
            .map_err(native_error)?;
        // respond_manual rechecks the same native restored frame before recording a result.
        tools
            .respond_manual(&inner.id.to_string(), request, response)
            .map_err(native_error)
    }

    #[napi(js_name = "_complete_manual_continuation")]
    pub async fn _complete_manual_continuation(
        &self,
        output_schema_json: Option<String>,
        selection_json: Option<String>,
        trace_json: Option<String>,
        tracing_context: Option<String>,
        observation_submission_id: Option<String>,
    ) -> napi::Result<String> {
        let trace = resolve_trace_json(trace_json.as_deref(), tracing_context.as_deref())
            .map_err(input_error)?;
        let context = tracing_context
            .as_deref()
            .map(codex_otel::sdk_trace::context)
            .transpose()
            .map_err(input_error)?
            .unwrap_or_default();
        (async {
            let output_schema = output_schema_json
                .map(|schema| serde_json::from_str::<Value>(&schema).map_err(native_error))
                .transpose()?;
            let selection = selection_json
                .map(|selection| {
                    serde_json::from_str::<python_tools::OperationSelection>(&selection)
                        .map_err(native_error)
                })
                .transpose()?;
            // A restored root can use step preparation to enforce its remaining
            // SDK budget. The SDK never serializes an application callback.
            if selection
                .as_ref()
                .is_some_and(|selection| selection.prepare_request)
            {
                return Err(native_error(
                    "manual continuation recovery cannot restore request preparation",
                ));
            }
            let inner = self.current()?;
            let _operation = inner.engine.operation(false).map_err(native_error)?;
            inner
                .engine
                .interception
                .check_code_import_admission()
                .map_err(native_error)?;
            let _mutation = inner.mutations.lock().await;
            let tools = inner
                .thread
                .thread_extension_data()
                .get::<python_tools::PythonTools>()
                .ok_or_else(|| native_error("manual continuation requires managed tools"))?;
            if let Some(selection) = &selection {
                tools.validate_operation(selection).map_err(native_error)?;
            }
            let saved = checkpoint::export_restored_manual(&inner)
                .await
                .map_err(native_error)?;
            let (frame, items, settings) = tools
                .manual_completion(&saved["history"])
                .map_err(native_error)?;
            if !items.is_empty() {
                // Update Core's live model context as well as its rollout. A raw
                // writer append alone would let prompt normalization invent "aborted".
                inner
                    .thread
                    .inject_response_item_envelopes(items)
                    .await
                    .map_err(native_error)?;
            }
            let result = ops::recover_prepared(
                &inner,
                frame.turn_id,
                frame.reply_order,
                settings,
                output_schema,
                selection,
                trace,
                observation_submission_id,
            )
            .await
            .map_err(native_error)?;
            if result.get("status").and_then(Value::as_str) == Some("started") {
                tools.retire_manual();
            }
            serde_json::to_string(&result).map_err(native_error)
        })
        .with_context(codex_otel::sdk_trace::explicit_submission_context(context))
        .await
    }

    #[napi(js_name = "read_checklist")]
    pub async fn read_checklist(&self, subagent_id: Option<String>) -> napi::Result<String> {
        let inner = self.current()?;
        let id = subagent_id
            .as_deref()
            .map(codex_core_api::ThreadId::from_string)
            .transpose()
            .map_err(input_error)?;
        let _lifecycle = inner.engine.lifecycle.lock().await;
        inner.engine.operation(false).map_err(native_error)?;
        let _mutation = inner.mutations.lock().await;
        inner.engine.operation(false).map_err(native_error)?;
        inner.instructions.check_usable().map_err(native_error)?;
        if inner.is_closed() {
            return Err(native_error(
                "native checklist read requires an open thread",
            ));
        }
        if inner.thread.config_snapshot().await.ephemeral {
            return Err(input_error("native checklist requires a persistent thread"));
        }
        if inner.engine.local_checklist_store.is_some() {
            if id.is_some_and(|id| id != inner.id) {
                return Err(input_error(
                    "local checklist reads require the current root",
                ));
            }
        } else {
            // Memory/child membership and flush retain their existing owner.
            subagents::read_history(&inner, id)
                .await
                .map_err(native_error)?;
        }
        // Local history and sidecar must be sampled under one store writer lock.
        let result = checkpoint::checklist(&inner, id.unwrap_or(inner.id))
            .await
            .map_err(native_error)?;
        if inner.engine.local_checklist_store.is_some() {
            if inner.is_closed()
                || inner
                    .engine
                    .closed
                    .load(std::sync::atomic::Ordering::Acquire)
            {
                return Err(native_error(
                    "native checklist read requires an open thread",
                ));
            }
            inner.instructions.check_usable().map_err(native_error)?;
        }
        serde_json::to_string(&result).map_err(native_error)
    }

    #[napi(js_name = "read_thread_history")]
    pub async fn read_thread_history(&self, subagent_id: Option<String>) -> napi::Result<String> {
        let subagent_id = subagent_id.as_deref();

        let inner = self.current()?;
        let id = subagent_id
            .map(codex_core_api::ThreadId::from_string)
            .transpose()
            .map_err(native_error)?;
        (async move {
            let _context_operation = inner.engine.operation(false).map_err(native_error)?;
            let history = subagents::read_history(&inner, id)
                .await
                .map_err(native_error)?;
            let wire = usage::history_to_wire(&history).map_err(native_error)?;
            serde_json::to_string(&wire).map_err(native_error)
        })
        .await
    }

    #[napi(js_name = "_interrupt_session")]
    pub async fn interrupt_session(&self) -> napi::Result<()> {
        let inner = self.current()?;
        let _context_operation = inner.engine.operation(false).map_err(native_error)?;
        let _mutation = inner.mutations.lock().await;

        let settlement = inner
            .thread
            .thread_extension_data()
            .get::<turn_settlement::Settlement>()
            .ok_or_else(|| native_error("Native turn admission receipt missing"))?;
        settlement
            .interrupt_session(&inner.thread)
            .await
            .map_err(native_error)
    }

    #[napi(js_name = "_request_graph_stop")]
    pub fn request_graph_stop(&self, scope: String, mode: String) -> napi::Result<NativeGraphStop> {
        let _admission_state = self.current()?;
        let _admission = _admission_state
            .engine
            .operation(false)
            .map_err(native_error)?;
        let scope = graph_stop::Scope::parse(&scope).map_err(native_error)?;
        let force = match mode.as_str() {
            "force" => true,
            "graceful" => false,
            _ => return Err(native_error("Invalid Session stop mode")),
        };
        let inner = self.current()?;
        if !force
            && inner
                .thread
                .thread_extension_data()
                .get::<python_tools::PythonTools>()
                .is_some_and(|tools| tools.has_restored_manual())
        {
            return Err(native_error(
                "Graceful stop requires a recovered manual turn",
            ));
        }
        let control = inner
            .thread
            .thread_extension_data()
            .get::<native_interception::Control>()
            .ok_or_else(|| native_error("Native graph owner unavailable"))?;
        let request = graph_stop::Request::begin(&inner.engine.interception, control, scope, force)
            .map_err(native_error)?;
        if force
            && let Some(tools) = inner
                .thread
                .thread_extension_data()
                .get::<python_tools::PythonTools>()
            && tools.has_restored_manual()
        {
            // A restored ledger has no running Core task to revoke it. A
            // completion already inside the mutation lock remains joined;
            // its actual TurnStart observes the synchronous fence.
            tools.retire_manual();
        }
        Ok(NativeGraphStop {
            receipt: Arc::new(tokio::sync::Mutex::new(Some(GraphStopReceipt {
                state: inner,
                request,
                started: false,
            }))),
        })
    }

    #[napi(js_name = "_next_session_events")]
    pub async fn next_session_events(&self) -> napi::Result<Vec<String>> {
        self.current()?
            .next_session_events()
            .await
            .map_err(native_error)
    }

    #[napi(js_name = "_next_session_event")]
    pub async fn next_session_event(&self) -> napi::Result<String> {
        let inner = self.current()?;
        let value = inner.next_session_event().await.map_err(native_error)?;
        serde_json::to_string(&value).map_err(native_error)
    }

    #[napi(js_name = "_child_turn")]
    pub async fn _child_turn(&self, child_id: String) -> napi::Result<Option<NativeChildTurn>> {
        let id = codex_core_api::ThreadId::from_string(&child_id).map_err(native_error)?;
        let inner = self.current()?;
        let _operation = inner.engine.operation(false).map_err(native_error)?;
        Ok(subagents::current(&inner, id)
            .await
            .map_err(native_error)?
            .map(|turn| NativeChildTurn {
                session_id: inner.id.to_string(),
                inner: turn,
            }))
    }

    #[napi(js_name = "_child_instance")]
    pub async fn _child_instance(
        &self,
        child_id: String,
    ) -> napi::Result<Option<(String, Option<NativeChildTurn>)>> {
        let id = codex_core_api::ThreadId::from_string(&child_id).map_err(input_error)?;
        let inner = self.current()?;
        let _operation = inner.engine.operation(false).map_err(native_error)?;
        Ok(subagents::instance(&inner, id)
            .await
            .map_err(native_error)?
            .map(|(instance, _, turn)| {
                (
                    instance.to_string(),
                    turn.map(|turn| NativeChildTurn {
                        session_id: inner.id.to_string(),
                        inner: turn,
                    }),
                )
            }))
    }

    #[napi(js_name = "_child_submit")]
    pub async fn _child_submit(
        &self,
        child_id: String,
        instance_id: String,
        input_json: String,
    ) -> napi::Result<NativeChildTurn> {
        let id = codex_core_api::ThreadId::from_string(&child_id).map_err(input_error)?;
        let instance = crate::native_id(&instance_id)?;
        let input = serde_json::from_str(&input_json).map_err(input_error)?;
        let inner = self.current()?;
        let _operation = inner.engine.operation(false).map_err(native_error)?;
        let turn = subagents::submit(&inner, id, instance, input)
            .await
            .map_err(native_error)?;
        Ok(NativeChildTurn {
            session_id: inner.id.to_string(),
            inner: turn,
        })
    }

    #[napi(js_name = "_finish_child_event_reader")]
    pub fn _finish_child_event_reader(&self) -> napi::Result<()> {
        if let Some(inner) = self.live()? {
            inner.finish_child_event_reader().map_err(native_error)?;
        }
        Ok(())
    }

    #[napi(js_name = "close")]
    pub async fn close(&self) -> napi::Result<()> {
        if let Some(diagnostic) = self.close_owned(false).await? {
            return Err(native_error(diagnostic));
        }
        Ok(())
    }

    #[napi(js_name = "_close_report")]
    pub async fn _close_report(&self) -> napi::Result<Option<String>> {
        self.close_owned(false).await
    }

    #[napi(js_name = "_close_private_root_report")]
    pub async fn _close_private_root_report(&self) -> napi::Result<Option<String>> {
        self.close_owned_mode(false, true).await
    }

    #[napi(js_name = "_close_selected_environment")]
    pub async fn _close_selected_environment(&self) -> napi::Result<Option<String>> {
        self.close_owned(true).await
    }

    #[napi(js_name = "_stop_sampling_for_close")]
    pub fn _stop_sampling_for_close(&self) -> napi::Result<()> {
        // Wake idle resource requests before JS joins the owned mutation.
        self.inner
            .lock()
            .map_err(native_error)?
            .resource_requests_stop
            .cancel();
        if let Some(inner) = self.live()?
            && let Some(root) = inner
                .thread
                .thread_extension_data()
                .get::<native_interception::Control>()
        {
            root.graph().close_sampling.request();
        }
        Ok(())
    }
}

// No constructor: only an observed turn from this native event owner issues a
// receipt. IDs are diagnostic strings, never authority for wait or cancel.
#[napi(js_name = "_NativeChildTurn")]
pub struct NativeChildTurn {
    inner: Arc<subagents::Turn>,
    session_id: String,
}

#[napi]
impl NativeChildTurn {
    #[napi(js_name = "_continue")]
    pub async fn _continue(&self) -> napi::Result<Option<NativeChildTurn>> {
        let owner = self
            .inner
            .owner
            .upgrade()
            .ok_or_else(|| native_error("Session is closed"))?;
        let _operation = owner.engine.operation(false).map_err(native_error)?;
        Ok(subagents::continue_retained(&owner, &self.inner)
            .await
            .map_err(native_error)?
            .map(|inner| NativeChildTurn {
                inner,
                session_id: self.session_id.clone(),
            }))
    }

    #[napi(getter, js_name = "session_id")]
    pub fn session_id(&self) -> String {
        self.session_id.clone()
    }

    #[napi(getter, js_name = "child_id")]
    pub fn child_id(&self) -> String {
        self.inner.child_id.to_string()
    }

    #[napi(getter, js_name = "instance_id")]
    pub fn instance_id(&self) -> String {
        self.inner.instance_id.to_string()
    }

    #[napi(getter, js_name = "turn_id")]
    pub fn turn_id(&self) -> String {
        self.inner.turn_id.clone()
    }
    #[napi(getter)]
    pub fn incarnation(&self) -> String {
        self.inner.incarnation.clone()
    }

    #[napi(js_name = "terminal_error")]
    pub fn terminal_error(&self) -> Option<String> {
        self.inner.terminal_error()
    }

    #[napi(js_name = "wait_with_usage")]
    pub async fn wait_with_usage(&self) -> napi::Result<String> {
        self.inner.wait_with_usage().await.map_err(native_error)
    }

    #[napi]
    pub async fn cancel(&self) -> napi::Result<Option<bool>> {
        self.inner.cancel().await.map_err(native_error)
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReconciliationInput {
    thread_id: codex_protocol::ThreadId,
    turn_id: String,
    call_id: String,
    result: codex_protocol::dynamic_tools::DynamicToolResponse,
}

// Constructed before the async operation starts, so its original writer remains
// reachable even when reconciliation or physical release fails.
#[napi(js_name = "_SessionStoreReconciliation")]
pub struct SessionStoreReconciliation {
    store: Arc<custom_storage::CustomThreadStore>,
    thread_id: codex_protocol::ThreadId,
    input: std::sync::Mutex<Option<ReconciliationInput>>,
}

#[napi]
impl SessionStoreReconciliation {
    #[napi]
    pub async fn run(&self) -> napi::Result<()> {
        let result = self
            .input
            .lock()
            .map_err(native_error)?
            .take()
            .ok_or_else(|| input_error("Reconciliation already started"))?;
        let reconciled = self
            .store
            .reconcile(
                result.thread_id,
                result.turn_id,
                result.call_id,
                result.result,
            )
            .await;
        // Preserve the existing immediate release retry. A later retry through
        // this same owner only releases the writer, never repeats the receipt.
        let cleanup = match self.store.release_writer(self.thread_id).await {
            Ok(_) => Ok(()),
            Err(first) => {
                if self
                    .store
                    .take_release_failure(self.thread_id)
                    .await
                    .is_some()
                {
                    self.store
                        .release_writer(self.thread_id)
                        .await
                        .map(|_| ())
                        .map_err(|retry| format!("{first}; release retry failed: {retry}"))
                } else {
                    Err(first.to_string())
                }
            }
        };
        match (reconciled, cleanup) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(primary), Ok(())) => Err(native_error(primary)),
            (Ok(()), Err(cleanup)) => Err(native_error(cleanup)),
            (Err(primary), Err(cleanup)) => Err(native_error(format!(
                "reconciliation failed: {primary}; writer cleanup failed: {cleanup}"
            ))),
        }
    }

    #[napi]
    pub async fn close(&self) -> napi::Result<()> {
        // The optional returned diagnostic belongs to the original receipt.
        // Successful physical release completes this cleanup obligation.
        self.store
            .release_writer(self.thread_id)
            .await
            .map(|_| ())
            .map_err(native_error)
    }
}

#[napi(js_name = "reconcile_thread_store")]
pub fn reconcile_thread_store(
    callback: custom_storage::Callback,
    result_json: String,
) -> napi::Result<SessionStoreReconciliation> {
    let result: ReconciliationInput = serde_json::from_str(&result_json).map_err(input_error)?;
    Ok(SessionStoreReconciliation {
        store: Arc::new(custom_storage::CustomThreadStore::new(callback)),
        thread_id: result.thread_id,
        input: std::sync::Mutex::new(Some(result)),
    })
}

#[napi(js_name = "create_store_engine")]
pub async fn create_store_engine(
    config_json: String,
    runtime_json: String,
    api_key: Option<String>,
    callback: custom_storage::Callback,
    application_apps_json: Option<String>,
) -> napi::Result<Engine> {
    let application =
        verification::prepare(application_apps_json.as_deref()).map_err(native_error)?;
    let store = Arc::new(custom_storage::CustomThreadStore::new(callback));
    let mut inner = engine::EngineState::new_owned_with_store(
        config_json,
        runtime_json,
        false,
        api_key,
        None,
        Default::default(),
        Some(store),
    )
    .await
    .map_err(native_error)?;
    inner.application_apps = match application {
        Some(application) => Some(
            application
                .bind(&inner.service_config)
                .await
                .map_err(native_error)?,
        ),
        None => None,
    };
    Ok(Engine::new(inner))
}

#[napi(js_name = "create_engine")]
pub async fn create_engine(
    config_json: String,
    runtime_json: String,
    api_key: Option<String>,
    application_apps_json: Option<String>,
) -> napi::Result<Engine> {
    let config_json = config_json.as_str();
    let runtime_json = runtime_json.as_str();

    let config_json = config_json.to_owned();
    let runtime_json = runtime_json.to_owned();
    (async move {
        let inner = engine::EngineState::new_owned_with_application(
            config_json,
            runtime_json,
            false,
            api_key,
            None,
            Default::default(),
            application_apps_json,
        )
        .await
        .map_err(native_error)?;
        Ok(Engine::new(inner))
    })
    .await
}

#[napi(js_name = "create_checkpoint_engine")]
pub async fn create_checkpoint_engine(
    config_json: String,
    runtime_json: String,
    api_key: Option<String>,
    initial_checkpoint: Option<String>,
    initial_specs_json: Option<String>,
    fresh_manual: Option<bool>,
    application_apps_json: Option<String>,
) -> napi::Result<Engine> {
    let config_json = config_json.as_str();
    let runtime_json = runtime_json.as_str();

    let config_json = config_json.to_owned();
    let runtime_json = runtime_json.to_owned();
    let specs: Option<Vec<codex_protocol::dynamic_tools::DynamicToolSpec>> = initial_specs_json
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(input_error)?;
    let initial_models = initial_checkpoint
        .as_deref()
        .map(|encoded| {
            let raw = checkpoint_wire_value(encoded).map_err(input_error)?;
            let checkpoint: checkpoint::Checkpoint =
                serde_json::from_value(raw).map_err(input_error)?;
            checkpoint
                .initial_models(specs.as_deref(), fresh_manual.unwrap_or(false))
                .map_err(input_error)
        })
        .transpose()?
        .unwrap_or_default();
    (async move {
        let inner = engine::EngineState::new_owned_with_application(
            config_json,
            runtime_json,
            true,
            api_key,
            None,
            initial_models,
            application_apps_json,
        )
        .await
        .map_err(native_error)?;
        Ok(Engine::new(inner))
    })
    .await
}

// Only the exact trusted private HTTP route reaches this function. EndpointSession
// has already prepared/authenticated the request and admitted prepared editing.
async fn direct_sentinel_stream(
    inner: &engine::EngineState,
    expected_url: &str,
    request: codex_client::Request,
) -> Result<codex_client::StreamResponse, TransportError> {
    use base64::Engine as _;
    use futures_util::StreamExt as _;

    let reject = |status| TransportError::Http {
        status,
        url: Some(request.url.clone()),
        headers: Some(http::HeaderMap::new()),
        body: Some(String::new()),
        retry_after: None,
    };
    // Match NativeProviderRoutes.start: an unmatched route/grant is 401;
    // a handler exception before response headers is 502. These remain HTTP
    // errors so Core keeps its existing auth recovery and retry classification.
    let unmatched = || reject(http::StatusCode::UNAUTHORIZED);
    let invalid = || reject(http::StatusCode::BAD_GATEWAY);
    // The direct route does not own a request timeout. The existing invocation
    // deadline remains responsible for cancellation and joining its request work.
    if request.timeout.is_some() {
        return Err(invalid());
    }
    if request.url != expected_url {
        return Err(unmatched());
    }
    let binding = inner
        .sentinel
        .read()
        .expect("sentinel poisoned")
        .clone()
        .ok_or_else(unmatched)?;
    let prefix = format!("{}/p-", binding.0.trim_end_matches('/'));
    let encoded = request
        .url
        .strip_prefix(&prefix)
        .and_then(|path| path.strip_suffix("/responses"))
        .filter(|encoded| {
            !encoded.is_empty()
                && encoded
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        })
        .ok_or_else(unmatched)?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| unmatched())?;
    if base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&decoded) != encoded {
        return Err(unmatched());
    }
    // Node joins duplicate grant values, which cannot match the single grant.
    if !request
        .headers
        .get_all("x-sdk-sentinel-grant")
        .iter()
        .map(|value| value.as_bytes().trim_ascii())
        .eq(std::iter::once(binding.1.as_bytes()))
    {
        return Err(unmatched());
    }
    // The old route decoder throws for canonical base64 containing invalid
    // UTF-8, rather than declining the matched route.
    let provider_id = std::str::from_utf8(&decoded).map_err(|_| invalid())?;
    if request.method != http::Method::POST {
        return Err(reject(http::StatusCode::METHOD_NOT_ALLOWED));
    }
    let prepared = request.prepare_body_for_send().map_err(|_| invalid())?;
    // Node joins repeated Content-Encoding values before comparing the single
    // value with identity. Two identity fields therefore still produce 415.
    let mut encodings = prepared
        .headers
        .get_all(http::header::CONTENT_ENCODING)
        .iter();
    if encodings
        .next()
        .is_some_and(|value| value.as_bytes().trim_ascii() != b"identity")
        || encodings.next().is_some()
    {
        return Err(reject(http::StatusCode::UNSUPPORTED_MEDIA_TYPE));
    }
    let raw = prepared.body_bytes();
    if raw.len() > 64 * 1024 * 1024 {
        return Err(reject(http::StatusCode::PAYLOAD_TOO_LARGE));
    }
    let _permit = inner.operation(false).map_err(|_| invalid())?;
    let mut body: serde_json::Value = serde_json::from_slice(&raw).map_err(|_| invalid())?;
    let metadata = body
        .get("client_metadata")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    if !body.is_object() || !metadata.is_object() {
        return Err(invalid());
    }
    let ticket = serde_json::json!({
        "sdk_sentinel_thread": metadata.get("sdk_sentinel_thread"),
        "sdk_sentinel_nonce": metadata.get("sdk_sentinel_nonce"),
    });
    // Reuse exact control, provider, nonce, turn, cancellation and one-use gates.
    let receipt = native_interception::sentinel_admit(inner, provider_id, &metadata)
        .await
        .map_err(|_| invalid())?;
    let receipt: serde_json::Value = serde_json::from_str(&receipt).map_err(|_| invalid())?;
    if receipt.get("model") != body.get("model")
        || !matches!(receipt["kind"].as_str(), Some("generation" | "warmup"))
    {
        return Err(invalid());
    }
    let mut metadata = metadata.as_object().cloned().ok_or_else(invalid)?;
    metadata.remove("sdk_sentinel_thread");
    metadata.remove("sdk_sentinel_nonce");
    body["client_metadata"] = serde_json::Value::Object(metadata);
    native_interception::sentinel_restore_schemas(inner, provider_id, &ticket, &mut body)
        .await
        .map_err(|_| invalid())?;
    let headers: Vec<_> = prepared
        .headers
        .iter()
        .map(|(name, value)| {
            (
                name.as_str(),
                value
                    .as_bytes()
                    .trim_ascii()
                    .iter()
                    .copied()
                    .map(char::from)
                    .collect::<String>(),
            )
        })
        .collect();
    // Match Node rawHeaders' Latin-1 decode. Native sentinel_headers remains
    // authoritative for provider/grant/Host resolution.
    let headers = serde_json::to_string(&headers).map_err(|_| invalid())?;
    let body = serde_json::to_vec(&body).map_err(|_| invalid())?;
    let (status, headers, body) = sentinel_stream_dispatch(
        inner,
        provider_id,
        &headers,
        body.into(),
        &ticket,
        request.response_body_limit_bytes,
    )
    .await
    .map_err(|_| invalid())?;
    let headers = sentinel_response_headers(headers).map_err(|_| invalid())?;
    match body {
        NativeModelBody::HttpError(text) => {
            if let Some(max_bytes) = request.response_body_limit_bytes {
                if text.as_ref().is_some_and(|body| body.len() > max_bytes) {
                    return Err(TransportError::ResponseTooLarge { max_bytes });
                }
            }
            // The carrier sends UTF-8 diagnostics, then the outer transport
            // decodes again. Keep BOM/charset behavior and filtered Retry-After.
            let mut response = http::Response::new(bytes::Bytes::from(text.unwrap_or_default()));
            *response.headers_mut() = headers.clone();
            let body = codex_http_client::HttpResponse::from(response)
                .text()
                .await
                .ok();
            Err(TransportError::Http {
                status,
                url: Some(request.url),
                retry_after: codex_client::RetryAfter::from_headers(&headers),
                headers: Some(headers),
                body,
            })
        }
        NativeModelBody::Streaming(bytes) => Ok(codex_client::StreamResponse {
            status,
            headers,
            // A carrier read failure closes the outer HTTP body. Preserve that
            // transport failure category instead of exposing a raw native error.
            bytes: bytes
                .map(|chunk| {
                    chunk.map_err(|error| match error {
                        error @ TransportError::ResponseTooLarge { .. } => error,
                        _ => TransportError::Network("error decoding response body".into()),
                    })
                })
                .boxed(),
        }),
        NativeModelBody::Closed => Ok(codex_client::StreamResponse {
            status,
            headers,
            bytes: futures_util::stream::empty().boxed(),
        }),
    }
}

// Match NativeProviderRoutes.responseHeaders, including Connection nominees.
fn sentinel_response_headers(
    mut headers: http::HeaderMap,
) -> Result<http::HeaderMap, TransportError> {
    let nominated: Vec<String> = headers
        .get_all(http::header::CONNECTION)
        .iter()
        .flat_map(|value| {
            String::from_utf8_lossy(value.as_bytes())
                .split(',')
                .map(|name| name.trim().to_ascii_lowercase())
                .collect::<Vec<_>>()
        })
        .collect();
    for name in nominated {
        headers.remove(name.as_str());
    }
    for name in [
        "connection",
        "content-length",
        "content-encoding",
        "transfer-encoding",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "upgrade",
        "x-agents-model-grant",
        "x-codex-agents-native-route",
        "x-sdk-sentinel-grant",
    ] {
        headers.remove(name);
    }
    // N-API decodes native response values as UTF-8; Node's writeHead then
    // accepts only Latin-1. Retain that encoding/error boundary without a socket.
    let mut carrier = http::HeaderMap::new();
    for (name, value) in headers.iter() {
        let value = String::from_utf8_lossy(value.as_bytes())
            .chars()
            .map(|character| u8::try_from(u32::from(character)))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| TransportError::Network("Invalid native response header".into()))?;
        let value = http::HeaderValue::from_bytes(value.trim_ascii())
            .map_err(|_| TransportError::Network("Invalid native response header".into()))?;
        carrier.append(name, value);
    }
    Ok(carrier)
}

// One native upstream dispatcher serves the N-API carrier and in-process route.
async fn sentinel_stream_dispatch(
    inner: &engine::EngineState,
    provider_id: &str,
    headers: &str,
    body: bytes::Bytes,
    ticket: &serde_json::Value,
    response_body_limit_bytes: Option<usize>,
) -> napi::Result<(http::StatusCode, http::HeaderMap, NativeModelBody)> {
    let _permit = inner.operation(false).map_err(native_error)?;
    let route = inner.sentinel_route(provider_id, headers)?;
    let turn = native_interception::sentinel_http_turn(inner, provider_id, ticket)
        .map_err(native_error)?;
    let provider = route.provider.api_provider().await.map_err(native_error)?;
    let mut request = provider
        .build_request("POST".parse().map_err(native_error)?, "responses")
        .with_raw_body(body);
    request.headers = model_websocket::sentinel_headers(headers, &provider)?;
    // Reuse the physical transport's existing streaming and error-body bounds.
    request.response_body_limit_bytes = response_body_limit_bytes;
    let result = match request.into_prepared() {
        Ok(request) => {
            codex_client::run_with_retry(
                provider.retry.to_policy(),
                || request.clone(),
                |request, _attempt| async {
                    // Each upstream attempt is newly admitted, including
                    // retries of a request that began before the stop.
                    if turn
                        .as_deref()
                        .is_some_and(turn_settlement::Turn::sampling_stopped)
                    {
                        // Keep the owning interrupt responsible for settlement.
                        std::future::pending::<()>().await;
                    }
                    route
                        .transport
                        .stream(request)
                        .await
                        .map_err(model_transport_error)
                },
            )
            .await
        }
        Err(error) => Err(TransportError::Build(error)),
    };
    let (status, headers, body) = match result {
        Ok(response) => (
            response.status,
            response.headers,
            NativeModelBody::Streaming(response.bytes),
        ),
        Err(TransportError::Http {
            status,
            headers,
            body,
            ..
        }) => NativeModelBody::http_error(status, headers, body)?,
        Err(error) => {
            native_interception::sentinel_failed(
                inner,
                provider_id,
                ticket,
                native_interception::SentinelFailure::Transport(error),
            )
            .map_err(native_error)?;
            // This private success carrier owns no provider events.
            // The admitted ticket supplies the settled native error.
            let mut headers = http::HeaderMap::new();
            headers.insert(
                http::header::CONTENT_TYPE,
                http::HeaderValue::from_static("text/event-stream"),
            );
            (http::StatusCode::OK, headers, NativeModelBody::Closed)
        }
    };
    Ok((status, headers, body))
}

fn model_transport_error(error: TransportError) -> TransportError {
    if model_websocket::tls_certificate_rejected(&error) {
        TransportError::Http {
            status: http::StatusCode::BAD_REQUEST,
            url: None,
            headers: None,
            body: Some(model_websocket::CERTIFICATE_REJECTED.to_owned()),
            retry_after: None,
        }
    } else {
        error
    }
}

struct NativeModelRoute {
    provider: codex_model_provider::SharedModelProvider,
    transport: ReqwestTransport,
    websocket: model_websocket::ConnectorCache,
    client_factory: codex_http_client::HttpClientFactory,
}

// A Response is pulled only by the adapter's existing HTTP request owner.
// Closing first retires that owner's pending send/read, then acquires the mutex.
enum NativeModelBody {
    Streaming(ByteStream),
    HttpError(Option<String>),
    Closed,
}

impl NativeModelBody {
    fn http_error(
        status: http::StatusCode,
        headers: Option<http::HeaderMap>,
        body: Option<String>,
    ) -> napi::Result<(http::StatusCode, http::HeaderMap, Self)> {
        let mut headers = headers.unwrap_or_default();
        if body.is_some()
            && let Some(content_type) = headers.get("content-type")
        {
            // Transport::stream already decoded this diagnostic. Retain its
            // media type even if a quoted parameter contained HTTP obs-text;
            // those parameters no longer describe the String's UTF-8 bytes.
            let media_type = content_type
                .as_bytes()
                .split(|byte| *byte == b';')
                .next()
                .unwrap_or_default();
            let media_type = std::str::from_utf8(media_type)
                .ok()
                .filter(|value| value.is_ascii())
                .unwrap_or("text/plain")
                .trim();
            headers.insert(
                "content-type",
                format!("{media_type}; charset=utf-8")
                    .parse()
                    .map_err(native_error)?,
            );
        }
        Ok((status, headers, Self::HttpError(body)))
    }
}

#[napi(js_name = "_ModelHttpRequest")]
pub struct ModelHttpRequest {
    cancelled: tokio_util::sync::CancellationToken,
}

#[napi]
impl ModelHttpRequest {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            cancelled: tokio_util::sync::CancellationToken::new(),
        }
    }

    #[napi]
    pub fn cancel(&self) {
        self.cancelled.cancel();
    }
}

#[napi(js_name = "NativeModelResponse")]
pub struct NativeModelResponse {
    inner: RuntimeOwned<tokio::sync::Mutex<NativeModelBody>>,
    cancelled: tokio_util::sync::CancellationToken,
    status: u16,
    headers: Vec<(String, String)>,
}

#[napi]
impl NativeModelResponse {
    #[napi(getter, js_name = "status")]
    pub fn get_status(&self) -> u16 {
        self.status
    }
    #[napi(getter, js_name = "headers")]
    pub fn get_headers(&self) -> Vec<Vec<String>> {
        self.headers
            .iter()
            .map(|(k, v)| vec![k.clone(), v.clone()])
            .collect()
    }

    #[napi(js_name = "next_chunk")]
    pub async fn __anext__(&self) -> napi::Result<Option<napi::bindgen_prelude::Buffer>> {
        let inner = Arc::clone(&self.inner);
        let cancelled = self.cancelled.clone();
        (async move {
            let mut body = inner.lock().await;
            match &mut *body {
                NativeModelBody::Streaming(bytes) => {
                    let next = tokio::select! {
                        biased;
                        _ = cancelled.cancelled() => None,
                        next = std::future::poll_fn(|cx| bytes.as_mut().poll_next(cx)) => next,
                    };
                    match next {
                        Some(Ok(chunk)) => {
                            return Ok(Some(napi::bindgen_prelude::Buffer::from(chunk.to_vec())));
                        }
                        Some(Err(error)) => {
                            *body = NativeModelBody::Closed;
                            return Err(native_error(error));
                        }
                        None => {}
                    }
                }
                NativeModelBody::HttpError(text) => {
                    if let Some(text) = text.take() {
                        return Ok(Some(napi::bindgen_prelude::Buffer::from(text.into_bytes())));
                    }
                }
                NativeModelBody::Closed => {}
            }
            *body = NativeModelBody::Closed;
            Ok(None)
        })
        .await
    }

    #[napi(js_name = "close")]
    pub async fn close(&self) -> napi::Result<()> {
        self.cancelled.cancel();
        let inner = Arc::clone(&self.inner);
        (async move {
            *inner.lock().await = NativeModelBody::Closed;
            Ok(())
        })
        .await
    }
}

// Provider selection belongs to native configuration, including file layers.
// This query opens no provider connection or credential manager.

#[napi(js_name = "CODEX_REVISION")]
pub const CODEX_REVISION: &str = include_str!("../CODEX_REVISION").trim_ascii();

#[napi_derive::module_init]
fn init() {
    napi::bindgen_prelude::register_async_runtime(node_runtime::NodeRuntime::default());
}

async fn retain_writer_operation<T: Send + 'static>(
    operation: impl std::future::Future<Output = napi::Result<T>> + Send + 'static,
) -> napi::Result<T> {
    tokio::spawn(operation).await.map_err(native_error)?
}

#[cfg(test)]
mod local_storage_tests;

#[cfg(test)]
mod goal_tests;

#[cfg(test)]
mod engine_owner_tests {
    use super::*;

    #[tokio::test]
    async fn aliases_preserve_live_engine_and_last_owner_joins_real_shutdown() {
        let provider = crate::local_storage_tests::Provider::start().await;
        let home = tempfile::tempdir().unwrap();
        let state = engine::EngineState::new(
            provider.config().to_string(),
            serde_json::json!({"codex_home": home.path(), "cwd": home.path()}).to_string(),
            false,
            None,
        )
        .await
        .unwrap();
        let engine = Engine::new(state);
        let observed = engine.current().unwrap();
        let weak_owner = Arc::downgrade(&engine.inner);
        let retained = Arc::clone(&engine.inner);
        drop(engine);
        assert!(retained.lock().unwrap().live.is_some());
        assert!(!observed.closed.load(std::sync::atomic::Ordering::Acquire));
        drop(retained);
        assert!(
            weak_owner.upgrade().is_none(),
            "the shared owner must not retain itself"
        );
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while !observed.closed.load(std::sync::atomic::Ordering::Acquire) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("last owner must finish actual engine shutdown");
        assert!(observed.operation(false).is_err());
    }
}

/// Explicit native lifecycle errors must never include configuration contents.
fn telemetry_error(error: anyhow::Error) -> napi::Error {
    let message = error.to_string();
    let safe = match message.as_str() {
        "Codex telemetry can only be configured once per process"
        | "Configure telemetry before creating any Codex clients"
        | "A Rust tracing subscriber is already installed; Codex telemetry cannot replace it"
        | "Configure telemetry successfully before shutdown"
        | "Configure native telemetry before starting traces; shutdown is terminal"
        | "Configure a trace exporter or trace processors before starting native traces"
        | "Telemetry timeout must be between 1 and 60000 milliseconds"
        | "Telemetry shutdown timed out waiting for the telemetry owner" => message.as_str(),
        _ => {
            "Native telemetry operation failed. Check the exporter settings; a new process may be required."
        }
    };
    native_error(safe)
}

#[napi(js_name = "configure_telemetry")]
pub async fn configure_telemetry(config_json: String) -> napi::Result<()> {
    telemetry::initialize(&config_json, "{}")
        .await
        .map_err(telemetry_error)
}

#[napi(js_name = "shutdown_telemetry")]
pub async fn shutdown_telemetry(timeout_ms: Option<u32>) -> napi::Result<()> {
    telemetry::shutdown(timeout_ms)
        .await
        .map_err(telemetry_error)
}

#[napi(js_name = "start_trace_span")]
pub fn start_trace_span(options_json: String) -> napi::Result<String> {
    telemetry::scope_ready().map_err(telemetry_error)?;
    codex_otel::sdk_trace::start_trace_span(&options_json).map_err(native_error)
}

#[napi(js_name = "end_trace_span")]
pub fn end_trace_span(handle: String, outcome_json: String) -> napi::Result<()> {
    codex_otel::sdk_trace::end_trace_span(&handle, &outcome_json).map_err(native_error)
}

#[napi(js_name = "retain_trace_context")]
pub fn retain_trace_context(handle: String) -> napi::Result<String> {
    codex_otel::sdk_trace::retain_trace_context(&handle).map_err(native_error)
}

#[napi(js_name = "trace_span_context")]
pub fn trace_span_context(handle: String) -> napi::Result<String> {
    codex_otel::sdk_trace::trace_span_context(&handle).map_err(native_error)
}

#[napi(js_name = "set_trace_routes")]
pub fn set_trace_routes(options_json: String) -> napi::Result<f64> {
    telemetry::tracing_ready().map_err(telemetry_error)?;
    codex_otel::sdk_trace_routes::set_trace_routes(&options_json)
        .map(|sequence| sequence as f64)
        .map_err(native_error)
}

#[napi(js_name = "register_trace_credentials")]
pub fn register_trace_credentials(headers_json: String) -> napi::Result<String> {
    telemetry::tracing_ready().map_err(telemetry_error)?;
    codex_otel::sdk_trace_routes::register_trace_credentials(&headers_json).map_err(native_error)
}

#[napi(js_name = "release_trace_credentials")]
pub fn release_trace_credentials(credential_ref: String) -> napi::Result<()> {
    codex_otel::sdk_trace_routes::release_trace_credentials(&credential_ref).map_err(native_error)
}

#[napi(js_name = "ack_trace_events")]
pub fn ack_trace_events(through_sequence: f64, failed_deliveries: f64) -> napi::Result<()> {
    if ![through_sequence, failed_deliveries]
        .iter()
        .all(|v| v.is_finite() && *v >= 0.0 && v.fract() == 0.0 && *v <= 9_007_199_254_740_991.0)
    {
        return Err(input_error(
            "Trace acknowledgments require nonnegative safe integers",
        ));
    }
    codex_otel::sdk_trace_routes::ack_trace_events(
        through_sequence as u64,
        failed_deliveries as u64,
    )
    .map_err(native_error)
}

#[napi(js_name = "release_trace_context")]
pub fn release_trace_context(handle: String) {
    codex_otel::sdk_trace::release_trace_context(&handle);
}

#[napi(js_name = "release_trace_span")]
pub fn release_trace_span(handle: String) {
    codex_otel::sdk_trace::release_trace_span(&handle);
}

#[napi(js_name = "force_flush_telemetry")]
pub async fn force_flush_telemetry(timeout_ms: Option<u32>) -> napi::Result<String> {
    telemetry::force_flush(timeout_ms)
        .await
        .map_err(telemetry_error)
}
#[napi(js_name = "drain_trace_events")]
pub async fn drain_trace_events(max_count: u32) -> napi::Result<String> {
    codex_otel::sdk_trace_routes::drain_trace_events(max_count as usize).map_err(native_error)
}

#[derive(Debug)]
pub(crate) enum TraceIngressError {
    Conflict,
    Invalid(String),
}
impl std::fmt::Display for TraceIngressError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Conflict => {
                f.write_str("Explicit trace context must match the SDK tracing parent")
            }
            Self::Invalid(message) => f.write_str(message),
        }
    }
}

fn lease_context(
    lease: Option<&codex_otel::sdk_trace::ContextLease>,
) -> anyhow::Result<opentelemetry::Context> {
    let context = lease
        .map(|lease| codex_otel::sdk_trace::context(lease.token()))
        .transpose()
        .map_err(anyhow::Error::msg)?
        .unwrap_or_default();
    Ok(codex_otel::sdk_trace::explicit_submission_context(context))
}

fn trace_identity(
    carrier: &codex_protocol::protocol::W3cTraceContext,
) -> Result<(opentelemetry::trace::TraceId, opentelemetry::trace::SpanId), TraceIngressError> {
    let context = codex_otel::context_from_w3c_trace_context(carrier)
        .ok_or_else(|| TraceIngressError::Invalid("Invalid trace carrier".into()))?;
    let span = context.span();
    let parent = span.span_context();
    Ok((parent.trace_id(), parent.span_id()))
}

fn resolve_trace_parent(
    explicit: Option<codex_protocol::protocol::W3cTraceContext>,
    tracing_context: Option<&str>,
) -> Result<Option<codex_protocol::protocol::W3cTraceContext>, TraceIngressError> {
    let explicit_identity = explicit.as_ref().map(trace_identity).transpose()?;
    let scoped = tracing_context
        .map(codex_otel::sdk_trace::trace_carrier)
        .transpose()
        .map_err(TraceIngressError::Invalid)?;
    if let (Some(parent), Some(scoped)) = (explicit_identity, scoped.as_ref())
        && parent != trace_identity(scoped)?
    {
        return Err(TraceIngressError::Conflict);
    }
    // The native token carries policy independently. Preserve explicit wire flags and tracestate.
    Ok(explicit.or(scoped))
}

fn resolve_trace_json(
    trace_json: Option<&str>,
    tracing_context: Option<&str>,
) -> Result<Option<codex_protocol::protocol::W3cTraceContext>, TraceIngressError> {
    let explicit = trace_json
        .map(serde_json::from_str::<codex_protocol::protocol::W3cTraceContext>)
        .transpose()
        .map_err(|_| TraceIngressError::Invalid("Invalid trace carrier".into()))?;
    resolve_trace_parent(explicit, tracing_context)
}

pub(crate) fn prepare_submission_trace(value: &mut Value) -> Result<(), TraceIngressError> {
    let Some(object) = value.as_object_mut() else {
        return Ok(());
    };
    let token = object.remove("tracing_context");
    let tracing_context = match &token {
        None | Some(Value::Null) => None,
        Some(Value::String(token)) => Some(token.as_str()),
        Some(_) => {
            return Err(TraceIngressError::Invalid(
                "Invalid tracing context token".into(),
            ));
        }
    };
    let explicit = object
        .remove("trace")
        .filter(|trace| !trace.is_null())
        .map(serde_json::from_value::<codex_protocol::protocol::W3cTraceContext>)
        .transpose()
        .map_err(|_| TraceIngressError::Invalid("Invalid trace carrier".into()))?;
    if let Some(trace) = resolve_trace_parent(explicit, tracing_context)? {
        object.insert(
            "trace".into(),
            serde_json::to_value(trace)
                .map_err(|_| TraceIngressError::Invalid("Invalid trace carrier".into()))?,
        );
    }
    Ok(())
}

#[cfg(test)]
mod native_trace_merge_tests {
    use super::*;
    use codex_protocol::protocol::W3cTraceContext;
    use serde_json::json;

    fn carrier(span: &str, flags: &str, state: &str) -> W3cTraceContext {
        W3cTraceContext {
            traceparent: Some(format!(
                "00-123456789012345678901234567890ab-{span}-{flags}"
            )),
            tracestate: Some(state.into()),
        }
    }

    #[test]
    fn parsed_identity_uses_trace_and_span_ids_not_flags_or_state() {
        let sampled = carrier("12345678901234ab", "01", "fixture=one");
        let unsampled = carrier("12345678901234ab", "00", "fixture=two");
        assert_eq!(
            trace_identity(&sampled).unwrap(),
            trace_identity(&unsampled).unwrap()
        );
        assert_ne!(
            trace_identity(&sampled).unwrap(),
            trace_identity(&carrier("12345678901234ac", "01", "fixture=one")).unwrap()
        );
        assert!(
            trace_identity(&W3cTraceContext {
                traceparent: Some("invalid".into()),
                tracestate: None
            })
            .is_err()
        );
    }

    #[test]
    fn explicit_carrier_without_sdk_scope_keeps_flags_and_tracestate() {
        let explicit = carrier("12345678901234ab", "00", "fixture=explicit");
        let selected = resolve_trace_json(Some(&serde_json::to_string(&explicit).unwrap()), None)
            .unwrap()
            .unwrap();
        assert_eq!(selected.traceparent, explicit.traceparent);
        assert_eq!(selected.tracestate, explicit.tracestate);
    }

    #[test]
    fn sdk_submit_conflict_is_not_submitted_and_matching_parent_keeps_policy() {
        const CHILD: &str = "AGENTS_TRACE_MERGE_NATIVE_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "native_trace_merge_tests::sdk_submit_conflict_is_not_submitted_and_matching_parent_keeps_policy", "--nocapture"])
                .env(CHILD, "1").status().unwrap();
            assert!(status.success());
            return;
        }
        codex_otel::sdk_trace::configure_pipeline(false);
        let readback: Value = serde_json::from_str(
            &codex_otel::sdk_trace::start_trace_span(
                r#"{"name":"merge-policy","kind":"workflow","disabled":true}"#,
            )
            .unwrap(),
        )
        .unwrap();
        let token = readback["handle"].as_str().unwrap();
        for flags in ["02", "03"] {
            let explicit = W3cTraceContext {
                traceparent: Some(format!(
                    "00-{}-{}-{flags}",
                    readback["trace_id"].as_str().unwrap(),
                    readback["span_id"].as_str().unwrap()
                )),
                tracestate: Some("fixture=explicit".into()),
            };
            let mut mismatch = json!({"input":[],"trace":carrier("12345678901234ab","01","fixture=other"),"tracing_context":token});
            let receipt = ops::prepare_submission_trace(&mut mismatch)
                .unwrap()
                .unwrap();
            assert_eq!(receipt["status"], "not_submitted");
            assert_eq!(receipt["reason"]["type"], "trace_context_conflict");
            assert!(codex_otel::sdk_trace::trace_span_context(token).is_ok());
            let mut matching = json!({"input":[],"trace":explicit,"tracing_context":token});
            assert!(
                ops::prepare_submission_trace(&mut matching)
                    .unwrap()
                    .is_none()
            );
            assert_eq!(
                matching["trace"]["traceparent"],
                explicit.traceparent.as_deref().unwrap()
            );
            assert_eq!(matching["trace"]["tracestate"], "fixture=explicit");
            assert!(matching.get("tracing_context").is_none());
            let parsed = codex_otel::context_from_w3c_trace_context(&explicit).unwrap();
            assert!(codex_otel::sdk_trace::policy_for_context(&parsed).is_none());
            let _caller = codex_otel::sdk_trace::context(token).unwrap().attach();
            let restored = codex_otel::sdk_trace::current_scope_policy().unwrap();
            let original = codex_otel::sdk_trace::policy_for_context(
                &codex_otel::sdk_trace::context(token).unwrap(),
            )
            .unwrap();
            assert!(std::sync::Arc::ptr_eq(&restored, &original));
            assert!(restored.disabled);
            assert!(!restored.include_sensitive_data);
        }
        let mut scoped_only = json!({"input":[],"tracing_context":token});
        assert!(
            ops::prepare_submission_trace(&mut scoped_only)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            scoped_only["trace"]["traceparent"],
            codex_otel::sdk_trace::trace_carrier(token)
                .unwrap()
                .traceparent
                .unwrap()
        );
        codex_otel::sdk_trace::end_trace_span(token, r#"{"status":"ok"}"#).unwrap();
        codex_otel::sdk_trace::release_trace_span(token);
    }
}

mod request_metadata;
