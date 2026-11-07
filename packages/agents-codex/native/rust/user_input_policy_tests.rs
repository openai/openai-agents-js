//! Private SDK policy composition with actual Core registration, dispatch and events.
use super::*;
use crate::local_storage_tests::Provider;
use codex_protocol::items::{AgentMessageContent, AgentMessageDelivery, TurnItem};
use codex_protocol::protocol::{EventMsg, Op, SessionSource, SubAgentSource};
use codex_protocol::request_user_input::{RequestUserInputAnswer, RequestUserInputResponse};
use serde_json::{Value, json};

const SYNC: &str = "request_user_input";
const ASYNC: &str = "request_user_input_async";
const LEGACY: &str = "send_user_message_async";
const MESSAGE: &str = "send_message_to_user_async";

fn arguments(name: &str) -> Value {
    match name {
        SYNC => json!({"questions":[{"id":"environment","header":"Deploy",
            "question":"Which environment?","options":[
                {"label":"Staging","description":"Use staging."},
                {"label":"Production","description":"Use production."}]}]}),
        MESSAGE => json!({"message":"Deployment is ready."}),
        _ => {
            json!({"questions":[{"title":"Which environment?","options":["Staging","Production"]}]})
        }
    }
}

// These are native tools, not same-name dynamic application callbacks.
async fn exercise(enabled: bool, legacy_only: bool, non_root: bool) {
    tokio::time::timeout(Duration::from_secs(30), async {
        let calls = if !enabled {
            vec![SYNC, ASYNC, LEGACY, MESSAGE]
        } else if non_root {
            vec![SYNC, ASYNC, MESSAGE]
        } else if legacy_only {
            vec![ASYNC]
        } else {
            vec![SYNC, ASYNC]
        };
        let mut items: Vec<Value> = calls.iter().enumerate().map(|(i, name)| {
            json!({"type":"function_call","id":format!("fc_{i}"),"call_id":format!("call_{i}"),
                "name":name,"namespace":"functions","arguments":arguments(name).to_string(),"status":"completed"})
        }).collect();
        items.push(json!({"type":"message","id":"final","role":"assistant","status":"completed",
            "phase":"final_answer","content":[{"type":"output_text","text":"done","annotations":[]}]}));
        let provider = Provider::start_with_items(items).await;
        let home = tempfile::tempdir().unwrap();
        let mut catalog = codex_models_manager::bundled_models_response().unwrap();
        let mut model = catalog.models.iter().find(|m| m.slug == "gpt-5.5").unwrap().clone();
        model.experimental_supported_tools = if legacy_only {
            vec![LEGACY.into(), MESSAGE.into()]
        } else {
            vec![ASYNC.into(), LEGACY.into(), MESSAGE.into()]
        };
        // Use native function schemas even when the bundled model prefers Code Mode.
        model.tool_mode = None;
        let advertised = model.experimental_supported_tools.clone();
        catalog.models = vec![model];
        let catalog_path = home.path().join("models.json");
        std::fs::write(&catalog_path, serde_json::to_vec(&catalog).unwrap()).unwrap();
        let mut config = provider.config();
        config["model"] = json!("gpt-5.5");
        config["model_catalog_json"] = json!(catalog_path);
        config["tools.experimental_request_user_input.enabled"] = json!(enabled);
        config["features.default_mode_request_user_input"] = json!(true);
        // Catalog-only opt-in must survive; a feature cannot rescue a dropped message label.
        config["features.send_message_to_user_async"] = json!(false);
        let runtime = json!({"codex_home":home.path(),"cwd":home.path(),"_sdk_native_config":true,
            "loader":{"ignore_user_config":true,"ignore_project_config":true}});
        let engine = crate::create_engine(config.to_string(), runtime.to_string(), None, None).await.unwrap();
        {
            let owned = engine.current().unwrap();
            assert_eq!(owned.sdk_user_input_enabled, Some(enabled));
            let actual = owned.manager.get_models_manager().get_model_info("gpt-5.5",
                &owned.service_config.to_models_manager_config()).await;
            assert_eq!(actual.slug, "gpt-5.5", "catalog model must not fall back");
            if enabled {
                assert_eq!(actual.experimental_supported_tools, advertised);
            } else {
                assert_eq!(actual.experimental_supported_tools, vec![MESSAGE]);
            }
        }
        let source = if non_root {
            SessionSource::SubAgent(SubAgentSource::Other("policy-test".into()))
        } else {
            SessionSource::Exec
        };
        let thread_options = json!({"session_source":source});
        let thread = if non_root {
            // Replaceable application tools are root-only. Exercise Core's source guard
            // through the existing native startup path, with no application tools installed.
            let owned = engine.current().unwrap();
            let _guard = owned.lifecycle.lock().await;
            let (startup, instructions) = owned.build_startup(
                crate::config::decode(thread_options).unwrap()).await.unwrap();
            owned.start_prepared(startup, instructions, None).await.unwrap()
        } else {
            engine.start_replaceable_thread(thread_options.to_string(), "[]".into()).await.unwrap()
        };
        if non_root {
            // This is private Core source-restriction proof, not a public enabled-child API.
            thread.current().unwrap().thread.start_or_steer_turn(
                codex_core::TurnInputRequest::user_input(vec![codex_protocol::user_input::UserInput::Text {
                    text: "Exercise the native policy.".into(), text_elements: vec![],
                }])).await.unwrap();
        } else {
            let started: Value = serde_json::from_str(&thread._submit(json!({"mode":"start_if_idle",
                "input":[{"type":"text","text":"Exercise the native policy."}]}).to_string()).await.unwrap()).unwrap();
            assert_eq!(started["status"], "started");
        }
        let mut sync_requests = 0;
        let mut async_messages = Vec::new();
        let mut final_messages = 0;
        loop {
            let event: Event = serde_json::from_str(&thread.next_session_event().await.unwrap()).unwrap();
            match event.msg {
                EventMsg::RequestUserInput(request) => {
                    assert!(enabled && !non_root && !legacy_only, "unexpected question: {request:?}");
                    assert_eq!(request.call_id, "call_0");
                    assert_eq!(request.questions.len(), 1);
                    assert_eq!(request.questions[0].id, "environment");
                    sync_requests += 1;
                    // Internal Core response, not a new public SDK question API.
                    thread.current().unwrap().thread.submit(Op::UserInputAnswer {
                        id: request.turn_id,
                        response: RequestUserInputResponse { answers: HashMap::from([
                            ("environment".into(), RequestUserInputAnswer { answers: vec!["Staging".into()] })
                        ]) },
                    }).await.unwrap();
                }
                EventMsg::ItemCompleted(event) => {
                    if let TurnItem::AgentMessage(message) = event.item {
                        if message.delivery == Some(AgentMessageDelivery::Async) {
                            async_messages.push(message);
                        } else if message.id == "final" {
                            assert!(matches!(&message.content[..],
                                [AgentMessageContent::Text { text, .. }] if text == "done"));
                            final_messages += 1;
                        }
                    }
                }
                EventMsg::TurnComplete(_) => break,
                EventMsg::Error(error) => panic!("unexpected Core error: {error:?}"),
                EventMsg::TurnAborted(error) => panic!("unexpected turn abort: {error:?}"),
                _ => {}
            }
        }
        assert_eq!(sync_requests, usize::from(enabled && !non_root && !legacy_only));
        assert_eq!(final_messages, 1, "scripted final answer must complete");
        let requests = provider.requests.lock().unwrap().clone();
        assert_eq!(requests.len(), calls.len() + 1);
        for request in &requests {
            assert_eq!(request["model"], "gpt-5.5");
        }
        // Observe Core's outgoing callable catalog, not just the filtered metadata.
        let names: Vec<&str> = requests[0]["tools"].as_array().unwrap().iter()
            .filter_map(|tool| tool["name"].as_str()).collect();
        assert_eq!(names.contains(&SYNC), enabled);
        assert_eq!(names.contains(&ASYNC), enabled && !non_root);
        assert!(!names.contains(&LEGACY), "legacy label must only select the canonical tool");
        assert_eq!(names.contains(&MESSAGE), !non_root);
        for (i, name) in calls.iter().enumerate() {
            let output = requests[i + 1]["input"].as_array().unwrap().iter().find(|item|
                item["type"] == "function_call_output" && item["call_id"] == format!("call_{i}"))
                .unwrap_or_else(|| panic!("missing {name} output: {}", requests[i + 1]));
            let text = output["output"].as_str().unwrap();
            if !non_root && *name == MESSAGE {
                assert_eq!(serde_json::from_str::<Value>(text).unwrap(), json!({"accepted":true}));
            } else if enabled && !non_root {
                let expected = if *name == SYNC {
                    json!({"answers":{"environment":{"answers":["Staging"]}}})
                } else { json!({"accepted":true}) };
                assert_eq!(serde_json::from_str::<Value>(text).unwrap(), expected);
            } else if non_root && *name == SYNC {
                assert!(text.contains("can only be used by the root thread"), "{text}");
            } else {
                assert!(text.contains("unsupported") && text.contains(name), "{text}");
            }
        }
        if non_root {
            assert!(async_messages.is_empty());
        } else {
            assert_eq!(async_messages.len(), 1);
            let message = &async_messages[0];
            let async_call = calls.iter().position(|name| *name == if enabled { ASYNC } else { MESSAGE }).unwrap();
            assert_eq!(message.id, format!("call_{async_call}"));
            if enabled {
                let questions = message.questions.as_ref().expect("async question payload");
                assert_eq!(questions.len(), 1);
                assert_eq!(questions[0].title, "Which environment?");
                assert_eq!(questions[0].options.as_ref().unwrap(), &["Staging", "Production"]);
            } else {
                assert!(message.questions.is_none(), "independent message must not become a question");
                assert!(matches!(&message.content[..],
                    [AgentMessageContent::Text { text, .. }] if text == "Deployment is ready."));
            }
        }
        thread.close().await.unwrap();
        engine.close().await.unwrap();
    }).await.expect("native user-input policy scenario timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disabled_questions_preserve_catalog_only_independent_message() {
    exercise(false, false, false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn enabled_sync_and_current_async_questions_complete() {
    exercise(true, false, false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn enabled_legacy_catalog_selects_canonical_async_question() {
    exercise(true, true, false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn enabled_questions_and_messages_remain_root_only() {
    exercise(true, false, true).await;
}
