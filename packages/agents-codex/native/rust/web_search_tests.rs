use super::*;
use serde_json::json;

async fn startup(
    mode: &str,
    standalone: bool,
    allowed: Vec<ToolName>,
) -> (tempfile::TempDir, StartThreadOptions) {
    let home = tempfile::tempdir().unwrap();
    let (config, _) = crate::config::load(
        &json!({"web_search":mode,"features.standalone_web_search":standalone,
            "features.apps":false,"features.plugins":false,"features.code_mode":false,"agents.enabled":false,
            "tools.update_plan.enabled":false,"features.tool_registry.error_on_tool_collisions":true}).to_string(),
        &json!({"codex_home":home.path(),"cwd":home.path(),"loader":{"ignore_user_config":true,"ignore_project_config":true}}).to_string(),None
    ).await.unwrap();
    let db = codex_state::StateRuntime::init(
        config.sqlite_config().clone(),
        config.model_provider_id.clone(),
    )
    .await
    .unwrap();
    let mut local = codex_thread_store::LocalThreadStoreConfig::from_config(&config);
    local.codex_home = home.path().to_path_buf();
    let store = Arc::new(crate::local_storage::LocalChecklistStore::new(
        codex_thread_store::LocalThreadStore::new(local, Some(db.clone())),
        db,
        home.path().to_path_buf(),
    ));
    let mut start = StartThreadOptions::new(config);
    start.session_source = Some(SessionSource::Exec);
    start.thread_source = Some(ThreadSource::User);
    start
        .thread_extension_init
        .insert(crate::local_storage::LocalReceiptStore(store));
    start.thread_extension_init.insert(ToolPolicy {
        allowed_tools: Some(allowed),
        ..Default::default()
    });
    (home, start)
}

