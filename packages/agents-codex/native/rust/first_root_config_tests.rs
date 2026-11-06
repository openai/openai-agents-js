//! One opening snapshot is data, never another runtime cleanup owner.
use super::*;
use serde_json::json;

async fn state() -> (tempfile::TempDir, Arc<EngineState>) {
    let home = tempfile::tempdir().unwrap();
    let runtime = json!({
        "codex_home": home.path(), "cwd": home.path(), "strict_config": true,
        "loader": {"ignore_user_config":true,"ignore_project_config":true},
        "base_instructions": "Follow the application instructions."
    })
    .to_string();
    // Ordinary Agent.prepare has no _sdk_native_config flag. Its selected
    // provider explicitly disables WebSockets and programmatic Code Mode.
    let config = json!({
        "model":"gpt-5", "model_provider":"native_agent", "mcp_servers":{},
        "model_providers.native_agent": {"name":"Native agent provider",
            "base_url":"http://127.0.0.1:1/v1", "wire_api":"responses",
            "requires_openai_auth":true, "supports_websockets":false,
            "supports_standalone_web_search":false},
        "agents.enabled":false, "features.goals":false,
        "features.code_mode":{"enabled":false,"direct_only_tool_namespaces":["functions"]}
    })
    .to_string();
    let state = Arc::new(
        EngineState::new_owned_for_first_root(config, runtime, Some("fixture".into()))
            .await
            .unwrap(),
    );
    assert!(
        state.first_root_config.lock().unwrap().is_some(),
        "ordinary Agent shape must be eligible"
    );
    (home, state)
}

#[tokio::test]
async fn ordinary_agent_first_root_is_prepared_but_old_creator_is_not() {
    let (_home, state) = state().await;
    let raw = EngineState::new_owned(
        state.config_json.clone(),
        state.runtime_json.clone(),
        false,
        Some("fixture".into()),
        None,
        Default::default(),
    )
    .await
    .unwrap();
    assert!(raw.first_root_config.lock().unwrap().is_none());
    raw.close().await.unwrap();
    state.close().await.unwrap();
}

#[tokio::test]
async fn cancelled_first_start_discards_snapshot_while_waiting_for_lifecycle() {
    let (_home, state) = state().await;
    let held = state.lifecycle.lock().await;
    let mut start = Box::pin(state.start_first_root(Default::default(), Vec::new()));
    assert!(futures_util::poll!(start.as_mut()).is_pending());
    drop(start);
    assert!(state.first_root_config.lock().unwrap().is_none());
    drop(held);
    state.close().await.unwrap();
}

#[tokio::test]
async fn close_discards_snapshot_and_first_start_stays_closed() {
    let (_home, state) = state().await;
    state.close().await.unwrap();
    assert!(state.first_root_config.lock().unwrap().is_none());
    let error = state
        .start_first_root(Default::default(), Vec::new())
        .await
        .err()
        .unwrap();
    assert!(error.to_string().contains("Codex engine is closed"));
}

#[tokio::test]
async fn absolute_fallback_cwd_uses_the_same_builder_precedence() {
    let (_home, state) = state().await;
    let mut runtime: serde_json::Value = serde_json::from_str(&state.runtime_json).unwrap();
    let fields = runtime.as_object_mut().unwrap();
    let cwd = fields.remove("cwd").unwrap();
    fields.insert("fallback_cwd".into(), cwd);
    fields.insert(
        "loader".into(),
        json!({"ignore_user_config":true,"ignore_project_config":true}),
    );
    let fallback = EngineState::new_owned_for_first_root(
        state.config_json.clone(),
        runtime.to_string(),
        Some("fixture".into()),
    )
    .await
    .unwrap();
    assert!(fallback.first_root_config.lock().unwrap().is_some());
    assert_eq!(fallback.service_config.cwd, state.service_config.cwd);
    fallback.close().await.unwrap();
    state.close().await.unwrap();
}

