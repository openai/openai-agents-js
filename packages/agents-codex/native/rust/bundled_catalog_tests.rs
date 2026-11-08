//! Model selection and catalog authority through the real Engine entrypoint.
use super::*;
use crate::local_storage_tests::Provider;
use serde_json::{Value, json};

async fn open(config: Value, home: &std::path::Path, user_input: bool) -> crate::Engine {
    let mut config = config;
    config["tools.experimental_request_user_input.enabled"] = json!(user_input);
    let runtime = json!({"codex_home":home,"cwd":home,"_sdk_native_config":true,
        "loader":{"ignore_user_config":true,"ignore_project_config":true}});
    crate::create_engine(
        config.to_string(),
        runtime.to_string(),
        Some("synthetic-catalog-key".into()),
        None,
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn bundled_selection_and_metadata_match_the_original_dynamic_manager() {
    let provider = Provider::start().await;
    for user_input in [true, false] {
        let home = tempfile::tempdir().unwrap();
        let engine = open(provider.config(), home.path(), user_input).await;
        let owned = engine.current().unwrap();
        let config = &owned.service_config;
        assert!(
            config.model_catalog.is_none(),
            "the seed must not become config authority"
        );
        let auth = crate::auth::manager(config, Some("synthetic-catalog-key".into()))
            .await
            .unwrap();
        let original =
            codex_model_provider::create_model_provider(config.model_provider.clone(), Some(auth))
                .models_manager_without_cache(None);
        let actual = owned.manager.get_models_manager();
        let factory = config.http_client_factory();
        for requested in [
            None,
            Some("gpt-5.5".to_owned()),
            Some("fixture-unlisted-model".to_owned()),
        ] {
            for fallback in [false, true] {
                assert_eq!(
                    actual
                        .get_default_model(
                            &requested,
                            fallback,
                            RefreshStrategy::Offline,
                            factory.clone()
                        )
                        .await,
                    original
                        .get_default_model(
                            &requested,
                            fallback,
                            RefreshStrategy::Offline,
                            factory.clone()
                        )
                        .await
                );
            }
        }
        assert_eq!(
            serde_json::to_value(
                actual
                    .list_models(RefreshStrategy::Offline, factory.clone())
                    .await
            )
            .unwrap(),
            serde_json::to_value(
                original
                    .list_models(RefreshStrategy::Offline, factory.clone())
                    .await
            )
            .unwrap()
        );
        let mut policy = config.to_models_manager_config();
        policy.model_context_window = Some(123456);
        for model in ["gpt-5.5", "fixture-unlisted-model"] {
            let mut expected = original.get_model_info(model, &policy).await;
            if !user_input {
                expected.experimental_supported_tools.retain(|tool| {
                    !matches!(
                        tool.as_str(),
                        "request_user_input_async" | "send_user_message_async"
                    )
                });
            }
            assert_eq!(
                serde_json::to_value(actual.get_model_info(model, &policy).await).unwrap(),
                serde_json::to_value(expected).unwrap()
            );
        }
        let expected = original
            .raw_model_catalog(RefreshStrategy::Offline, factory.clone())
            .await;
        let mut returned = actual
            .raw_model_catalog(RefreshStrategy::Offline, factory.clone())
            .await;
        assert_eq!(
            serde_json::to_value(&returned).unwrap(),
            serde_json::to_value(&expected).unwrap()
        );
        returned.models.clear();
        assert_eq!(
            serde_json::to_value(
                actual
                    .raw_model_catalog(RefreshStrategy::Offline, factory)
                    .await
            )
            .unwrap(),
            serde_json::to_value(expected).unwrap(),
            "callers own independent catalog copies"
        );
        engine.close().await.unwrap();
    }
    assert_eq!(provider.request_count(), 0);
}

#[tokio::test]
async fn explicit_catalog_keeps_authority_and_provider_fallback() {
    let provider = Provider::start().await;
    for user_input in [true, false] {
        let home = tempfile::tempdir().unwrap();
        let mut catalog = codex_models_manager::bundled_models_response().unwrap();
        let mut model = catalog
            .models
            .iter()
            .find(|model| model.slug == "gpt-5.5")
            .unwrap()
            .clone();
        model.slug = "authoritative-fixture-model".into();
        model.experimental_supported_tools = vec![
            "request_user_input_async".into(),
            "send_message_to_user_async".into(),
        ];
        catalog.models = vec![model];
        let path = home.path().join("models.json");
        std::fs::write(&path, serde_json::to_vec(&catalog).unwrap()).unwrap();
        let mut config = provider.config();
        config["model_catalog_json"] = json!(path);
        let engine = open(config, home.path(), user_input).await;
        let owned = engine.current().unwrap();
        let actual = owned.manager.get_models_manager();
        let factory = owned.service_config.http_client_factory();
        let unknown = Some("fixture-unlisted-model".to_owned());
        assert_eq!(
            actual
                .get_default_model(&unknown, true, RefreshStrategy::Offline, factory.clone())
                .await,
            "authoritative-fixture-model"
        );
        assert_eq!(
            actual
                .get_default_model(&unknown, false, RefreshStrategy::Offline, factory.clone())
                .await,
            "fixture-unlisted-model"
        );
        assert_eq!(
            actual
                .get_default_model(&None, true, RefreshStrategy::Offline, factory.clone())
                .await,
            "authoritative-fixture-model"
        );
        assert_eq!(
            serde_json::to_value(&owned.service_config.model_catalog).unwrap(),
            serde_json::to_value(Some(&catalog)).unwrap()
        );
        let info = actual
            .get_model_info(
                "authoritative-fixture-model",
                &owned.service_config.to_models_manager_config(),
            )
            .await;
        assert_eq!(
            info.experimental_supported_tools
                .contains(&"request_user_input_async".to_owned()),
            user_input
        );
        assert!(
            info.experimental_supported_tools
                .contains(&"send_message_to_user_async".to_owned())
        );
        engine.close().await.unwrap();
    }
    assert_eq!(provider.request_count(), 0);
}

#[tokio::test]
async fn explicit_catalog_url_does_not_expose_the_bundle_as_its_catalog() {
    let provider = Provider::start().await;
    let home = tempfile::tempdir().unwrap();
    let mut config = provider.config();
    config["model_providers.local-fixture"]["model_catalog_url"] =
        json!("http://127.0.0.1:1/explicit-models");
    let engine = open(config, home.path(), true).await;
    let owned = engine.current().unwrap();
    // The authoritative URL's catalog is empty until discovery, never the bundled seed.
    assert!(
        owned
            .manager
            .get_models_manager()
            .try_get_remote_models()
            .unwrap()
            .is_empty()
    );
    assert_eq!(provider.request_count(), 0);
    engine.close().await.unwrap();
}

#[tokio::test]
async fn warm_cache_keeps_catalog_and_auth_eligibility_checks() {
    let provider = Provider::start().await;
    let home = tempfile::tempdir().unwrap();
    let engine = open(provider.config(), home.path(), true).await;
    let owned = engine.current().unwrap();
    let config = &owned.service_config;
    let auth = crate::auth::manager(config, Some("synthetic-catalog-key".into()))
        .await
        .unwrap();
    let catalog = bundled_model_catalog(config, &auth).unwrap();

    let mut excluded = config.clone();
    excluded.model_catalog = Some(catalog);
    assert!(bundled_model_catalog(&excluded, &auth).is_none());
    let mut excluded = config.clone();
    excluded
        .features
        .enable(Feature::ApiKeyModelDiscovery)
        .unwrap();
    assert!(bundled_model_catalog(&excluded, &auth).is_none());
    for auth in [
        AuthManager::from_optional_auth_for_testing(None),
        AuthManager::from_auth_for_testing(
            codex_login::CodexAuth::create_dummy_chatgpt_auth_for_testing(),
        ),
    ] {
        assert!(bundled_model_catalog(config, &auth).is_none());
    }
    for (field, value) in [
        ("model_catalog_url", json!("https://catalog.invalid/models")),
        (
            "auth",
            json!({"command":"not-invoked", "args":[], "timeout_ms":1,
            "refresh_interval_ms":0, "cwd":home.path()}),
        ),
        (
            "gateway_oauth",
            json!({"authorization_url":"https://gateway.invalid/auth",
            "token_url":"https://gateway.invalid/token", "client_id":"fixture",
            "delivery":{"kind":"header", "name":"x-fixture-auth"}}),
        ),
        ("aws", json!({"region":"fixture"})),
        ("name", json!("Amazon Bedrock")),
    ] {
        let mut excluded = config.clone();
        let mut provider = serde_json::to_value(&excluded.model_provider).unwrap();
        provider[field] = value;
        excluded.model_provider = serde_json::from_value(provider).unwrap();
        assert!(bundled_model_catalog(&excluded, &auth).is_none(), "{field}");
    }
    assert!(bundled_model_catalog(config, &auth).is_some());
    assert_eq!(provider.request_count(), 0);
    engine.close().await.unwrap();
}

// Run this test alone in a fresh test process to exercise concurrent cold use.
#[tokio::test]
async fn concurrent_catalog_first_use_returns_independent_owned_results() {
    let provider = Provider::start().await;
    let home = tempfile::tempdir().unwrap();
    let runtime = crate::config::prepare_runtime(
        &json!({
            "codex_home":home.path(), "cwd":home.path(), "_sdk_native_config":true,
            "loader":{"ignore_user_config":true,"ignore_project_config":true}
        })
        .to_string(),
    )
    .unwrap();
    let (config, _) = crate::config::load(&provider.config().to_string(), &runtime, None)
        .await
        .unwrap();
    let auth = crate::auth::manager(&config, Some("synthetic-catalog-key".into()))
        .await
        .unwrap();
    let barrier = std::sync::Barrier::new(8);
    let mut catalogs = std::thread::scope(|scope| {
        let workers = (0..8)
            .map(|_| {
                scope.spawn(|| {
                    barrier.wait();
                    bundled_model_catalog(&config, &auth).unwrap()
                })
            })
            .collect::<Vec<_>>();
        workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>()
    });
    let expected =
        serde_json::to_value(codex_models_manager::bundled_models_response().unwrap()).unwrap();
    for catalog in &catalogs {
        assert_eq!(serde_json::to_value(catalog).unwrap(), expected);
    }
    catalogs[0].models[0].slug = "caller-owned-slug".into();
    catalogs[0]
        .models
        .iter_mut()
        .find_map(|model| model.model_messages.as_mut())
        .unwrap()
        .instructions_template = Some("caller-owned-instructions".into());
    catalogs[0].models.clear();
    for catalog in &catalogs[1..] {
        assert_eq!(serde_json::to_value(catalog).unwrap(), expected);
    }
    assert_eq!(
        serde_json::to_value(bundled_model_catalog(&config, &auth).unwrap()).unwrap(),
        expected
    );
    assert_eq!(provider.request_count(), 0);
}
