//! Native access-adapter fixtures, distinct from public executor/permission tests.
//! These execute the real decorator with an issued opaque key and controlled I/O,
//! not fabricated observation events or a claim of a new public registration API.
use super::*;
use bytes::Bytes;
use futures_util::stream;

struct FixtureAccess {
    key: EnvironmentAccessKey,
    fail: bool,
    alias: bool,
    writes: Mutex<Vec<(PathUri, Vec<u8>)>>,
}
impl EnvironmentAccess for FixtureAccess {
    fn cache_key(&self) -> EnvironmentAccessKey {
        self.key.clone()
    }
    fn canonicalize<'a>(&'a self, path: &'a PathUri) -> ExecutorFileSystemFuture<'a, PathUri> {
        Box::pin(async move {
            if self.alias {
                Ok(PathUri::parse("file:///foreign/resource.txt").unwrap())
            } else {
                Ok(path.clone())
            }
        })
    }
    fn read_file<'a>(
        &'a self,
        _: &'a PathUri,
        _: ReadFileOptions,
    ) -> ExecutorFileSystemFuture<'a, Vec<u8>> {
        Box::pin(async move {
            if self.fail {
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "fixture denied",
                ))
            } else {
                Ok(b"resource body".to_vec())
            }
        })
    }
    fn read_file_stream<'a>(
        &'a self,
        _: &'a PathUri,
    ) -> ExecutorFileSystemFuture<'a, FileSystemReadStream> {
        Box::pin(async move {
            let mut chunks = vec![Ok(Bytes::from_static(b"resource body"))];
            if self.fail {
                chunks.push(Err(io::Error::new(
                    io::ErrorKind::Other,
                    "fixture stream failed",
                )));
            }
            Ok(FileSystemReadStream::new(stream::iter(chunks)))
        })
    }
    fn write_file<'a>(
        &'a self,
        path: &'a PathUri,
        contents: Vec<u8>,
        _: WriteFileOptions,
    ) -> ExecutorFileSystemFuture<'a, ()> {
        Box::pin(async move {
            if self.fail {
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "fixture denied",
                ))
            } else {
                self.writes.lock().unwrap().push((path.clone(), contents));
                Ok(())
            }
        })
    }
    fn create_directory<'a>(
        &'a self,
        _: &'a PathUri,
        _: CreateDirectoryOptions,
    ) -> ExecutorFileSystemFuture<'a, ()> {
        unsupported()
    }
    fn get_metadata<'a>(
        &'a self,
        _: &'a PathUri,
        _: GetMetadataOptions,
    ) -> ExecutorFileSystemFuture<'a, FileMetadata> {
        unsupported()
    }
    fn read_directory<'a>(
        &'a self,
        _: &'a PathUri,
    ) -> ExecutorFileSystemFuture<'a, Vec<ReadDirectoryEntry>> {
        unsupported()
    }
    fn walk<'a>(
        &'a self,
        _: &'a PathUri,
        _: WalkOptions,
    ) -> ExecutorFileSystemFuture<'a, WalkOutcome> {
        unsupported()
    }
    fn remove<'a>(&'a self, _: &'a PathUri, _: RemoveOptions) -> ExecutorFileSystemFuture<'a, ()> {
        unsupported()
    }
    fn copy<'a>(
        &'a self,
        _: &'a PathUri,
        _: &'a PathUri,
        _: CopyOptions,
    ) -> ExecutorFileSystemFuture<'a, ()> {
        unsupported()
    }
}
fn unsupported<'a, T: Send + 'a>() -> ExecutorFileSystemFuture<'a, T> {
    Box::pin(async {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "fixture operation not enrolled",
        ))
    })
}
fn root() -> PathUri {
    PathUri::parse("file:///project").unwrap()
}
fn resource() -> PathUri {
    root().join("src/resource.txt").unwrap()
}
fn sandbox() -> FileSystemSandboxContext {
    FileSystemSandboxContext::from_permission_profile(
        PermissionProfile::workspace_write_with_path_uris(
            &[],
            codex_protocol::permissions::NetworkSandboxPolicy::Restricted,
            true,
            true,
        ),
        root(),
    )
}
fn fixture(fail: bool, alias: bool) -> FixtureAccess {
    // The real constructor supplies opaque filesystem + complete sandbox identity.
    // No unrestricted filesystem operation is executed by this fixture.
    let accessor = FileSystemEnvironmentAccessor::new(&codex_exec_server::LOCAL_FS, sandbox());
    FixtureAccess {
        key: accessor.cache_key(),
        fail,
        alias,
        writes: Mutex::new(Vec::new()),
    }
}
fn owner(access: &FixtureAccess) -> (Arc<Rules>, Arc<AccessContext>) {
    let context = Arc::new(AccessContext {
        environment_id: "executor".into(),
        cwd: root(),
        workspace_roots: vec![root()],
        permission_profile: sandbox().permissions.clone(),
        sandbox: sandbox(),
        canonical_root: root(),
        key: access.cache_key(),
    });
    let rules = Arc::new(Rules::new(root()));
    {
        let mut scope = rules.0.lock().unwrap();
        scope.turn = "turn".into();
        scope.identity = Some(context.clone());
        scope.active = Some(Arc::new(Batch::default()));
    }
    (rules, context)
}
fn bound<'a>(
    access: &'a FixtureAccess,
    rules: &'a Arc<Rules>,
    context: &'a Arc<AccessContext>,
) -> BoundAccess<'a> {
    BoundAccess {
        inner: access,
        environment_id: &context.environment_id,
        cwd: &context.cwd,
        turn: "turn",
        call_id: "original-call",
        rules,
        context: Some(context),
        key: Arc::new(access.cache_key()),
    }
}
fn paths(rules: &Rules) -> HashSet<PathUri> {
    rules
        .0
        .lock()
        .unwrap()
        .batch
        .as_ref()
        .map(|batch| batch.0.lock().unwrap().paths.clone())
        .unwrap_or_default()
}

