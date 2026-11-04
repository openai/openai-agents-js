//! Constructs native services and owns their orderly shutdown.

use std::collections::{HashMap, HashSet, VecDeque};
use std::future::{Future, poll_fn};
use std::pin::Pin;
use std::sync::{
    Arc, OnceLock, RwLock, Weak,
    atomic::{AtomicBool, Ordering},
};
use std::task::Poll;
use std::time::{Duration, SystemTime};

use anyhow::{Context, ensure};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use codex_core_api::*;
use codex_history::{ResumedHistory, RolloutItem};
use codex_http_client::HttpClientFactory;
use codex_login::AuthManager;
use codex_models_manager::ModelsManagerConfig;
use codex_models_manager::manager::{ModelsManager, ModelsManagerFuture};
use codex_protocol::config_types::CollaborationModeMask;
use codex_protocol::openai_models::{ModelInfo, ModelPreset, ModelsResponse};
use codex_protocol::protocol::Event;
use codex_thread_store::{
    DeleteThreadParams, LoadThreadHistoryParams, ReadThreadParams, StoredThread, ThreadStore,
    ThreadStoreError,
};
use tokio::sync::{Mutex, broadcast, mpsc, watch};

use crate::{NativeThread, config, extensions, goals, options};

pub(crate) const CLOSE_TIMEOUT: Duration = Duration::from_secs(30);

pub struct EngineState {
    pub manager: Arc<ThreadManager>,
    pub(crate) sdk_selected_model: bool,
    pub store: Arc<dyn ThreadStore>,
    pub(crate) local_checklist_store: Option<Arc<crate::local_storage::LocalChecklistStore>>,
    pub agent_graph: Arc<crate::storage::MemoryAgentGraph>,
    pub goals: Option<goals::GoalBackend>,
    sdk_user_input_enabled: Option<bool>,
    telemetry: Option<crate::telemetry::EmissionSettings>,
    pub(crate) config_json: String,
    pub(crate) runtime_json: String,
    pub(crate) closed: AtomicBool,
    pub(crate) retired: AtomicBool,
    pub(crate) context_gate: Arc<tokio::sync::RwLock<()>>,
    pub(crate) lifecycle: Mutex<()>,
    // Passive manual queries retain a read permit through serialization;
    // shutdown takes the writer without excluding unrelated thread startup.
    manual_observations: tokio::sync::RwLock<()>,
    event_owners: Mutex<HashMap<ThreadId, ThreadId>>,
    // MemoryThreadStore cannot persist extension mode. Retain only provenance
    // for this engine/store lifetime, including after the live owner closes.
    managed_thread_ids: Mutex<HashSet<ThreadId>>,
    // Wrapper slots stay weak. Shared raw fork receipts survive a lost source,
    // without retaining a ThreadState (which itself owns this EngineState).
    native_threads: std::sync::Mutex<Vec<NativeThreadRegistration>>,
    pub startup_warnings: Vec<String>,
    extension_events: Arc<extensions::Events>,
    cloud_config: codex_config::CloudConfigBundleLoader,
    pub(crate) service_config: Config,
    pub(crate) application_apps: Option<codex_mcp::ApplicationApps>,
    pub(crate) sentinel: Arc<RwLock<Option<(String, String, Option<String>)>>>,
    pub(crate) interception: Arc<crate::native_interception::Boundary>,
    sentinel_transports: std::sync::Mutex<
        HashMap<
            bool,
            (
                codex_http_client::ReqwestTransport,
                crate::model_websocket::ConnectorCache,
            ),
        >,
    >,
    pub restored_creation_times: Mutex<HashMap<ThreadId, SystemTime>>,
}

impl EngineState {
    pub(crate) fn local_storage_home(&self) -> Option<&std::path::Path> {
        (self.local_checklist_store.is_some() || self.goals.is_some())
            .then(|| self.service_config.sqlite_config().home())
    }

    pub(crate) fn validate_hosted_search(config: &Config, info: &ModelInfo) -> anyhow::Result<()> {
        ensure!(
            config.web_search_mode.value() == codex_protocol::config_types::WebSearchMode::Disabled
                || config.features.enabled(Feature::StandaloneWebSearch)
                || !info.use_responses_lite,
            "WebSearch hosted route is unavailable with the selected native model's Responses Lite protocol"
        );
        Ok(())
    }

    pub(crate) async fn validate_hosted_search_model(&self, model: &str) -> anyhow::Result<()> {
        if crate::config::web_search_tool(&self.service_config)
            .is_some_and(|name| name.is_default_namespace())
        {
            // Exercise the real awaiting ingress even when bundled metadata is cached.
            #[cfg(test)]
            tokio::task::yield_now().await;
            let info = self
                .manager
                .get_models_manager()
                .get_model_info(model, &self.service_config.to_models_manager_config())
                .await;
            Self::validate_hosted_search(&self.service_config, &info)?;
        }
        Ok(())
    }

    pub(crate) fn manual_observation(
        &self,
    ) -> Option<(
        tokio::sync::RwLockReadGuard<'_, ()>,
        tokio::sync::OwnedRwLockReadGuard<()>,
    )> {
        let permit = self.manual_observations.try_read().ok()?;
        Some((permit, self.operation(false).ok()?))
    }

    pub fn operation(
        &self,
        closing: bool,
    ) -> anyhow::Result<tokio::sync::OwnedRwLockReadGuard<()>> {
        let permit = self
            .context_gate
            .clone()
            .try_read_owned()
            .context("native context change is in progress")?;
        ensure!(
            closing
                || (!self.closed.load(Ordering::Acquire) && !self.retired.load(Ordering::Acquire)),
            "Codex engine is closed or retired"
        );
        Ok(permit)
    }

    pub async fn new(
        config_json: String,
        runtime_json: String,
        checkpoint: bool,
        api_key: Option<String>,
    ) -> anyhow::Result<Self> {
        Self::new_owned(
            config_json,
            runtime_json,
            checkpoint,
            api_key,
            None,
            Default::default(),
        )
        .await
    }

    pub(crate) async fn new_owned_with_application(
        config_json: String,
        runtime_json: String,
        checkpoint: bool,
        api_key: Option<String>,
        prospective: Option<&std::sync::Mutex<Option<crate::RuntimeOwned<EnvironmentManager>>>>,
        initial_models: crate::checkpoint::InitialModels,
        application_apps_json: Option<String>,
    ) -> anyhow::Result<Self> {
        let application = crate::verification::prepare(application_apps_json.as_deref())?;
        let mut engine = Self::new_owned(
            config_json,
            runtime_json,
            checkpoint,
            api_key,
            prospective,
            initial_models,
        )
        .await?;
        engine.application_apps = match application {
            Some(application) => Some(application.bind(&engine.service_config).await?),
            None => None,
        };
        Ok(engine)
    }

    pub(crate) async fn new_owned(
        config_json: String,
        runtime_json: String,
        checkpoint: bool,
        api_key: Option<String>,
        prospective: Option<&std::sync::Mutex<Option<crate::RuntimeOwned<EnvironmentManager>>>>,
        initial_models: crate::checkpoint::InitialModels,
    ) -> anyhow::Result<Self> {
        let telemetry = crate::telemetry::engine_starting().await?;
        let runtime_json = config::prepare_runtime(&runtime_json)?;
        let (mut config, cloud_config) = config::load(&config_json, &runtime_json, None).await?;
        let environment_options = config::environment(&runtime_json)?;
        if let Some(environment) = &environment_options {
            environment.restrict_network_approval(&mut config)?;
            environment.check_config(&config)?;
        }
        let sdk_selected_model = config::sdk_selected_model(&runtime_json)?;
        if let Some(settings) = &telemetry {
            settings.apply(&mut config);
        } else if crate::telemetry::export_requested(&config) {
            config.startup_warnings.push(
                "Native telemetry export was requested without telemetry.configure(); no process exporter is installed".into(),
            );
        }
        // Managed portable state owns the effective model, never its credentials or tools.
        if checkpoint && config::native_agents(&runtime_json)? {
            if let Some(model) = &initial_models.root_model {
                config.model = Some(model.clone());
            }
        }
        let sdk_user_input_enabled = config::sdk_native_config(&runtime_json)?
            .then_some(config.experimental_request_user_input_enabled);
        ensure!(
            !checkpoint || !config.ephemeral,
            "checkpoints require persistent threads"
        );
        let local_home = if checkpoint {
            None
        } else {
            config::native_thread_store(&runtime_json)?
        };
        if local_home.is_some() {
            config::validate_local_tool_config(&config)?;
            ensure!(
                (!config.agents_enabled || config::native_agents(&runtime_json)?)
                    && !config.features.enabled(Feature::CodeMode),
                "local storage requires current NativeAgents and no Code Mode"
            );
        }
        let goals_enabled = config::native_goal_store_enabled(&runtime_json)?;
        // Check before opening SQLite or launching the executor.
        if let Some(environment) = &environment_options {
            let storage =
                (goals_enabled || local_home.is_some()).then(|| config.sqlite_config().home());
            environment.check_local_session_paths(&config, storage)?;
        }
        let responses = Arc::new(crate::response_control::ResponseContributor::default());
        let services = &config;
        let auth = crate::auth::manager(services, api_key).await?;
        let models = codex_model_provider::create_model_provider(
            services.model_provider.clone(),
            Some(auth.clone()),
        )
        .models_manager_without_cache(services.model_catalog.clone());
        models.set_api_key_model_discovery_enabled(
            services.features.enabled(Feature::ApiKeyModelDiscovery),
        );
        let models: SharedModelsManager = if sdk_user_input_enabled == Some(false) {
            Arc::new(ConfiguredModels {
                inner: models,
                disable_user_input: sdk_user_input_enabled == Some(false),
            })
        } else {
            models
        };
        let models: SharedModelsManager = if config::native_agents(&runtime_json)? {
            let catalog = crate::native_agents::validated_catalog(
                services,
                &models,
                &initial_models.descendant_models,
            )
            .await?;
            Arc::new(codex_models_manager::manager::StaticModelsManager::new(
                Some(auth.clone()),
                ModelsResponse { models: catalog },
            ))
        } else {
            models
        };
        if config::web_search_tool(&config).is_some_and(|name| name.is_default_namespace())
            && local_home.is_none()
        {
            let selected = if checkpoint {
                initial_models
                    .root_model
                    .clone()
                    .or_else(|| config.model.clone())
            } else {
                config.model.clone()
            };
            let model = models
                .get_default_model(
                    &selected,
                    false,
                    codex_models_manager::manager::RefreshStrategy::Offline,
                    config.http_client_factory(),
                )
                .await;
            let info = models
                .get_model_info(&model, &config.to_models_manager_config())
                .await;
            Self::validate_hosted_search(&config, &info)?;
        }
        let installation_id = ThreadId::new().to_string();
        let user_instructions = Arc::new(options::EmptyUserInstructions);
        let extension_events = Arc::new(extensions::Events::new());
        let code_mode = config::code_mode_provider(&runtime_json, &config)?.or_else(|| {
            // Mirror ThreadManager's pinned default if no package helper was
            // selected, so every enabled native Code Mode session uses the same
            // owning delegate. Disabled Code Mode still uses Core's default.
            config::code_mode_host_enabled(&config).then(|| {
                Arc::new(codex_code_mode::ProcessOwnedCodeModeSessionProvider::default())
                    as Arc<dyn codex_code_mode::CodeModeSessionProvider>
            })
        });
        let sentinel = Arc::new(RwLock::new(None));
        let state_db = if goals_enabled || local_home.is_some() {
            // StateRuntime supplies the exact goal store used by the extension.
            // Avoid rollout::try_init's unrelated host rollout backfill.
            Some(
                codex_state::StateRuntime::init(
                    config.sqlite_config().clone(),
                    config.model_provider_id.clone(),
                )
                .await?,
            )
        } else {
            None
        };
        let agent_graph = Arc::new(if local_home.is_some() {
            crate::storage::MemoryAgentGraph::local(
                state_db
                    .as_ref()
                    .expect("local state DB initialized")
                    .clone(),
            )
        } else {
            crate::storage::MemoryAgentGraph::default()
        });
        let interception = Arc::new(crate::native_interception::Boundary::new(
            agent_graph.clone(),
            sentinel.clone(),
        ));
        let local_checklist_store = local_home.map(|home| {
            let mut storage_config =
                codex_thread_store::LocalThreadStoreConfig::from_config(&config);
            storage_config.codex_home = home.to_path_buf();
            Arc::new(crate::local_storage::LocalChecklistStore::with_graph(
                codex_thread_store::LocalThreadStore::new(storage_config, state_db.clone()),
                state_db
                    .as_ref()
                    .expect("local state DB initialized")
                    .clone(),
                home.to_path_buf(),
                agent_graph.clone(),
            ))
        });
        let store: Arc<dyn ThreadStore> = match &local_checklist_store {
            Some(store) => store.clone(),
            None => Arc::new(crate::storage::MemoryThreadStore::default()),
        };
        if let Some(id) = config::sdk_resume_thread_id(&runtime_json)? {
            let local = local_checklist_store
                .as_ref()
                .context("SDK resume requires current native local storage")?;
            let saved = store
                .read_thread(ReadThreadParams {
                    thread_id: id,
                    include_archived: true,
                    include_history: false,
                })
                .await?;
            local.expect_resume_model(id, saved.model.clone());
            if config.model.is_none() {
                config.model = saved.model;
            }
        }
        if local_checklist_store.is_some()
            && config::web_search_tool(&config).is_some_and(|name| name.is_default_namespace())
        {
            let model = models
                .get_default_model(
                    &config.model,
                    false,
                    codex_models_manager::manager::RefreshStrategy::Offline,
                    config.http_client_factory(),
                )
                .await;
            let info = models
                .get_model_info(&model, &config.to_models_manager_config())
                .await;
            Self::validate_hosted_search(&config, &info)?;
        }
        let goals = if goals_enabled {
            Some(goals::GoalBackend {
                state_db: state_db.expect("enabled goal store was initialized"),
                service: Arc::new(codex_goal_extension::GoalService::new()),
            })
        } else {
            None
        };
        // Retain the environment before startup can fail. The private context
        // owner drains this exact manager even when no EngineState is returned.
        let environment = Arc::new(
            if local_checklist_store.is_some() && environment_options.is_none() {
                EnvironmentManager::without_environments(config.http_client_factory())
            } else {
                match &environment_options {
                    Some(environment) => environment.prepare(&config).await?,
                    None => crate::environment::for_unattached_threads(&config).await?,
                }
            },
        );
        if let Some(slot) = prospective {
            *slot
                .lock()
                .map_err(|_| anyhow::anyhow!("candidate environment owner poisoned"))? =
                Some(crate::RuntimeOwned::new(environment.clone()));
        }
        if let Some(options) = &environment_options {
            options.check_ready(&config, &environment).await?;
        }
        let manager = Arc::new_cyclic(|weak| {
            let extensions = extensions::build(
                &config,
                auth.clone(),
                goals.as_ref(),
                local_checklist_store.is_some(),
                weak.clone(),
                environment.clone(),
                extension_events.clone(),
                interception.clone(),
                responses.clone(),
                sentinel.clone(),
            );
            let manager = ThreadManager::new(
                &config,
                auth.clone(),
                models,
                CodexAppsToolsCache::new_without_cache(),
                SessionSource::Exec,
                environment,
                extensions,
                user_instructions,
                None,
                passthrough_image_store(),
                store.clone(),
                Some(agent_graph.clone()),
                installation_id,
                None,
                None,
            );
            match code_mode {
                Some(provider) => manager.with_code_mode_session_provider(Arc::new(
                    crate::native_interception::Provider {
                        inner: provider,
                        boundary: interception.clone(),
                    },
                )),
                None => manager,
            }
        });
        Ok(Self {
            sdk_selected_model,
            manager,
            store,
            local_checklist_store,
            agent_graph,
            goals,
            sdk_user_input_enabled,
            telemetry,
            config_json,
            runtime_json,
            closed: AtomicBool::new(false),
            retired: AtomicBool::new(false),
            context_gate: Arc::new(tokio::sync::RwLock::new(())),
            native_threads: std::sync::Mutex::new(Vec::new()),
            lifecycle: Mutex::new(()),
            manual_observations: tokio::sync::RwLock::new(()),
            event_owners: Mutex::new(HashMap::new()),
            managed_thread_ids: Mutex::new(HashSet::new()),
            startup_warnings: config.startup_warnings.clone(),
            extension_events,
            cloud_config,
            service_config: config,
            application_apps: None,
            sentinel,
            sentinel_transports: std::sync::Mutex::new(HashMap::new()),
            interception,
            restored_creation_times: Mutex::new(HashMap::new()),
        })
    }

