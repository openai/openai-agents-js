//! Embedded command metadata and narrow adapters to existing native operations.

use anyhow::{Context, Result, ensure};
use codex_core_api::WithTurnExtensionData;
use codex_protocol::protocol::{
    Op, ReviewRequest, ReviewTarget, ThreadSettingsOverrides, W3cTraceContext,
};
use codex_thread_store::{StoredThread, ThreadMetadataPatch};
use serde_json::{Value, json};

use crate::{engine::ThreadState, python_tools::PythonTools};

#[path = "../.upstream/reviewed-codex/codex-rs/tui/src/slash_command.rs"]
mod slash_command;

use slash_command::SlashCommand;

fn supported(command: SlashCommand) -> bool {
    matches!(
        command,
        SlashCommand::Compact | SlashCommand::Stop | SlashCommand::Rename | SlashCommand::Review
    )
}

pub(crate) fn catalog() -> Value {
    Value::Array(
        slash_command::built_in_slash_commands()
            .into_iter()
            .filter(|(_, command)| supported(*command))
            .map(|(name, command)| {
                json!({
                    "name": name,
                    "description": command.description(),
                    "supports_inline_arguments": command.supports_inline_args(),
                })
            })
            .collect(),
    )
}

pub(crate) fn validate_arguments(name: &str, arguments: &str) -> Result<()> {
    let command = slash_command::built_in_slash_commands()
        .into_iter()
        .find(|(canonical, command)| *canonical == name && supported(*command))
        .map(|(_, command)| command)
        .context("Unsupported embedded command")?;
    ensure!(
        command.supports_inline_args() || arguments.trim().is_empty(),
        "Command does not support inline arguments"
    );
    if matches!(command, SlashCommand::Rename | SlashCommand::Review) {
        ensure!(!arguments.trim().is_empty(), "Command requires an argument");
    }
    Ok(())
}

// Callers hold the engine lifecycle, operation, and thread mutation guards.
pub(crate) async fn rename(state: &ThreadState, name: &str) -> Result<StoredThread> {
    let name =
        codex_core::util::normalize_thread_name(name).context("Thread name cannot be empty")?;
    Ok(state
        .engine
        .manager
        .update_thread_metadata(
            state.id,
            ThreadMetadataPatch {
                name: Some(Some(name)),
                ..Default::default()
            },
            false,
        )
        .await?)
}

// The returned ID acknowledges enqueueing, not background-terminal completion.
pub(crate) async fn stop(state: &ThreadState) -> Result<String> {
    Ok(state.thread.submit(Op::CleanBackgroundTerminals).await?)
}

pub(crate) async fn check_review(state: &ThreadState) -> Result<()> {
    let tools = state
        .thread
        .thread_extension_data()
        .get::<PythonTools>()
        .context("Review requires a managed Session")?;
    tools.check_idle(&state.thread).await?;
    if let Some(store) = &state.engine.local_checklist_store {
        store.check_failure(Some(state.id)).await?;
    }
    state.engine.operation(false)?;
    state.instructions.check_usable()?;
    ensure!(!state.is_closed(), "Codex thread is closed");
    crate::graph_stop::check_mutation(state)?;
    Ok(())
}

// Call check_review under the same guards before submitting settings or review.
pub(crate) async fn review(
    state: &ThreadState,
    instructions: &str,
    trace: Option<W3cTraceContext>,
) -> Result<String> {
    validate_arguments("review", instructions)?;
    let mut init = state.thread.config_snapshot().await.turn_extension_init;
    init.insert(None::<crate::python_tools::OperationSelection>);
    state
        .thread
        .update_thread_settings(WithTurnExtensionData::new(
            ThreadSettingsOverrides::default(),
            init,
        ))
        .await?;
    state.engine.operation(false)?;
    state.instructions.check_usable()?;
    ensure!(!state.is_closed(), "Codex thread is closed");
    crate::graph_stop::check_mutation(state)?;
    Ok(state
        .thread
        .submit_with_trace(
            Op::Review {
                review_request: ReviewRequest {
                    target: ReviewTarget::Custom {
                        instructions: instructions.to_owned(),
                    },
                    user_facing_hint: None,
                },
            },
            trace,
        )
        .await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_uses_native_order_descriptions_and_argument_metadata() {
        let catalog = catalog();
        let commands = catalog.as_array().unwrap();
        assert_eq!(
            commands
                .iter()
                .map(|command| command["name"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["review", "rename", "compact", "stop"]
        );
        for ((name, native), command) in slash_command::built_in_slash_commands()
            .into_iter()
            .filter(|(_, command)| supported(*command))
            .zip(commands)
        {
            assert_eq!(command["name"], name);
            assert_eq!(command["description"], native.description());
            assert_eq!(
                command["supports_inline_arguments"],
                native.supports_inline_args()
            );
            assert_eq!(command.as_object().unwrap().len(), 3);
        }
    }

    #[test]
    fn argument_validation_keeps_the_four_embedded_command_shapes() {
        for name in ["compact", "stop"] {
            assert!(validate_arguments(name, "").is_ok());
            assert!(validate_arguments(name, "  ").is_ok());
            assert!(validate_arguments(name, "unexpected").is_err());
        }
        for name in ["rename", "review"] {
            assert!(validate_arguments(name, "").is_err());
            assert!(validate_arguments(name, "  \n ").is_err());
            assert!(validate_arguments(name, "custom instructions with spaces").is_ok());
        }
        assert!(validate_arguments("clean", "").is_err());
        assert!(validate_arguments("unknown", "").is_err());
    }
}
