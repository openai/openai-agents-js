//! One application instruction owner, published through Core's native history.

use anyhow::{Context, Result, ensure};
use codex_core_api::CodexThread;
use codex_extension_api::{
    ContextContributor, ExtensionFuture, PreviousWorldStateSection, RenderedWorldStateFragment,
    SdkApplicationInstructions, SdkTurnReceiptSeed, WorldStateContributionInput,
    WorldStateSectionContribution,
};
use codex_history::{ResponseItemEnvelope, RolloutItem};
use codex_protocol::models::{
    ContentItem, ContentItemKind, InternalChatMessageMetadataPassthrough, ResponseItem,
};
use codex_protocol::protocol::EventMsg;
use codex_protocol::{ResponseItemId, ThreadId};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::{Arc, LazyLock};

use crate::options::ThreadInstructions;

const SECTION: &str = "sdk_application";
const ACCEPTED: &str = "sdk_application.accepted";
const PROJECTED: &str = "sdk_application.instructions";
const ID_PREFIX: &str = "msg_sdk_application";
const MARKERS: (&str, &str) = ("<application_instructions>", "</application_instructions>");
const REVISION: &str = "Native instruction revision: ";
const NOTICE: &str = "The following application instructions replace all earlier application instructions. An empty value clears them.\n";

#[derive(Clone)]
#[cfg_attr(test, derive(Debug, PartialEq, Eq))]
pub struct Accepted {
    pub(crate) id: ResponseItemId,
    pub(crate) text: String,
    pub(crate) files: Vec<Value>,
}

impl ThreadInstructions {
    pub(crate) fn realtime_snapshot(&self) -> Option<String> {
        self.accepted().map(|accepted| accepted.text)
    }
}

fn body(accepted: &Accepted) -> String {
    format!("{REVISION}{}\n{NOTICE}{}", accepted.id, accepted.text)
}

fn rendered(accepted: &Accepted) -> String {
    format!("{}{}{}", MARKERS.0, body(accepted), MARKERS.1)
}

fn decode_body(text: &str) -> Result<(&str, &str)> {
    let (id, text) = text
        .strip_prefix(MARKERS.0)
        .and_then(|text| text.strip_prefix(REVISION))
        .and_then(|text| text.split_once('\n'))
        .context("invalid revision for native application instructions")?;
    let text = text
        .strip_prefix(NOTICE)
        .and_then(|text| text.strip_suffix(MARKERS.1))
        .context("invalid native application instructions")?;
    Ok((id, text))
}

fn accepted(item: &ResponseItem) -> Result<Option<Accepted>> {
    let has_id = item
        .id()
        .is_some_and(|id| id.starts_with(&format!("{ID_PREFIX}_")));
    let ResponseItem::Message {
        id,
        role,
        content,
        phase,
        internal_chat_message_metadata_passthrough: metadata,
    } = item
    else {
        ensure!(!has_id, "invalid native application instructions item");
        return Ok(None);
    };
    let kinds = metadata
        .as_ref()
        .and_then(|metadata| metadata.content_item_kinds.as_deref());
    let has_kind = kinds.is_some_and(|kinds| kinds.iter().any(|kind| kind.0 == ACCEPTED));
    if !has_id && !has_kind {
        return Ok(None);
    }
    ensure!(
        has_id && id.is_some() && role == "developer" && phase.is_none(),
        "invalid identity for native application instructions"
    );
    ensure!(
        kinds == Some(&[ContentItemKind(ACCEPTED.to_owned())]),
        "invalid provenance for native application instructions"
    );
    let [ContentItem::InputText { text }] = content.as_slice() else {
        anyhow::bail!("invalid content for native application instructions");
    };
    let (body_id, text) = decode_body(text)?;
    let id = id
        .as_ref()
        .context("missing native application instructions identity")?;
    ensure!(
        id.as_str() == body_id,
        "application instructions body revision differs from item identity"
    );
    Ok(Some(Accepted {
        id: id.clone(),
        text: text.to_owned(),
        files: Vec::new(),
    }))
}