    pub async fn start_with_tools(
        self: &Arc<Self>,
        mut options: options::ThreadOptions,
        specs: Vec<codex_protocol::dynamic_tools::DynamicToolSpec>,
    ) -> anyhow::Result<NativeThread> {
        let _guard = self.lifecycle.lock().await;
        if self.local_checklist_store.is_some() {
            options.validate_local_authority()?;
        }
        let resume = options.sdk_resume_thread_id;
        let reconciled_calls = std::mem::take(&mut options.sdk_reconciled_calls);
        ensure!(
            reconciled_calls.is_empty() || resume.is_some(),
            "reconciled calls require local resume"
        );
        ensure!(
            config::sdk_resume_thread_id(&self.runtime_json)?.is_none_or(|id| Some(id) == resume),
            "SDK resume must match the current runtime admission"
        );
        let (mut startup, instructions) = self.build_startup(options).await?;
        let mut local_resume_admission = None;
        if let Some(id) = resume {
            ensure!(
                self.local_checklist_store.is_some()
                    && matches!(startup.initial_history, InitialHistory::New)
                    && startup.reserved_thread_id.is_none(),
                "SDK resume requires local storage and no competing history or identity"
            );
            self.ensure_no_live_owner(id).await?;
            let saved = self.read_stored_thread(id).await?;
            if startup.config.model.is_none() {
                startup.config.model = saved.model.clone();
            }
            startup.initial_history = self.history(id).await?;
            ensure!(
                startup
                    .initial_history
                    .get_dynamic_tools()
                    .unwrap_or_default()
                    .is_empty(),
                "SDK resume cannot authorize saved startup tools"
            );
            let executor_policy =
                crate::environment::LocalResumeExecutorPolicy::from_startup(&startup)?;
            let InitialHistory::Resumed(history) = &mut startup.initial_history else {
                anyhow::bail!("SDK resume requires the stored model context");
            };
            let admission = self
                .local_checklist_store
                .as_ref()
                .expect("checked local store")
                .prepare_resume(
                    codex_thread_store::ResumeThreadParams {
                        thread_id: id,
                        rollout_path: history.rollout_path.clone(),
                        history: Some(history.history.clone()),
                        history_revision: history.history_revision.clone(),
                        include_archived: true,
                        metadata: codex_thread_store::ThreadPersistenceMetadata {
                            cwd: Some(startup.config.cwd.to_path_buf()),
                            model_provider: startup.config.model_provider_id.clone(),
                            memory_mode: if startup.config.memories.generate_memories {
                                codex_protocol::protocol::ThreadMemoryMode::Enabled
                            } else {
                                codex_protocol::protocol::ThreadMemoryMode::Disabled
                            },
                        },
                    },
                    saved.model,
                    instructions.clone(),
                    executor_policy,
                    reconciled_calls,
                )
                .await?;
            let prepared = admission.prepared_params()?;
            history.history = prepared.history.as_ref().expect("prepared history").clone();
            history.rollout_path = prepared.rollout_path.clone();
            history.history_revision = prepared.history_revision.clone();
            ensure!(
                startup
                    .initial_history
                    .get_dynamic_tools()
                    .unwrap_or_default()
                    .is_empty(),
                "SDK resume cannot authorize saved startup tools"
            );
            local_resume_admission = Some(admission);
        }
        if let Some(store) = &self.local_checklist_store {
            config::validate_local_tool_config(&startup.config)?;
            // An absent current Environment is explicit empty authority. Never
            // let a saved selection become an executor grant on local resume.
            startup.environments.get_or_insert_with(Vec::new);
            ensure!(
                startup.dynamic_tools.is_empty()
                    && (resume.is_some() || matches!(startup.initial_history, InitialHistory::New))
                    && startup.reserved_thread_id.is_none()
                    && !startup.config.ephemeral
                    && (!startup.config.agents_enabled
                        || config::native_agents(&self.runtime_json)?)
                    && !startup.config.features.enabled(Feature::CodeMode),
                "local storage requires a root thread with current managed tools and no imported history"
            );
            startup
                .thread_extension_init
                .insert(crate::local_storage::LocalReceiptStore(store.clone()));
        }
        if let Some(model) = &startup.config.model {
            self.validate_hosted_search_model(model).await?;
        }
        let local_goals =
            self.local_checklist_store.is_some() && startup.config.features.enabled(Feature::Goals);
        ensure!(
            !local_goals || self.goals.is_some(),
            "local goals require the current goal store"
        );
        crate::python_tools::PythonTools::install(
            &mut startup,
            specs,
            crate::python_tools::ToolInstallOptions {
                preserve_schemas: self.sentinel.read().expect("sentinel poisoned").is_some(),
                strict_functions: self.sdk_selected_model,
                allow_local_goals: local_goals,
            },
        )?;
        self.start_prepared(startup, instructions, local_resume_admission.as_ref())
            .await
    }

    // The caller holds lifecycle through validation, native import and start.
    pub(crate) async fn start_prepared(
        self: &Arc<Self>,
        mut startup: StartThreadOptions,
        instructions: Arc<options::ThreadInstructions>,
        local_resume_admission: Option<&crate::local_storage::LocalResumeAdmission<'_>>,
    ) -> anyhow::Result<NativeThread> {
        if let Some(application) = &self.application_apps {
            startup.thread_extension_init.insert(application.clone());
        }
        if let Some(admission) = local_resume_admission {
            let store = self.local_checklist_store.as_ref().ok_or_else(|| {
                anyhow::anyhow!("local resume admission requires its local store")
            })?;
            let InitialHistory::Resumed(history) = &startup.initial_history else {
                anyhow::bail!("local resume admission requires its stored model context");
            };
            admission.validate(
                store,
                history.conversation_id,
                &history.history,
                &instructions,
            )?;
        }
        let mut initial_receipt = None;
        if local_resume_admission.is_none()
            && instructions.managed()
            && instructions.accepted().is_none()
        {
            let current = instructions.text()?.unwrap_or_default();
            let accepted = match &startup.initial_history {
                InitialHistory::Resumed(history) => {
                    crate::application_instructions::validate(&history.history, &current)?
                }
                InitialHistory::Forked(history) => {
                    crate::application_instructions::validate(history, &current)?
                }
                _ => None,
            };
            if let Some(accepted) = accepted {
                if let InitialHistory::Forked(history) = &mut startup.initial_history {
                    let root = history.iter().find_map(|row| match row {
                        RolloutItem::SessionMeta(header) => Some(header.meta.id),
                        _ => None,
                    });
                    if let Some(root) = root {
                        initial_receipt = crate::application_instructions::take_initial_receipt(
                            history, &accepted, root,
                        );
                    }
                }
                instructions.confirm(accepted)?;
            }
        }
        let id = match &startup.initial_history {
            InitialHistory::Resumed(history) => {
                crate::checkpoint::validate_imported_history(&history.history)?;
                Some(history.conversation_id)
            }
            InitialHistory::Forked(history) => {
                crate::checkpoint::validate_imported_history(history)?;
                startup.reserved_thread_id
            }
            _ => startup.reserved_thread_id,
        };
        if let Some(id) = id {
            self.ensure_no_live_owner(id).await?;
            ensure!(
                !self.managed_thread_ids.lock().await.contains(&id),
                "Bare resume of a managed thread is unsupported; restore a portable checkpoint in a new engine"
            );
        }
        let extension_events = self.extension_events.subscribe();

        let new_thread = self.manager.start_thread(startup).await?;
        if let Some(admission) = local_resume_admission {
            if let Some(guard) = new_thread
                .thread
                .thread_extension_data()
                .get::<crate::recovery_guard::Guard>()
            {
                guard.set_reconciled(admission.protected_call_ids().clone());
            }
        }
        if let Some(store) = &self.local_checklist_store {
            let created = match store.canonical_creation_time(new_thread.thread_id).await {
                Ok(created) => created,
                Err(error) => {
                    // Do not publish an owner with invented creation metadata.
                    // Join Core before removing this exact manager membership.
                    new_thread.thread.shutdown_and_wait().await?;
                    self.manager
                        .remove_thread_if_matches(&new_thread.thread_id, &new_thread.thread)
                        .await;
                    return Err(error.into());
                }
            };
            self.restored_creation_times
                .lock()
                .await
                .insert(new_thread.thread_id, created);
        }

        let native = self
            .wrap(new_thread, instructions, extension_events)
            .await?;
        {
            let state = native.current()?;
            let _mutation = state.mutations.lock().await;
            if let Some(item) = initial_receipt {
                crate::application_instructions::publish_item(&state.thread, item).await?;
            } else {
                crate::application_instructions::publish_if_ready(&state.thread, false).await?;
            }
        }

        Ok(native)
    }

    async fn ensure_no_live_owner(&self, id: ThreadId) -> anyhow::Result<()> {
        ensure!(
            !self.event_owners.lock().await.contains_key(&id)
                && self.manager.get_thread(id).await.is_err(),
            "This thread already has a live owner; reuse its Session"
        );
        Ok(())
    }

    async fn wrap(
        self: &Arc<Self>,
        new: NewThread,
        instructions: Arc<options::ThreadInstructions>,
        extension_events: broadcast::Receiver<(String, Event)>,
    ) -> anyhow::Result<NativeThread> {
        // Claiming an existing root in claim_subtree is idempotent only for
        // that owner's reader; it must never admit a second wrapper.
        ensure!(
            !self.event_owners.lock().await.contains_key(&new.thread_id),
            "This thread already has a live owner; reuse its Session"
        );
        if new
            .thread
            .thread_extension_data()
            .get::<crate::python_tools::PythonTools>()
            .is_some()
        {
            self.managed_thread_ids.lock().await.insert(new.thread_id);
        }
        // Subscribe before inspecting descendants so a concurrent spawn cannot be missed.
        let created = self.manager.subscribe_thread_created();
        let (publication_boundaries, boundary_requests) = mpsc::channel(1);
        let native_dequeued = Arc::new(AtomicBool::new(false));
        let state = Arc::new(ThreadState {
            id: new.thread_id,
            thread: new.thread.clone(),
            engine: self.clone(),
            instructions,
            retained_metadata: OnceLock::new(),
            events: Mutex::new(ThreadEvents {
                initial: Some(Event {
                    id: String::new(),
                    msg: EventMsg::SessionConfigured(new.session_configured),
                }),
                extensions: extension_events,
                created,
                graph: self.agent_graph.subscribe(new.thread_id).await,
                native: Some(next_native_event(new.thread, native_dequeued.clone())),
                native_dequeued,
                session_terminal: None,
                children: VecDeque::new(),
                pending: VecDeque::new(),
                deferred_child_steps: VecDeque::new(),
                next_instance: 0,
                boundary_requests,
                publication_prefix: None,
            }),
            publication_boundaries,
            child_instances: RwLock::new(HashMap::new()),
            native_questions: std::sync::Mutex::new(HashMap::new()),
            child_reader_retired: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            closing: watch::channel(false).0,
            close_lock: Mutex::new(()),
            mutations: Arc::new(Mutex::new(())),
            fork_copy: Arc::new(Mutex::new(None)),
            #[cfg(test)]
            fork_test_failure: std::sync::atomic::AtomicU8::new(0),
        });
        if let Err(error) = state
            .discover_children(&mut *state.events.lock().await)
            .await
        {
            let _ = state.thread.shutdown_and_wait().await;
            self.manager
                .remove_thread_if_matches(&state.id, &state.thread)
                .await;
            return Err(error);
        }
        Ok(NativeThread::new(state))
    }

