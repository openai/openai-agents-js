//! Focused native bridge lifetime checks without transport or model execution.
use super::*;
use codex_extension_api::{ModelAttemptAdmission, ModelToolAdmission, TurnSamplingStop};
use codex_protocol::model_retry::{ModelAttemptSnapshot, ModelProducerFailure, ModelRetryContext};
use codex_protocol::protocol::TokenUsage;

#[derive(Debug)]
struct Attempt {
    id: &'static str,
    cancel: CancellationToken,
    stop: Arc<TurnSamplingStop>,
    usage: Mutex<Option<TokenUsage>>,
}
impl Attempt {
    fn new(id: &'static str) -> Arc<Self> {
        Arc::new(Self {
            id,
            cancel: CancellationToken::new(),
            stop: Arc::new(TurnSamplingStop::default()),
            usage: Mutex::default(),
        })
    }
}
impl ModelAttemptAdmission for Attempt {
    fn id(&self) -> &str {
        self.id
    }
    fn attempt(&self) -> u64 {
        1
    }
    fn retry_configured(&self) -> bool {
        true
    }
    fn disable_provider_retries(&self) -> bool {
        true
    }
    fn cancellation(&self) -> CancellationToken {
        self.cancel.clone()
    }
    fn sampling_stop(&self) -> Arc<TurnSamplingStop> {
        Arc::clone(&self.stop)
    }
    fn snapshot(&self) -> std::result::Result<ModelAttemptSnapshot, String> {
        Ok(Default::default())
    }
    fn observe_request(
        &self,
        _: &str,
        _: Option<&str>,
        _: Option<&str>,
    ) -> std::result::Result<(), String> {
        Ok(())
    }
    fn report_failure(&self, failure: ModelProducerFailure) -> std::result::Result<(), String> {
        if failure.attempt_id != self.id {
            return Err("Foreign failure".into());
        }
        if let Some(usage) = failure.usage {
            self.report_usage(usage)?;
        }
        Ok(())
    }
    fn report_usage(&self, usage: TokenUsage) -> std::result::Result<(), String> {
        *self.usage.lock().unwrap() = Some(usage);
        Ok(())
    }
    fn mark_response_started(&self) {}
    fn mark_unsafe_output(&self) {}
    fn mark_local_effect(&self) {}
}
#[derive(Debug)]
struct Admission {
    turn: Arc<ExtensionData>,
    original: Arc<dyn ModelAttemptAdmission>,
}
impl ModelToolAdmission for Admission {
    fn thread_id(&self) -> &str {
        "root"
    }
    fn turn_store(&self) -> &ExtensionData {
        &self.turn
    }
    fn model_attempt(&self) -> Option<Arc<dyn ModelAttemptAdmission>> {
        Some(Arc::clone(&self.original))
    }
    fn admits(&self, _: &ResponseItem) -> bool {
        true
    }
}
fn receipt(event: &Value) -> Value {
    json!({"thread":"root","instance":null,"turn_id":"turn", "generation":event["msg"]["generation"],
        "request_id":event["msg"]["request_id"]})
}
fn admission(attempt: Arc<dyn ModelAttemptAdmission>) -> Arc<Admission> {
    Arc::new(Admission {
        turn: Arc::new(ExtensionData::new("turn")),
        original: attempt,
    })
}