fn named(namespace: Option<&str>, name: &str) -> ToolName {
    ToolName::new(namespace.map(str::to_owned), name.to_owned())
}
fn callback() -> DynamicToolSpec {
    serde_json::from_value(json!({"type":"function","name":"web_search","description":"managed",
        "inputSchema":{"type":"object","properties":{},"additionalProperties":false},"deferLoading":false})).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn current_search_only_extends_local_policy_by_its_exact_identity() {
    for namespace in [None, Some(""), Some("functions")] {
        let (_home, mut start) =
            startup("cached", false, vec![named(namespace, "web_search")]).await;
        crate::config::validate_local_tool_config(&start.config).unwrap();
        PythonTools::install(
            &mut start,
            vec![].into(),
            ToolInstallOptions {
                preserve_schemas: false,
                allow_local_goals: false,
            },
        )
        .unwrap();
    }
    let (_home, mut start) = startup("live", true, vec![named(Some("web"), "run")]).await;
    PythonTools::install(
        &mut start,
        vec![].into(),
        ToolInstallOptions {
            preserve_schemas: false,
            allow_local_goals: false,
        },
    )
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn current_search_and_checklist_require_both_current_policy_grants() {
    for (allowed, admitted) in [
        (
            vec![named(None, "web_search"), named(None, "update_plan")],
            true,
        ),
        (vec![named(None, "web_search")], false),
        (vec![named(None, "update_plan")], false),
    ] {
        let (_home, mut start) = startup("cached", false, allowed).await;
        start.config.update_plan_enabled = true;
        assert_eq!(
            PythonTools::install(
                &mut start,
                vec![].into(),
                ToolInstallOptions {
                    preserve_schemas: false,
                    allow_local_goals: false
                }
            )
            .is_ok(),
            admitted
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn enabled_search_requires_its_current_policy_grant() {
    for standalone in [false, true] {
        let (_home, mut start) = startup("cached", standalone, vec![]).await;
        assert!(
            PythonTools::install(
                &mut start,
                vec![].into(),
                ToolInstallOptions {
                    preserve_schemas: false,
                    allow_local_goals: false
                }
            )
            .is_err()
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disabled_search_does_not_admit_plain_search_policy_name() {
    let (_home, mut start) = startup("disabled", false, vec![named(None, "web_search")]).await;
    assert!(
        PythonTools::install(
            &mut start,
            vec![].into(),
            ToolInstallOptions {
                preserve_schemas: false,
                allow_local_goals: false
            }
        )
        .is_err()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hosted_grant_cannot_alias_a_managed_callback() {
    let (_home, mut start) = startup("cached", false, vec![named(None, "web_search")]).await;
    assert!(
        PythonTools::install(
            &mut start,
            vec![callback()].into(),
            ToolInstallOptions {
                preserve_schemas: false,
                allow_local_goals: false
            }
        )
        .is_err()
    );
    let (_home, mut disabled) = startup("disabled", false, vec![named(None, "web_search")]).await;
    PythonTools::install(
        &mut disabled,
        vec![callback()].into(),
        ToolInstallOptions {
            preserve_schemas: false,
            allow_local_goals: false,
        },
    )
    .unwrap();
    assert!(crate::config::web_search_tool(&disabled.config).is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unrelated_policy_and_alternate_route_are_rejected() {
    for unrelated in [
        named(None, "exec_command"),
        named(Some("web"), "run"),
        named(Some("foreign"), "web_search"),
    ] {
        let (_home, mut start) =
            startup("cached", false, vec![named(None, "web_search"), unrelated]).await;
        assert!(
            PythonTools::install(
                &mut start,
                vec![].into(),
                ToolInstallOptions {
                    preserve_schemas: false,
                    allow_local_goals: false
                }
            )
            .is_err()
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hosted_grant_rejects_lite_without_rejecting_disabled_or_standalone() {
    let (_home, start) = startup("cached", false, vec![named(None, "web_search")]).await;
    let models =
        codex_model_provider::create_model_provider(start.config.model_provider.clone(), None)
            .models_manager_without_cache(start.config.model_catalog.clone());
    models.set_api_key_model_discovery_enabled(false);
    let mut info = models
        .get_model_info("gpt-5.5", &start.config.to_models_manager_config())
        .await;
    info.use_responses_lite = true;
    assert!(crate::engine::EngineState::validate_hosted_search(&start.config, &info).is_err());
    info.use_responses_lite = false;
    crate::engine::EngineState::validate_hosted_search(&start.config, &info).unwrap();
    info.use_responses_lite = true;
    let (_home, disabled) = startup("disabled", false, vec![]).await;
    crate::engine::EngineState::validate_hosted_search(&disabled.config, &info).unwrap();
    let (_home, standalone) = startup("cached", true, vec![named(Some("web"), "run")]).await;
    crate::engine::EngineState::validate_hosted_search(&standalone.config, &info).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retained_native_agent_model_keeps_authentic_lite_metadata() {
    let (_home, start) = startup("disabled", false, vec![]).await;
    let mut config = start.config.clone();
    config.model = Some("gpt-5.5".to_owned());
    config.code_mode.direct_only_tool_namespaces = vec!["functions".into(), "collaboration".into()];
    let models: codex_models_manager::manager::SharedModelsManager =
        codex_model_provider::create_model_provider(config.model_provider.clone(), None)
            .models_manager_without_cache(config.model_catalog.clone());
    models.set_api_key_model_discovery_enabled(false);
    let catalog = crate::native_agents::validated_catalog(
        &config,
        &models,
        &["gpt-5.6-sol".to_owned(), "gpt-5.6-sol".to_owned()],
    )
    .await
    .unwrap();
    let saved: Vec<_> = catalog
        .iter()
        .filter(|info| info.slug == "gpt-5.6-sol")
        .collect();
    assert_eq!(saved.len(), 1);
    assert!(saved[0].use_responses_lite);
    assert!(!saved[0].used_fallback_model_metadata);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hosted_catalog_rejects_retained_lite_before_freezing_metadata() {
    let (_home, start) = startup("cached", false, vec![named(None, "web_search")]).await;
    let mut config = start.config.clone();
    config.model = Some("gpt-5.5".to_owned());
    config.code_mode.direct_only_tool_namespaces = vec!["functions".into(), "collaboration".into()];
    let models: codex_models_manager::manager::SharedModelsManager =
        codex_model_provider::create_model_provider(config.model_provider.clone(), None)
            .models_manager_without_cache(config.model_catalog.clone());
    models.set_api_key_model_discovery_enabled(false);
    let error =
        crate::native_agents::validated_catalog(&config, &models, &["gpt-5.6-sol".to_owned()])
            .await
            .unwrap_err();
    assert!(error.to_string().contains("hosted"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hosted_model_validation_retains_context_admission_until_await_finishes() {
    use std::future::{Future, poll_fn};
    use std::task::Poll;

    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        let provider = crate::local_storage_tests::Provider::start().await;
        let home = tempfile::tempdir().unwrap();
        let mut config = provider.config();
        config["web_search"] = json!("cached");
        config["features.standalone_web_search"] = json!(false);
        let engine = crate::create_engine(
            config.to_string(),
            json!({"codex_home":home.path(),"cwd":home.path(),
                "loader":{"ignore_user_config":true,"ignore_project_config":true}})
            .to_string(),
            None,
            None,
        )
        .await
        .unwrap();
        let mut options: serde_json::Value =
            serde_json::from_str(&crate::local_storage_tests::options(None)).unwrap();
        options["tool_policy"]["allowed_tools"]
            .as_array_mut()
            .unwrap()
            .push(json!({"name":"web_search"}));
        let native = engine
            .start_replaceable_thread(options.to_string(), crate::local_storage_tests::specs())
            .await
            .unwrap();
        let state = native.current().unwrap();
        let before = crate::context::begin(Arc::clone(&state)).await;
        let initially_available = before.is_ok();
        drop(before);

        let mut validation = Box::pin(native._validate_hosted_search_model());
        let (pending, early) = poll_fn(|cx| {
            Poll::Ready(match validation.as_mut().poll(cx) {
                Poll::Pending => (true, None),
                Poll::Ready(result) => (false, Some(result)),
            })
        })
        .await;
        let competing = crate::context::begin(Arc::clone(&state)).await;
        let refused_during_validation = competing.as_ref().err().is_some_and(|error| {
            error
                .to_string()
                .contains("native operations are still in progress")
        });
        // A failed assertion must not retain the write lease before joining validation.
        drop(competing);
        let validated = match early {
            Some(result) => result,
            None => validation.await,
        };
        let after = crate::context::begin(Arc::clone(&state)).await;
        let available_after_validation = after.is_ok();
        drop(after);
        let closed_thread = native.close().await;
        let closed_engine = engine.close().await;
        let requests = provider.request_count();
        drop(provider);

        closed_thread.unwrap();
        closed_engine.unwrap();
        assert!(initially_available);
        assert!(pending);
        validated.unwrap();
        assert!(refused_during_validation);
        assert!(available_after_validation);
        assert_eq!(requests, 0);
    })
    .await
    .expect("hosted model admission did not release its context permit");
}
