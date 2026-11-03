use codex_core_api::{Config, Feature};
use codex_protocol::protocol::{SessionSource, SubAgentSource, ThreadSource};
use serde_json::{Value, json};

fn fixture() -> (tempfile::TempDir, Value, Value) {
    let home = tempfile::tempdir().unwrap();
    let config = json!({
        "model":"gpt-5.1-codex", "model_provider":"finite-retry-fixture",
        "model_providers.finite-retry-fixture":{
            "name":"Finite connection retry fixture", "base_url":"http://127.0.0.1:1/v1",
            "wire_api":"responses", "requires_openai_auth":false, "supports_websockets":false,
            "request_max_retries":7, "stream_max_retries":9
        },
        "approval_policy":"never", "sandbox_mode":"read-only", "web_search":"disabled"
    });
    let runtime = json!({
        "codex_home":home.path(), "cwd":home.path(),
        "loader":{
            "ignore_user_config":true, "ignore_project_config":true,
            "ignore_user_and_project_exec_policy_rules":true,
            "ignore_managed_requirements":true, "ignore_login_requirements":true,
            "managed_config_path":home.path().join("managed.toml"),
            "system_config_path":home.path().join("system.toml"),
            "system_requirements_path":home.path().join("requirements.toml")
        }
    });
    (home, config, runtime)
}

fn assert_finite(config: &Config) {
    assert!(!config.features.enabled(Feature::UnboundedConnectionRetries));
    assert_eq!(config.model_provider.request_max_retries(), 7);
    assert_eq!(config.model_provider.stream_max_retries(), 9);
}

#[tokio::test]
async fn shared_loader_disables_the_default_and_explicit_connection_exception() {
    for enabled in [None, Some(false), Some(true)] {
        let (_home, mut config, runtime) = fixture();
        if let Some(enabled) = enabled {
            config["features.unbounded_connection_retries"] = json!(enabled);
        }
        let (effective, _) = super::load(&config.to_string(), &runtime.to_string(), None)
            .await
            .unwrap();
        assert_finite(&effective);
    }
}

#[tokio::test]
async fn standalone_search_keeps_current_capability_and_finite_provider_budgets() {
    for mode in ["cached", "live"] {
        let (_home, mut config, runtime) = fixture();
        config["web_search"] = json!(mode);
        config["features.standalone_web_search"] = json!(true);
        config["features.unbounded_connection_retries"] = json!(true);
        config["model_providers.finite-retry-fixture"]["supports_standalone_web_search"] =
            json!(true);
        let (effective, _) = super::load(&config.to_string(), &runtime.to_string(), None)
            .await
            .unwrap();
        assert_finite(&effective);
        assert!(effective.features.enabled(Feature::StandaloneWebSearch));
        assert!(effective.model_provider.supports_standalone_web_search);
        let expected = if mode == "cached" {
            codex_protocol::config_types::WebSearchMode::Cached
        } else {
            codex_protocol::config_types::WebSearchMode::Live
        };
        assert_eq!(effective.web_search_mode.value(), expected);
    }
}

#[tokio::test]
async fn shared_loader_preserves_explicit_zero_retry_budgets() {
    let (_home, mut config, runtime) = fixture();
    config["features.unbounded_connection_retries"] = json!(false);
    config["model_providers.finite-retry-fixture"]["request_max_retries"] = json!(0);
    config["model_providers.finite-retry-fixture"]["stream_max_retries"] = json!(0);
    let (effective, _) = super::load(&config.to_string(), &runtime.to_string(), None)
        .await
        .unwrap();
    assert!(
        !effective
            .features
            .enabled(Feature::UnboundedConnectionRetries)
    );
    assert_eq!(effective.model_provider.request_max_retries(), 0);
    assert_eq!(effective.model_provider.stream_max_retries(), 0);
}

#[tokio::test]
async fn managed_connection_requirement_is_not_bypassed() {
    for enabled in [false, true] {
        let (home, mut config, mut runtime) = fixture();
        config["features.unbounded_connection_retries"] = json!(enabled);
        runtime["loader"]["ignore_managed_requirements"] = json!(false);
        std::fs::write(
            home.path().join("requirements.toml"),
            format!("[features]\nunbounded_connection_retries = {enabled}\n"),
        )
        .unwrap();
        let loaded = super::load(&config.to_string(), &runtime.to_string(), None).await;
        if enabled {
            let error = match loaded {
                Ok(_) => panic!("managed true must not be silently bypassed"),
                Err(error) => error,
            };
            assert!(
                error
                    .to_string()
                    .contains("requires finite connection retries")
            );
        } else {
            assert_finite(&loaded.unwrap().0);
        }
    }
}