#[tokio::test]
async fn cancelled_producer_joins_cleanup_and_measures_original_frame() {
    let tools = super::super::pending_tests::tools();
    let original = Attempt::new("original");
    let frame: Arc<dyn ModelAttemptAdmission> = original.clone();
    let source = admission(frame.clone());
    let mut produce = Box::pin(
        tools.produce_model_response("fixture", json!({"model":"fixture","input":[]}), source.clone()),
    );
    assert!(futures_util::poll!(&mut produce).is_pending());
    let event = tools.next_request().await;
    let callback = event["msg"]["_sdk_callback"].clone();
    assert!(tools.callback_operation("root", &callback, "enter"));
    let successor = Attempt::new("successor");
    source
        .turn
        .insert(codex_extension_api::CapturedModelAttempt(successor.clone()));
    original.cancel.cancel();
    original.stop.request();
    let mut retire = Box::pin(tools.retire_model_attempt_callbacks(&frame));
    assert!(futures_util::poll!(&mut retire).is_pending());
    assert!(futures_util::poll!(&mut produce).is_pending());
    assert!(
        tools
            .reply_model_producer(
                serde_json::from_value(json!({"owner":receipt(&event),
        "data":{"response_id":"late","output":[]}}))
                .unwrap()
            )
            .is_err()
    );
    let usage = TokenUsage {
        input_tokens: 3,
        output_tokens: 2,
        total_tokens: 5,
        ..Default::default()
    };
    assert!(
        !tools
            .report_model_attempt_usage("root", "successor", &callback, usage.clone())
            .unwrap()
    );
    assert!(
        tools
            .report_model_attempt_usage("root", "original", &callback, usage.clone())
            .unwrap()
    );
    assert_eq!(original.usage.lock().unwrap().as_ref(), Some(&usage));
    assert!(successor.usage.lock().unwrap().is_none());
    assert!(tools.callback_operation("root", &callback, "release"));
    retire.await.unwrap();
    assert!(produce.await.is_err());
    assert!(
        !tools
            .report_model_attempt_usage("root", "original", &callback, usage)
            .unwrap()
    );
}

#[tokio::test]
async fn generic_failed_producer_reply_closes_after_physical_release() {
    let tools = super::super::pending_tests::tools();
    let original = Attempt::new("original");
    let mut produce = Box::pin(
        tools.produce_model_response("fixture", json!({"model":"fixture","input":[]}), admission(original)),
    );
    assert!(futures_util::poll!(&mut produce).is_pending());
    let event = tools.next_request().await;
    let callback = event["msg"]["_sdk_callback"].clone();
    assert!(tools.callback_operation("root", &callback, "enter"));
    tools
        .reply_model_producer(
            serde_json::from_value(json!({"owner":receipt(&event),"failed":true})).unwrap(),
        )
        .unwrap();
    assert!(futures_util::poll!(&mut produce).is_pending());
    assert!(tools.callback_operation("root", &callback, "release"));
    assert!(produce.await.is_err());
}

#[tokio::test]
async fn retry_decision_outlives_expired_attempt_and_joins_its_callback() {
    let tools = super::super::pending_tests::tools();
    let original = Attempt::new("original");
    original.cancel.cancel();
    original.stop.request();
    let context = ModelRetryContext {
        attempt_id: "original".into(),
        original_error_attempt_id: Some("original".into()),
        attempt: 1,
        request_attempt: 1,
        max_retries: 1,
        policy_enabled: true,
        thread_id: "root".into(),
        turn_id: "turn".into(),
        model: "fixture".into(),
        transport: "http".into(),
        normalized: Default::default(),
        provider_advice: Default::default(),
        response_started: false,
        retry_unsafe_output: false,
        local_effects: false,
        stateful: false,
        previous_response_id: None,
        conversation_id: None,
        usage: None,
    };
    let mut decide = Box::pin(
        tools.decide_model_retry(codex_extension_api::ModelRetryInput {
            context,
            admission: admission(original),
            cancellation: CancellationToken::new(),
        }),
    );
    assert!(futures_util::poll!(&mut decide).is_pending());
    let event = tools.next_request().await;
    assert_eq!(event["msg"]["type"], "_sdk_model_retry");
    let callback = event["msg"]["_sdk_callback"].clone();
    assert!(tools.callback_operation("root", &callback, "enter"));
    tools
        .reply_model_retry(
            serde_json::from_value(json!({"owner":receipt(&event),"data":{
        "decision":{"retry":false}}}))
            .unwrap(),
        )
        .unwrap();
    assert!(futures_util::poll!(&mut decide).is_pending());
    assert!(tools.callback_operation("root", &callback, "release"));
    assert!(!decide.await.unwrap().decision.unwrap().retry);
}

