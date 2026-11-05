//! The standard agent extensions installed by Codex's application host.
use std::sync::{Arc, RwLock, Weak};

use codex_core_api::{
    AnalyticsEventsClient, AuthManager, Config, EnvironmentManager, Feature, SessionSource,
    ThreadManager,
};
use codex_extension_api::{
    ConfigContributor, ExtensionData, ExtensionEventSink, ExtensionFuture, ExtensionRegistry,
    ExtensionRegistryBuilder, ExtensionWarning, ThreadIdleInput, ThreadLifecycleContributor,
    ThreadReadyInput, ThreadResumeInput, ThreadStartInput, ThreadStopInput,
};
use codex_protocol::protocol::{Event, EventMsg, WarningEvent};
use tokio::sync::broadcast;

/// Extension events use a separate native sink. Subscribe before starting a thread.
/// An empty target denotes a global event; subscribers should retain it.
pub struct Events {
    sender: broadcast::Sender<(String, Event)>,
}

impl Events {
    pub fn new() -> Self {
        Self {
            sender: broadcast::channel(1024).0,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<(String, Event)> {
        self.sender.subscribe()
    }
}

impl ExtensionEventSink for Events {
    fn emit(&self, event: Event) {
        let target = match &event.msg {
            EventMsg::ThreadGoalUpdated(update) => update.thread_id.to_string(),
            EventMsg::ThreadQueueChanged(update) => update.thread_id.to_string(),
            _ => String::new(),
        };
        // No receivers means no live SDK session. Lag is reported to receivers.
        let _ = self.sender.send((target, event));
    }

    fn emit_warning(&self, warning: ExtensionWarning) {
        let event = Event {
            id: warning.turn_id.unwrap_or_default(),
            msg: EventMsg::Warning(WarningEvent {
                message: warning.message,
            }),
        };
        let _ = self.sender.send((warning.thread_id, event));
    }
}

struct LocalGoalLifecycle(Arc<dyn ThreadLifecycleContributor<Config>>);

impl ThreadLifecycleContributor<Config> for LocalGoalLifecycle {
    fn on_thread_start<'a>(
        &'a self,
        input: ThreadStartInput<'a, Config>,
    ) -> ExtensionFuture<'a, ()> {
        self.0.on_thread_start(input)
    }

    fn on_thread_ready<'a>(
        &'a self,
        input: ThreadReadyInput<'a, Config>,
    ) -> ExtensionFuture<'a, ()> {
        self.0.on_thread_ready(input)
    }

    fn on_thread_resume<'a>(&'a self, input: ThreadResumeInput<'a>) -> ExtensionFuture<'a, ()> {
        self.0.on_thread_resume(input)
    }

    fn on_thread_idle<'a>(&'a self, input: ThreadIdleInput<'a>) -> ExtensionFuture<'a, ()> {
        if input
            .thread_store
            .get::<crate::python_tools::PythonTools>()
            .is_some()
        {
            Box::pin(async {})
        } else {
            self.0.on_thread_idle(input)
        }
    }

    fn on_thread_stop<'a>(&'a self, input: ThreadStopInput<'a>) -> ExtensionFuture<'a, ()> {
        self.0.on_thread_stop(input)
    }
}