/// Core tolerates malformed content_item_kinds during serde reload. A retained
/// reserved SDK tag must not vanish through that fallback and become "legacy".
/// Inspect only native response-item locations, never arbitrary user content.
pub(crate) fn decode(history: Value) -> Result<Vec<RolloutItem>> {
    fn hints(item: &Value) -> (bool, Vec<&str>) {
        let reserved_id = item
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| id.starts_with(&format!("{ID_PREFIX}_")));
        let raw = item.pointer("/internal_chat_message_metadata_passthrough/content_item_kinds");
        let parts = match raw {
            Some(Value::Array(parts)) => parts.as_slice(),
            Some(value) => std::slice::from_ref(value),
            None => &[],
        };
        let kinds = parts
            .iter()
            .filter_map(Value::as_str)
            .filter(|kind| *kind == ACCEPTED || *kind == PROJECTED)
            .collect();
        (reserved_id, kinds)
    }
    fn item(raw: &Value, decoded: &Value) -> Result<()> {
        let evidence = hints(raw);
        if evidence.0 || !evidence.1.is_empty() {
            ensure!(
                raw.get("type").and_then(Value::as_str) == Some("message")
                    && evidence == hints(decoded),
                "invalid or erased reserved native application instructions evidence"
            );
        }
        Ok(())
    }
    let history_rows = history
        .as_array()
        .context("native history must be a list")?;
    let parsed: Vec<RolloutItem> =
        serde_json::from_value(history.clone()).context("Invalid checkpoint history record")?;
    for (raw, parsed) in history_rows.iter().zip(&parsed) {
        let normalized = serde_json::to_value(parsed)?;
        match parsed {
            RolloutItem::ResponseItem(_) => item(&raw["payload"], &normalized["payload"])?,
            RolloutItem::Compacted(_) => {
                if let Some(originals) = raw
                    .pointer("/payload/sdk_originals/items")
                    .and_then(Value::as_array)
                {
                    let decoded = normalized
                        .pointer("/payload/sdk_originals/items")
                        .and_then(Value::as_array)
                        .context("invalid SDK original projection catalog")?;
                    ensure!(
                        originals.len() == decoded.len(),
                        "SDK original projection catalog differs"
                    );
                    for (original, decoded) in originals.iter().zip(decoded) {
                        item(
                            &original["projection"]["item"],
                            &decoded["projection"]["item"],
                        )?;
                    }
                }
                if let Some(replacement) = raw
                    .pointer("/payload/replacement_history")
                    .and_then(Value::as_array)
                {
                    let normalized = normalized
                        .pointer("/payload/replacement_history")
                        .and_then(Value::as_array)
                        .context("invalid compacted native history")?;
                    ensure!(
                        replacement.len() == normalized.len(),
                        "compacted native history differs"
                    );
                    for (raw, parsed) in replacement.iter().zip(normalized) {
                        item(raw, parsed)?;
                    }
                }
            }
            _ => {}
        }
    }
    Ok(parsed)
}

/// Receipt-free Node formats 1/2 and the old manual format 3 remain readable.
/// Any reserved evidence must validate; an orphan projection is never legacy.
pub fn validate(history: &[RolloutItem], expected: &str) -> Result<Option<Accepted>> {
    let marked = |item: &ResponseItemEnvelope| {
        item.metadata.as_ref().is_some_and(|metadata| {
            metadata.sdk_agent_profile.is_some() || metadata.sdk_agent_graph.is_some()
        })
    };
    ensure!(
        !history.iter().any(|row| match row {
            RolloutItem::ResponseItem(item) => marked(item),
            RolloutItem::Compacted(compacted) => compacted
                .replacement_history
                .as_ref()
                .is_some_and(|items| items.iter().any(marked)),
            _ => false,
        }),
        "Restoring Agent profile history requires its fresh captured graph"
    );
    let latest = latest(history)?;
    if let Some(latest) = &latest {
        ensure!(
            latest.text == expected,
            "Restore requires Agent.instructions to match the checkpoint's latest accepted instructions"
        );
    }
    Ok(latest)
}

