//! Real MCP startup questions must survive the candidate reader handoff.
use super::*;
use crate::local_storage_tests::{Provider, options, specs};
use futures_util::{FutureExt, StreamExt};
use serde_json::{Value, json};
use std::time::Duration;

// The peer can answer tools/list without answering its outstanding form.
// Its request goes through the real RMCP elicitation router, not a fake event.
const PEER: &str = r#"
import { createInterface } from 'node:readline';
const question = process.argv[2] === 'question';
let asked = false;
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (!request.method || request.id === undefined) continue;
  let result;
  switch (request.method) {
    case 'initialize':
      result = { protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: 'startup', version: '1' } };
      break;
    case 'tools/list':
      if (question && !asked) {
        asked = true;
        send({ jsonrpc: '2.0', id: 'startup-form', method: 'elicitation/create',
          params: { mode: 'form', message: 'Choose the startup answer.',
            requestedSchema: { type: 'object', properties: { answer: { type: 'string' } },
              required: ['answer'] } } });
      }
      result = { tools: [] };
      break;
    case 'ping': result = {}; break;
    default:
      send({ jsonrpc: '2.0', id: request.id,
        error: { code: -32601, message: 'unsupported fixture method' } });
      continue;
  }
  send({ jsonrpc: '2.0', id: request.id, result });
}
"#;

async fn native<T>(future: impl Future<Output = napi::Result<T>>) -> Result<T, String> {
    tokio::time::timeout(Duration::from_secs(10), future)
        .await
        .map_err(|_| "native fixture operation timed out".to_owned())?
        .map_err(|error| error.to_string())
}

// Use the existing real provider's first lookup response, then its final answer.
async fn turn(thread: &NativeThread, text: &str) -> Result<(), String> {
    native(thread._submit(
        json!({"mode":"start_if_idle","input":[{"type":"text","text":text}]}).to_string(),
    ))
    .await?;
    loop {
        let raw = native(thread.next_session_event()).await?;
        let event: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
        match event["msg"]["type"].as_str() {
            Some("dynamic_tool_call_request") => {
                let accepted = native(thread._respond_python_tool(json!({
                    "request": event["msg"],
                    "response":{"contentItems":[{"type":"inputText","text":"fixture receipt"}],"success":true}
                }).to_string())).await?;
                if !accepted {
                    return Err("fixture reply was not accepted".into());
                }
            }
            Some("task_complete" | "turn_complete") => return Ok(()),
            Some("error" | "turn_aborted") => {
                return Err(format!("unexpected fixture failure: {event}"));
            }
            _ => {}
        }
    }
}

// Observe the actual store without appending another settings checkpoint.
async fn stored_audit(thread: &NativeThread) -> Result<Value, String> {
    let state = thread.current().map_err(|error| error.to_string())?;
    let history = state
        .engine
        .load_checkpoint_history(state.id)
        .await
        .map_err(|error| error.to_string())?;
    Ok(json!({"source_session_id": state.id, "history": history}))
}

struct Fixture {
    provider: Provider,
    _home: tempfile::TempDir,
    source_engine: crate::Engine,
    source: NativeThread,
    change: crate::ContextChange,
    _candidate_engine: crate::Engine,
    candidate: NativeThread,
    servers: String,
    before: Value,
}