    // Lock order: lifecycle, source mutations, then its copy receipt. The
    // checkpoint helper does not reacquire mutations. No application callback runs.
    pub(crate) async fn fork_settled(
        self: &Arc<Self>,
        source: &Arc<ThreadState>,
    ) -> anyhow::Result<NativeThread> {
        // Keep read admission through queued locks and every native fork await.
        let _context_operation = self.operation(false)?;
        let _lifecycle = self.lifecycle.lock().await;
        let _mutation = source.mutations.lock().await;
        // Close can finish while this reader waits for the lifecycle lock.
        drop(self.operation(false)?);
        ensure!(!source.is_closed(), "Codex thread is closed");
        crate::graph_stop::check_mutation(source)?;
        if let Some(diagnostic) = source.discard_fork_copy(None).await? {
            anyhow::bail!(diagnostic);
        }
        let captured = crate::checkpoint::export(source, None).await?;
        ensure!(
            captured["descendants"]
                .as_array()
                .is_some_and(Vec::is_empty),
            "fork requires a root without descendants"
        );
        ensure!(
            captured["interrupted_thread_ids"]
                .as_array()
                .is_some_and(Vec::is_empty),
            "fork requires settled native history"
        );
        let mut metadata = crate::checkpoint::ForkMetadata::capture(&captured, source.id)?;
        source.check_fork_liveness().await?;
        let specs = source
            .thread
            .thread_extension_data()
            .get::<crate::python_tools::PythonTools>()
            .context("fork requires current managed tools")?
            .current_specs()?;
        let options: options::ThreadOptions = serde_json::from_value(serde_json::json!({
            "_managed_instructions": source.instructions.managed(),
            "instructions": source.instructions.text()?,
        }))?;
        let (mut startup, instructions) = self.build_startup(options).await?;
        if let Some(accepted) = source.instructions.accepted() {
            instructions.confirm(accepted)?;
        }
        let settings = source.thread.thread_settings_snapshot().await;
        startup.config.model = Some(settings.model);
        startup.config.model_reasoning_effort = settings.reasoning_effort;
        startup.config.model_reasoning_summary = settings.reasoning_summary;
        startup.config.service_tier = settings.service_tier;
        startup.config.mcp_servers.set(HashMap::new())?;
        let history = self.history(source.id).await?;
        startup.initial_history = history.clone();
        crate::python_tools::PythonTools::install(
            &mut startup,
            serde_json::from_value(specs)?,
            crate::python_tools::ToolInstallOptions {
                preserve_schemas: self.sentinel.read().expect("sentinel poisoned").is_some(),
                strict_functions: self.sdk_selected_model,
                allow_local_goals: false,
            },
        )?;
        source.check_fork_liveness().await?;
        let extension_events = self.extension_events.subscribe();
        let new = self
            .manager
            .fork_thread_from_history(ForkSnapshot::Interrupted, startup, history)
            .await?;
        // Register the exact Core-created ID and raw owner before wrap can fail.
        *source.fork_copy.lock().await = Some(ForkCopy {
            id: new.thread_id,
            thread: new.thread.clone(),
            wrapper: None,
            shutdown_complete: false,
            diagnostic: None,
            #[cfg(test)]
            test_failure: std::sync::atomic::AtomicU8::new(0),
        });
        // The exact raw cleanup receipt owns the copy before metadata changes.
        metadata.retarget(new.thread_id);
        if let Some(snapshot) = metadata.code_state() {
            self.interception
                .stage_code_state(new.thread_id, snapshot.clone());
        }
        #[cfg(test)]
        if source
            .fork_test_failure
            .compare_exchange(3, 0, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            source.discard_fork_copy(None).await?;
            anyhow::bail!(
                "injected failure before wrapping native fork {}",
                new.thread_id
            );
        }
        let mut native = match self.wrap(new, instructions, extension_events).await {
            Ok(native) => native,
            Err(error) => {
                return match source.discard_fork_copy(None).await {
                    Ok(_) => Err(error),
                    Err(cleanup) => {
                        Err(error.context(format!("fork wrapper cleanup failed: {cleanup}")))
                    }
                };
            }
        };
        source
            .fork_copy
            .lock()
            .await
            .as_mut()
            .expect("registered copy")
            .wrapper = Some(Arc::downgrade(&native.inner));
        let state = native.current()?;
        if self.interception.pending_code_state(state.id).is_some()
            && state
                .thread
                .config()
                .await
                .features
                .enabled(Feature::CodeMode)
            && let Err(error) = state.thread.prepare_code_mode_state().await
        {
            let error = anyhow::anyhow!(error);
            return match source.discard_fork_copy(None).await {
                Ok(_) => Err(error),
                Err(cleanup) => {
                    Err(error.context(format!("fork VM import cleanup failed: {cleanup}")))
                }
            };
        }
        if let (Some(original), Some(copied)) = (
            source
                .thread
                .thread_extension_data()
                .get::<crate::recovery_guard::Guard>(),
            native
                .current()?
                .thread
                .thread_extension_data()
                .get::<crate::recovery_guard::Guard>(),
        ) {
            copied.copy_origins_from(&original);
        }
        native.current()?.retain_metadata(metadata)?;
        native.fork_source = Some(Arc::downgrade(source));
        Ok(native)
    }