pub fn build(
    config: &Config,
    auth: Arc<AuthManager>,
    goals: Option<&crate::goals::GoalBackend>,
    local_store: bool,
    manager: Weak<ThreadManager>,
    environment: Arc<EnvironmentManager>,
    events: Arc<Events>,
    interception: Arc<crate::native_interception::Boundary>,
    responses: Arc<crate::response_control::ResponseContributor>,
    sentinel: Arc<RwLock<Option<(String, String, Option<String>)>>>,
) -> Arc<ExtensionRegistry<Config>> {
    let mut builder = ExtensionRegistryBuilder::<Config>::with_event_sink(events);
    let settlement = Arc::new(crate::turn_settlement::Contributor);
    builder.thread_lifecycle_contributor(settlement.clone());
    builder.turn_lifecycle_contributor(settlement);
    let graph = Arc::new(crate::graph_stop::Contributor {
        manager: manager.clone(),
    });
    builder.turn_lifecycle_contributor(graph.clone());
    builder.prompt_contributor(graph);
    builder.prompt_contributor(Arc::new(crate::application_instructions::Contributor));
    let rules = Arc::new(crate::canonical_rules::CanonicalRules::new(
        manager.clone(),
        environment.clone(),
    ));
    builder.prompt_contributor(rules.clone());
    builder.turn_lifecycle_contributor(rules.clone());
    builder.tool_lifecycle_contributor(rules.clone());
    builder.tool_contributor(Arc::new(crate::native_interception::DirectContributor(
        rules,
        crate::native_interception::DirectOutput::Json,
    )));
    builder.thread_lifecycle_contributor(interception.clone());
    builder.turn_lifecycle_contributor(interception.clone());
    builder.tool_lifecycle_contributor(interception.clone());
    let managed = Arc::new(crate::python_tools::PythonContributor {
        manager: manager.clone(),
        models_config: config.to_models_manager_config(),
        code_mode_enabled: config.features.enabled(Feature::CodeMode),
    });
    builder.thread_lifecycle_contributor(managed.clone());
    builder.turn_lifecycle_contributor(managed.clone());
    builder.tool_lifecycle_contributor(managed.clone());
    builder.prompt_contributor(managed.clone());
    builder.tool_contributor(managed);
    let recovery = Arc::new(crate::recovery_guard::RecoveryContributor::default());
    builder.thread_lifecycle_contributor(recovery.clone());
    builder.turn_lifecycle_contributor(recovery.clone());
    builder.tool_lifecycle_contributor(recovery.clone());
    let mcp_results = Arc::new(crate::mcp_result_control::McpResultContributor(
        manager.clone(),
    ));
    builder.thread_lifecycle_contributor(mcp_results.clone());
    builder.turn_lifecycle_contributor(mcp_results.clone());
    builder.tool_lifecycle_contributor(mcp_results);
    builder.thread_lifecycle_contributor(responses.clone());
    builder.turn_lifecycle_contributor(responses.clone());
    codex_history_notes_extension::install(&mut builder, auth.clone());
    let mut board_registry = ExtensionRegistryBuilder::with_event_sink(builder.event_sink());
    codex_core::install_agent_message_board(&mut board_registry, manager.clone());
    install_audited_extensions(
        &mut builder,
        board_registry.build(),
        crate::native_interception::DirectOutput::Json,
    );
    if let Some(goals) = goals {
        // Keep one native contributor set for accounting and local goal tools.
        // Portable checkpoint metadata retains its existing inert tool boundary.
        let mut goal_registry = ExtensionRegistryBuilder::with_event_sink(builder.event_sink());
        codex_goal_extension::install_with_backend(
            &mut goal_registry,
            goals.state_db.clone(),
            AnalyticsEventsClient::disabled(),
            codex_otel::global(),
            manager.clone(),
            goals.service.clone(),
            |config: &Config| codex_goal_extension::GoalExtensionConfig {
                enabled: config.features.enabled(Feature::Goals),
                max_goal_token_budget: config.max_goal_token_budget,
            },
        );
        let goal_registry = goal_registry.build();
        for contributor in goal_registry.thread_lifecycle_contributors() {
            if local_store {
                builder.thread_lifecycle_contributor(Arc::new(LocalGoalLifecycle(
                    contributor.clone(),
                )));
            } else {
                builder.thread_lifecycle_contributor(contributor.clone());
            }
        }
        for contributor in goal_registry.config_contributors() {
            builder.config_contributor(contributor.clone());
        }
        for contributor in goal_registry.turn_lifecycle_contributors() {
            builder.turn_lifecycle_contributor(contributor.clone());
        }
        for contributor in goal_registry.token_usage_contributors() {
            builder.token_usage_contributor(contributor.clone());
        }
        for contributor in goal_registry.tool_lifecycle_contributors() {
            builder.tool_lifecycle_contributor(contributor.clone());
        }
        if local_store {
            for contributor in goal_registry.tool_contributors() {
                builder.tool_contributor(contributor.clone());
            }
        }
    }
    codex_git_attribution::install(
        &mut builder,
        auth.clone(),
        config.chatgpt_base_url.clone(),
        config.http_client_factory(),
    );
    codex_guardian_v2::install(&mut builder, auth.clone(), manager);
    codex_mcp_extension::install(&mut builder);
    codex_mcp_extension::install_plugins(&mut builder, environment.clone());
    // Apply the explicit host capability after generic MCP defaults and plugins.
    builder.mcp_server_contributor(Arc::new(crate::verification::Contributor));
    let media_project: Arc<dyn Fn(&Config) -> Config + Send + Sync> = {
        // The entered Engine is the only source of this pairing. Core can
        // change thread settings after start: never project an old provider
        // over a different current one. Other current settings stay current.
        let entered = config.clone();
        let auth = auth.clone();
        Arc::new(move |current| {
            let mut media = current.clone();
            if let Some(provider) = entered.model_providers.get(&current.model_provider_id) {
                let mut expected = entered.clone();
                let issued = match sentinel.read().expect("sentinel poisoned").as_ref() {
                    Some((base, grant, excluded)) => crate::engine::EngineState::prepare_sentinel(
                        &mut expected,
                        &auth,
                        base,
                        grant,
                        excluded.as_deref(),
                    ),
                    None => Ok(()),
                };
                if issued.is_ok()
                    && expected.model_providers.get(&current.model_provider_id)
                        == Some(&current.model_provider)
                {
                    media.model_provider = provider.clone();
                }
            }
            media
        })
    };
    let mut media_registry = ExtensionRegistryBuilder::with_event_sink(builder.event_sink());
    {
        let project = media_project.clone();
        let auth = auth.clone();
        responses.set_reporting_projection(Arc::new(move |current| {
            // Only a bound Sentinel route can use this per-thread mapping.
            // The projector compares the whole issued native provider config;
            // a user-supplied URL or grant header alone cannot authorize it.
            if !current
                .model_provider
                .http_headers
                .as_ref()
                .is_some_and(|headers| headers.contains_key("x-sdk-sentinel-grant"))
            {
                return None;
            }
            let entered = project(current);
            if entered.model_provider == current.model_provider {
                return None;
            }
            let native = current.model_provider.base_url.clone()?;
            let provider = entered
                .model_provider
                .to_api_provider(auth.auth_mode())
                .ok()?;
            Some((native, url::Url::parse(&provider.base_url).ok()?))
        }));
    }
    codex_web_search_extension::install(&mut media_registry, auth.clone());
    let media_registry = media_registry.build();
    // The pinned web installer registers exactly one thread, config and
    // tool contributor, sharing its auth manager and thread store. Retain
    // that tool Arc and the normal interception; only adapt its inputs.
    let web = Arc::new(EnteredMedia {
        thread: media_registry.thread_lifecycle_contributors()[0].clone(),
        config: media_registry.config_contributors()[0].clone(),
        project: media_project.clone(),
    });
    builder.thread_lifecycle_contributor(web.clone());
    builder.config_contributor(web);
    for contributor in media_registry.tool_contributors() {
        builder.tool_contributor(Arc::new(crate::native_interception::DirectContributor(
            Arc::new(crate::canonical_rules::AccessContributor(
                contributor.clone(),
            )),
            crate::native_interception::DirectOutput::ResponseBody,
        )));
    }
    // Image generation owns both real filesystem access and a typed result body.
    let mut image_registry = ExtensionRegistryBuilder::with_event_sink(builder.event_sink());
    codex_image_generation_extension::install(&mut image_registry, auth, |_: &Config| None);
    let image_registry = image_registry.build();
    // The pinned image installer also shares exactly one thread/config/tool Arc.
    let image = Arc::new(EnteredMedia {
        thread: image_registry.thread_lifecycle_contributors()[0].clone(),
        config: image_registry.config_contributors()[0].clone(),
        project: media_project,
    });
    builder.thread_lifecycle_contributor(image.clone());
    builder.config_contributor(image);
    for contributor in image_registry.tool_contributors() {
        builder.tool_contributor(Arc::new(crate::native_interception::DirectContributor(
            Arc::new(crate::canonical_rules::AccessContributor(
                contributor.clone(),
            )),
            crate::native_interception::DirectOutput::ResponseBody,
        )));
    }
    let skills = codex_skills_extension::SkillProviders::new().with_executor_provider(Arc::new(
        codex_skills_extension::ExecutorSkillProvider::new_with_restriction_product(
            environment,
            SessionSource::Exec.restriction_product(),
        ),
    ));
    let mut skills_registry = ExtensionRegistryBuilder::with_event_sink(builder.event_sink());
    codex_skills_extension::install_with_providers_and_metrics(
        &mut skills_registry,
        skills,
        codex_otel::global(),
        |config: &Config| codex_skills_extension::SkillsExtensionConfig {
            include_instructions: config.include_skill_instructions,
            max_context_tokens: config.skill_max_context_tokens,
            bundled_skills_enabled: config.bundled_skills_enabled(),
            cloud_skill_enabled: config.cloud_skill_enabled,
            shadow_selection_enabled: config.features.enabled(Feature::SkillSearch),
        },
    );
    install_audited_extensions(
        &mut builder,
        skills_registry.build(),
        crate::native_interception::DirectOutput::Json,
    );
    builder.model_request_contributor(Arc::new(
        crate::python_tools::prepared_requests::Contributor,
    ));
    builder.model_request_contributor(recovery);
    builder.model_request_contributor(Arc::new(crate::response_integrity::Contributor(
        interception.clone(),
    )));
    builder.prompt_contributor(interception.clone());
    builder.model_request_contributor(interception);
    // Core wraps streams in registration order. Recovery must see the original
    // item before any application callback; managed integrity rejects provider
    // receipts before review. Response/step control then records precisely the
    // item admitted by interception, never a rejected stream's Completed.
    Arc::new(builder.build())
}