#[tokio::test]
async fn successful_resource_eof_is_single_consumption() {
    let access = fixture(false, false);
    let (rules, context) = owner(&access);
    let issued = bound(&access, &rules, &context);
    let mut stream = issued.read_file_stream(&resource()).await.unwrap();
    assert_eq!(
        stream.next().await.unwrap().unwrap(),
        Bytes::from_static(b"resource body")
    );
    assert!(paths(&rules).is_empty());
    assert!(stream.next().await.is_none());
    assert_eq!(paths(&rules), HashSet::from([resource()]));
    // Re-polling EOF cannot replay the proof into a subsequent collecting batch.
    {
        let mut scope = rules.0.lock().unwrap();
        scope.batch = None;
        scope.active = Some(Arc::new(Batch::default()));
    }
    assert!(stream.next().await.is_none());
    assert!(paths(&rules).is_empty());
}
#[tokio::test]
async fn partial_error_and_dropped_accessors_never_observe() {
    for mode in ["partial", "error", "accessor-dropped"] {
        let access = fixture(mode == "error", false);
        let (rules, context) = owner(&access);
        let issued = bound(&access, &rules, &context);
        let mut stream = issued.read_file_stream(&resource()).await.unwrap();
        assert!(stream.next().await.unwrap().is_ok());
        if mode == "partial" {
            drop(stream);
        } else {
            if mode == "accessor-dropped" {
                drop(issued);
            }
            while stream.next().await.is_some() {}
        }
        assert!(paths(&rules).is_empty(), "{mode}");
    }
}
#[tokio::test]
async fn streams_cannot_revive_replaced_or_ended_authority() {
    for mode in ["new-key", "new-turn", "away-and-back"] {
        let access = fixture(false, false);
        let (rules, context) = owner(&access);
        let issued = bound(&access, &rules, &context);
        let mut stream = issued.read_file_stream(&resource()).await.unwrap();
        assert!(stream.next().await.unwrap().is_ok());
        {
            let mut scope = rules.0.lock().unwrap();
            if mode == "new-turn" {
                scope.turn = "later-turn".into();
            } else {
                let mut replacement = (*context).clone();
                if mode == "new-key" {
                    let mut changed = sandbox();
                    changed.workspace_roots.clear();
                    replacement.key =
                        FileSystemEnvironmentAccessor::new(&codex_exec_server::LOCAL_FS, changed)
                            .cache_key();
                }
                scope.identity = Some(Arc::new(replacement));
            }
        }
        assert!(stream.next().await.is_none());
        assert!(paths(&rules).is_empty(), "{mode}");
    }
}
#[tokio::test]
async fn denied_and_outside_or_aliased_accesses_do_not_select_rules() {
    for (fail, alias, outside) in [
        (true, false, false),
        (false, true, false),
        (false, false, true),
    ] {
        let access = fixture(fail, alias);
        let (rules, context) = owner(&access);
        let issued = bound(&access, &rules, &context);
        let path = if outside {
            PathUri::parse("file:///foreign/resource.txt").unwrap()
        } else {
            resource()
        };
        let result = issued.read_file(&path, ReadFileOptions::default()).await;
        assert_eq!(result.is_err(), fail);
        assert!(paths(&rules).is_empty());
    }
}
#[tokio::test]
async fn completed_native_file_io_preserves_results_and_observes_original_owner() {
    let access = fixture(false, false);
    let (rules, context) = owner(&access);
    let issued = bound(&access, &rules, &context);
    assert_eq!(
        issued
            .read_file(&resource(), ReadFileOptions::default())
            .await
            .unwrap(),
        b"resource body"
    );
    assert_eq!(paths(&rules), HashSet::from([resource()]));
    let updated = root().join("src/updated.txt").unwrap();
    issued
        .write_file(&updated, b"updated".to_vec(), WriteFileOptions::default())
        .await
        .unwrap();
    assert_eq!(paths(&rules), HashSet::from([resource(), updated.clone()]));
    assert_eq!(
        *access.writes.lock().unwrap(),
        vec![(updated, b"updated".to_vec())]
    );
}

#[tokio::test]
async fn current_epoch_still_rejects_a_different_issued_access_key() {
    let access = fixture(false, false);
    let (rules, original) = owner(&access);
    let mut changed = sandbox();
    changed.workspace_roots.clear();
    let mut current = (*original).clone();
    current.sandbox = changed.clone();
    current.workspace_roots.clear();
    current.key =
        FileSystemEnvironmentAccessor::new(&codex_exec_server::LOCAL_FS, changed).cache_key();
    let current = Arc::new(current);
    rules.0.lock().unwrap().identity = Some(current.clone());
    let issued = bound(&access, &rules, &current);
    assert_ne!(issued.cache_key(), current.key);
    assert!(Arc::ptr_eq(
        rules.0.lock().unwrap().identity.as_ref().unwrap(),
        &current
    ));
    assert!(rules.0.lock().unwrap().active.is_some());
    assert_eq!(
        issued
            .read_file(&resource(), ReadFileOptions::default())
            .await
            .unwrap(),
        b"resource body"
    );
    assert!(paths(&rules).is_empty());
}

mod routes {
    include!("project_guidance_routes.rs");
}