#[tokio::test]
async fn construction_runtime_optional_nulls_preserve_defaults() {
    let (_home, original) = state().await;
    let mut missing: serde_json::Value = serde_json::from_str(&original.runtime_json).unwrap();
    let fields = [
        "environment",
        "native_thread_store",
        "native_goal_store",
        "code_mode_host_exe",
        "_sdk_resume_thread_id",
    ];
    for field in fields {
        missing.as_object_mut().unwrap().remove(field);
    }
    let mut nulls = missing.clone();
    for field in fields {
        nulls[field] = serde_json::Value::Null;
    }
    let mut observations = Vec::new();
    for runtime in [missing, nulls] {
        let engine = EngineState::new_owned(
            original.config_json.clone(),
            runtime.to_string(),
            false,
            Some("fixture".into()),
            None,
            Default::default(),
        )
        .await
        .unwrap();
        observations.push((
            engine.sdk_selected_model,
            engine.sdk_user_input_enabled,
            engine.local_checklist_store.is_some(),
            engine.goals.is_some(),
            engine.service_config.cwd.clone(),
        ));
        engine.close().await.unwrap();
    }
    let expected_cwd = original.service_config.cwd.clone();
    original.close().await.unwrap();
    assert_eq!(observations[0], observations[1]);
    assert_eq!(observations[0], (false, None, false, false, expected_cwd));
}

async fn construction_error(config: String, runtime: String) -> String {
    match EngineState::new_owned(
        config,
        runtime,
        false,
        Some("fixture".into()),
        None,
        Default::default(),
    )
    .await
    {
        Ok(engine) => {
            engine.close().await.unwrap();
            panic!("invalid construction must fail");
        }
        Err(error) => error.to_string(),
    }
}

#[tokio::test]
async fn construction_runtime_keeps_config_error_precedence_and_strict_types() {
    let (_home, original) = state().await;
    let config = original.config_json.clone();
    let runtime: serde_json::Value = serde_json::from_str(&original.runtime_json).unwrap();
    original.close().await.unwrap();

    let mut unknown = runtime.clone();
    unknown["unexpected_runtime_option"] = json!(true);
    let error = construction_error("[]".into(), unknown.to_string()).await;
    assert_eq!(error, "config must be an object of native TOML options");

    for (field, value, expected) in [
        (
            "unexpected_runtime_option",
            json!(true),
            "unexpected_runtime_option",
        ),
        ("_native_agents", serde_json::Value::Null, "boolean"),
        ("_sdk_selected_model", serde_json::Value::Null, "boolean"),
        (
            "environment",
            json!({"unexpected_environment_option": true}),
            "unexpected_environment_option",
        ),
    ] {
        let mut invalid = runtime.clone();
        invalid[field] = value;
        let error = construction_error(config.clone(), invalid.to_string()).await;
        assert!(error.contains(expected), "unexpected diagnostic: {error}");
    }
}

#[tokio::test]
async fn construction_runtime_keeps_credentials_and_managed_policy_fresh() {
    let (home, original) = state().await;
    let config = original.config_json.clone();
    let mut runtime: serde_json::Value = serde_json::from_str(&original.runtime_json).unwrap();
    original.close().await.unwrap();
    let requirements = home.path().join("construction-requirements.toml");
    runtime["loader"]["ignore_managed_requirements"] = json!(false);
    runtime["loader"]["system_requirements_path"] = json!(requirements);
    let runtime = runtime.to_string();
    std::fs::write(
        &requirements,
        "[features]\nunbounded_connection_retries = false\n",
    )
    .unwrap();

    let mut keys = Vec::new();
    for key in ["fixture-one", "fixture-two"] {
        let engine = EngineState::new_owned(
            config.clone(),
            runtime.clone(),
            false,
            Some(key.into()),
            None,
            Default::default(),
        )
        .await
        .unwrap();
        keys.push(
            engine
                .manager
                .auth_manager()
                .auth()
                .await
                .and_then(|auth| auth.api_key().map(str::to_owned)),
        );
        engine.close().await.unwrap();
    }
    std::fs::write(
        &requirements,
        "[features]\nunbounded_connection_retries = true\n",
    )
    .unwrap();
    let expected = crate::config::load(&config, &runtime, None)
        .await
        .err()
        .expect("managed retry requirement must reject the SDK load")
        .to_string();
    let error = construction_error(config, runtime).await;
    assert_eq!(error, expected);
    assert_eq!(keys, [Some("fixture-one".into()), Some("fixture-two".into())]);
}
