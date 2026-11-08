// Included as a child of the existing project_guidance_access test module.
// The installed route tests use its opaque-key fixture, not direct observe calls.
use super::*;

// Hold the actual consumer immediately before the decorator can observe EOF.
// This lets a production lifecycle transition run while the issued owner lives.
struct HeldResourceAccess {
    inner: FixtureAccess,
    at_eof: Arc<tokio::sync::Notify>,
    release_eof: Arc<tokio::sync::Notify>,
}

impl EnvironmentAccess for HeldResourceAccess {
    fn cache_key(&self) -> EnvironmentAccessKey {
        self.inner.cache_key()
    }
    fn canonicalize<'a>(&'a self, path: &'a PathUri) -> ExecutorFileSystemFuture<'a, PathUri> {
        self.inner.canonicalize(path)
    }
    fn read_file<'a>(
        &'a self,
        path: &'a PathUri,
        options: ReadFileOptions,
    ) -> ExecutorFileSystemFuture<'a, Vec<u8>> {
        self.inner.read_file(path, options)
    }
    fn read_file_stream<'a>(
        &'a self,
        path: &'a PathUri,
    ) -> ExecutorFileSystemFuture<'a, FileSystemReadStream> {
        Box::pin(async move {
            let stream = self.inner.read_file_stream(path).await?;
            let at_eof = self.at_eof.clone();
            let release_eof = self.release_eof.clone();
            Ok(FileSystemReadStream::new(futures_util::stream::unfold(
                (stream, at_eof, release_eof),
                |(mut stream, at_eof, release_eof)| async move {
                    match stream.next().await {
                        Some(chunk) => Some((chunk, (stream, at_eof, release_eof))),
                        None => {
                            at_eof.notify_one();
                            release_eof.notified().await;
                            None
                        }
                    }
                },
            )))
        })
    }
    fn write_file<'a>(
        &'a self,
        path: &'a PathUri,
        contents: Vec<u8>,
        options: WriteFileOptions,
    ) -> ExecutorFileSystemFuture<'a, ()> {
        self.inner.write_file(path, contents, options)
    }
    fn create_directory<'a>(
        &'a self,
        path: &'a PathUri,
        options: CreateDirectoryOptions,
    ) -> ExecutorFileSystemFuture<'a, ()> {
        self.inner.create_directory(path, options)
    }
    fn get_metadata<'a>(
        &'a self,
        path: &'a PathUri,
        options: GetMetadataOptions,
    ) -> ExecutorFileSystemFuture<'a, FileMetadata> {
        self.inner.get_metadata(path, options)
    }
    fn read_directory<'a>(
        &'a self,
        path: &'a PathUri,
    ) -> ExecutorFileSystemFuture<'a, Vec<ReadDirectoryEntry>> {
        self.inner.read_directory(path)
    }
    fn walk<'a>(
        &'a self,
        path: &'a PathUri,
        options: WalkOptions,
    ) -> ExecutorFileSystemFuture<'a, WalkOutcome> {
        self.inner.walk(path, options)
    }
    fn remove<'a>(
        &'a self,
        path: &'a PathUri,
        options: RemoveOptions,
    ) -> ExecutorFileSystemFuture<'a, ()> {
        self.inner.remove(path, options)
    }
    fn copy<'a>(
        &'a self,
        from: &'a PathUri,
        to: &'a PathUri,
        options: CopyOptions,
    ) -> ExecutorFileSystemFuture<'a, ()> {
        self.inner.copy(from, to, options)
    }
}

use codex_skills_extension::catalog::{
    SkillAuthority, SkillCatalog, SkillCatalogEntry, SkillPackageId, SkillReadResult,
    SkillResourceId, SkillSearchResult, SkillSourceKind,
};
use codex_skills_extension::provider::{
    SkillListQuery, SkillProvider, SkillProviderFuture, SkillReadRequest, SkillSearchRequest,
};

const PACKAGE: &str = "skill://selected/project/src";
const SUBSIDIARY: &str = "skill://selected/project/src/resource.txt";