// Detached originals can rebuild model context during pop. Retain legacy
// instruction copies only when validated canonical history already owns them.
fn validate_detached_instruction_projections(history: &[RolloutItem]) -> Result<()> {
    use codex_history::sdk_originals::SdkOriginalHistoryCheckpoint;

    let reserved = |item: &ResponseItem| {
        let reserved_id = item.id().is_some_and(|id| {
            id.strip_prefix(ID_PREFIX)
                .is_some_and(|suffix| suffix.starts_with('_'))
        });
        let reserved_tag = matches!(item,
            ResponseItem::Message { internal_chat_message_metadata_passthrough: Some(metadata), .. }
            if metadata.content_item_kinds.as_ref().is_some_and(|kinds|
                kinds.iter().any(|kind| matches!(kind.0.as_str(), ACCEPTED | PROJECTED)))
        );
        reserved_id || reserved_tag
    };
    let key = |envelope: &ResponseItemEnvelope| -> serde_json::Result<Value> {
        let mut normalized = envelope.clone();
        if let ResponseItem::Message {
            internal_chat_message_metadata_passthrough: Some(metadata),
            ..
        } = &mut normalized.item
        {
            metadata.turn_id = None;
            metadata.create_time = None;
        }
        normalized.metadata = Some(normalized.metadata.take().unwrap_or_default());
        serde_json::to_value(normalized)
    };
    let mut canonical = std::collections::HashMap::<Value, Vec<&ResponseItemEnvelope>>::new();
    for record in history {
        match record {
            RolloutItem::ResponseItem(item) => {
                if reserved(&item.item) {
                    canonical.entry(key(item)?).or_default().push(item);
                }
            }
            RolloutItem::Compacted(compacted) => {
                for item in compacted.replacement_history.iter().flatten() {
                    if reserved(&item.item) {
                        canonical.entry(key(item)?).or_default().push(item);
                    }
                }
            }
            _ => {}
        }
    }
    for record in history {
        let RolloutItem::Compacted(compacted) = record else {
            continue;
        };
        let Some(SdkOriginalHistoryCheckpoint::Replace(originals)) = &compacted.sdk_originals
        else {
            continue;
        };
        for original in &originals.items {
            let Some(projection) = &original.projection else {
                continue;
            };
            if !reserved(&projection.item) {
                continue;
            }
            let same = |canonical: &ResponseItemEnvelope| {
                same_receipt(&projection.item, &canonical.item)
                    && projection.metadata.clone().unwrap_or_default()
                        == canonical.metadata.clone().unwrap_or_default()
            };
            let admitted = canonical
                .get(&key(projection)?)
                .is_some_and(|items| items.iter().any(|item| same(item)));
            ensure!(
                admitted,
                "SDK original instruction projection has no admitted canonical receipt"
            );
        }
    }
    Ok(())
}

/// Only original accepted items change authority. Compaction copies never do.
pub(crate) fn latest(history: &[RolloutItem]) -> Result<Option<Accepted>> {
    let mut originals: Vec<(&ResponseItem, Accepted)> = Vec::new();
    for row in history {
        if let RolloutItem::ResponseItem(item) = row {
            if let Some(mut accepted) = accepted(&item.item)? {
                if let Some(files) = item
                    .metadata
                    .as_ref()
                    .and_then(|metadata| metadata.sdk_instruction_files.clone())
                {
                    accepted.files = serde_json::from_value(files)
                        .context("Invalid native instruction file receipt")?;
                }
                ensure!(
                    !originals
                        .iter()
                        .any(|(original, _)| original.id() == item.item.id()),
                    "duplicate accepted application instructions identity"
                );
                originals.push((&item.item, accepted));
            }
        }
    }
    let latest = originals.last().map(|(_, accepted)| accepted);
    let mut has_prior_original = false;
    for row in history {
        // Projected evidence can also occur in original native world-state
        // rows. It never grants authority there or in a compaction replacement.
        let (replacement, compacted): (&[_], _) = match row {
            RolloutItem::Compacted(compacted) => match compacted.replacement_history.as_deref() {
                Some(replacement) => (replacement, true),
                None => {
                    ensure!(
                        !has_prior_original,
                        "compacted native history has no verifiable replacement instructions"
                    );
                    continue;
                }
            },
            RolloutItem::ResponseItem(item) => (std::slice::from_ref(item), false),
            _ => continue,
        };
        let mut contains_latest = false;
        let mut latest_is_last = false;
        for envelope in replacement {
            let item = &envelope.item;
            if let Some(accepted) = accepted(item)? {
                // An older receipt-free compaction remains legacy after this
                // thread acquires its first receipt. A later compaction must
                // still preserve instructions already accepted at its position.
                has_prior_original |= !compacted;
                ensure!(
                    originals
                        .iter()
                        .any(|(original, _)| same_receipt(item, original)),
                    "compacted application instructions differ from their accepted original"
                );
                latest_is_last = latest.is_some_and(|latest| accepted.id == latest.id);
                contains_latest |= latest_is_last;
                continue;
            }
            if let ResponseItem::Message {
                role,
                content,
                internal_chat_message_metadata_passthrough: metadata,
                ..
            } = item
            {
                let kinds = metadata
                    .as_ref()
                    .and_then(|metadata| metadata.content_item_kinds.as_deref());
                if kinds.is_some_and(|kinds| kinds.iter().any(|kind| kind.0 == PROJECTED)) {
                    ensure!(
                        kinds.is_some_and(|kinds| kinds.len() == content.len()),
                        "invalid projected application instructions"
                    );
                }
                for (index, part) in content.iter().enumerate() {
                    let tagged = kinds
                        .and_then(|kinds| kinds.get(index))
                        .is_some_and(|kind| kind.0 == PROJECTED);
                    // Ordinary legacy text may use these markers. Only a body
                    // naming an accepted revision can be a damaged projection.
                    let marked = role == "developer"
                        && matches!(part, ContentItem::InputText { text }
                            if decode_body(text).is_ok_and(|(id, _)|
                                originals.iter().any(|(_, accepted)| accepted.id.as_str() == id)));
                    if tagged || marked {
                        ensure!(
                            role == "developer"
                                && tagged
                                && kinds.is_some_and(|kinds| kinds.len() == content.len()),
                            "invalid projected application instructions"
                        );
                        let ContentItem::InputText { text } = part else {
                            anyhow::bail!("invalid projected application instructions")
                        };
                        let (id, text) = decode_body(text)?;
                        ensure!(
                            originals
                                .iter()
                                .any(|(_, accepted)| accepted.id.as_str() == id
                                    && accepted.text == text),
                            "projected application instructions have no accepted original"
                        );
                        latest_is_last = latest.is_some_and(|latest| latest.id.as_str() == id);
                        contains_latest |= latest_is_last;
                    }
                }
            }
        }
        // Core's retained matcher finds any exact copy. If that copy is present,
        // an older fragment after it would suppress the necessary current update.
        ensure!(
            !compacted || !contains_latest || latest_is_last,
            "compacted history places older application instructions after the latest accepted instructions"
        );
    }
    validate_detached_instruction_projections(history)?;
    Ok(latest.cloned())
}

