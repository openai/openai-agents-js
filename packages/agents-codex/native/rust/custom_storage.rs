//! Application-owned canonical snapshots with a disposable native projection.
use codex_history::RolloutItem;
use codex_protocol::{
    ThreadId, dynamic_tools::DynamicToolResponse, models::ResponseItem, protocol::EventMsg,
};
use codex_thread_store::*;
use codex_tools::{ToolOutput, ToolPayload};
use napi::{bindgen_prelude::Promise, threadsafe_function::ThreadsafeFunction};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
use tokio::sync::Mutex;

pub type Callback = ThreadsafeFunction<String, Promise<String>, String, napi::Status, false>;
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
enum Mutation {
    Create {
        params: CreateThreadParams,
        created_at: chrono::DateTime<chrono::Utc>,
    },
    Append {
        items: Vec<RolloutItem>,
    },
    Metadata {
        params: UpdateThreadMetadataParams,
    },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    version: u32,
    thread_id: ThreadId,
    revision: u64,
    mutations: Vec<Mutation>,
}
pub(crate) struct ReceiptStore(pub Arc<CustomThreadStore>);
struct Writer {
    fence: String,
    snapshot: Snapshot,
    failure: Option<String>,
    managed: HashSet<(String, String)>,
}
pub struct CustomThreadStore {
    callback: Arc<Callback>,
    plan_provider: Option<String>,
    projection: crate::storage::MemoryThreadStore,
    writers: Mutex<HashMap<ThreadId, Writer>>,
    failures: Mutex<HashMap<ThreadId, String>>,
    release_failures: Mutex<HashMap<ThreadId, String>>,
}
fn error(message: impl ToString) -> ThreadStoreError {
    ThreadStoreError::Internal {
        message: message.to_string(),
    }
}
fn backend_error(_: impl std::fmt::Display) -> ThreadStoreError {
    error("canonical storage operation failed; close and reconcile the application backend")
}
fn identities(
    items: &[RolloutItem],
) -> ThreadStoreResult<(
    HashMap<(String, String), ResponseItem>,
    HashMap<(String, String), ResponseItem>,
)> {
    let mut turn = String::new();
    let mut calls = HashMap::new();
    let mut outputs = HashMap::new();
    for item in items {
        match item {
            RolloutItem::EventMsg(EventMsg::TurnStarted(start)) => turn = start.turn_id.clone(),
            RolloutItem::ResponseItem(row) => {
                let call_id = match &row.item {
                    ResponseItem::FunctionCall { call_id, .. }
                    | ResponseItem::CustomToolCall { call_id, .. }
                    | ResponseItem::ComputerCall { call_id, .. } => Some(call_id.as_str()),
                    ResponseItem::ShellCall {
                        provider_fields, ..
                    } if crate::local_reconciliation::is_application_shell_call(row) => {
                        provider_fields.get("call_id").and_then(Value::as_str)
                    }
                    _ => None,
                };
                if let Some(call_id) = call_id {
                    let identity = (
                        row.item.turn_id().unwrap_or(&turn).to_owned(),
                        call_id.to_owned(),
                    );
                    if let Some(previous) = calls.get(&identity)
                        && (matches!(
                            previous,
                            ResponseItem::ComputerCall { .. } | ResponseItem::ShellCall { .. }
                        ) || matches!(
                            row.item,
                            ResponseItem::ComputerCall { .. } | ResponseItem::ShellCall { .. }
                        ))
                    {
                        return Err(error("ambiguous original local tool call identity"));
                    }
                    calls.insert(identity, row.item.clone());
                } else if let Some((call, owner)) =
                    crate::local_reconciliation::output_identity(&row.item)
                {
                    outputs.insert(
                        (owner.unwrap_or(&turn).to_owned(), call.to_owned()),
                        row.item.clone(),
                    );
                }
            }
            _ => {}
        }
    }
    Ok((calls, outputs))
}