// Catalog setup is deterministic; every read is delegated to the real executor
// provider. Its manager is never used as an unrestricted callback filesystem.
struct InstalledResourceProvider {
    real: codex_skills_extension::ExecutorSkillProvider,
}
impl SkillProvider for InstalledResourceProvider {
    fn list(&self, _: SkillListQuery) -> SkillProviderFuture<'_, SkillCatalog> {
        Box::pin(async {
            let mut catalog = SkillCatalog::default();
            catalog.push_entry(SkillCatalogEntry::new(
                SkillPackageId(PACKAGE.into()),
                SkillAuthority::new(SkillSourceKind::Executor, "selected"),
                "route-example",
                "An explicitly selected executor skill.",
                SkillResourceId::environment(
                    format!("{PACKAGE}/SKILL.md"),
                    codex_exec_server::LOCAL_ENVIRONMENT_ID,
                    root().join("src/SKILL.md").unwrap(),
                ),
            ));
            Ok(catalog)
        })
    }
    fn read<'a>(
        &'a self,
        request: SkillReadRequest<'a>,
    ) -> SkillProviderFuture<'a, SkillReadResult> {
        assert_eq!(
            request.resource,
            SkillResourceId::environment(
                SUBSIDIARY,
                codex_exec_server::LOCAL_ENVIRONMENT_ID,
                resource(),
            )
        );
        assert_eq!(request.resource.as_str(), SUBSIDIARY);
        self.real.read(request)
    }
    fn search(&self, request: SkillSearchRequest) -> SkillProviderFuture<'_, SkillSearchResult> {
        self.real.search(request)
    }
}

// This is a ready local metadata handle only. The tool's I/O is supplied through
// ToolCall.environments below, using the existing permission-bound opaque key.
async fn enrolled_roots(
    manager: &codex_exec_server::EnvironmentManager,
) -> Vec<codex_exec_server::ResolvedSelectedCapabilityRoot> {
    let selected = codex_protocol::capabilities::SelectedCapabilityRoot {
        id: "selected".into(),
        location: codex_protocol::capabilities::CapabilityRootLocation::Environment {
            environment_id: codex_exec_server::LOCAL_ENVIRONMENT_ID.into(),
            path: root().join("src").unwrap(),
        },
    };
    let resolved = manager
        .resolve_selected_capability_roots(&[selected], &HashMap::new())
        .await;
    assert_eq!(
        resolved.len(),
        1,
        "the manager must resolve actual readiness"
    );
    resolved
}