/// Pinned web and image configs live in their existing Core thread stores.
/// Delegate start and config commits without owning thread or auth-result state.
struct EnteredMedia {
    thread: Arc<dyn ThreadLifecycleContributor<Config>>,
    config: Arc<dyn ConfigContributor<Config>>,
    // ModelProviderInfo is not re-exported by our pinned public dependencies;
    // infer its concrete type at construction rather than copying fields or
    // adding a crate dependency for a second provider representation.
    project: Arc<dyn Fn(&Config) -> Config + Send + Sync>,
}

impl ThreadLifecycleContributor<Config> for EnteredMedia {
    fn on_thread_start<'a>(
        &'a self,
        input: ThreadStartInput<'a, Config>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            let config = (self.project)(input.config);
            self.thread
                .on_thread_start(ThreadStartInput {
                    config: &config,
                    session_source: input.session_source,
                    persistent_thread_state_available: input.persistent_thread_state_available,
                    environments: input.environments,
                    mcp_resource_client: input.mcp_resource_client,
                    extension_metrics: input.extension_metrics,
                    session_store: input.session_store,
                    thread_store: input.thread_store,
                })
                .await;
        })
    }
}

impl ConfigContributor<Config> for EnteredMedia {
    fn on_config_changed(
        &self,
        session_store: &ExtensionData,
        thread_store: &ExtensionData,
        previous_config: &Config,
        new_config: &Config,
    ) {
        self.config.on_config_changed(
            session_store,
            thread_store,
            &(self.project)(previous_config),
            &(self.project)(new_config),
        );
    }
}