impl CustomThreadStore {
    pub fn new(callback: Callback) -> Self {
        Self {
            callback: Arc::new(callback),
            plan_provider: None,
            projection: Default::default(),
            writers: Default::default(),
            failures: Default::default(),
            release_failures: Default::default(),
        }
    }

    pub(crate) fn with_plan_provider(mut self, provider: String) -> Self {
        self.plan_provider = Some(provider);
        self
    }

    fn check_provider(&self, stored: Option<&str>) -> ThreadStoreResult<()> {
        if !chatgpt_plan_binding_matches(self.plan_provider.as_deref(), stored) {
            return Err(error(
                "Session requires matching Sign in with ChatGPT registration and account",
            ));
        }
        Ok(())
    }

    fn check_mutation(&self, mutation: &Mutation) -> ThreadStoreResult<()> {
        match mutation {
            Mutation::Create { params, .. } => {
                self.check_provider(Some(&params.metadata.model_provider))
            }
            Mutation::Metadata { params } => {
                if let Some(provider) = &params.patch.model_provider {
                    self.check_provider(Some(provider))?;
                }
                Ok(())
            }
            Mutation::Append { items } => {
                for item in items {
                    if let RolloutItem::SessionMeta(header) = item {
                        self.check_provider(header.meta.model_provider.as_deref())?;
                    }
                }
                Ok(())
            }
        }
    }
    async fn call(&self, op: Value) -> ThreadStoreResult<Value> {
        let promise = self
            .callback
            .call_async_catch(op.to_string())
            .await
            .map_err(backend_error)?;
        let result = promise.await.map_err(backend_error)?;
        serde_json::from_str(&result).map_err(backend_error)
    }
    async fn apply(&self, id: ThreadId, mutation: Mutation) -> ThreadStoreResult<()> {
        match mutation {
            Mutation::Create { params, created_at } => {
                self.projection.create_thread(params).await?;
                self.projection
                    .update_thread_metadata(UpdateThreadMetadataParams {
                        thread_id: id,
                        include_archived: true,
                        patch: ThreadMetadataPatch {
                            created_at: Some(created_at),
                            updated_at: Some(created_at),
                            advance_recency_at: Some(created_at),
                            ..Default::default()
                        },
                    })
                    .await
                    .map(|_| ())
            }
            Mutation::Append { items } => {
                self.projection
                    .append_items(AppendThreadItemsParams {
                        thread_id: id,
                        items,
                    })
                    .await
            }
            Mutation::Metadata { params } => self
                .projection
                .update_thread_metadata(params)
                .await
                .map(|_| ()),
        }
    }
    pub async fn open(&self, id: ThreadId, existing: bool) -> ThreadStoreResult<()> {
        self.open_mode(id, existing, false).await
    }
    pub(crate) async fn open_for_resume(&self, id: ThreadId) -> anyhow::Result<()> {
        // Inspect the canonical intent/result ledger under the acquired writer,
        // before Core can reconcile unfinished work or publish a new runtime.
        self.open_mode(id, true, true).await?;
        let history = self
            .projection
            .load_history(LoadThreadHistoryParams {
                thread_id: id,
                include_archived: true,
            })
            .await?;
        match crate::local_reconciliation::plan(id, &history.items, &history.items, &[]) {
            Ok(_) => Ok(()),
            Err(error) => match error.downcast::<crate::local_reconciliation::RecoveryRequired>() {
                Ok(mut required) => {
                    required.history = history.items;
                    // The engine retains this writer until failed-opening
                    // cleanup settles, including an exact release retry.
                    Err(required.into())
                }
                Err(error) => Err(error),
            },
        }
    }
    async fn open_mode(
        &self,
        id: ThreadId,
        existing: bool,
        recovery: bool,
    ) -> ThreadStoreResult<()> {
        let mut writers = self.writers.lock().await;
        if let Some(writer) = writers.get(&id) {
            return writer
                .failure
                .as_ref()
                .map_or(Ok(()), |failure| Err(error(failure)));
        }
        let fence = self
            .call(json!({"operation":"acquire","threadId":id}))
            .await?
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| error("canonical store returned invalid fence"))?
            .to_owned();
        let opening = async {
            let raw = self
                .call(json!({"operation":"read","threadId":id,"fence":fence}))
                .await?;
            let snapshot = if raw.is_null() {
                if existing {
                    return Err(ThreadStoreError::ThreadNotFound { thread_id: id });
                }
                Snapshot {
                    version: 1,
                    thread_id: id,
                    revision: 0,
                    mutations: Vec::new(),
                }
            } else {
                if !existing {
                    return Err(error("canonical thread already exists"));
                }
                let snapshot: Snapshot = serde_json::from_str(
                    raw.as_str()
                        .ok_or_else(|| error("invalid canonical snapshot"))?,
                )
                .map_err(backend_error)?;
                if snapshot.version != 1
                    || snapshot.thread_id != id
                    || snapshot.revision != snapshot.mutations.len() as u64
                {
                    return Err(error("unsupported canonical snapshot version or identity"));
                }
                if !matches!(snapshot.mutations.first(), Some(Mutation::Create { .. })) {
                    return Err(error("canonical snapshot requires root creation metadata"));
                }
                for (index, mutation) in snapshot.mutations.iter().enumerate() {
                    match mutation {
                        Mutation::Create { params, .. }
                            if index == 0
                                && params.thread_id == id
                                && params.parent_thread_id.is_none()
                                && params.forked_from_id.is_none() => {}
                        Mutation::Append { .. } if index > 0 => {}
                        Mutation::Metadata { params } if index > 0 && params.thread_id == id => {}
                        _ => {
                            return Err(error(
                                "invalid canonical mutation identity or unsupported child history",
                            ));
                        }
                    }
                    self.check_mutation(mutation)?;
                }
                for mutation in &snapshot.mutations {
                    self.apply(id, mutation.clone()).await?;
                }
                let history = self
                    .projection
                    .load_history(LoadThreadHistoryParams {
                        thread_id: id,
                        include_archived: true,
                    })
                    .await?;
                crate::local_storage::validate_root_header(id, &history.items)?;
                if !recovery {
                    crate::local_storage::validate_settled(&history.items)?;
                }
                snapshot
            };
            Ok(snapshot)
        }
        .await;
        match opening {
            Ok(snapshot) => {
                writers.insert(
                    id,
                    Writer {
                        fence,
                        snapshot,
                        failure: None,
                        managed: HashSet::new(),
                    },
                );
                Ok(())
            }
            Err(primary) => {
                let _ = self
                    .projection
                    .delete_thread(DeleteThreadParams { thread_id: id })
                    .await;
                let cleanup = self
                    .call(json!({"operation":"release","threadId":id,"fence":fence}))
                    .await;
                match cleanup {
                    Ok(_) => Err(primary),
                    Err(_) => {
                        writers.insert(
                            id,
                            Writer {
                                fence,
                                snapshot: Snapshot {
                                    version: 1,
                                    thread_id: id,
                                    revision: 0,
                                    mutations: Vec::new(),
                                },
                                failure: Some(primary.to_string()),
                                managed: HashSet::new(),
                            },
                        );
                        Err(error(format!(
                            "{primary}; canonical writer release failed; retry close"
                        )))
                    }
                }
            }
        }
    }
    async fn commit(&self, id: ThreadId, mutation: Mutation) -> ThreadStoreResult<()> {
        self.commit_inner(id, mutation, false).await
    }
    async fn commit_inner(
        &self,
        id: ThreadId,
        mut mutation: Mutation,
        real_receipt: bool,
    ) -> ThreadStoreResult<()> {
        self.check_mutation(&mutation)?;
        let mut writers = self.writers.lock().await;
        let writer = writers
            .get_mut(&id)
            .ok_or_else(|| error("canonical writer not acquired"))?;
        if let Some(failure) = &writer.failure {
            return Err(error(failure));
        }
        if let Mutation::Append { items } = &mut mutation {
            if !real_receipt {
                let history = self
                    .projection
                    .load_history(LoadThreadHistoryParams {
                        thread_id: id,
                        include_archived: true,
                    })
                    .await?;
                let mut turn = history
                    .items
                    .iter()
                    .rev()
                    .find_map(|item| match item {
                        RolloutItem::EventMsg(EventMsg::TurnStarted(start)) => {
                            Some(start.turn_id.clone())
                        }
                        _ => None,
                    })
                    .unwrap_or_default();
                let mut retained = Vec::new();
                for item in std::mem::take(items) {
                    if let RolloutItem::EventMsg(EventMsg::TurnStarted(start)) = &item {
                        turn = start.turn_id.clone();
                    }
                    if let RolloutItem::ResponseItem(row) = &item
                        && let Some((call, owner)) =
                            crate::local_reconciliation::output_identity(&row.item)
                    {
                        let owner = owner.unwrap_or(&turn).to_owned();
                        if writer.managed.contains(&(owner, call.to_owned())) {
                            // Only the explicit SDK receipt owns the effect; synthesized
                            // Core drain output cannot settle a managed computer call.
                            continue;
                        }
                    }
                    retained.push(item);
                }
                *items = retained;
            }
            if items.is_empty() {
                return Ok(());
            }
        }
        let mut next = writer.snapshot.clone();
        next.revision += 1;
        next.mutations.push(mutation.clone());
        let snapshot = serde_json::to_string(&next).map_err(error)?;
        let write_id = format!("{}:{}", id, next.revision);
        let request = json!({"operation":"commit","threadId":id,"fence":writer.fence,"writeId":write_id,"expectedRevision":writer.snapshot.revision,"snapshot":snapshot});
        let result = self.call(request.clone()).await;
        if let Err(failure) = result {
            let accepted = self
                .call(json!({"operation":"read","threadId":id,"fence":writer.fence}))
                .await
                .is_ok_and(|saved| saved.as_str() == Some(snapshot.as_str()));
            if !accepted {
                writer.failure = Some(failure.to_string());
                return Err(failure);
            }
            // Readback can observe a rename whose final durability barrier failed.
            // Confirm the same logical write; a successful idempotent commit must
            // establish the backend's complete durable-acknowledgment boundary.
            if let Err(confirmation) = self.call(request).await {
                writer.failure = Some(confirmation.to_string());
                return Err(confirmation);
            }
        }
        writer.snapshot = next;
        if let Err(failure) = self.apply(id, mutation).await {
            writer.failure = Some(failure.to_string());
            return Err(failure);
        }
        Ok(())
    }
    pub async fn check(&self, id: ThreadId) -> ThreadStoreResult<()> {
        if let Some(failure) = self.failures.lock().await.get(&id) {
            return Err(error(failure));
        }
        let writers = self.writers.lock().await;
        if let Some(failure) = writers.get(&id).and_then(|w| w.failure.as_ref()) {
            return Err(error(failure));
        }
        Ok(())
    }
    pub async fn register_call(
        &self,
        id: ThreadId,
        turn: &str,
        call: &str,
    ) -> ThreadStoreResult<()> {
        self.check(id).await?;
        let mut writers = self.writers.lock().await;
        let writer = writers
            .get_mut(&id)
            .ok_or_else(|| error("canonical writer not acquired"))?;
        let history = self
            .projection
            .load_history(LoadThreadHistoryParams {
                thread_id: id,
                include_archived: true,
            })
            .await?;
        let active = history
            .items
            .iter()
            .rev()
            .find_map(|item| match item {
                RolloutItem::EventMsg(EventMsg::TurnStarted(start)) => {
                    Some(Some(start.turn_id.as_str()))
                }
                RolloutItem::EventMsg(EventMsg::TurnComplete(_) | EventMsg::TurnAborted(_)) => {
                    Some(None)
                }
                _ => None,
            })
            .flatten();
        if active != Some(turn) || !writer.managed.insert((turn.to_owned(), call.to_owned())) {
            let failure =
                "SDK call does not belong to an unused active canonical turn/call identity";
            writer.failure = Some(failure.into());
            return Err(error(failure));
        }
        Ok(())
    }
    pub async fn receipt(&self, id: ThreadId, item: ResponseItem) -> ThreadStoreResult<()> {
        let Some((call, Some(turn))) = crate::local_reconciliation::output_identity(&item) else {
            return Err(error("canonical receipt identity required"));
        };
        let identity = (turn.to_owned(), call.to_owned());
        let history = self
            .projection
            .load_history(LoadThreadHistoryParams {
                thread_id: id,
                include_archived: true,
            })
            .await?;
        let (calls, outputs) = identities(&history.items)?;
        if !calls.get(&identity).is_some_and(|original| {
            crate::local_reconciliation::output_matches_invocation(original, &item)
        }) || outputs.contains_key(&identity)
        {
            return Err(error(
                "canonical receipt requires an unresolved original tool call",
            ));
        }
        self.commit_inner(
            id,
            Mutation::Append {
                items: vec![RolloutItem::ResponseItem(item.clone().into())],
            },
            true,
        )
        .await?;
        self.flush(id).await
    }
    async fn flush(&self, id: ThreadId) -> ThreadStoreResult<()> {
        self.check(id).await?;
        let mut writers = self.writers.lock().await;
        if let Some(writer) = writers.get_mut(&id) {
            if let Err(failure) = self
                .call(json!({"operation":"flush","threadId":id,"fence":writer.fence}))
                .await
            {
                writer.failure = Some(failure.to_string());
                return Err(failure);
            }
        }
        Ok(())
    }
    pub async fn take_release_failure(&self, id: ThreadId) -> Option<String> {
        self.release_failures.lock().await.remove(&id)
    }
    pub async fn close_all(&self) -> ThreadStoreResult<Option<String>> {
        let ids: Vec<_> = self.writers.lock().await.keys().copied().collect();
        let mut first = None;
        for id in ids {
            if let Err(failure) = self.release(id).await {
                first.get_or_insert(failure);
            }
        }
        if !self.writers.lock().await.is_empty() {
            return Err(first.unwrap_or_else(|| error("canonical writer cleanup incomplete")));
        }
        let retained = self.failures.lock().await.values().next().cloned();
        let release_failure = self
            .release_failures
            .lock()
            .await
            .drain()
            .next()
            .map(|(_, failure)| failure);
        Ok(first
            .map(|failure| failure.to_string())
            .or(retained)
            .or(release_failure))
    }
    pub async fn reconcile(
        &self,
        id: ThreadId,
        turn: String,
        call: String,
        result: DynamicToolResponse,
    ) -> ThreadStoreResult<()> {
        self.open_mode(id, true, true).await?;
        let history = self
            .projection
            .load_history(LoadThreadHistoryParams {
                thread_id: id,
                include_archived: true,
            })
            .await?;
        let (calls, outputs) = identities(&history.items)?;
        let identity = (turn.clone(), call.clone());
        let original = calls
            .get(&identity)
            .ok_or_else(|| error("canonical reconciliation requires an original call"))?;
        if outputs.contains_key(&identity) {
            return Err(error(
                "canonical reconciliation requires an unresolved call",
            ));
        }
        if matches!(original, ResponseItem::ComputerCall { .. }) {
            let item = crate::local_reconciliation::computer_receipt(original, result, &turn)
                .map_err(|_| error("Computer reconciliation requires a valid screenshot and safety acknowledgements"))?;
            return self.receipt(id, item).await;
        }
        if matches!(original, ResponseItem::ShellCall { .. }) {
            let item = crate::local_reconciliation::shell_receipt(original, result, &turn)
                .map_err(|_| error("Shell reconciliation requires its original local call and valid structured output"))?;
            return self.receipt(id, item).await;
        }
        let mut item: ResponseItem = crate::python_tools::PythonOutput(result)
            .to_response_item(
                &call,
                &ToolPayload::Function {
                    arguments: String::new(),
                },
            )
            .into();
        if let ResponseItem::FunctionCallOutput {
            internal_chat_message_metadata_passthrough,
            ..
        } = &mut item
        {
            *internal_chat_message_metadata_passthrough = Some(
                codex_protocol::models::InternalChatMessageMetadataPassthrough {
                    turn_id: Some(turn),
                    ..Default::default()
                },
            );
        }
        self.receipt(id, item).await
    }
    async fn release(&self, id: ThreadId) -> ThreadStoreResult<()> {
        self.release_writer(id)
            .await?
            .map_or(Ok(()), |failure| Err(error(failure)))
    }
    // Standalone reconciliation retains the receipt failure separately from
    // physical writer cleanup. Session callers still receive sticky failures.
    pub(crate) async fn release_writer(&self, id: ThreadId) -> ThreadStoreResult<Option<String>> {
        let mut writers = self.writers.lock().await;
        let Some(writer) = writers.get(&id) else {
            return Ok(None);
        };
        let failure = writer.failure.clone();
        if let Some(failure) = &failure {
            self.failures.lock().await.insert(id, failure.clone());
        }
        if let Err(failure) = self
            .call(json!({"operation":"release","threadId":id,"fence":writer.fence}))
            .await
        {
            // Core may successfully retry through discard during the same close.
            // Keep the first release failure visible to the owning SDK caller.
            self.release_failures
                .lock()
                .await
                .entry(id)
                .or_insert_with(|| failure.to_string());
            return Err(failure);
        }
        writers.remove(&id);
        self.projection.shutdown_thread(id).await?;
        Ok(failure)
    }
}
impl ThreadStore for CustomThreadStore {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn create_thread(&self, params: CreateThreadParams) -> ThreadStoreFuture<'_, ()> {
        Box::pin(async move {
            let id = params.thread_id;
            self.check_provider(Some(&params.metadata.model_provider))?;
            if params.parent_thread_id.is_some() || params.forked_from_id.is_some() {
                return Err(error(
                    "custom canonical storage does not support child agents or forks",
                ));
            }
            self.open(id, false).await?;
            self.commit(
                id,
                Mutation::Create {
                    params,
                    created_at: chrono::Utc::now(),
                },
            )
            .await
        })
    }
    fn resume_thread(
        &self,
        mut params: ResumeThreadParams,
    ) -> ThreadStoreFuture<'_, Arc<Vec<RolloutItem>>> {
        Box::pin(async move {
            self.check_provider(Some(&params.metadata.model_provider))?;
            self.open(params.thread_id, true).await?;
            params.history = None;
            self.projection.resume_thread(params).await
        })
    }
    fn append_items(&self, params: AppendThreadItemsParams) -> ThreadStoreFuture<'_, ()> {
        Box::pin(async move {
            self.commit(
                params.thread_id,
                Mutation::Append {
                    items: params.items,
                },
            )
            .await
        })
    }
    fn persist_thread(&self, id: ThreadId, _context: PersistContext) -> ThreadStoreFuture<'_, ()> {
        Box::pin(self.flush(id))
    }
    fn flush_thread(&self, id: ThreadId) -> ThreadStoreFuture<'_, ()> {
        Box::pin(self.flush(id))
    }
    fn shutdown_thread(&self, id: ThreadId) -> ThreadStoreFuture<'_, ()> {
        Box::pin(self.release(id))
    }
    fn discard_thread(&self, id: ThreadId) -> ThreadStoreFuture<'_, ()> {
        Box::pin(self.release(id))
    }
    fn canonical_tool_output<'a>(
        &'a self,
        thread_id: ThreadId,
        output: &'a ResponseItem,
        native_cancellation: bool,
    ) -> ThreadStoreFuture<'a, Option<ResponseItem>> {
        Box::pin(async move {
            let Some((call, Some(turn))) = crate::local_reconciliation::output_identity(output)
            else {
                return Ok(None);
            };
            let mut writers = self.writers.lock().await;
            let writer = writers
                .get_mut(&thread_id)
                .ok_or_else(|| error("canonical writer not acquired"))?;
            if let Some(failure) = &writer.failure {
                return Err(error(failure));
            }
            if !writer.managed.contains(&(turn.to_owned(), call.to_owned())) {
                return Ok(None);
            }
            let accepted = writer.snapshot.mutations.iter().rev().find_map(|mutation| {
                if let Mutation::Append { items } = mutation {
                    items.iter().rev().find_map(|row| {
                        if let RolloutItem::ResponseItem(envelope) = row
                            && crate::local_reconciliation::output_identity(&envelope.item)
                                == Some((call, Some(turn)))
                        {
                            Some(envelope.item.clone())
                        } else {
                            None
                        }
                    })
                } else {
                    None
                }
            });
            if accepted.as_ref().is_some_and(|accepted| {
                !crate::local_reconciliation::matches_acknowledged_output(
                    accepted,
                    output,
                    native_cancellation,
                )
            }) {
                let message = "Core drain changed an acknowledged SDK receipt";
                writer.failure = Some(message.into());
                return Err(error(message));
            }
            Ok(accepted)
        })
    }

    fn load_history(
        &self,
        params: LoadThreadHistoryParams,
    ) -> ThreadStoreFuture<'_, StoredThreadHistory> {
        self.projection.load_history(params)
    }
    fn read_original_history(
        &self,
        params: LoadThreadHistoryParams,
        reader: Box<dyn codex_thread_store::OriginalHistoryReader>,
    ) -> ThreadStoreFuture<'_, codex_thread_store::OriginalHistorySnapshot> {
        self.projection.read_original_history(params, reader)
    }

    fn load_latest_model_context(
        &self,
        params: LoadThreadHistoryParams,
    ) -> ThreadStoreFuture<'_, StoredModelContext> {
        self.projection.load_latest_model_context(params)
    }
    fn read_thread(&self, params: ReadThreadParams) -> ThreadStoreFuture<'_, StoredThread> {
        self.projection.read_thread(params)
    }
    fn read_thread_by_rollout_path(
        &self,
        params: ReadThreadByRolloutPathParams,
    ) -> ThreadStoreFuture<'_, StoredThread> {
        self.projection.read_thread_by_rollout_path(params)
    }
    fn list_threads(&self, params: ListThreadsParams) -> ThreadStoreFuture<'_, ThreadPage> {
        self.projection.list_threads(params)
    }
    fn update_thread_metadata(
        &self,
        params: UpdateThreadMetadataParams,
    ) -> ThreadStoreFuture<'_, Option<StoredThread>> {
        Box::pin(async move {
            let id = params.thread_id;
            self.commit(id, Mutation::Metadata { params }).await?;
            self.projection
                .read_thread(ReadThreadParams {
                    thread_id: id,
                    include_archived: true,
                    include_history: false,
                })
                .await
                .map(Some)
        })
    }
    fn archive_thread(&self, _params: ArchiveThreadParams) -> ThreadStoreFuture<'_, ()> {
        Box::pin(async {
            Err(ThreadStoreError::Unsupported {
                operation: "custom store archive",
            })
        })
    }
    fn unarchive_thread(
        &self,
        _params: ArchiveThreadParams,
    ) -> ThreadStoreFuture<'_, StoredThread> {
        Box::pin(async {
            Err(ThreadStoreError::Unsupported {
                operation: "custom store unarchive",
            })
        })
    }
    fn delete_thread(&self, _params: DeleteThreadParams) -> ThreadStoreFuture<'_, ()> {
        Box::pin(async {
            Err(ThreadStoreError::Unsupported {
                operation: "custom store delete",
            })
        })
    }
}