/// Transfer only the validated initial SDK receipt of an otherwise empty
/// checkpoint. No Core context, response provenance or other history is moved.
pub(crate) fn take_initial_receipt(
    history: &mut Vec<RolloutItem>,
    latest: &Accepted,
    root: ThreadId,
) -> Option<ResponseItem> {
    let mut receipt_index = None;
    for (index, row) in history.iter().enumerate() {
        match row {
            RolloutItem::SessionMeta(_) => {}
            RolloutItem::EventMsg(EventMsg::ThreadSettingsApplied(event))
                if event.thread_id == Some(root) => {}
            RolloutItem::ResponseItem(envelope)
                if receipt_index.is_none()
                    && envelope.metadata.is_none()
                    && envelope.item.id() == Some(&latest.id) =>
            {
                receipt_index = Some(index);
            }
            _ => return None,
        }
    }
    match history.remove(receipt_index?) {
        RolloutItem::ResponseItem(envelope) => Some(envelope.item),
        _ => unreachable!("receipt_index identifies a response item"),
    }
}

pub(crate) fn publication(text: &str) -> ResponseItem {
    let accepted = Accepted {
        id: ResponseItemId::new(ID_PREFIX),
        text: text.to_owned(),
        files: Vec::new(),
    };
    ResponseItem::Message {
        id: Some(accepted.id.clone()),
        role: "developer".to_owned(),
        content: vec![ContentItem::InputText {
            text: rendered(&accepted),
        }],
        phase: None,
        internal_chat_message_metadata_passthrough: Some(InternalChatMessageMetadataPassthrough {
            content_item_kinds: Some(vec![ContentItemKind(ACCEPTED.to_owned())]),
            ..Default::default()
        }),
    }
}

fn same_receipt(actual: &ResponseItem, expected: &ResponseItem) -> bool {
    let normalize = |item: &ResponseItem| {
        let mut item = item.clone();
        if let ResponseItem::Message {
            internal_chat_message_metadata_passthrough: Some(metadata),
            ..
        } = &mut item
        {
            metadata.turn_id = None;
            metadata.create_time = None;
        }
        item
    };
    normalize(actual) == normalize(expected)
}

fn receipt<'a>(
    items: impl Iterator<Item = &'a ResponseItem>,
    expected: &ResponseItem,
) -> Result<()> {
    let matches = items
        .filter(|item| item.id() == expected.id())
        .collect::<Vec<_>>();
    ensure!(
        matches.len() == 1 && same_receipt(matches[0], expected),
        "native application instruction publication was not confirmed"
    );
    Ok(())
}