impl Fixture {
    async fn open(question: bool) -> Self {
        let provider = Provider::start().await;
        let home = tempfile::tempdir().unwrap();
        let peer = home.path().join("startup-peer.mjs");
        std::fs::write(&peer, PEER).unwrap();
        let mut config = provider.config();
        config["approval_policy"] = json!("on-request");
        config["sandbox_mode"] = json!("read-only");
        // The package loader supplies these roles for JS callers. A direct
        // Rust fixture receives genuine, source-qualified private helpers.
        let runtime_exe = std::path::PathBuf::from(
            std::env::var_os("CODEX_AGENTS_TEST_RUNTIME")
                .expect("admitted native runtime helper is required for local MCP"),
        );
        assert!(runtime_exe.is_absolute() && runtime_exe.is_file());
        let runtime = json!({"codex_home":home.path(),"cwd":home.path(),
            "codex_self_exe": runtime_exe});
        #[cfg(target_os = "linux")]
        let runtime = {
            let mut runtime = runtime;
            let sandbox = std::path::PathBuf::from(
                std::env::var_os("CODEX_AGENTS_TEST_SANDBOX")
                    .expect("admitted Linux sandbox helper alias is required"),
            );
            assert!(sandbox.is_absolute() && sandbox.is_file());
            runtime["codex_linux_sandbox_exe"] = json!(sandbox);
            runtime
        };
        let source_engine =
            crate::create_engine(config.to_string(), runtime.to_string(), None, None)
                .await
                .unwrap();
        let options = options(None);
        let source = source_engine
            .start_replaceable_thread(options.clone(), specs())
            .await
            .unwrap();
        source
            ._configure_manual_tools("[{\"name\":\"lookup\"}]".into())
            .unwrap();
        turn(&source, "Record the original audit.").await.unwrap();
        assert_eq!(provider.request_count(), 2);
        let change = source._begin_context_change().await.unwrap();
        // begin() completed its intentional settings checkpoint. Compare all
        // stored rows from this boundary through candidate rollback.
        let before = stored_audit(&source).await.unwrap();
        let checkpoint = change
            .prepare("The lookup is complete.".into(), vec![])
            .await
            .unwrap();
        let servers = json!({"startup":{"command":"node","args":[peer, if question { "question" } else { "clean" }],
            "enabled":true,"required":false,"startup_timeout_sec":5}}).to_string();
        // Start with an empty roster so only the actual publication below can
        // create the observed form; no event can belong to an earlier roster.
        let candidate_engine = change
            .create_candidate_engine(None, Some("{}".into()))
            .await
            .unwrap();
        let candidate = candidate_engine
            .restore_checkpoint(checkpoint, options, Some(specs()), Some(false))
            .await
            .unwrap();
        candidate
            ._configure_manual_tools("[{\"name\":\"lookup\"}]".into())
            .unwrap();
        Self {
            provider,
            _home: home,
            source_engine,
            source,
            change,
            _candidate_engine: candidate_engine,
            candidate,
            servers,
            before,
        }
    }
}

// Peek the actual Core event future, leaving its real result buffered for the
// SDK's sole reader. This is a scheduling barrier at an existing retained slot;
// it creates neither a synthetic question nor a replacement publication result.
async fn buffer_real_question(state: &Arc<ThreadState>) -> Result<Value, String> {
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut next = state
            .events
            .lock()
            .await
            .native
            .take()
            .ok_or_else(|| "candidate native reader is missing".to_owned())?;
        let native_dequeued = state.events.lock().await.native_dequeued.clone();
        loop {
            let mut buffered = next.into_stream().peekable();
            let (event, _) = match Pin::new(&mut buffered).peek().await {
                Some(Ok(event)) => event,
                Some(Err(error)) => return Err(error.to_string()),
                None => return Err("candidate native reader ended".into()),
            };
            if let EventMsg::ElicitationRequest(request) = &event.msg {
                let observed = serde_json::to_value(request).map_err(|error| error.to_string())?;
                state.events.lock().await.native = Some(Box::pin(async move {
                    buffered.next().await.expect("peeked real native event")
                }));
                return Ok(observed);
            }
            if !matches!(
                &event.msg,
                EventMsg::McpStartupUpdate(_)
                    | EventMsg::McpStartupComplete(_)
                    | EventMsg::Warning(_)
            ) {
                return Err(format!("unexpected event before the real form: {event:?}"));
            }
            // Consume only real benign startup notices before the form.
            buffered
                .next()
                .await
                .expect("peeked real native event")
                .map_err(|error| error.to_string())?;
            native_dequeued.store(false, Ordering::Release);
            next = next_native_event(Arc::clone(&state.thread), native_dequeued.clone());
        }
    })
    .await
    .map_err(|_| "real MCP form was not routed before the barrier deadline".to_owned())?
}

#[derive(Clone, Copy, PartialEq)]
enum Handoff {
    Default,
    BenignBeforeQuestion,
    ExhaustedCooperativeBudget,
    EmptyWaitingReader,
    ExcessReadyTail,
}

fn benign_startup(raw: &str) -> Result<(), String> {
    let event: Value = serde_json::from_str(raw).map_err(|error| error.to_string())?;
    if matches!(
        event["msg"]["type"].as_str(),
        Some("warning" | "mcp_startup_update" | "mcp_startup_complete")
    ) {
        Ok(())
    } else {
        Err(format!("unexpected startup delivery: {event}"))
    }
}