/// Only the audited pinned installers above: board registers thread/tool
/// contributors and notifications register turn lifecycle; skills registers
/// thread/turn/config/context/turn-input/skill/tool contributors; web and image
/// register thread/config/tool contributors. Preserve all
/// their original Arcs and relative registration positions. In particular do
/// not rebuild the whole registry: its public API has no approval-contributor
/// or turn-admission getter, and doing so would silently lose policy.
fn install_audited_extensions(
    builder: &mut ExtensionRegistryBuilder<Config>,
    installed: ExtensionRegistry<Config>,
    output: crate::native_interception::DirectOutput,
) {
    for contributor in installed.thread_lifecycle_contributors() {
        builder.thread_lifecycle_contributor(contributor.clone());
    }
    for contributor in installed.turn_lifecycle_contributors() {
        builder.turn_lifecycle_contributor(contributor.clone());
    }
    for contributor in installed.config_contributors() {
        builder.config_contributor(contributor.clone());
    }
    for contributor in installed.context_contributors() {
        builder.prompt_contributor(contributor.clone());
    }
    for contributor in installed.turn_input_contributors() {
        builder.turn_input_contributor(contributor.clone());
    }
    for contributor in installed.skill_invocation_contributors() {
        builder.skill_invocation_contributor(contributor.clone());
    }
    for contributor in installed.tool_contributors() {
        builder.tool_contributor(Arc::new(crate::native_interception::DirectContributor(
            Arc::new(crate::canonical_rules::AccessContributor(
                contributor.clone(),
            )),
            output,
        )));
    }
}