#[tokio::test]
async fn failed_cleanup_is_retained_until_exact_retirement_even_after_early_release() {
    for early in [false, true] {
        let tools = super::super::pending_tests::tools();
        let original = Attempt::new("original");
        let frame: Arc<dyn ModelAttemptAdmission> = original.clone();
        let mut produce = Box::pin(tools.produce_model_response("fixture",
            json!({"model":"fixture","input":[]}),
            admission(frame.clone()),
        ));
        assert!(futures_util::poll!(&mut produce).is_pending());
        let event = tools.next_request().await;
        let callback = event["msg"]["_sdk_callback"].clone();
        assert!(tools.callback_operation("root", &callback, "enter"));
        original.cancel.cancel();
        if early {
            assert!(tools.callback_operation("root", &callback, "release_failed"));
            assert!(produce.as_mut().await.is_err());
        }
        let mut retire = Box::pin(tools.retire_model_attempt_callbacks(&frame));
        if !early {
            assert!(futures_util::poll!(&mut retire).is_pending());
            assert!(tools.callback_operation("root", &callback, "release_failed"));
        }
        assert!(retire.await.is_err());
        if !early {
            assert!(produce.await.is_err());
        }
    }
}
#[tokio::test]
async fn provider_failure_wrapper_reports_the_original_frame() {
    let tools = super::super::pending_tests::tools();
    let original = Attempt::new("original");
    let mut produce = Box::pin(tools.produce_model_response("fixture",
        json!({"model":"fixture","input":[]}),
        admission(original.clone()),
    ));
    assert!(futures_util::poll!(&mut produce).is_pending());
    let event = tools.next_request().await;
    let callback = event["msg"]["_sdk_callback"].clone();
    assert!(tools.callback_operation("root", &callback, "enter"));
    tools
        .reply_model_producer(
            serde_json::from_value(json!({"owner":receipt(&event),"failed":true,
        "failure":{"attempt_id":"original","normalized":{"message":"provider failure",
        "is_abort":false,"is_network_error":true,"is_timeout":false},
        "usage":{"input_tokens":3,"cached_input_tokens":0,"output_tokens":2,"reasoning_output_tokens":0,"total_tokens":5}}}))
            .unwrap(),
        )
        .unwrap();
    assert_eq!(
        original
            .usage
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .total_tokens,
        5
    );
    assert!(tools.callback_operation("root", &callback, "release"));
    assert!(produce.await.is_err());
}

#[test]
fn borrowed_cache_write_usage_has_three_strict_states() {
    let generic: ModelReply = serde_json::from_value(json!({
        "response_id": "sdk-id", "output": []
    }))
    .unwrap();
    assert!(generic.received_cache_write_usage.is_none());
    for count in [
        Value::Null,
        json!(0),
        json!(4),
        json!(9_007_199_254_740_991_i64),
    ] {
        let reply: ModelReply = serde_json::from_value(json!({
            "response_id": "sdk-id", "output": [],
            "received_cache_write_usage": {"count": count.clone()}
        }))
        .unwrap();
        assert_eq!(
            reply.received_cache_write_usage.unwrap().count,
            count.as_i64()
        );
    }
    for invalid in [
        Value::Null,
        json!({}),
        json!({"count": "0"}),
        json!({"count": false}),
        json!({"count": -1}),
        json!({"count": 0.5}),
        json!({"count": 9_007_199_254_740_992_i64}),
        json!({"count": 0, "extra": true}),
        json!([]),
        json!([0]),
        json!([null]),
        json!([0, 1]),
        json!(0),
        json!(false),
        json!("0"),
    ] {
        assert!(
            serde_json::from_value::<ModelReply>(json!({
                "response_id": "sdk-id", "output": [],
                "received_cache_write_usage": invalid
            }))
            .is_err()
        );
    }
}

#[test]
fn borrowed_omitted_usage_remains_an_empty_object_in_observation_wire() {
    let reply: ModelReply = serde_json::from_value(json!({
        "response_id": "sdk-id", "output": [],
        "received_cache_write_usage": {"count": null}
    }))
    .unwrap();
    let received = reply.received_cache_write_usage.unwrap();
    let observation = codex_protocol::protocol::ResponseObservation {
        response_id: None,
        upstream_request_id: None,
        status: codex_protocol::protocol::ResponseObservationStatus::Completed,
        incomplete_reason: None,
        usage: Some(codex_protocol::protocol::ReceivedResponseUsage {
            cache_write_input_tokens: received.count,
            ..Default::default()
        }),
    };
    let encoded = serde_json::to_value(observation).unwrap();
    assert_eq!(encoded["usage"], json!({}));
    assert!(encoded["response_id"].is_null());
    let decoded: codex_protocol::protocol::ResponseObservation =
        serde_json::from_value(encoded).unwrap();
    assert!(decoded.usage.is_some());
    assert_eq!(decoded.usage.unwrap().cache_write_input_tokens, None);
}