    fn discard_fork_receipt<'a>(
        &'a self,
        receipt: &'a Mutex<Option<ForkCopy>>,
        expected: Option<ThreadId>,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<Option<String>>> + Send + 'a>> {
        Box::pin(async move {
            let mut slot = receipt.lock().await;
            let Some(copy) = slot.as_mut() else {
                return Ok(None);
            };
            if expected.is_some_and(|id| id != copy.id) {
                return Ok(None);
            }
            #[cfg(test)]
            if copy
                .test_failure
                .compare_exchange(1, 0, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                anyhow::bail!("injected incomplete fork shutdown");
            }
            if !copy.shutdown_complete {
                let state = copy
                    .wrapper
                    .as_ref()
                    .and_then(Weak::upgrade)
                    .and_then(|owner| {
                        owner
                            .lock()
                            .expect("native thread owner poisoned")
                            .live
                            .clone()
                    });
                if let Some(state) = state {
                    // Every copy has an empty receipt of its own; the boxed
                    // discard future breaks the recursive close type.
                    copy.diagnostic = state.close_report().await?;
                } else {
                    copy.thread.shutdown_and_wait().await?;
                    self.manager
                        .remove_thread_if_matches(&copy.id, &copy.thread)
                        .await;
                }
                copy.shutdown_complete = true;
                self.interception.clear_code_state(copy.id);
                if let Some(owner) = copy.wrapper.as_ref().and_then(Weak::upgrade) {
                    owner
                        .lock()
                        .expect("native thread owner poisoned")
                        .release();
                }
            }
            if let Some(goals) = &self.goals {
                goals.state_db.delete_threads_strict(&[copy.id]).await?;
            }
            #[cfg(test)]
            if copy
                .test_failure
                .compare_exchange(2, 0, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                anyhow::bail!("injected incomplete fork deletion");
            }
            self.store
                .delete_thread(DeleteThreadParams { thread_id: copy.id })
                .await?;
            self.agent_graph.remove_checkpoint_edges(&[copy.id]).await;
            self.event_owners.lock().await.remove(&copy.id);
            self.restored_creation_times.lock().await.remove(&copy.id);
            self.managed_thread_ids.lock().await.remove(&copy.id);
            let diagnostic = copy.diagnostic.clone();
            slot.take();
            Ok(diagnostic)
        })
    }

    pub async fn read_stored_thread(&self, id: ThreadId) -> Result<StoredThread, ThreadStoreError> {
        let params = ReadThreadParams {
            thread_id: id,
            include_archived: true,
            include_history: false,
        };
        let mut stored = self.store.read_thread(params).await?;
        // Preserve the checkpoint's accepted birth time, or the actual local
        // writer's durable SessionMeta timestamp, across native reindexing.
        if let Some(created_at) = self.restored_creation_times.lock().await.get(&id) {
            stored.created_at = (*created_at).into();
        }
        Ok(stored)
    }

    pub(crate) async fn load_checkpoint_history(
        &self,
        id: ThreadId,
    ) -> Result<Vec<codex_history::RolloutItem>, ThreadStoreError> {
        if let Some(store) = &self.local_checklist_store {
            return store.load_owned_history(id).await;
        }
        Ok(self
            .store
            .load_history(LoadThreadHistoryParams {
                thread_id: id,
                include_archived: true,
            })
            .await?
            .items)
    }

    pub async fn history(&self, id: ThreadId) -> anyhow::Result<InitialHistory> {
        let stored = self.read_stored_thread(id).await?;
        let history = self
            .store
            .load_latest_model_context(LoadThreadHistoryParams {
                thread_id: stored.thread_id,
                include_archived: true,
            })
            .await?;
        Ok(InitialHistory::Resumed(ResumedHistory {
            conversation_id: stored.thread_id,
            history: Arc::new(history.items),
            history_revision: history.revision,
            rollout_path: stored.rollout_path,
        }))
    }

    pub async fn close(&self) -> anyhow::Result<()> {
        if let Some(diagnostic) = self.close_report().await? {
            anyhow::bail!(diagnostic);
        }
        Ok(())
    }

    pub(crate) async fn close_report(&self) -> anyhow::Result<Option<String>> {
        let _guard = self.lifecycle.lock().await;
        let _observations = self.manual_observations.write().await;
        self.close_locked().await
    }

    async fn close_locked(&self) -> anyhow::Result<Option<String>> {
        if self.closed.load(Ordering::Acquire) {
            return Ok(match &self.local_checklist_store {
                Some(store) => store
                    .check_failure(None)
                    .await
                    .err()
                    .map(|error| error.to_string()),
                None => None,
            });
        }
        // The registration retains the same raw receipt after the source owner
        // disappears. It never retains an SDK ThreadState or a strong wrapper.
        let receipts: Vec<_> = self
            .native_threads
            .lock()
            .expect("native threads poisoned")
            .iter()
            .map(|registration| registration.fork_copy.clone())
            .collect();
        let mut fork_diagnostics = Vec::new();
        for receipt in receipts {
            if let Some(diagnostic) = self.discard_fork_receipt(&receipt, None).await? {
                fork_diagnostics.push(diagnostic);
            }
        }
        let import_deadline = tokio::time::Instant::now() + CLOSE_TIMEOUT;
        let report = self
            .manager
            .shutdown_all_threads_bounded(CLOSE_TIMEOUT)
            .await;
        ensure!(
            report.timed_out.is_empty() && report.submit_failed.is_empty(),
            "Codex shutdown incomplete: {} timed out, {} failed",
            report.timed_out.len(),
            report.submit_failed.len()
        );
        if let Some(diagnostic) = self
            .interception
            .cleanup_code_imports(None, import_deadline)
            .await?
        {
            fork_diagnostics.push(diagnostic);
        }
        let diagnostic = if let Some(store) = &self.local_checklist_store {
            store.close_database().await?;
            store
                .check_failure(None)
                .await
                .err()
                .map(|error| error.to_string())
        } else {
            if let Some(goals) = &self.goals {
                goals.state_db.close().await;
            }
            None
        };
        if let Some(diagnostic) = diagnostic {
            fork_diagnostics.push(diagnostic);
        }
        self.closed.store(true, Ordering::Release);
        Ok((!fork_diagnostics.is_empty()).then(|| fork_diagnostics.join("; ")))
    }

    pub(crate) fn register_native_thread(
        &self,
        owner: &Arc<std::sync::Mutex<crate::NativeThreadOwner>>,
    ) {
        let fork_copy = owner
            .lock()
            .expect("native thread owner poisoned")
            .live
            .as_ref()
            .expect("new native thread is live")
            .fork_copy
            .clone();
        let mut threads = self.native_threads.lock().expect("native threads poisoned");
        // A vanished wrapper cannot discard a pending raw cleanup receipt.
        // Keep locked receipts too: another admitted cleanup owns their stage.
        threads.retain(|registration| {
            registration.owner.strong_count() != 0
                || registration
                    .fork_copy
                    .try_lock()
                    .map_or(true, |slot| slot.is_some())
        });
        threads.push(NativeThreadRegistration {
            owner: Arc::downgrade(owner),
            fork_copy,
        });
    }

    pub(crate) fn release_native_threads(&self) {
        for owner in self
            .native_threads
            .lock()
            .expect("native threads poisoned")
            .drain(..)
            .filter_map(|registration| registration.owner.upgrade())
        {
            owner
                .lock()
                .expect("native thread owner poisoned")
                .release();
        }
    }

    pub(crate) async fn build_startup(
        &self,
        options: options::ThreadOptions,
    ) -> anyhow::Result<(StartThreadOptions, Arc<options::ThreadInstructions>)> {
        self.interception.check_code_import_admission()?;
        ensure!(
            !self.closed.load(Ordering::Acquire),
            "Codex engine is closed"
        );
        let (mut startup, instructions) = options
            .build(
                &self.config_json,
                &self.runtime_json,
                self.cloud_config.clone(),
            )
            .await?;
        if let Some(settings) = &self.telemetry {
            settings.apply(&mut startup.config);
        }
        // Thread options reload the original config. Keep the proxy ceiling on
        // the final configuration as well as the engine's initial admission.
        if let Some(environment) = config::environment(&self.runtime_json)? {
            environment.restrict_network_approval(&mut startup.config)?;
            environment.check_config(&startup.config)?;
            if startup.environments.is_none() {
                let (selection, strict) = environment
                    .selection(
                        &startup.config,
                        &self.manager.environment_manager(),
                        self.local_storage_home(),
                    )
                    .await?;
                environment.configure_local_proxy(&mut startup.config, &selection)?;
                if let Some(strict) = strict {
                    startup.thread_extension_init.insert(strict);
                }
                startup.environments = Some(vec![selection]);
            } else {
                ensure!(
                    !environment.strict_writes(),
                    "strict executor policy cannot use raw environment overrides"
                );
            }
        }
        let config = &startup.config;
        let original = &self.service_config;
        if let Some(enabled) = self.sdk_user_input_enabled {
            ensure!(
                config.experimental_request_user_input_enabled == enabled,
                "SDK user-input policy belongs to the Codex client; create a separate client to change it"
            );
        }

        // Keep restored sessions bound to this engine’s current services.
        ensure!(
            config.experimental_thread_store == original.experimental_thread_store
                && config.sqlite_config() == original.sqlite_config()
                && config.model_catalog == original.model_catalog
                && config.model_provider_id == original.model_provider_id
                && config.model_provider == original.model_provider
                && [
                    Feature::ApiKeyModelDiscovery,
                    Feature::LocalThreadStoreCompression,
                    Feature::BackgroundPaginatedRolloutMigration,
                ]
                .into_iter()
                .all(|feature| config.features.enabled(feature)
                    == original.features.enabled(feature)),
            "Storage and model-discovery services belong to the Codex client; create a separate client to change them"
        );
        ensure!(
            config::code_mode_host_enabled(config) == config::code_mode_host_enabled(original),
            "Code Mode host selection belongs to the Codex client; create a separate client to change it"
        );
        if let Some((base, grant, excluded)) =
            self.sentinel.read().expect("sentinel poisoned").as_ref()
        {
            Self::prepare_sentinel(
                &mut startup.config,
                &self.manager.auth_manager(),
                base,
                grant,
                excluded.as_deref(),
            )?;
        }
        Ok((startup, instructions))
    }

    // Use the same native transformation for startup and for recognizing the
    // effective provider of this engine's entered media owner.
    pub(crate) fn prepare_sentinel(
        config: &mut Config,
        auth: &AuthManager,
        base: &str,
        grant: &str,
        excluded: Option<&str>,
    ) -> anyhow::Result<()> {
        for (id, info) in &mut config.model_providers {
            if !info.is_amazon_bedrock() {
                if !excluded.is_some_and(|base| info.base_url.as_deref() == Some(base)) {
                    let original = codex_model_provider::create_model_provider(info.clone(), None);
                    let provider = info.to_api_provider(auth.auth_mode())?;
                    let capabilities = original.capabilities();
                    info.include_internal_metadata = original.include_internal_metadata(&provider);
                    info.capabilities = Some(serde_json::from_value(serde_json::json!({
                        "remote_compaction": capabilities.remote_compaction,
                        "external_web_access": capabilities.external_web_access,
                    }))?);
                    info.base_url = Some(format!(
                        "{}/p-{}",
                        base.trim_end_matches('/'),
                        URL_SAFE_NO_PAD.encode(id.as_bytes())
                    ));
                    info.query_params = None;
                    // Only the private hop has no request retry budget.
                    // The original provider's native transport owns that
                    // budget, including mixed transport/HTTP failures.
                    info.request_max_retries = Some(0);
                }
                Self::set_sentinel_grant(&mut info.http_headers, &mut info.env_http_headers, grant);
            }
        }
        config.model_provider = config
            .model_providers
            .get(&config.model_provider_id)
            .context("sentinel selected entry")?
            .clone();
        Ok(())
    }

    pub(crate) fn set_sentinel_grant<H: From<String>>(
        http_headers: &mut Option<HashMap<String, H>>,
        env_http_headers: &mut Option<HashMap<String, String>>,
        grant: &str,
    ) {
        // Only the private transport grant may reach the sentinel. Native
        // header resolution is case-insensitive; env may override static.
        let headers = http_headers.get_or_insert_default();
        headers.retain(|name, _| !name.eq_ignore_ascii_case("x-sdk-sentinel-grant"));
        if let Some(headers) = env_http_headers {
            headers.retain(|name, _| !name.eq_ignore_ascii_case("x-sdk-sentinel-grant"));
        }
        headers.insert("x-sdk-sentinel-grant".to_owned(), grant.to_owned().into());
    }

    pub(crate) fn sentinel_route(
        &self,
        id: &str,
        headers: &str,
    ) -> napi::Result<Arc<crate::NativeModelRoute>> {
        let forwarded: Vec<(String, String)> =
            serde_json::from_str(headers).map_err(crate::native_error)?;
        let valid = self
            .sentinel
            .read()
            .expect("sentinel poisoned")
            .as_ref()
            .is_some_and(|(_, grant, _)| {
                forwarded
                    .iter()
                    .filter(|(name, _)| name.eq_ignore_ascii_case("x-sdk-sentinel-grant"))
                    .map(|(_, value)| value)
                    .eq(std::iter::once(grant))
            });
        if !valid {
            return Err(crate::native_error("Invalid sentinel transport grant"));
        }
        let info = self
            .service_config
            .model_providers
            .get(id)
            .ok_or_else(|| crate::native_error("Unknown sentinel entry"))?;
        if info.is_amazon_bedrock() {
            return Err(crate::native_error("Ineligible sentinel entry"));
        }
        let original = info
            .to_api_provider(self.manager.auth_manager().auth_mode())
            .map_err(crate::native_error)?;
        let mut builder = codex_http_client::HttpClientBuilder::new().without_request_logging();
        // Resolve redirect policy before narrowing original header declarations.
        let no_redirects = original
            .headers
            .contains_key(codex_model_provider::ACCOUNT_ROUTING_HEADER);
        if no_redirects {
            builder = builder.without_redirects();
        }
        let mut info = info.clone();
        info.base_url = Some(original.base_url);
        info.auth = None;
        info.env_key = None;
        info.experimental_bearer_token = None;
        info.requires_openai_auth = false;
        info.gateway_oauth = None;
        // Other headers and auth already belong to the inbound native
        // request. Restore the overwritten grant and stripped Host only from
        // this provider's original declarations, using native header/env resolution.
        if let Some(headers) = &mut info.http_headers {
            headers.retain(|name, _| {
                name.eq_ignore_ascii_case("x-sdk-sentinel-grant")
                    || name.eq_ignore_ascii_case("host")
            });
        }
        if let Some(headers) = &mut info.env_http_headers {
            headers.retain(|name, _| {
                name.eq_ignore_ascii_case("x-sdk-sentinel-grant")
                    || name.eq_ignore_ascii_case("host")
            });
        }
        let factory = self.service_config.http_client_factory().clone();
        let (transport, websocket) = self
            .sentinel_transports
            .lock()
            .expect("sentinel transports poisoned")
            .entry(no_redirects)
            .or_insert_with(|| {
                let pool = codex_http_client::RouteAwareClientPool::with_builder(
                    factory.clone(),
                    codex_http_client::ClientRouteClass::Api,
                    builder,
                );
                (
                    codex_http_client::ReqwestTransport::from_route_aware_client_pool(pool),
                    crate::model_websocket::ConnectorCache::default(),
                )
            })
            .clone();
        Ok(Arc::new(crate::NativeModelRoute {
            provider: codex_model_provider::create_model_provider(info, None),
            transport,
            websocket,
            client_factory: factory,
        }))
    }
}

// SDK unattended mode removes question capabilities before Core registers tools.
#[derive(Debug)]
struct ConfiguredModels {
    inner: SharedModelsManager,
    disable_user_input: bool,
}

impl ModelsManager for ConfiguredModels {
    fn set_api_key_model_discovery_enabled(&self, enabled: bool) {
        self.inner.set_api_key_model_discovery_enabled(enabled);
    }

    fn list_models(
        &self,
        strategy: RefreshStrategy,
        factory: HttpClientFactory,
    ) -> ModelsManagerFuture<'_, Vec<ModelPreset>> {
        self.inner.list_models(strategy, factory)
    }

    fn raw_model_catalog(
        &self,
        strategy: RefreshStrategy,
        factory: HttpClientFactory,
    ) -> ModelsManagerFuture<'_, ModelsResponse> {
        self.inner.raw_model_catalog(strategy, factory)
    }

    fn refresh_after_auth_change(&self, factory: HttpClientFactory) -> ModelsManagerFuture<'_, ()> {
        self.inner.refresh_after_auth_change(factory)
    }

    fn get_remote_models(&self) -> ModelsManagerFuture<'_, Vec<ModelInfo>> {
        self.inner.get_remote_models()
    }

    fn try_get_remote_models(&self) -> Result<Vec<ModelInfo>, tokio::sync::TryLockError> {
        self.inner.try_get_remote_models()
    }

    fn auth_manager(&self) -> Option<&AuthManager> {
        self.inner.auth_manager()
    }

    fn build_available_models(&self, models: Vec<ModelInfo>) -> Vec<ModelPreset> {
        self.inner.build_available_models(models)
    }

    fn list_collaboration_modes(&self) -> Vec<CollaborationModeMask> {
        self.inner.list_collaboration_modes()
    }

    fn try_list_models(&self) -> Result<Vec<ModelPreset>, tokio::sync::TryLockError> {
        self.inner.try_list_models()
    }

    fn get_default_model<'a>(
        &'a self,
        model: &'a Option<String>,
        allow_provider_model_fallback: bool,
        strategy: RefreshStrategy,
        factory: HttpClientFactory,
    ) -> ModelsManagerFuture<'a, String> {
        self.inner
            .get_default_model(model, allow_provider_model_fallback, strategy, factory)
    }

    fn get_model_info<'a>(
        &'a self,
        model: &'a str,
        config: &'a ModelsManagerConfig,
    ) -> ModelsManagerFuture<'a, ModelInfo> {
        Box::pin(async move {
            let mut info = self.inner.get_model_info(model, config).await;
            if self.disable_user_input {
                info.experimental_supported_tools.retain(|tool| {
                    !matches!(
                        tool.as_str(),
                        "request_user_input_async" | "send_user_message_async"
                    )
                });
            }
            info
        })
    }

    fn refresh_if_new_etag(
        &self,
        etag: String,
        factory: HttpClientFactory,
    ) -> ModelsManagerFuture<'_, ()> {
        self.inner.refresh_if_new_etag(etag, factory)
    }
}

pub struct ThreadState {
    pub id: ThreadId,
    pub thread: Arc<CodexThread>,
    pub engine: Arc<EngineState>,
    pub instructions: Arc<options::ThreadInstructions>,
    pub(crate) retained_metadata: OnceLock<crate::checkpoint::ForkMetadata>,
    events: Mutex<ThreadEvents>,
    publication_boundaries: mpsc::Sender<String>,
    pub mutations: Arc<Mutex<()>>,
    fork_copy: Arc<Mutex<Option<ForkCopy>>>,
    #[cfg(test)]
    fork_test_failure: std::sync::atomic::AtomicU8,
    closed: AtomicBool,
    close_lock: Mutex<()>,
    closing: watch::Sender<bool>,
    pub(crate) child_instances: RwLock<HashMap<ThreadId, crate::subagents::Instance>>,
    native_questions: std::sync::Mutex<HashMap<String, OwnedNativeQuestion>>,
    child_reader_retired: AtomicBool,
}

#[derive(Clone)]
struct CapturedQuestion {
    thread: Weak<CodexThread>,
    incarnation: Option<String>,
    turn_id: Option<String>,
    grant: Option<codex_core::OwnedQuestion>,
    url: Option<CapturedUrl>,
}

#[derive(Clone)]
struct CapturedUrl {
    server: String,
    request_id: codex_protocol::mcp::RequestId,
    _elicitation_id: String,
    // Root URLs can outlive the originating tool and turn. Their Core status
    // event, not a fabricated active-turn grant, owns completion.
    completed: Arc<std::sync::Mutex<Option<bool>>>,
    // 0: unanswered, 1: response in flight, 2: cancellation queued, 3: responded.
    response_state: Arc<std::sync::atomic::AtomicU8>,
}

#[derive(Clone)]
struct OwnedNativeQuestion {
    child: Option<(ThreadId, u64)>,
    captured: CapturedQuestion,
}

struct NativeThreadRegistration {
    owner: Weak<std::sync::Mutex<crate::NativeThreadOwner>>,
    fork_copy: Arc<Mutex<Option<ForkCopy>>>,
}

// Source and engine registration share one receipt. Raw Core ownership covers
// lost wrappers without a strong SDK state cycle; stages preserve cleanup retries.
struct ForkCopy {
    id: ThreadId,
    thread: Arc<CodexThread>,
    wrapper: Option<Weak<std::sync::Mutex<crate::NativeThreadOwner>>>,
    shutdown_complete: bool,
    diagnostic: Option<String>,
    #[cfg(test)]
    test_failure: std::sync::atomic::AtomicU8,
}