#[tokio::test]
async fn installed_skill_read_preserves_real_provider_eof_and_lifecycle_authority() {
    use codex_extension_api::{
        ExtensionRegistryBuilder, ThreadStartInput, TurnAbortInput, TurnStopInput,
    };
    use codex_protocol::protocol::TruncationPolicy;
    use codex_skills_extension::{SkillProviders, SkillsExtensionConfig};
    use codex_tools::{ConversationHistory, NoopTurnItemEmitter, ToolEnvironment};

    // No partial/error/drop matrix here: the parent adapter cases already own it.
    for end in ["current", "stop", "abort", "renew-away-and-back"] {
        let manager = Arc::new(codex_exec_server::EnvironmentManager::default_for_tests());
        let providers =
            SkillProviders::new().with_executor_provider(Arc::new(InstalledResourceProvider {
                real: codex_skills_extension::ExecutorSkillProvider::new_with_restriction_product(
                    manager.clone(),
                    None,
                ),
            }));
        let mut builder = ExtensionRegistryBuilder::<()>::new();
        codex_skills_extension::install_with_providers(&mut builder, providers, |_| {
            SkillsExtensionConfig {
                include_instructions: false,
                max_context_tokens: None,
                bundled_skills_enabled: false,
                cloud_skill_enabled: false,
                shadow_selection_enabled: false,
            }
        });
        let installed = builder.build();
        let session = ExtensionData::new("session");
        let thread = ExtensionData::new("thread");
        let turn = ExtensionData::new("turn");
        let step = ExtensionData::new("step");
        for contributor in installed.thread_lifecycle_contributors() {
            contributor
                .on_thread_start(ThreadStartInput {
                    config: &(),
                    session_source: &codex_protocol::protocol::SessionSource::Exec,
                    persistent_thread_state_available: false,
                    spawning_step_store: None,
                    environments: &[],
                    mcp_resource_client: None,
                    extension_metrics: None,
                    session_store: &session,
                    thread_store: &thread,
                })
                .await;
        }
        step.insert(enrolled_roots(&manager).await);
        thread.insert(Rules::new(root(), codex_exec_server::LOCAL_ENVIRONMENT_ID));
        let rules = thread.get::<Rules>().unwrap();
        let lifecycle = CanonicalRules::new(std::sync::Weak::new(), manager);
        let mode = serde_json::from_value(json!({
            "mode":"default", "settings": {"model":"gpt-5", "reasoning_effort":null, "developer_instructions":null}
        })).unwrap();
        lifecycle
            .on_turn_start(TurnStartInput {
                turn_id: "turn",
                collaboration_mode: &mode,
                token_usage_at_turn_start: None,
                session_store: &session,
                thread_store: &thread,
                turn_store: &turn,
            })
            .await;
        let held = HeldResourceAccess {
            inner: fixture(false, false),
            at_eof: Arc::new(tokio::sync::Notify::new()),
            release_eof: Arc::new(tokio::sync::Notify::new()),
        };
        // Reuse the parent's captured permission-bound context, with the actual
        // resolved environment id. This bootstraps adapter authority, not discovery.
        let (_, original) = owner(&held.inner);
        let mut context = (*original).clone();
        context.environment_id = codex_exec_server::LOCAL_ENVIRONMENT_ID.into();
        rules
            .0
            .lock()
            .unwrap()
            .renew_context(&step, Some(context.clone()));
        let contributor = installed.tool_contributors().first().unwrap().clone();
        let wrapped = AccessContributor(contributor);
        let read = wrapped
            .tools_for_step(&session, &thread, &step)
            .into_iter()
            .find(|tool| tool.tool_name() == ToolName::new(Some("skills".into()), "read"))
            .expect("the real installed skills.read must be published for this enrolled step");
        let payload = ToolPayload::Function {
            arguments: json!({
                "package":PACKAGE, "resource":SUBSIDIARY, "cursor":null
            })
            .to_string(),
        };
        let call = ToolCall {
            turn_id: "turn".into(),
            call_id: "resource-read".into(),
            tool_name: read.tool_name(),
            model: "gpt-5".into(),
            model_info: Arc::new(codex_models_manager::model_info::model_info_from_slug("gpt-5")),
            provider_reference_profile: codex_protocol::provider_reference_profile::ProviderImageReferencePolicy::PrepareInline,
            inline_data_url_low_detail_supported: true,
            codex_turn_metadata: None,
            truncation_policy: TruncationPolicy::Bytes(32_768),
            source: ToolCallSource::Direct,
            conversation_history: ConversationHistory::default(),
            turn_item_emitter: Arc::new(NoopTurnItemEmitter),
            environments: vec![ToolEnvironment::new(
                codex_exec_server::LOCAL_ENVIRONMENT_ID.into(),
                root(),
                &held,
            )],
            payload: payload.clone(),
        };
        let mut consume = Box::pin(read.handle(call));
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::select! {
                result = &mut consume => match result {
                    Ok(_) => panic!("installed read returned before its held EOF"),
                    Err(error) => panic!("installed read failed before EOF: {error:?}"),
                },
                () = held.at_eof.notified() => {}
            }
        })
        .await
        .expect("installed resource consumer must reach EOF");
        assert!(paths(&rules).is_empty(), "bytes alone cannot select rules");
        match end {
            "stop" => {
                lifecycle
                    .on_turn_stop(TurnStopInput {
                        session_store: &session,
                        thread_store: &thread,
                        turn_store: &turn,
                    })
                    .await
            }
            "abort" => {
                lifecycle
                    .on_turn_abort(TurnAbortInput {
                        reason: codex_protocol::protocol::TurnAbortReason::Interrupted,
                        session_store: &session,
                        thread_store: &thread,
                        turn_store: &turn,
                    })
                    .await
            }
            "renew-away-and-back" => {
                let mut scope = rules.0.lock().unwrap();
                scope.renew_context(&step, None);
                scope.renew_context(&step, Some(context.clone()));
            }
            _ => {}
        }
        held.release_eof.notify_one();
        let output = tokio::time::timeout(std::time::Duration::from_secs(5), consume)
            .await
            .expect("installed resource read must finish after EOF release");
        let output = output.expect("the real provider must preserve its successful result");
        let encoded =
            serde_json::to_string(&output.to_response_item("resource-read", &payload)).unwrap();
        assert!(encoded.contains("resource body"), "{encoded}");
        if end == "current" {
            assert_eq!(paths(&rules), HashSet::from([resource()]));
            assert!(!paths(&rules).contains(&root().join("docs/unread.txt").unwrap()));
        } else {
            assert!(paths(&rules).is_empty(), "late EOF admitted after {end}");
        }
    }
}