/// Prepare one immutable instruction envelope for an atomic Core profile activation.
pub(crate) fn prepare(
    thread: &CodexThread,
    text: &str,
    files: Vec<Value>,
) -> Result<(ResponseItemEnvelope, Accepted)> {
    let mut envelope = thread.annotate_client_response_item(publication(text));
    if !files.is_empty() {
        envelope
            .metadata
            .get_or_insert_with(Default::default)
            .sdk_instruction_files = Some(serde_json::to_value(&files)?);
    }
    let mut accepted = accepted(&envelope.item)?.context("Missing prepared Agent instructions")?;
    accepted.files = files;
    Ok((envelope, accepted))
}

/// The caller holds the existing native operation and idle mutation gates.
pub async fn publish(thread: &CodexThread, text: String) -> Result<()> {
    if crate::agent_profiles::update_instructions(thread, &text).await? {
        return Ok(());
    }
    publish_item(thread, publication(&text)).await
}

/// Explicit public edits update the same omission metadata before admission resumes.
pub async fn publish_explicit(thread: &CodexThread, text: String) -> Result<()> {
    let settings = crate::hosted_prompt::explicit_inputs(thread, true, false).await?;
    if crate::agent_profiles::update_instructions_with_settings(thread, &text, settings.as_ref())
        .await?
    {
        return Ok(());
    }
    let result = async {
        publish_item(thread, publication(&text)).await?;
        if let Some(settings) = settings {
            thread.update_thread_settings(settings).await?;
        }
        Ok(())
    }
    .await;
    if result.is_err() {
        if let Some(owner) = thread.thread_extension_data().get::<ThreadInstructions>() {
            owner.retire_uncertain();
        }
    }
    result
}

/// Publish an existing validated receipt on restore without allocating a revision.
pub(crate) async fn publish_item(thread: &CodexThread, item: ResponseItem) -> Result<()> {
    let owner = thread
        .thread_extension_data()
        .get::<ThreadInstructions>()
        .context("application instruction updates require a managed Session")?;
    owner.check_usable()?;
    let accepted = accepted(&item)?.context("missing application instructions publication")?;
    let result = async {
        thread.inject_response_items(vec![item.clone()]).await?;
        thread.flush_rollout().await?;
        let live = thread.conversation_history_snapshot().await;
        receipt(live.items(), &item)?;
        let stored = thread.load_history(true).await?;
        receipt(
            stored.items.iter().filter_map(|row| match row {
                RolloutItem::ResponseItem(item) => Some(&item.item),
                _ => None,
            }),
            &item,
        )?;
        owner.confirm(accepted)
    }
    .await;
    if result.is_err() {
        // Publication may have partially changed live or stored history. Only
        // this owner becomes unusable; its normal close path remains available.
        owner.retire_uncertain();
    }
    result
}

/// Called with a native mutation permit. Legacy sealed manual continuations
/// must not receive an unrelated response item before recovery is complete.
pub(crate) async fn publish_if_ready(
    thread: &CodexThread,
    include_legacy_manual: bool,
) -> Result<()> {
    let owner = thread
        .thread_extension_data()
        .get::<ThreadInstructions>()
        .context("thread instructions owner is missing")?;
    if owner.needs_publication(include_legacy_manual) {
        publish(thread, owner.text()?.unwrap_or_default()).await?;
    }
    Ok(())
}

static CODEX_SOURCE_TREE: LazyLock<String> = LazyLock::new(|| {
    let manifest: Value = serde_json::from_str(include_str!("../patches/series.json"))
        .expect("native patch manifest must be valid JSON");
    manifest["result_tree"]
        .as_str()
        .expect("native patch result tree")
        .to_owned()
});