struct ThreadEvents {
    initial: Option<Event>,
    extensions: broadcast::Receiver<(String, Event)>,
    created: broadcast::Receiver<ThreadId>,
    graph: mpsc::UnboundedReceiver<crate::storage::GraphEvent>,
    // Like a child read, keep an already received native Error across other
    // select branches while its typed reporting receipt is being finalized.
    native: Option<NextNativeEvent>,
    // Question capture can suspend after dequeue. Keep it in a finite prefix.
    native_dequeued: Arc<AtomicBool>,
    // Retain the dequeued terminal across cancellation of a managed reader.
    session_terminal: Option<(Event, Arc<crate::turn_settlement::Turn>)>,
    children: VecDeque<(ThreadId, ChildReader)>,
    pending: VecDeque<((ThreadId, u64), Event)>,
    // Auxiliary selectors can arrive before the ordered child start event.
    // Keep their original receipt until that event publishes the original Turn.
    deferred_child_steps: VecDeque<serde_json::Value>,
    next_instance: u64,
    boundary_requests: mpsc::Receiver<String>,
    publication_prefix: Option<PublicationPrefix>,
}

enum ChildStepPublication {
    Ready,
    Deferred,
    Retired,
}

// Snapshot each owned source once. Later arrivals remain after the boundary;
// they must never extend opening by turning this into a drain-until-idle loop.
struct PublicationPrefix {
    id: String,
    native: usize,
    extensions: usize,
    children: HashMap<(ThreadId, u64), usize>,
    // A ready prefetched event need not retain its Core thread. Keep captured
    // child receivers alive until their finite prefixes have been delivered.
    _child_owners: Vec<Arc<CodexThread>>,
}

impl PublicationPrefix {
    fn complete(&self) -> bool {
        self.native == 0
            && self.extensions == 0
            && self.children.values().all(|remaining| *remaining == 0)
    }

    fn allows_child(&self, source: (ThreadId, u64)) -> bool {
        self.children
            .get(&source)
            .is_some_and(|remaining| *remaining > 0)
    }

    fn consume_child(&mut self, source: (ThreadId, u64)) -> anyhow::Result<()> {
        let remaining = self
            .children
            .get_mut(&source)
            .context("Native publication child source changed")?;
        ensure!(
            *remaining > 0,
            "Native publication child prefix was exhausted"
        );
        *remaining -= 1;
        Ok(())
    }
}

type NextEvent<T = Event> = Pin<Box<dyn Future<Output = codex_protocol::error::Result<T>> + Send>>;

struct ChildReader {
    thread: Weak<CodexThread>,
    next: Option<NextChildEvent>,
    // A retained child event can await its exact error receipt after Core dequeue.
    dequeued: Arc<AtomicBool>,
    instance: u64,
}

type NextNativeEvent = NextEvent<(Event, Option<CapturedQuestion>)>;

fn next_native_event(thread: Arc<CodexThread>, dequeued: Arc<AtomicBool>) -> NextNativeEvent {
    Box::pin(async move {
        let event = thread.next_event().await?;
        dequeued.store(true, Ordering::Release);
        let incarnation = thread_incarnation(&thread);
        let question = capture_question(&thread, incarnation, &event).await;
        let event = crate::response_control::ResponseControl::report_event(&thread, event).await;
        Ok((event, question))
    })
}

type NextChildEvent = NextEvent<(Event, Option<serde_json::Value>, Option<CapturedQuestion>)>;

fn thread_incarnation(thread: &CodexThread) -> Option<String> {
    thread
        .thread_extension_data()
        .get::<crate::native_interception::Control>()
        .map(|control| control.incarnation.clone())
}

async fn capture_question(
    thread: &Arc<CodexThread>,
    incarnation: Option<String>,
    event: &Event,
) -> Option<CapturedQuestion> {
    let (turn_id, url) = match &event.msg {
        EventMsg::ExecApprovalRequest(request) => (Some(request.turn_id.clone()), None),
        EventMsg::ApplyPatchApprovalRequest(request) => (Some(request.turn_id.clone()), None),
        EventMsg::ElicitationRequest(request) => {
            let url = match &request.request {
                codex_protocol::approvals::ElicitationRequest::Url { elicitation_id, .. } => {
                    Some(CapturedUrl {
                        server: request.server_name.clone(),
                        request_id: request.id.clone(),
                        _elicitation_id: elicitation_id.clone(),
                        completed: Arc::new(std::sync::Mutex::new(None)),
                        response_state: Arc::new(std::sync::atomic::AtomicU8::new(0)),
                    })
                }
                _ => None,
            };
            (request.turn_id.clone(), url)
        }
        _ => return None,
    };
    let grant = if turn_id.is_some() {
        thread.capture_owned_question(event).await
    } else {
        None
    };
    if grant.is_none()
        && !(turn_id.is_none()
            && url.is_some()
            && thread
                .thread_extension_data()
                .get::<crate::native_interception::Control>()
                .is_some_and(|control| control.is_root()))
    {
        return None;
    }
    Some(CapturedQuestion {
        thread: Arc::downgrade(thread),
        incarnation,
        turn_id,
        grant,
        url,
    })
}

fn question_ended(
    owner: Option<(ThreadId, u64)>,
    turn_id: Option<&str>,
    source: Option<(ThreadId, u64)>,
    event: &Event,
) -> bool {
    owner == source
        && match &event.msg {
            EventMsg::TurnComplete(done) => Some(done.turn_id.as_str()) == turn_id,
            EventMsg::TurnAborted(aborted) => {
                turn_id.is_some() && aborted.turn_id.as_deref() == turn_id
            }
            EventMsg::ShutdownComplete => true,
            _ => false,
        }
}

fn next_child_event(thread: Arc<CodexThread>, dequeued: Arc<AtomicBool>) -> NextChildEvent {
    let native = next_native_event(thread.clone(), dequeued);
    Box::pin(async move {
        let (event, question) = native.await?;
        let mut terminal_error = None;
        if let EventMsg::TurnComplete(done) = &event.msg
            && done.turn_id == event.id
            && let Some(error) = &done.error
        {
            let receipt = thread
                .thread_extension_data()
                .get::<crate::turn_settlement::Settlement>()
                .and_then(|settlement| settlement.observed(&done.turn_id));
            // Retain this exact receipt across native completion. A newer turn
            // can close it, but cannot supply its metadata to this old event.
            if let Some(receipt) = receipt
                && receipt.wait().await.is_ok()
            {
                terminal_error = Some(receipt.error_json(error));
            }
        }
        Ok((event, terminal_error, question))
    })
}

async fn prefetch_event<T: Send + 'static>(
    next: &mut Option<NextEvent<T>>,
    dequeued: Option<&AtomicBool>,
) -> anyhow::Result<bool> {
    let reader = next
        .as_mut()
        .context("Native publication event reader closed")?;
    // One nonwaiting poll retains an already ready event or EOF/error. It is
    // not an idle drain, and creates no additional Core event consumer.
    let ready = poll_fn(|cx| Poll::Ready(reader.as_mut().poll(cx))).await;
    let ready = if let Poll::Ready(event) = ready {
        *next = Some(Box::pin(std::future::ready(event)));
        true
    } else {
        false
    };
    // This poll may dequeue a child event and then suspend on its metadata.
    // Count it once without replacing that still-pending retained future.
    Ok(ready || dequeued.is_some_and(|dequeued| dequeued.load(Ordering::Acquire)))
}

async fn snapshot_event_prefix<T: Send + 'static>(
    thread: &CodexThread,
    next: &mut Option<NextEvent<T>>,
    dequeued: Option<&AtomicBool>,
) -> anyhow::Result<usize> {
    let prefetched = prefetch_event(next, dequeued).await?;
    thread
        .queued_event_count()
        .checked_add(usize::from(prefetched))
        .context("Native publication event prefix overflow")
}

async fn read_child(
    children: &mut VecDeque<(ThreadId, ChildReader)>,
    prefix: Option<&PublicationPrefix>,
) -> (
    (ThreadId, u64),
    Event,
    Option<serde_json::Value>,
    Option<CapturedQuestion>,
) {
    let (id, result) = poll_fn(|cx| {
        // Put each reader at the back before yielding so a busy child cannot starve siblings.
        for _ in 0..children.len() {
            let (id, mut reader) = children.pop_front().expect("child reader exists");
            let event = if prefix.is_none_or(|prefix| prefix.allows_child((id, reader.instance))) {
                reader.next.as_mut().map(|next| next.as_mut().poll(cx))
            } else {
                None
            };
            children.push_back((id, reader));
            if let Some(Poll::Ready(event)) = event {
                return Poll::Ready((id, event));
            }
        }
        Poll::Pending
    })
    .await;
    let (event, terminal_error, question) = result.unwrap_or_else(|_| {
        (
            Event {
                id: String::new(),
                msg: EventMsg::ShutdownComplete,
            },
            None,
            None,
        )
    });
    let reader = &mut children.back_mut().expect("child reader exists").1;
    reader.dequeued.store(false, Ordering::Release);
    reader.next = if matches!(event.msg, EventMsg::ShutdownComplete) {
        None
    } else {
        reader
            .thread
            .upgrade()
            .map(|thread| next_child_event(thread, reader.dequeued.clone()))
    };
    ((id, reader.instance), event, terminal_error, question)
}

fn native_event(
    source: Option<(ThreadId, u64)>,
    event: Event,
) -> anyhow::Result<serde_json::Value> {
    let mut value = serde_json::to_value(&event)?;
    crate::usage::event_to_wire(&mut value["msg"])?;
    if let Some((id, instance)) = source {
        value["subagent_id"] = serde_json::json!(id);
        value["subagent_instance_id"] = serde_json::json!(instance);
    }
    if let EventMsg::Error(error) = &event.msg {
        value["error_affects_turn_status"] = serde_json::json!(error.affects_turn_status());
    }
    Ok(value)
}

fn graph_event(event: crate::storage::GraphEvent) -> anyhow::Result<serde_json::Value> {
    let mut message = serde_json::to_value(event)?;
    message["type"] = serde_json::json!("sdk_subagent_lifecycle");
    Ok(serde_json::json!({"id": "", "msg": message}))
}

impl ThreadState {
    fn question_owner_current(&self, question: &OwnedNativeQuestion) -> bool {
        if *self.closing.borrow() || self.closed.load(Ordering::Acquire) {
            return false;
        }
        let owner = match question.child {
            None => Weak::ptr_eq(&question.captured.thread, &Arc::downgrade(&self.thread)),
            Some((child, instance)) => {
                !self.child_events_retired()
                    && self.child_instances.read().ok().is_some_and(|instances| {
                        instances.get(&child).is_some_and(|current| {
                            current.id == instance
                                && Weak::ptr_eq(&current.thread, &question.captured.thread)
                        })
                    })
            }
        };
        owner
            && question
                .captured
                .thread
                .upgrade()
                .is_some_and(|thread| thread_incarnation(&thread) == question.captured.incarnation)
    }

    fn attach_question(
        &self,
        event: &mut serde_json::Value,
        child: Option<(ThreadId, u64)>,
        captured: Option<CapturedQuestion>,
    ) {
        let Some(captured) = captured else {
            return;
        };
        let question = OwnedNativeQuestion { child, captured };
        let mut questions = self
            .native_questions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.question_owner_current(&question) {
            let id = ThreadId::new().to_string();
            questions.insert(id.clone(), question);
            event["msg"]["_sdk_question_id"] = serde_json::json!(id);
        }
    }

    fn root_event(
        &self,
        event: Event,
        question: Option<CapturedQuestion>,
    ) -> anyhow::Result<serde_json::Value> {
        self.retire_questions_for_event(None, &event);
        let mut value = native_event(None, event)?;
        self.attach_question(&mut value, None, question);
        Ok(value)
    }

    fn retire_questions_for_event(&self, source: Option<(ThreadId, u64)>, event: &Event) {
        let mut questions = self
            .native_questions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Preserve the exact source as well as the opaque RPC token. The public
        // elicitation ID is metadata, never consent authority.
        if let EventMsg::ElicitationStatus {
            server_name,
            request_id,
            completed,
        } = &event.msg
        {
            questions.retain(|_, question| {
                if question.child == source
                    && self.question_owner_current(question)
                    && let Some(url) = &question.captured.url
                    && matches!(&url.request_id, codex_protocol::mcp::RequestId::String(id) if id == request_id)
                    && url.server == *server_name
                {
                    let mut status = url.completed.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                    if status.is_none() { *status = Some(*completed); }
                    // Expiry has no success receipt to retain. A previously
                    // captured success still wins a later retirement notice.
                    return *status != Some(false);
                }
                true
            });
            return;
        }
        if !matches!(
            event.msg,
            EventMsg::TurnComplete(_) | EventMsg::TurnAborted(_) | EventMsg::ShutdownComplete
        ) {
            return;
        }
        questions.retain(|_, question| {
            // URL completion receipts survive consent and ordinary turn end.
            if question.captured.url.is_some() && !matches!(event.msg, EventMsg::ShutdownComplete) {
                return true;
            }
            !question_ended(
                question.child,
                question.captured.turn_id.as_deref(),
                source,
                event,
            )
        });
    }

    fn captured_question(&self, id: &str) -> Option<OwnedNativeQuestion> {
        self.native_questions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(id)
            .cloned()
    }

