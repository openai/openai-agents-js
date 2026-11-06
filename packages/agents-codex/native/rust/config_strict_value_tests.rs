use super::validate_effective_config;
use pretty_assertions::assert_eq;

fn old_validation(effective: &toml::Value, redact: bool) -> Result<(), String> {
    let contents = toml::to_string(effective).map_err(|error| error.to_string())?;
    match codex_config::config_error_from_ignored_toml_fields::<codex_config::config_toml::ConfigToml>(
        "JavaScript configuration",
        &contents,
    ) {
        None => Ok(()),
        Some(_) if redact => Err("Unsupported isolated SDK configuration".to_owned()),
        Some(error) => Err(error.message),
    }
}

#[test]
fn strict_value_accepts_public_provider_and_feature_forms() {
    for contents in [
        "",
        "model = 'gpt-5.1-codex'\napproval_policy = 'never'\ninclude_environment_context = false",
        r#"
model = "gpt-5.1-codex"
model_provider = "native_agent"
[model_providers.native_agent]
name = "Native agent provider"
base_url = "http://127.0.0.1:1/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
[features]
goals = false
skip_host_skill_discovery = true
code_mode = false
"#,
        "[features.code_mode]\nenabled = false\ndirect_only_tool_namespaces = ['functions']",
    ] {
        let effective = toml::from_str::<toml::Value>(contents).unwrap();
        for redact in [false, true] {
            assert_eq!(old_validation(&effective, redact), Ok(()));
            assert_eq!(
                validate_effective_config(effective.clone(), redact).map_err(|e| e.to_string()),
                Ok(())
            );
        }
    }
}

#[test]
fn strict_value_preserves_unknown_fields_types_and_redaction() {
    for contents in [
        "unknown_option = true",
        "[features]\nunknown_feature = true",
        "[tui]\nunknown_tui_option = true",
        "model = 42",
        "project_doc_max_bytes = 'wide'",
        "[model_providers.native_agent]\nbase_url = 'http://127.0.0.1:1/v1'",
        "[model_providers.native_agent]\nname = 'Native'\nunknown_provider_option = true",
        // Multiple errors must keep the old algorithm's first error.
        "unknown_z = true\n[unknown_a]\nvalue = 1",
        "model = 42\nunknown_option = true\n[features]\nunknown_feature = true",
        "project_doc_max_bytes = 'private-fixture-value'",
    ] {
        let effective = toml::from_str::<toml::Value>(contents).unwrap();
        for redact in [false, true] {
            let expected = old_validation(&effective, redact);
            assert!(expected.is_err(), "fixture must fail: {contents}");
            assert_eq!(
                validate_effective_config(effective.clone(), redact).map_err(|e| e.to_string()),
                expected,
                "{contents}, redact={redact}"
            );
        }
    }
}

#[tokio::test]
async fn strict_value_loader_keeps_the_strict_switch_and_error_order() {
    let home = tempfile::tempdir().unwrap();
    let mut runtime = serde_json::json!({
        "codex_home": home.path(), "cwd": home.path(), "strict_config": false
    });
    let runtime_json = super::prepare_runtime(&runtime.to_string()).unwrap();
    super::load(r#"{"unknown_fixture_option":true}"#, &runtime_json, None)
        .await
        .unwrap();

    let invalid = r#"{"unknown_fixture_option":true,"features.memories":true}"#;
    let error = super::load(invalid, &runtime_json, None)
        .await
        .err()
        .expect("unsupported native memories");
    assert!(
        error
            .to_string()
            .contains("Native memories require host files")
    );

    runtime["strict_config"] = serde_json::json!(true);
    let runtime_json = super::prepare_runtime(&runtime.to_string()).unwrap();
    let error = super::load(invalid, &runtime_json, None)
        .await
        .err()
        .expect("the original early strict check must win");
    assert!(
        error
            .to_string()
            .contains("unknown configuration field `unknown_fixture_option`")
    );
    assert!(!error.to_string().contains("Native memories"));
}