// Retain the one existing read at Pending, after consuming only known notices.
// The fixed fixture sends finite startup traffic; the limit detects setup drift.
async fn waiting_reader<'a>(
    change: &'a crate::ContextChange,
    candidate: &'a NativeThread,
) -> Result<impl std::future::Future<Output = napi::Result<Option<String>>> + 'a, String> {
    let mut reader = Box::pin(change.next_candidate_event(candidate));
    for _ in 0..64 {
        match futures_util::poll!(tokio::task::unconstrained(reader.as_mut())) {
            std::task::Poll::Pending => return Ok(reader),
            std::task::Poll::Ready(Ok(Some(raw))) => benign_startup(&raw)?,
            std::task::Poll::Ready(other) => {
                return Err(format!("reader ended before stop: {other:?}"));
            }
        }
        reader = Box::pin(change.next_candidate_event(candidate));
    }
    Err("finite fixture startup did not reach a waiting reader".into())
}

async fn exercise(question: bool, handoff: Handoff) {
    let fixture = Fixture::open(question).await;
    let mut retired = false;
    let outcome: Result<bool, String> = async {
        let raw = native(fixture.change.next_candidate_event(&fixture.candidate))
            .await?
            .ok_or_else(|| "startup reader ended before its benign event".to_owned())?;
        let benign: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
        if benign["msg"]["type"] != "session_configured" {
            return Err(format!(
                "fixture did not retain a benign first delivery: {benign}"
            ));
        }
        let raw = native(fixture.change.publish_candidate_mcp_servers(
            &fixture.candidate,
            fixture.servers.clone(),
            None,
            None,
        ))
        .await?;
        let publication: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
        if publication["result"]["ready"] != true
            || publication["result"]["publication"] != "published"
        {
            return Err(format!("real startup did not publish ready: {publication}"));
        }
        if fixture.provider.request_count() != 2 {
            return Err("startup made an unexpected model request".into());
        }
        if matches!(
            handoff,
            Handoff::EmptyWaitingReader | Handoff::ExcessReadyTail
        ) {
            let reader = waiting_reader(&fixture.change, &fixture.candidate).await?;
            let state = fixture
                .candidate
                .current()
                .map_err(|error| error.to_string())?;
            if state.thread.queued_event_count() != 0 {
                return Err("fixture's waiting reader still has Core events".into());
            }
            if handoff == Handoff::EmptyWaitingReader {
                fixture.change.stop_candidate_events().await;
                return Ok(native(reader).await?.is_none());
            }
            drop(reader);
            // Use the existing SDK notification sink, after the real reader is
            // idle. These ready notices exceed Core's empty queue plus its slot.
            use codex_extension_api::ExtensionEventSink;
            for index in 0..3 {
                state.engine.extension_events.emit(Event {
                    id: String::new(),
                    msg: EventMsg::Warning(codex_protocol::protocol::WarningEvent {
                        message: format!("finite extra startup notice {index}"),
                    }),
                });
            }
            fixture.change.stop_candidate_events().await;
            for _ in 0..3 {
                match native(fixture.change.next_candidate_event(&fixture.candidate)).await {
                    Ok(Some(raw)) => benign_startup(&raw)?,
                    Ok(None) => return Ok(false),
                    Err(error) if error.contains("Compaction startup events did not quiesce") => {
                        return Ok(true);
                    }
                    Err(error) => return Err(error),
                }
            }
            return Ok(false);
        }
        if question {
            let state = fixture
                .candidate
                .current()
                .map_err(|error| error.to_string())?;
            let request = buffer_real_question(&state).await?;
            if request["turn_id"] != Value::Null
                || request["server_name"] != "startup"
                || request["request"]["mode"] != "form"
            {
                return Err(format!("fixture did not route an idle MCP form: {request}"));
            }
            if handoff == Handoff::BenignBeforeQuestion {
                // Retain a notice ahead of the actual form already held by the
                // native future. No second reader or fabricated request is used.
                state.events.lock().await.initial = Some(Event {
                    id: String::new(),
                    msg: EventMsg::Warning(codex_protocol::protocol::WarningEvent {
                        message: "benign retained delivery before the real form".into(),
                    }),
                });
            }
        }
        fixture.change.stop_candidate_events().await;
        if handoff == Handoff::BenignBeforeQuestion {
            let raw = native(fixture.change.next_candidate_event(&fixture.candidate))
                .await?
                .ok_or_else(|| "reader lost the retained benign delivery".to_owned())?;
            let event: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
            if event["msg"]["type"] != "warning"
                || event["msg"]["message"] != "benign retained delivery before the real form"
            {
                return Err(format!(
                    "retained notice did not precede the question: {event}"
                ));
            }
        }
        if handoff == Handoff::ExhaustedCooperativeBudget {
            for _ in 0..256 {
                if !tokio::task::coop::has_budget_remaining() {
                    break;
                }
                tokio::task::consume_budget().await;
            }
            if tokio::task::coop::has_budget_remaining() {
                return Err("fixture could not exhaust a constrained cooperative budget".into());
            }
        }
        let observed = loop {
            let observed = match native(fixture.change.next_candidate_event(&fixture.candidate))
                .await
            {
                Ok(observed) => observed,
                // The additional SDK notice can consume the finite allowance.
                // Rejection is safe; successful EOF with this real form is not.
                Err(error)
                    if handoff == Handoff::BenignBeforeQuestion
                        && (error.contains("Compaction startup events did not quiesce")
                            || error.contains("Compaction startup event drain is incomplete")) =>
                {
                    return Ok(true);
                }
                Err(error) => return Err(error),
            };
            let Some(raw) = observed.as_deref() else {
                break None;
            };
            let event: Value = serde_json::from_str(raw).map_err(|error| error.to_string())?;
            if event["msg"]["type"] == "elicitation_request" {
                break observed;
            }
            benign_startup(raw)?;
        };
        let validation = native(fixture.change.validate_candidate(&fixture.candidate)).await;
        if question {
            let saw_question = observed
                .as_deref()
                .map(serde_json::from_str::<Value>)
                .transpose()
                .map_err(|error| error.to_string())?
                .is_some_and(|event| event["msg"]["type"] == "elicitation_request");
            return Ok(saw_question || validation.is_err());
        }
        validation?;
        native(fixture.change.retire()).await?;
        retired = true;
        fixture.change.release().await;
        native(fixture.source.close()).await?;
        native(fixture.source_engine.close()).await?;
        turn(&fixture.candidate, "Continue from the supplied summary.").await?;
        Ok(fixture.provider.request_count() == 3)
    }
    .await;

    // Observe the failure only after real candidate teardown and source checks.
    let cleanup = native(fixture.change.cleanup_candidate()).await;
    fixture.change.release().await;
    let source_usable: Result<(), String> = if !retired {
        async {
            let after = stored_audit(&fixture.source).await?;
            if after["source_session_id"] != fixture.before["source_session_id"]
                || after["history"] != fixture.before["history"]
            {
                return Err(format!("rollback changed the source identity or original audit: before={}; after={after}", fixture.before));
            }
            turn(&fixture.source, "Continue after candidate rollback.").await?;
            if fixture.provider.request_count() != 3 {
                return Err("rollback continuation request count differs".into());
            }
            Ok(())
        }
        .await
    } else {
        Ok(())
    };
    let source_closed = native(fixture.source.close()).await;
    let engine_closed = native(fixture.source_engine.close()).await;
    assert!(
        cleanup.is_ok() && source_usable.is_ok() && source_closed.is_ok() && engine_closed.is_ok(),
        "cleanup={cleanup:?}; source={source_usable:?}; close={source_closed:?}/{engine_closed:?}; outcome={outcome:?}"
    );
    assert!(
        outcome.expect("real startup fixture must establish its schedule"),
        "ready publication and reader EOF silently admitted a buffered real MCP question"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn candidate_startup_question_cannot_escape_reader_handoff() {
    exercise(true, Handoff::Default).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn candidate_startup_without_question_preserves_summary_continuation() {
    exercise(false, Handoff::Default).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn candidate_startup_empty_waiting_reader_stops() {
    exercise(false, Handoff::EmptyWaitingReader).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn candidate_startup_benign_delivery_preserves_retained_question() {
    exercise(true, Handoff::BenignBeforeQuestion).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn candidate_startup_retained_question_survives_exhausted_cooperative_budget() {
    exercise(true, Handoff::ExhaustedCooperativeBudget).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn candidate_startup_excess_ready_tail_rolls_back_and_preserves_source() {
    exercise(false, Handoff::ExcessReadyTail).await;
}