    pub(crate) async fn native_question_pending(&self, id: &str) -> bool {
        let Some(question) = self.captured_question(id) else {
            return false;
        };
        let pending = self.question_owner_current(&question)
            && match &question.captured.grant {
                Some(grant) => grant.is_pending().await,
                None => self.native_url_pending(id).await,
            };
        if !pending && question.captured.url.is_none() {
            self.native_questions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(id);
        }
        pending
    }

    pub(crate) async fn native_url_pending(&self, id: &str) -> bool {
        let Some(question) = self.captured_question(id) else {
            return false;
        };
        let Some(url) = &question.captured.url else {
            return false;
        };
        if !self.question_owner_current(&question) {
            return false;
        }
        if let Some(grant) = &question.captured.grant {
            return grant.is_pending().await;
        }
        url.response_state.load(Ordering::Acquire) == 0
            && match &url.request_id {
                codex_protocol::mcp::RequestId::String(token) => {
                    self.thread.is_elicitation_pending(&url.server, token)
                }
                _ => false,
            }
    }

    pub(crate) async fn native_url_completion_status(&self, id: &str) -> Option<bool> {
        let Some(question) = self.captured_question(id) else {
            return Some(false);
        };
        let Some(url) = &question.captured.url else {
            return Some(false);
        };
        let status = match &question.captured.grant {
            Some(grant) => grant.url_completion_status().await,
            None => *url
                .completed
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        };
        // A terminal success from the original receipt wins admission retirement.
        let status = if status != Some(true) && !self.question_owner_current(&question) {
            Some(false)
        } else {
            status
        };
        // A terminal completion may precede consent. Do not consume the
        // original unanswered RPC merely because completion was observed.
        if status.is_some()
            && url.response_state.load(Ordering::Acquire) != 1
            && !self.native_url_pending(id).await
        {
            self.native_questions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(id);
        }
        status
    }

    pub(crate) async fn cancel_native_url_completion(&self, id: &str) -> anyhow::Result<bool> {
        let Some(question) = self.captured_question(id) else {
            return Ok(false);
        };
        let Some(url) = &question.captured.url else {
            return Ok(false);
        };
        if let Some(grant) = &question.captured.grant {
            let cancelled = grant.cancel_url_completion().await;
            // Completion may have won cancellation under Core's original
            // admission. Keep that success until the helper observes it.
            if !cancelled && grant.url_completion_status().await == Some(true) {
                return Ok(false);
            }
            self.native_questions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(id);
            return Ok(cancelled);
        }
        let completed = *url
            .completed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if completed == Some(true) {
            return Ok(false);
        }
        if !self.question_owner_current(&question) || completed == Some(false) {
            self.native_questions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(id);
            return Ok(false);
        }
        // Negative-only retirement also covers URL-required errors without a
        // positive RPC responder. Await this exact native submission.
        if url.response_state.swap(2, Ordering::AcqRel) == 2 {
            return Ok(false);
        }
        let result = self
            .thread
            .submit(codex_protocol::protocol::Op::ResolveElicitation {
                server_name: url.server.clone(),
                request_id: url.request_id.clone(),
                decision: codex_protocol::approvals::ElicitationAction::Cancel,
                content: None,
                meta: None,
            })
            .await;
        // A timeout helper may detach its probe after joining this operation.
        // Release its exact SDK handle even when native submission failed,
        // while returning that original failure unchanged.
        if *url
            .completed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            != Some(true)
        {
            self.native_questions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(id);
        }
        result?;
        Ok(true)
    }

    pub(crate) async fn respond_owned_native_question(
        &self,
        id: &str,
        response_json: &str,
    ) -> anyhow::Result<bool> {
        let Some(question) = self.captured_question(id) else {
            return Ok(false);
        };
        let response = if question.captured.url.is_some() {
            crate::ops::native_url_question_response(response_json)?
        } else {
            ensure!(
                !crate::ops::native_question_is_url_consent(response_json)?,
                "URL consent requires a captured URL"
            );
            crate::ops::native_question_response(response_json)?
        };
        if let Some(url) = &question.captured.url {
            ensure!(
                matches!(&response, codex_protocol::protocol::Op::ResolveElicitation { server_name, request_id, .. }
                if server_name == &url.server && request_id == &url.request_id),
                "URL response identity changed"
            );
        }
        let current = self.question_owner_current(&question);
        let accepted = if let Some(grant) = &question.captured.grant {
            if let Some(url) = &question.captured.url {
                if !current
                    || url
                        .response_state
                        .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
                        .is_err()
                {
                    return Ok(false);
                }
                let accepted = grant.respond(response).await;
                let _ = url.response_state.compare_exchange(
                    1,
                    if accepted { 3 } else { 0 },
                    Ordering::AcqRel,
                    Ordering::Acquire,
                );
                accepted
            } else {
                current && grant.respond(response).await
            }
        } else if current
            && (!crate::ops::native_question_is_url_consent(response_json)?
                || self.native_url_pending(id).await)
        {
            let url = question.captured.url.as_ref().expect("root URL capture");
            if url
                .response_state
                .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
            {
                return Ok(false);
            }
            self.thread.submit(response).await?;
            let _ = url
                .response_state
                .compare_exchange(1, 3, Ordering::AcqRel, Ordering::Acquire);
            true
        } else {
            false
        };
        if question.captured.url.is_none()
            && (accepted || !current || !self.native_question_pending(id).await)
        {
            self.native_questions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(id);
        }
        Ok(accepted)
    }

    pub(crate) fn request_publication_boundary(&self, id: String) -> anyhow::Result<()> {
        ensure!(!self.is_closed(), "Codex thread is closed");
        self.publication_boundaries
            .try_send(id)
            .map_err(|_| anyhow::anyhow!("Native publication boundary unavailable"))
    }

    async fn start_publication_prefix(
        &self,
        events: &mut ThreadEvents,
        id: String,
    ) -> anyhow::Result<()> {
        self.discover_children(events).await?;
        // Retained reads can await question capture or error metadata after
        // dequeue. Their witnesses keep those events in this finite prefix.
        // The mutex excludes other root/child polls.
        let native_dequeued = events.native_dequeued.clone();
        let native =
            snapshot_event_prefix(&self.thread, &mut events.native, Some(&native_dequeued)).await?;
        let mut children = HashMap::new();
        let mut child_owners = Vec::new();
        for (id, reader) in &mut events.children {
            if reader.next.is_none() {
                continue;
            }
            let thread = reader
                .thread
                .upgrade()
                .context("Native publication child owner closed")?;
            let remaining =
                snapshot_event_prefix(&thread, &mut reader.next, Some(reader.dequeued.as_ref()))
                    .await?;
            children.insert((*id, reader.instance), remaining);
            child_owners.push(thread);
        }
        events.publication_prefix = Some(PublicationPrefix {
            id,
            native,
            extensions: events.extensions.len(),
            children,
            _child_owners: child_owners,
        });
        Ok(())
    }

    pub(crate) fn retain_metadata(
        &self,
        metadata: crate::checkpoint::ForkMetadata,
    ) -> anyhow::Result<()> {
        metadata.validate_identity(self.id)?;
        self.retained_metadata
            .set(metadata)
            .map_err(|_| anyhow::anyhow!("retained metadata is already initialized"))
    }

    pub(crate) fn has_pending_fork_copy(&self) -> bool {
        self.fork_copy
            .try_lock()
            .map_or(true, |slot| slot.is_some())
    }

    async fn check_fork_liveness(&self) -> anyhow::Result<()> {
        ensure!(
            !self.closed.load(Ordering::Acquire),
            "Codex thread is closed"
        );
        ensure!(
            crate::subagents::list(self).await?.is_empty(),
            "fork requires a root without descendants"
        );
        ensure!(
            self.thread.list_background_terminals().await.is_empty(),
            "fork requires settled background terminals"
        );
        if let Some(control) = self
            .thread
            .thread_extension_data()
            .get::<crate::native_interception::Control>()
        {
            ensure!(
                !control.has_unsettled_code_cells(),
                "fork requires settled native code cells"
            );
        }
        Ok(())
    }

    pub(crate) fn discard_fork_copy(
        &self,
        expected: Option<ThreadId>,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<Option<String>>> + Send + '_>> {
        self.engine.discard_fork_receipt(&self.fork_copy, expected)
    }

    pub(crate) fn is_closed(&self) -> bool {
        *self.closing.borrow() || self.closed.load(Ordering::Acquire)
    }

    async fn claim_subtree(&self) -> anyhow::Result<Vec<ThreadId>> {
        let ids = self
            .engine
            .manager
            .list_agent_subtree_thread_ids(self.id)
            .await?;
        let mut owners = self.engine.event_owners.lock().await;
        ensure!(
            ids.iter()
                .all(|id| owners.get(id).is_none_or(|owner| *owner == self.id)),
            "Overlapping SDK sessions cannot consume the same subagent events"
        );
        for id in &ids {
            owners.insert(*id, self.id);
        }
        Ok(ids)
    }

    async fn discover_children(&self, events: &mut ThreadEvents) -> anyhow::Result<()> {
        for id in self.claim_subtree().await? {
            if id == self.id {
                continue;
            }
            let Ok(thread) = self.engine.manager.get_thread(id).await else {
                continue;
            };
            // An evicted child may be loaded again under the same durable thread ID.
            let previous = events
                .children
                .iter_mut()
                .find(|(child_id, _)| *child_id == id);
            if previous
                .as_ref()
                .is_some_and(|(_, reader)| Weak::ptr_eq(&reader.thread, &Arc::downgrade(&thread)))
            {
                continue;
            }
            events.next_instance += 1;
            let dequeued = Arc::new(AtomicBool::new(false));
            let reader = ChildReader {
                next: Some(next_child_event(thread.clone(), dequeued.clone())),
                dequeued,
                thread: Arc::downgrade(&thread),
                instance: events.next_instance,
            };
            self.child_instances
                .write()
                .map_err(|_| anyhow::anyhow!("Subagent state unavailable"))?
                .insert(
                    id,
                    crate::subagents::Instance {
                        id: reader.instance,
                        thread: Arc::downgrade(&thread),
                        turn: None,
                        usage: None,
                        blank_final: None,
                        last_blank: false,
                        submitted: HashMap::new(),
                        during_submission: None,
                    },
                )
                .inspect(|previous| previous.retire());
            if let Some((_, previous)) = previous {
                events.pending.push_back((
                    (id, previous.instance),
                    Event {
                        id: String::new(),
                        msg: EventMsg::ShutdownComplete,
                    },
                ));
                *previous = reader;
            } else {
                events.children.push_back((id, reader));
            }
        }
        Ok(())
    }

    fn child_event(
        self: &Arc<Self>,
        source: (ThreadId, u64),
        event: Event,
        terminal_error: Option<serde_json::Value>,
        question: Option<CapturedQuestion>,
    ) -> anyhow::Result<serde_json::Value> {
        self.retire_questions_for_event(Some(source), &event);
        let mut retained_error = None;
        let mut incarnation = None;
        let mut turn_failed = None;
        let mut managed_tools = false;
        if let Some(instance) = self
            .child_instances
            .write()
            .map_err(|_| anyhow::anyhow!("Native child state unavailable"))?
            .get_mut(&source.0)
        {
            if instance.id == source.1 && !self.child_events_retired() {
                incarnation = instance
                    .thread
                    .upgrade()
                    .and_then(|thread| {
                        if let Some(settlement) = thread
                            .thread_extension_data()
                            .get::<crate::turn_settlement::Settlement>()
                        {
                            settlement.delivered(&event.msg);
                        }
                        managed_tools = thread
                            .thread_extension_data()
                            .get::<crate::python_tools::PythonTools>()
                            .is_some();
                        thread
                            .thread_extension_data()
                            .get::<crate::native_interception::Control>()
                    })
                    .map(|control| control.incarnation.clone());
                turn_failed = instance.observe(self, source.0, &event, terminal_error.as_ref());
                retained_error = terminal_error;
            }
        }
        let mut value = native_event(Some(source), event)?;
        self.attach_question(&mut value, Some(source), question);
        if let Some(error) = retained_error {
            value["msg"]["error"] = error;
        }
        if let Some(incarnation) = incarnation {
            value["subagent_incarnation"] = serde_json::json!(incarnation);
            value["subagent_managed_tools"] = serde_json::json!(managed_tools);
        }
        if let Some(failed) = turn_failed {
            value["subagent_turn_failed"] = serde_json::json!(failed);
        }
        Ok(value)
    }

    pub(crate) fn child_events_retired(&self) -> bool {
        self.child_reader_retired.load(Ordering::Acquire)
    }