#[tokio::test]
async fn thread_startup_reloads_enforce_the_policy_for_root_and_child_sources() {
    let (_home, mut config, runtime) = fixture();
    config["features.unbounded_connection_retries"] = json!(true);
    let (_, cloud) = super::load(&config.to_string(), &runtime.to_string(), None)
        .await
        .unwrap();
    let source = SessionSource::SubAgent(SubAgentSource::ThreadSpawn {
        parent_thread_id: codex_protocol::ThreadId::new(),
        depth: 1,
        agent_path: None,
        agent_nickname: None,
        agent_role: None,
    });
    // EngineState::build_startup uses this same builder for opening and reopening.
    // The child-source case follows the existing native child startup fixture.
    for options in [
        json!({}),
        json!({"config":{"features.unbounded_connection_retries":true}}),
        json!({"session_source":source, "thread_source":ThreadSource::Subagent,
            "config":{"features.unbounded_connection_retries":true}}),
    ] {
        let options: crate::options::ThreadOptions = serde_json::from_value(options).unwrap();
        let (startup, _) = options
            .build(&config.to_string(), &runtime.to_string(), cloud.clone())
            .await
            .unwrap();
        assert_finite(&startup.config);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_connection_failures_terminate_with_configured_budgets() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;

    for stream_retries in [0, 1] {
        let (_home, mut config, runtime) = fixture();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let attempts = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&attempts);
        let (stop, mut stopped) = oneshot::channel::<()>();
        // Match Core's http-client TLS protocol-rejection fixture. This fails
        // during connect, before any HTTP status or model response exists.
        let mut server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = tokio::select! {
                    _ = &mut stopped => return Ok::<_, anyhow::Error>(()),
                    accepted = listener.accept() => accepted?,
                };
                let mut hello = [0_u8; 2048];
                let size =
                    tokio::time::timeout(Duration::from_secs(2), socket.read(&mut hello)).await??;
                anyhow::ensure!(
                    size > 0 && hello[0] == 22,
                    "expected an actual TLS ClientHello"
                );
                observed.fetch_add(1, Ordering::SeqCst);
                socket.write_all(&[21, 3, 3, 0, 2, 2, 70]).await?;
            }
        });
        config["features.unbounded_connection_retries"] = json!(true);
        config["model_providers.finite-retry-fixture"]["base_url"] =
            json!(format!("https://{address}/v1"));
        config["model_providers.finite-retry-fixture"]["request_max_retries"] = json!(0);
        config["model_providers.finite-retry-fixture"]["stream_max_retries"] =
            json!(stream_retries);
        let mut engine = None;
        let mut native = None;
        // Test timeout only: production retry ownership stays entirely in Core.
        let outcome = tokio::time::timeout(Duration::from_secs(15), async {
            engine = Some(Arc::new(
                crate::engine::EngineState::new(
                    config.to_string(),
                    runtime.to_string(),
                    false,
                    None,
                )
                .await?,
            ));
            native = Some(engine.as_ref().unwrap().start_with_tools(
                serde_json::from_value(json!({
                    "_managed_instructions":true, "instructions":"Fail the controlled connection.",
                    "session_source":SessionSource::Custom("finite-retry-fixture".into()),
                }))?,
                Vec::new(),
            ).await?);
            let native = native.as_ref().unwrap();
            let receipt: Value = serde_json::from_str(
                &native
                    ._submit(
                        json!({
                            "mode":"start_if_idle", "input":[{"type":"text","text":"begin"}],
                        })
                        .to_string(),
                    )
                    .await
                    .map_err(|error| anyhow::anyhow!(error.to_string()))?,
            )?;
            anyhow::ensure!(receipt["status"] == "started", "turn was not admitted");
            let expected = serde_json::to_value(
                codex_protocol::protocol::CodexErrorInfo::HttpConnectionFailed {
                    http_status_code: None,
                },
            )?;
            let mut failed = false;
            loop {
                let event: Value = serde_json::from_str(
                    &native
                        .next_session_event()
                        .await
                        .map_err(|error| anyhow::anyhow!(error.to_string()))?,
                )?;
                if event["msg"]["type"] == "error" {
                    anyhow::ensure!(
                        event["msg"]["codex_error_info"] == expected,
                        "fixture did not reach the typed native connection-failure path: {event}"
                    );
                    failed = true;
                }
                if event["msg"]["type"] == "task_complete"
                    && event["msg"]["turn_id"] == receipt["turn_id"]
                {
                    anyhow::ensure!(failed, "turn completed without a connection failure");
                    anyhow::ensure!(
                        attempts.load(Ordering::SeqCst) == stream_retries + 1,
                        "connection attempts exceeded the configured budgets"
                    );
                    return Ok::<_, anyhow::Error>(());
                }
            }
        })
        .await;
        // Clean up before asserting the outcome, including a baseline timeout.
        let cleanup = tokio::time::timeout(Duration::from_secs(40), async {
            let thread = match native.as_ref() {
                Some(native) => Some(native.close().await),
                None => None,
            };
            let engine = match engine.as_ref() {
                Some(engine) => Some(engine.close().await),
                None => None,
            };
            (thread, engine)
        })
        .await;
        let _ = stop.send(());
        let server_done = tokio::time::timeout(Duration::from_secs(3), &mut server).await;
        if server_done.is_err() {
            server.abort();
            let _ = server.await;
        }
        let (thread, engine) = cleanup.expect("native cleanup did not join");
        if let Some(result) = thread {
            result.expect("thread cleanup failed");
        }
        if let Some(result) = engine {
            result.expect("engine cleanup failed");
        }
        server_done
            .expect("TLS fixture did not join")
            .unwrap()
            .unwrap();
        outcome
            .expect("connection recovery did not terminate")
            .unwrap();
        assert_eq!(attempts.load(Ordering::SeqCst), stream_retries + 1);
    }
}