pub(crate) fn sha256(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

/// Extract only the already accepted instruction owner captured for this request.
pub(crate) fn captured_prompt_text(
    step: Option<&codex_extension_api::ExtensionData>,
) -> Result<String> {
    let seed = step
        .and_then(|step| step.get::<SdkTurnReceiptSeed>())
        .context("Missing captured hosted prompt instruction owner")?;
    let application = seed
        .application
        .as_ref()
        .context("Missing accepted hosted prompt instructions")?;
    Ok(decode_body(&application.rendered)?.1.to_owned())
}

/// Remove only SDK-owned instruction parts from the detached provider projection.
/// Accepted canonical envelopes and unrelated parts stay with their original owners.
pub(crate) fn remove_prompt_fragments(items: &mut Vec<ResponseItem>) -> Result<()> {
    let mut invalid_metadata = false;
    items.retain_mut(|item| {
        let ResponseItem::Message {
            content,
            internal_chat_message_metadata_passthrough: Some(metadata),
            ..
        } = item
        else {
            return true;
        };
        let Some(kinds) = &mut metadata.content_item_kinds else {
            return true;
        };
        if !kinds
            .iter()
            .any(|kind| kind.0 == ACCEPTED || kind.0 == PROJECTED)
        {
            return true;
        }
        if kinds.len() != content.len() {
            invalid_metadata = true;
            return true;
        }
        let mut index = 0;
        content.retain(|_| {
            let keep = !matches!(kinds[index].0.as_str(), ACCEPTED | PROJECTED);
            index += 1;
            keep
        });
        kinds.retain(|kind| !matches!(kind.0.as_str(), ACCEPTED | PROJECTED));
        !content.is_empty()
    });
    ensure!(!invalid_metadata, "Invalid SDK instruction part metadata");
    Ok(())
}

pub struct Contributor;

impl ContextContributor for Contributor {
    fn contribute_world_state<'a>(
        &'a self,
        input: WorldStateContributionInput<'a>,
    ) -> ExtensionFuture<'a, Vec<WorldStateSectionContribution>> {
        Box::pin(async move {
            // Initial publication must be durable before this cache contributes.
            let captured = input
                .step_store
                .get::<codex_extension_api::AgentProfileInstructions>()
                .is_some();
            let omitted_prompt_instructions = input
                .request_controls
                .hosted_prompt
                .as_ref()
                .and_then(Option::as_ref)
                .is_some_and(|prompt| prompt.omit_instructions);
            let accepted = input.step_store.get::<Accepted>().or_else(|| {
                if captured
                    || input
                        .step_store
                        .get::<codex_extension_api::CapturedAgentProfile>()
                        .is_some()
                {
                    None
                } else {
                    input
                        .thread_store
                        .get::<ThreadInstructions>()
                        .and_then(|owner| owner.accepted())
                        .map(Arc::new)
                }
            });
            let control = input
                .thread_store
                .get::<crate::native_interception::Control>();
            input.step_store.insert(SdkTurnReceiptSeed {
                operation_declaration_source: input
                    .turn_store
                    .get::<Option<crate::python_tools::OperationSelection>>()
                    .and_then(|selection| {
                        selection
                            .as_ref()
                            .as_ref()
                            .and_then(|selection| selection.operation_declaration_source.clone())
                    }),
                codex_revision: include_str!("../CODEX_REVISION").trim(),
                codex_source_tree: CODEX_SOURCE_TREE.as_str(),
                sha256,
                strict_executor_writes: control
                    .as_ref()
                    .is_some_and(|control| control.strict_executor_writes()),
                inherited_application: if accepted.is_none() && !captured {
                    control.and_then(|control| control.inherited_instruction_files())
                } else {
                    None
                },
                application: accepted
                    .as_ref()
                    .filter(|_| !omitted_prompt_instructions)
                    .map(|accepted| SdkApplicationInstructions {
                        revision: accepted.id.to_string(),
                        rendered: rendered(accepted),
                        developer_sha256: sha256(&accepted.text),
                        files: accepted.files.clone(),
                    }),
            });
            let Some(accepted) = accepted.filter(|_| !omitted_prompt_instructions) else {
                return Vec::new();
            };
            let exact = rendered(&accepted);
            let retained = exact.clone();
            vec![
                WorldStateSectionContribution::new(SECTION, move |previous| {
                    let snapshot = Value::String(accepted.id.to_string());
                    // Both matchers require the *current* exact body. Known/Unknown
                    // therefore prove that body is already in retained native history.
                    let unchanged = !matches!(previous, PreviousWorldStateSection::Absent);
                    (
                        Some(snapshot),
                        (!unchanged).then(|| {
                            RenderedWorldStateFragment::new("developer", MARKERS, body(&accepted))
                        }),
                    )
                })
                .with_legacy_matcher(move |role, text| role == "developer" && text == exact)
                .with_retained_fragment_matcher(move |role, text| {
                    role == "developer" && text == retained
                }),
            ]
        })
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn detached_originals_validate_instructions_without_losing_caller_data() {
        use codex_history::sdk_originals::{
            SdkOriginalHistory, SdkOriginalHistoryCheckpoint, SdkOriginalItem,
        };
        let caller_original = serde_json::to_string(&json!({
            "type":"message", "role":"user", "content":"caller-owned audit value",
            "application_field":{"retained":true}
        }))
        .unwrap();
        let public: ResponseItem = serde_json::from_value(json!({
            "type":"message", "role":"developer",
            "content":[{"type":"input_text","text":"caller-owned projected value"}],
            "internal_chat_message_metadata_passthrough":{"content_item_kinds":["customer.note"]}
        }))
        .unwrap();
        let mut originals = SdkOriginalHistory::default();
        originals.append(SdkOriginalItem {
            original: caller_original.clone(),
            projection: Some(public.into()),
        });
        let compacted: RolloutItem = serde_json::from_value(json!({
            "type":"compacted", "payload":{"message":"summary", "replacement_history":[], "sdk_originals": originals}
        })).unwrap();
        let canonical: ResponseItemEnvelope = publication("A").into();
        let history = vec![RolloutItem::ResponseItem(canonical.clone()), compacted];
        assert!(latest(&history).is_ok());
        for tag in [ACCEPTED, PROJECTED] {
            let mut rejected = history.clone();
            let RolloutItem::Compacted(compacted) = &mut rejected[1] else {
                unreachable!()
            };
            let Some(SdkOriginalHistoryCheckpoint::Replace(originals)) =
                &mut compacted.sdk_originals
            else {
                unreachable!()
            };
            assert_eq!(originals.items[0].original, caller_original);
            let ResponseItem::Message {
                internal_chat_message_metadata_passthrough: Some(metadata),
                ..
            } = &mut originals.items[0].projection.as_mut().unwrap().item
            else {
                unreachable!()
            };
            metadata.content_item_kinds = Some(vec![ContentItemKind(tag.to_owned())]);
            assert!(
                latest(&rejected)
                    .err()
                    .unwrap()
                    .to_string()
                    .contains("no admitted canonical receipt")
            );
        }
        for projected in [false, true] {
            let mut legacy = history.clone();
            let mut admitted = canonical.clone();
            if projected {
                let ResponseItem::Message {
                    id,
                    internal_chat_message_metadata_passthrough: Some(metadata),
                    ..
                } = &mut admitted.item
                else {
                    unreachable!()
                };
                *id = None;
                metadata.content_item_kinds = Some(vec![ContentItemKind(PROJECTED.to_owned())]);
                legacy.push(RolloutItem::ResponseItem(admitted.clone()));
            }
            let RolloutItem::Compacted(compacted) = &mut legacy[1] else {
                unreachable!()
            };
            let Some(SdkOriginalHistoryCheckpoint::Replace(originals)) =
                &mut compacted.sdk_originals
            else {
                unreachable!()
            };
            originals.items[0].projection = Some(admitted);
            assert_eq!(originals.items[0].original, caller_original);
            assert!(latest(&legacy).is_ok());
        }
        let mut audit_only = history;
        let RolloutItem::Compacted(compacted) = &mut audit_only[1] else {
            unreachable!()
        };
        let Some(SdkOriginalHistoryCheckpoint::Replace(originals)) = &mut compacted.sdk_originals
        else {
            unreachable!()
        };
        originals.items[0].original =
            serde_json::to_string(&publication("opaque caller data")).unwrap();
        originals.items[0].projection = None;
        assert!(latest(&audit_only).is_ok());
    }

    use super::*;
    use serde_json::json;

    fn row(item: ResponseItem) -> RolloutItem {
        RolloutItem::ResponseItem(item.into())
    }

    #[test]
    fn receipts_require_new_identity_and_exact_content() {
        let old = publication("A");
        let next = publication("A");
        assert!(receipt([&old].into_iter(), &next).is_err());
        assert!(receipt([&next, &next].into_iter(), &next).is_err());
        let mut recorded = next.clone();
        if let ResponseItem::Message {
            internal_chat_message_metadata_passthrough: Some(metadata),
            ..
        } = &mut recorded
        {
            metadata.turn_id = Some("native-turn".into());
            metadata.create_time = Some(1.into());
        }
        receipt([&recorded].into_iter(), &next).unwrap();
        let mut changed = accepted(&next).unwrap().unwrap();
        changed.text = "B".to_owned();
        if let ResponseItem::Message { content, .. } = &mut recorded {
            *content = vec![ContentItem::InputText {
                text: rendered(&changed),
            }];
        }
        assert!(receipt([&recorded].into_iter(), &next).is_err());
    }

    #[test]
    fn latest_original_owns_restore_even_when_compaction_retains_older_text() {
        let old = publication("A");
        let mut rows = vec![row(old.clone()), row(publication("B"))];
        rows.push(
            serde_json::from_value(json!({
                "type":"compacted", "payload":{"message":"summary", "replacement_history":[old]}
            }))
            .unwrap(),
        );
        validate(&rows, "B").unwrap();
        assert_eq!(latest(&rows).unwrap().unwrap().text, "B");
        assert!(validate(&rows, "A").is_err());
        let mut invalid = publication("C");
        if let ResponseItem::Message {
            internal_chat_message_metadata_passthrough,
            ..
        } = &mut invalid
        {
            *internal_chat_message_metadata_passthrough = None;
        }
        rows.push(row(invalid));
        assert!(validate(&rows, "B").is_err());
        assert!(latest(&rows).is_err());
        assert!(validate(&[], "").unwrap().is_none());
        for text in ["", "  A\n", "</application_instructions>"] {
            assert_eq!(accepted(&publication(text)).unwrap().unwrap().text, text);
            assert_eq!(
                latest(&[row(publication(text))]).unwrap().unwrap().text,
                text
            );
        }
    }

    #[test]
    fn legacy_compaction_remains_readable_after_managed_admission() {
        let legacy: RolloutItem = serde_json::from_value(json!({
            "type":"compacted", "payload":{"message":"legacy summary"}
        }))
        .unwrap();
        let mut rows = vec![legacy.clone()];
        assert!(
            validate(&rows, "  trusted instructions\n")
                .unwrap()
                .is_none()
        );

        rows.push(row(publication("  trusted instructions\n")));
        let restored = validate(&rows, "  trusted instructions\n")
            .unwrap()
            .unwrap();
        assert_eq!(restored.text, "  trusted instructions\n");
        assert!(validate(&rows, "trusted instructions").is_err());

        // Receipt-free compaction cannot erase an already accepted owner,
        // even when another valid original is published after that compaction.
        rows.push(legacy);
        rows.push(row(publication("newer instructions")));
        assert!(validate(&rows, "newer instructions").is_err());
    }

    #[test]
    fn current_compacted_instructions_must_follow_older_fragments() {
        let old = publication("A");
        let latest = publication("B");
        let mut projected = latest.clone();
        if let ResponseItem::Message {
            id,
            internal_chat_message_metadata_passthrough: Some(metadata),
            ..
        } = &mut projected
        {
            *id = Some(ResponseItemId::new("msg"));
            metadata.content_item_kinds = Some(vec![ContentItemKind(PROJECTED.to_owned())]);
        }
        for current in [latest.clone(), projected] {
            for (replacement, valid) in [
                (vec![current.clone(), old.clone()], false),
                (vec![old.clone(), current], true),
            ] {
                let rows = vec![
                    row(old.clone()),
                    row(latest.clone()),
                    serde_json::from_value(json!({
                        "type":"compacted", "payload":{"message":"summary", "replacement_history":replacement}
                    }))
                    .unwrap(),
                ];
                assert_eq!(validate(&rows, "B").is_ok(), valid);
            }
        }
    }
    #[test]
    fn erased_tags_and_orphan_projections_are_not_legacy() {
        let mut tagged = serde_json::to_value(row(publication("A"))).unwrap();
        tagged["payload"]["id"] = Value::Null;
        tagged["payload"]["role"] = json!("user");
        tagged["payload"]["internal_chat_message_metadata_passthrough"]["content_item_kinds"] =
            json!([ACCEPTED, {"invalid":"kind"}]);
        assert!(decode(json!([tagged.clone()])).is_err());
        tagged["payload"]["internal_chat_message_metadata_passthrough"]["content_item_kinds"] =
            json!(ACCEPTED);
        assert!(decode(json!([tagged])).is_err());

        let mut projection = publication("A");
        if let ResponseItem::Message {
            id,
            internal_chat_message_metadata_passthrough: Some(metadata),
            ..
        } = &mut projection
        {
            *id = Some(ResponseItemId::new("msg"));
            metadata.content_item_kinds = Some(vec![ContentItemKind(PROJECTED.into())]);
        }
        assert!(latest(&[row(projection)]).is_err());
        let original = publication("A");
        let mut untagged = original.clone();
        if let ResponseItem::Message {
            id,
            internal_chat_message_metadata_passthrough,
            ..
        } = &mut untagged
        {
            *id = Some(ResponseItemId::new("msg"));
            *internal_chat_message_metadata_passthrough = None;
        }
        assert!(latest(&[row(original), row(untagged)]).is_err());
        let user: ResponseItem = serde_json::from_value(json!({
    "type":"message", "role":"user",
    "content":[{"type":"input_text", "text":"<application_instructions>hello</application_instructions>"}]
})).unwrap();
        assert!(latest(&[row(user)]).unwrap().is_none());
    }
}