    // Receipts are scoped to this state and event owner, even if its durable
    // thread ID is restored elsewhere. Do not revoke or close the runtime:
    // existing suspension, compaction and shutdown code owns that lifecycle.
    pub(crate) fn finish_child_event_reader(&self) -> anyhow::Result<()> {
        let instances = self
            .child_instances
            .read()
            .map_err(|_| anyhow::anyhow!("Native child state unavailable"))?;
        self.child_reader_retired.store(true, Ordering::Release);
        for instance in instances.values() {
            instance.retire();
        }
        drop(instances);
        self.native_questions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|_, question| question.child.is_none());
        Ok(())
    }

    fn child_step_publication(
        &self,
        request: &serde_json::Value,
        tools: &Arc<crate::python_tools::PythonTools>,
    ) -> anyhow::Result<ChildStepPublication> {
        let Some(child) = request["subagent_id"].as_str() else {
            return Ok(ChildStepPublication::Ready);
        };
        if request["msg"]["type"] != "_sdk_select_step" {
            return Ok(ChildStepPublication::Ready);
        }
        if self.child_events_retired() {
            return Ok(ChildStepPublication::Retired);
        }
        let thread = request["msg"]["thread"]
            .as_str()
            .context("Child step thread missing")?;
        ensure!(thread == child, "Child step thread differs from its owner");
        let incarnation = request["subagent_incarnation"]
            .as_str()
            .context("Child step incarnation missing")?;
        let response =
            serde_json::from_value::<crate::python_tools::StepReply>(serde_json::json!({
                "thread": thread,
                "instance": incarnation,
                "turn_id": request["msg"]["turn_id"],
                "generation": request["msg"]["generation"],
                "request_id": request["msg"]["request_id"],
            }))?;
        let Some(owner) =
            tools.exact_owner(&self.id.to_string(), thread, &Some(incarnation.to_owned()))
        else {
            return Ok(ChildStepPublication::Retired);
        };
        if !owner.check_step(thread, &response)? {
            return Ok(ChildStepPublication::Retired);
        }
        let child = ThreadId::from_string(thread)?;
        let instances = self
            .child_instances
            .read()
            .map_err(|_| anyhow::anyhow!("Native child state unavailable"))?;
        let observed = instances
            .get(&child)
            .and_then(|instance| instance.turn.as_ref());
        Ok(
            if observed.is_some_and(|turn| {
                turn.incarnation == incarnation
                    && request["msg"]["turn_id"].as_str() == Some(turn.turn_id.as_str())
            }) {
                ChildStepPublication::Ready
            } else {
                ChildStepPublication::Deferred
            },
        )
    }

    pub async fn next_session_event(self: &Arc<Self>) -> anyhow::Result<serde_json::Value> {
        let python_tools = self
            .thread
            .thread_extension_data()
            .get::<crate::python_tools::PythonTools>();
        let mut closing = self.closing.subscribe();
        ensure!(!*closing.borrow(), "Codex thread is closed");
        let mut events = self.events.lock().await;
        ensure!(!*closing.borrow(), "Codex thread is closed");
        if let Some(event) = events.initial.take() {
            return self.root_event(event, None);
        }
        loop {
            if let Some((event, turn)) = &events.session_terminal {
                tokio::select! {
                    _ = closing.changed() => anyhow::bail!("Codex thread is closed"),
                    result = turn.wait() => result?,
                }
                if matches!(&event.msg, EventMsg::TurnComplete(done) if done.error.is_none())
                    && let Some(store) = &self.engine.local_checklist_store
                {
                    store.check_failure(Some(self.id)).await?;
                    ensure!(!*closing.borrow(), "Codex thread is closed");
                }
                let (event, turn) = events.session_terminal.take().expect("retained terminal");
                if let Some(settlement) = self
                    .thread
                    .thread_extension_data()
                    .get::<crate::turn_settlement::Settlement>()
                {
                    settlement.delivered(&event.msg);
                }
                let mut event = self.root_event(event, None)?;
                turn.attach_provider_error(&mut event);
                if let Some(unsampled) = turn.unsampled_steering() {
                    event["sdk_unsampled_steering"] = serde_json::Value::Bool(unsampled);
                }
                return Ok(event);
            }
            // A busy graph producer must not postpone capturing a requested
            // prefix. The select below wakes this same sole reader when idle.
            if events.publication_prefix.is_none()
                && let Ok(id) = events.boundary_requests.try_recv()
            {
                self.start_publication_prefix(&mut events, id).await?;
            }
            // Seed restored descendants and deliver queued graph changes before child completions.
            if events.publication_prefix.is_none()
                && let Ok(event) = events.graph.try_recv()
            {
                self.discover_children(&mut events).await?;
                return graph_event(event);
            }
            if let Some((source, event)) = events.pending.pop_front() {
                return self.child_event(source, event, None, None);
            }
            if let Some(prefix) = &events.publication_prefix {
                ensure!(
                    prefix.children.iter().all(|(source, remaining)| {
                        *remaining == 0
                            || events.children.iter().any(|(id, reader)| {
                                (*id, reader.instance) == *source && reader.next.is_some()
                            })
                    }),
                    "Native publication child reader changed"
                );
                if prefix.complete() {
                    ensure!(!*closing.borrow(), "Codex thread is closed");
                    let prefix = events.publication_prefix.take().expect("checked prefix");
                    return Ok(serde_json::json!({
                        "id": prefix.id,
                        "msg": {"type": "sdk_mcp_publication_boundary"}
                    }));
                }
            }
            if events.publication_prefix.is_none() {
                // Inspect one finite queue snapshot. A waiting child must not
                // block another ready child, and revoked receipts are discarded.
                for _ in 0..events.deferred_child_steps.len() {
                    let request = events
                        .deferred_child_steps
                        .pop_front()
                        .expect("queued step");
                    match self.child_step_publication(
                        &request,
                        python_tools.as_ref().context("Child step owner missing")?,
                    )? {
                        ChildStepPublication::Ready => return Ok(request),
                        ChildStepPublication::Deferred => {
                            events.deferred_child_steps.push_back(request)
                        }
                        ChildStepPublication::Retired => {}
                    }
                }
            }
            let ThreadEvents {
                extensions,
                created,
                graph,
                children,
                native,
                boundary_requests,
                publication_prefix,
                ..
            } = &mut *events;
            let bounded = publication_prefix.is_some();
            let read_native = publication_prefix
                .as_ref()
                .is_none_or(|prefix| prefix.native > 0);
            let read_extensions = publication_prefix
                .as_ref()
                .is_none_or(|prefix| prefix.extensions > 0);
            tokio::select! {
                _ = closing.changed() => anyhow::bail!("Codex thread is closed"),
                request = async {
                    python_tools.as_ref().expect("guarded JavaScript channel").next_request().await
                }, if python_tools.is_some() && !bounded => {
                    match self.child_step_publication(
                        &request,
                        python_tools.as_ref().expect("guarded JavaScript channel"),
                    )? {
                        ChildStepPublication::Ready => return Ok(request),
                        ChildStepPublication::Deferred => events.deferred_child_steps.push_back(request),
                        ChildStepPublication::Retired => {}
                    }
                },
                Some(id) = boundary_requests.recv(), if !bounded => {
                    self.start_publication_prefix(&mut events, id).await?;
                },
                event = async { native.as_mut().expect("guarded native reader").await }, if native.is_some() && read_native => {
                    if let Some(prefix) = &mut events.publication_prefix {
                        prefix.native = prefix.native.checked_sub(1)
                            .context("Native publication root prefix was exhausted")?;
                    }
                    events.native_dequeued.store(false, Ordering::Release);
                    events.native = Some(next_native_event(self.thread.clone(), events.native_dequeued.clone()));
                    let (event, question) = event?;
                    if let Some(tools) = &python_tools {
                        tools.observe_manual_event(&event);
                    }
                    if let EventMsg::TurnComplete(done) = &event.msg {
                        ensure!(done.turn_id == event.id, "Native completion turn identity differs");
                        let settlement = self.thread.thread_extension_data()
                            .get::<crate::turn_settlement::Settlement>()
                            .context("Native turn admission receipt missing")?;
                        if let Some(turn) = settlement.admission_ready(&done.turn_id)? {
                            events.session_terminal = Some((event, turn));
                            continue;
                        }
                        if done.error.is_none()
                            && let Some(store) = &self.engine.local_checklist_store
                        {
                            store.check_failure(Some(self.id)).await?;
                            ensure!(!*closing.borrow(), "Codex thread is closed");
                        }
                        return self.root_event(event, None);
                    }
                    if let Some(settlement) = self.thread.thread_extension_data()
                        .get::<crate::turn_settlement::Settlement>() {
                        settlement.delivered(&event.msg);
                    }
                    return self.root_event(event, question);
                },
                (source, event, error, question) = read_child(children, publication_prefix.as_ref()) => {
                    if let Some(prefix) = &mut events.publication_prefix {
                        prefix.consume_child(source)?;
                    }
                    return self.child_event(source, event, error, question);
                },
                Some(event) = graph.recv(), if !bounded => {
                    self.discover_children(&mut events).await?;
                    return graph_event(event);
                },
                notification = created.recv(), if !bounded => {
                    match notification {
                        Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {
                            self.discover_children(&mut events).await?;
                        }
                        Err(broadcast::error::RecvError::Closed) => anyhow::bail!("Thread discovery closed"),
                    }
                }
                event = extensions.recv(), if read_extensions => {
                    if let Some(prefix) = &mut events.publication_prefix {
                        prefix.extensions = prefix.extensions.checked_sub(1)
                            .context("Native publication extension prefix was exhausted")?;
                    }
                    let (target, event) = event?;
                    if target.is_empty() || target == self.id.to_string() {
                        return self.root_event(event, None);
                    }
                    if let Ok(id) = ThreadId::from_string(&target) {
                        if !events.children.iter().any(|(child_id, _)| *child_id == id) {
                            self.discover_children(&mut events).await?;
                        }
                        if let Some((_, reader)) = events.children.iter().find(|(child_id, _)| *child_id == id) {
                            let source = (id, reader.instance);
                            events.pending.push_back((source, event));
                        }
                    }
                }
            }
        }
    }

    pub async fn close(&self) -> anyhow::Result<()> {
        if let Some(diagnostic) = self.close_report().await? {
            anyhow::bail!(diagnostic);
        }
        Ok(())
    }

    pub(crate) async fn close_report(&self) -> anyhow::Result<Option<String>> {
        self.close_owned(false).await
    }

    pub(crate) async fn close_selected_environment(&self) -> anyhow::Result<Option<String>> {
        self.close_owned(true).await
    }

    async fn close_owned(&self, selected_environment: bool) -> anyhow::Result<Option<String>> {
        let _guard = self.close_lock.lock().await;
        // Raw close still retires admission before waiting for any mutation.
        // Selected close needs the live receipt to settle before listing terminals.
        if !selected_environment
            && let Some(settlement) = self
                .thread
                .thread_extension_data()
                .get::<crate::turn_settlement::Settlement>()
        {
            settlement.retire();
        }
        if let Some(control) = self
            .thread
            .thread_extension_data()
            .get::<crate::mcp_result_control::McpResultControl>()
        {
            control.revoke();
        }
        let _mutation = self.mutations.lock().await;
        let already_closed = self.closed.load(Ordering::Acquire);
        let fork_diagnostic = if already_closed {
            None
        } else {
            self.discard_fork_copy(None).await?
        };
        // Suspension stops execution but leaves its final events readable.
        // Explicit close must revoke that reader even after Core has stopped.
        self.closing.send_replace(true);
        self.finish_child_event_reader()?;
        self.native_questions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        {
            let mut events = self.events.lock().await;
            events.native = None;
            events.session_terminal = None;
            events.publication_prefix = None;
            events.boundary_requests.close();
            events.children.clear();
            events.deferred_child_steps.clear();
            events.graph.close();
        }
        if already_closed {
            return Ok(match &self.engine.local_checklist_store {
                Some(store) => store
                    .check_failure(Some(self.id))
                    .await
                    .err()
                    .map(|error| error.to_string()),
                None => None,
            });
        }
        let mut shutdown_deadline = tokio::time::Instant::now() + CLOSE_TIMEOUT;
        let mut ack_remaining = CLOSE_TIMEOUT;
        let mut ack_error = fork_diagnostic;
        let mut import_diagnostic = None;
        let shutdown = async {
            let mut stopped = HashMap::new();
            let mut pending = vec![(self.id, self.thread.clone())];
            loop {
                for (id, thread) in pending {
                    if selected_environment
                        && let Some(settlement) = thread
                            .thread_extension_data()
                            .get::<crate::turn_settlement::Settlement>()
                    {
                        let started = tokio::time::Instant::now();
                        // One budget for all attempts, including all known descendants.
                        // Never start another attempt after that budget has elapsed.
                        let acknowledged = if ack_remaining.is_zero() {
                            Err(())
                        } else {
                            tokio::time::timeout(ack_remaining, async {
                                // A child can already have stopped before root close finds it.
                                if matches!(
                                    thread.agent_status().await,
                                    codex_protocol::protocol::AgentStatus::Shutdown
                                        | codex_protocol::protocol::AgentStatus::NotFound
                                ) {
                                    return true;
                                }

                                if settlement.interrupt_session(&thread).await.is_err() {
                                    // Shutdown still owns cleanup, but cannot credit an
                                    // ACK from a terminal store that may already be drained.
                                    return false;
                                }
                                let mut all_acknowledged = true;
                                for terminal in thread.list_background_terminals().await {
                                    match terminal.process_id.parse::<i32>() {
                                        Ok(process_id) => {
                                            all_acknowledged &= thread
                                                .terminate_background_terminal(process_id)
                                                .await;
                                        }
                                        Err(_) => all_acknowledged = false,
                                    }
                                }
                                all_acknowledged
                            })
                            .await
                            .map_err(|_| ())
                        };
                        settlement.retire();
                        let elapsed = started.elapsed();
                        ack_remaining = ack_remaining.saturating_sub(elapsed);
                        // Preserve the original total shutdown bound independently of ACK time.
                        shutdown_deadline += elapsed;
                        match acknowledged {
                            Ok(true) => {}
                            Ok(false) => {
                                ack_error.get_or_insert(
                                    "A remote process termination attempt was not acknowledged"
                                        .to_owned(),
                                );
                            }
                            Err(()) => {
                                ack_error.get_or_insert_with(|| {
                                    "Remote process termination attempts timed out".to_owned()
                                });
                            }
                        }
                    }
                    tokio::time::timeout_at(shutdown_deadline, thread.shutdown_and_wait())
                        .await
                        .context("Codex thread shutdown timed out")??;
                    stopped.insert(id, thread);
                }
                // Shut down parents before rediscovering children created during shutdown.
                pending = tokio::time::timeout_at(shutdown_deadline, async {
                    let mut found = Vec::new();
                    for id in self.claim_subtree().await? {
                        if id != self.id
                            && let Ok(thread) = self.engine.manager.get_thread(id).await
                            && !stopped
                                .get(&id)
                                .is_some_and(|previous| Arc::ptr_eq(previous, &thread))
                        {
                            found.push((id, thread));
                        }
                    }
                    anyhow::Ok(found)
                })
                .await
                .context("Codex thread shutdown timed out")??;
                if pending.is_empty() {
                    break;
                }
            }
            tokio::time::timeout_at(shutdown_deadline, async {
                // Core's per-thread join waits for loop exit. Check managed process
                // cleanup across the exact tree before releasing its ownership.
                if let Err(error) = self
                    .thread
                    .shutdown_agent_tree_and_check_managed_processes()
                    .await
                {
                    ack_error = Some(match ack_error.take() {
                        Some(message) => format!("{message}; {error}"),
                        None => error.to_string(),
                    });
                }
                // Retain ancestors until every descendant has stopped, even without a graph store.
                for (id, thread) in stopped {
                    if id != self.id {
                        import_diagnostic = self
                            .engine
                            .interception
                            .cleanup_code_imports(Some(id), shutdown_deadline)
                            .await?
                            .or(import_diagnostic.take());
                        self.engine
                            .manager
                            .remove_thread_if_matches(&id, &thread)
                            .await;
                        self.engine.interception.clear_code_state(id);
                    }
                }
                anyhow::Ok(())
            })
            .await
            .context("Codex thread shutdown timed out")??;
            import_diagnostic = self
                .engine
                .interception
                .cleanup_code_imports(Some(self.id), shutdown_deadline)
                .await?
                .or(import_diagnostic.take());
            self.engine
                .manager
                .remove_thread_if_matches(&self.id, &self.thread)
                .await;
            self.engine.interception.clear_code_state(self.id);
            self.engine
                .event_owners
                .lock()
                .await
                .retain(|_, owner| *owner != self.id);
            anyhow::Ok(())
        }
        .await;
        if let Err(error) = shutdown {
            // Report both outcomes before returning incomplete cleanup for retry.
            // Keep the same shutdown error disclosure as ordinary native close.
            return Err(match ack_error {
                Some(message) => anyhow::anyhow!("{message}; {error}"),
                None => error,
            });
        }
        if let Some(diagnostic) = import_diagnostic {
            ack_error = Some(match ack_error {
                Some(message) => format!("{message}; {diagnostic}"),
                None => diagnostic,
            });
        }
        if let Some(store) = &self.engine.local_checklist_store
            && let Err(error) = store.check_failure(Some(self.id)).await
        {
            ack_error = Some(match ack_error {
                Some(message) => format!("{message}; {error}"),
                None => error.to_string(),
            });
        }
        self.closed.store(true, Ordering::Release);
        Ok(ack_error)
    }

    // Called only after Core has joined and the retained native writer has
    // finalized its suspension. Ordinary close must not send a second shutdown.
    pub(crate) async fn retire_suspended(&self) {
        self.native_questions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        self.engine
            .manager
            .remove_thread_if_matches(&self.id, &self.thread)
            .await;
        self.engine.interception.clear_code_state(self.id);
        self.engine
            .event_owners
            .lock()
            .await
            .retain(|_, owner| *owner != self.id);
        // Core has queued its final usage and ShutdownComplete. Let the sole
        // reader consume them; explicit close can still revoke it.
        self.closed.store(true, Ordering::Release);
    }
}

#[cfg(test)]
#[path = "turn_settlement_tests.rs"]
mod settlement_tests;

#[cfg(test)]
mod question_lifecycle_tests {
    use super::*;
    use codex_protocol::protocol::{TurnAbortReason, TurnAbortedEvent};

    #[test]
    fn canceled_questions_expire_only_with_their_original_turn_and_child_instance() {
        let child = ThreadId::new();
        let source = Some((child, 1));
        let canceled = Event {
            id: "transport-id".to_owned(),
            msg: EventMsg::TurnAborted(TurnAbortedEvent {
                turn_id: Some("original-turn".to_owned()),
                reason: TurnAbortReason::Interrupted,
                error: None,
                started_at: None,
                completed_at: None,
                duration_ms: None,
            }),
        };
        assert!(question_ended(
            source,
            Some("original-turn"),
            source,
            &canceled
        ));
        assert!(!question_ended(
            source,
            Some("successor-turn"),
            source,
            &canceled
        ));
        assert!(!question_ended(
            Some((child, 2)),
            Some("original-turn"),
            source,
            &canceled
        ));
        assert!(!question_ended(
            None,
            Some("original-turn"),
            source,
            &canceled
        ));
        assert!(question_ended(None, Some("original-turn"), None, &canceled));
    }

    #[test]
    fn child_shutdown_does_not_retire_a_successor_or_root_question() {
        let child = ThreadId::new();
        let source = Some((child, 1));
        let shutdown = Event {
            id: String::new(),
            msg: EventMsg::ShutdownComplete,
        };
        assert!(question_ended(
            source,
            Some("original-turn"),
            source,
            &shutdown
        ));
        assert!(!question_ended(
            Some((child, 2)),
            Some("original-turn"),
            source,
            &shutdown
        ));
        assert!(!question_ended(
            None,
            Some("original-turn"),
            source,
            &shutdown
        ));
    }
}

#[cfg(test)]
mod publication_boundary_tests {
    use super::*;

    fn event(id: &str) -> Event {
        Event {
            id: id.to_owned(),
            msg: EventMsg::ShutdownComplete,
        }
    }

    #[tokio::test]
    async fn ready_reader_error_is_retained_before_the_boundary() {
        let mut next: Option<NextEvent> = Some(Box::pin(std::future::ready(Err(
            codex_protocol::error::CodexErr::InternalAgentDied,
        ))));
        assert!(prefetch_event(&mut next, None).await.unwrap());
        let error = next.take().unwrap().await.unwrap_err();
        assert!(matches!(
            error.details(),
            codex_protocol::error::CodexErrorDetails::InternalAgentDied
        ));
    }

    #[tokio::test]
    async fn pending_prefetch_does_not_wait_or_drop_the_next_event() {
        let (send, receive) = tokio::sync::oneshot::channel();
        let mut next: Option<NextEvent> = Some(Box::pin(async move {
            Ok(receive.await.expect("owned event sender"))
        }));
        assert!(!prefetch_event(&mut next, None).await.unwrap());
        send.send(event("later")).unwrap();
        assert!(prefetch_event(&mut next, None).await.unwrap());
        assert_eq!(next.take().unwrap().await.unwrap().id, "later");
    }

    #[tokio::test]
    async fn child_prefix_preserves_uncaptured_events_and_exact_instances() {
        let a = ThreadId::from_string("00000000-0000-0000-0000-000000000001").unwrap();
        let b = ThreadId::from_string("00000000-0000-0000-0000-000000000002").unwrap();
        let reader = |instance, id| {
            let next: NextChildEvent = Box::pin(std::future::ready(Ok((event(id), None, None))));
            ChildReader {
                thread: Weak::new(),
                next: Some(next),
                dequeued: Arc::new(AtomicBool::new(false)),
                instance,
            }
        };
        let mut children =
            VecDeque::from([(a, reader(1, "uncaptured")), (b, reader(2, "captured"))]);
        let mut prefix = PublicationPrefix {
            id: "private-boundary".to_owned(),
            native: 0,
            extensions: 0,
            children: HashMap::from([((b, 2), 1)]),
            _child_owners: Vec::new(),
        };
        assert!(prefix.consume_child((b, 1)).is_err());
        assert!(!prefix.complete());
        let (source, received, error, _) = read_child(&mut children, Some(&prefix)).await;
        assert!(error.is_none());
        assert_eq!(source, (b, 2));
        assert_eq!(received.id, "captured");
        prefix.consume_child(source).unwrap();
        assert!(prefix.complete());
        let (source, received, error, _) = read_child(&mut children, None).await;
        assert!(error.is_none());
        assert_eq!(source, (a, 1));
        assert_eq!(received.id, "uncaptured");
    }
    fn withheld_child(
        instance: u64,
    ) -> (
        ChildReader,
        tokio::sync::oneshot::Sender<Event>,
        tokio::sync::oneshot::Sender<Option<serde_json::Value>>,
    ) {
        let (event_send, event_receive) = tokio::sync::oneshot::channel();
        let (metadata_send, metadata_receive) = tokio::sync::oneshot::channel();
        let dequeued = Arc::new(AtomicBool::new(false));
        let witness = dequeued.clone();
        let next: NextChildEvent = Box::pin(async move {
            let event = event_receive.await.expect("owned event sender");
            witness.store(true, Ordering::Release);
            let metadata = metadata_receive.await.expect("owned metadata sender");
            Ok((event, metadata, None))
        });
        (
            ChildReader {
                thread: Weak::new(),
                next: Some(next),
                dequeued,
                instance,
            },
            event_send,
            metadata_send,
        )
    }

    fn child_prefix(source: (ThreadId, u64), remaining: usize) -> PublicationPrefix {
        PublicationPrefix {
            id: "private-boundary".to_owned(),
            native: 0,
            extensions: 0,
            children: HashMap::from([(source, remaining)]),
            _child_owners: Vec::new(),
        }
    }

    #[tokio::test]
    async fn dequeued_child_waits_for_exact_metadata_before_publication() {
        let id = ThreadId::from_string("00000000-0000-0000-0000-000000000003").unwrap();
        let (mut reader, event_send, metadata_send) = withheld_child(3);
        event_send.send(event("held-error")).unwrap();
        let before_boundary = prefetch_event(&mut reader.next, Some(reader.dequeued.as_ref()))
            .await
            .unwrap();
        assert!(before_boundary);
        assert!(reader.dequeued.load(Ordering::Acquire));
        let mut prefix = child_prefix((id, 3), usize::from(before_boundary));
        assert!(!prefix.complete());
        let error = serde_json::json!({"provider_code":"exact-held-error"});
        metadata_send.send(Some(error.clone())).unwrap();
        let mut children = VecDeque::from([(id, reader)]);
        let (source, received, metadata, _) = read_child(&mut children, Some(&prefix)).await;
        assert_eq!(source, (id, 3));
        assert_eq!(received.id, "held-error");
        assert_eq!(metadata, Some(error));
        assert!(!children[0].1.dequeued.load(Ordering::Acquire));
        prefix.consume_child(source).unwrap();
        assert!(prefix.complete());
    }

    #[tokio::test]
    async fn a_future_child_event_does_not_extend_the_publication_prefix() {
        let id = ThreadId::from_string("00000000-0000-0000-0000-000000000004").unwrap();
        let (mut reader, event_send, metadata_send) = withheld_child(4);
        let before_boundary = prefetch_event(&mut reader.next, Some(reader.dequeued.as_ref()))
            .await
            .unwrap();
        assert!(!before_boundary);
        assert!(!reader.dequeued.load(Ordering::Acquire));
        let prefix = child_prefix((id, 4), usize::from(before_boundary));
        assert!(prefix.complete());
        event_send.send(event("after-boundary")).unwrap();
        metadata_send.send(None).unwrap();
        let mut children = VecDeque::from([(id, reader)]);
        let (source, received, metadata, _) = read_child(&mut children, None).await;
        assert_eq!(source, (id, 4));
        assert_eq!(received.id, "after-boundary");
        assert!(metadata.is_none());
        assert!(!children[0].1.dequeued.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn ready_dequeued_child_counts_once_and_reset_excludes_its_next_future() {
        let id = ThreadId::from_string("00000000-0000-0000-0000-000000000005").unwrap();
        let (mut reader, event_send, metadata_send) = withheld_child(5);
        event_send.send(event("ready")).unwrap();
        metadata_send.send(None).unwrap();
        let before_boundary = prefetch_event(&mut reader.next, Some(reader.dequeued.as_ref()))
            .await
            .unwrap();
        assert!(before_boundary);
        assert!(reader.dequeued.load(Ordering::Acquire));
        let mut prefix = child_prefix((id, 5), usize::from(before_boundary));
        let mut children = VecDeque::from([(id, reader)]);
        let (source, received, _, _) = read_child(&mut children, Some(&prefix)).await;
        assert_eq!(received.id, "ready");
        prefix.consume_child(source).unwrap();
        assert!(prefix.complete(), "ready and dequeued describe one event");
        let reader = &mut children[0].1;
        assert!(!reader.dequeued.load(Ordering::Acquire));
        let (send, receive) = tokio::sync::oneshot::channel();
        let witness = reader.dequeued.clone();
        reader.next = Some(Box::pin(async move {
            let event = receive.await.expect("next event sender");
            witness.store(true, Ordering::Release);
            Ok((event, None, None))
        }));
        assert!(
            !prefetch_event(&mut reader.next, Some(reader.dequeued.as_ref()))
                .await
                .unwrap()
        );
        send.send(event("fresh-future")).unwrap();
        let (_, received, _, _) = read_child(&mut children, None).await;
        assert_eq!(received.id, "fresh-future");
        assert!(!children[0].1.dequeued.load(Ordering::Acquire));
    }
}

#[cfg(test)]
#[path = "checklist_tests.rs"]
mod checklist_tests;

#[cfg(test)]
#[path = "settled_fork_tests.rs"]
mod settled_fork_tests;

#[cfg(test)]
#[path = "candidate_startup_tests.rs"]
mod candidate_startup_tests;

#[cfg(test)]
#[path = "user_input_policy_tests.rs"]
mod user_input_policy_tests;
