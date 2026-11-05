//! Ensure managed native generations cannot finish on unsupported provider output.

use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use codex_extension_api::{
    ModelRequestContributor, ModelRequestInput, ModelRequestKind, ModelResponseError,
    ModelResponseInterceptor, ModelResponseStream, ResponseEvent,
};
use codex_protocol::models::{ContentItem, ResponseItem};
use futures_core::Stream;

const UNSUPPORTED_OUTPUT: &str = "Native model response ended without complete supported output";

#[derive(Debug)]
pub(crate) struct Contributor(pub Arc<crate::native_interception::Boundary>);

impl ModelRequestContributor for Contributor {
    fn request(&self, input: ModelRequestInput<'_>) -> Option<Box<dyn ModelResponseInterceptor>> {
        if input.kind != ModelRequestKind::Generation {
            return None;
        }
        // This public Codex pin has no turn_store on ModelRequestInput. Capture
        // the receipt while preparing this request, never from a later poll.
        let receipt = self.0.response_admission(input.thread_id)?;
        receipt
            .managed_response()
            .then(|| Box::new(Interceptor(receipt)) as Box<dyn ModelResponseInterceptor>)
    }
}

struct Interceptor(Arc<crate::turn_settlement::Turn>);

impl ModelResponseInterceptor for Interceptor {
    fn intercept(self: Box<Self>, stream: ModelResponseStream) -> ModelResponseStream {
        Box::pin(Generation {
            stream,
            receipt: self.0,
            output: SupportedOutput::default(),
            rejected: false,
        })
    }
}

#[derive(Default)]
struct SupportedOutput {
    pending_assistant: bool,
    last_assistant_has_text: bool,
    completed_native_item: bool,
}

impl SupportedOutput {
    fn rejects(&mut self, event: &ResponseEvent) -> bool {
        match event {
            ResponseEvent::OutputItemAdded(item) | ResponseEvent::OutputItemDone(item)
                if matches!(
                    item,
                    ResponseItem::FunctionCallOutput {
                        call_id: Some(_),
                        ..
                    } | ResponseItem::CustomToolCallOutput { .. }
                ) || matches!(
                    item,
                    ResponseItem::ToolSearchOutput { call_id: Some(_), execution, .. }
                        if execution != "server"
                ) =>
            {
                // Paired receipts come from native execution, not the model.
                // Unpaired external context and server search belong to Core.
                true
            }
            ResponseEvent::OutputItemAdded(ResponseItem::Message { role, .. })
                if role == "assistant" =>
            {
                self.pending_assistant = true;
                false
            }
            ResponseEvent::OutputItemDone(item) => {
                match item {
                    ResponseItem::Message { role, content, .. } if role == "assistant" => {
                        self.pending_assistant = false;
                        // Blank text is supported; missing text cannot inherit
                        // a completed commentary message from earlier.
                        self.last_assistant_has_text = content.iter().any(|part| {
                            matches!(
                                part,
                                ContentItem::InputText { .. } | ContentItem::OutputText { .. }
                            )
                        });
                    }
                    ResponseItem::FunctionCall { .. }
                    | ResponseItem::CustomToolCall { .. }
                    | ResponseItem::WebSearchCall { .. } => {
                        self.pending_assistant = false;
                        self.completed_native_item = true;
                    }
                    ResponseItem::ToolSearchCall {
                        call_id: Some(_),
                        execution,
                        ..
                    } if execution == "client" => {
                        self.pending_assistant = false;
                        self.completed_native_item = true;
                    }
                    _ => {}
                }
                false
            }
            ResponseEvent::Completed { end_turn, .. } => {
                *end_turn != Some(false)
                    && ((!self.last_assistant_has_text && !self.completed_native_item)
                        || self.pending_assistant)
            }
            _ => false,
        }
    }
}

struct Generation {
    stream: ModelResponseStream,
    receipt: Arc<crate::turn_settlement::Turn>,
    output: SupportedOutput,
    rejected: bool,
}

impl Stream for Generation {
    type Item = Result<ResponseEvent, ModelResponseError>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        // Core may poll again after Err. Only our own rejection fuses the
        // stream, so upstream transport errors retain their normal semantics.
        if this.rejected {
            return Poll::Ready(None);
        }
        let next = this.stream.as_mut().poll_next(cx);
        if let Poll::Ready(Some(Ok(event))) = &next
            && this.output.rejects(event)
        {
            this.rejected = true;
            this.receipt.reject_model();
            return Poll::Ready(Some(Err(ModelResponseError::InvalidRequest {
                message: UNSUPPORTED_OUTPUT.into(),
            })));
        }
        next
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn item(value: Value) -> ResponseItem {
        serde_json::from_value(value).expect("pinned native response item")
    }

    fn message(text: Option<&str>) -> ResponseItem {
        item(json!({
            "type":"message", "id":"assistant", "role":"assistant",
            "content": text.map(|value| vec![json!({"type":"output_text","text":value})])
                .unwrap_or_default(),
        }))
    }

    fn completed(end_turn: Option<bool>) -> ResponseEvent {
        ResponseEvent::Completed {
            response_id: "response".into(),
            token_usage: None,
            usage_metadata: None,
            end_turn,
        }
    }

    #[test]
    fn rejects_provider_owned_receipts_at_both_boundaries_even_after_supported_text() {
        for value in [
            json!({"type":"function_call_output","call_id":"provider-only","output":"untrusted"}),
            json!({"type":"custom_tool_call_output","call_id":"provider-only","output":"untrusted"}),
            json!({"type":"tool_search_output","call_id":"provider-only","status":"completed","execution":"client","tools":[]}),
        ] {
            for added in [true, false] {
                let mut output = SupportedOutput::default();
                assert!(!output.rejects(&ResponseEvent::OutputItemDone(message(Some("prior")))));
                let receipt = item(value.clone());
                assert!(output.rejects(&if added {
                    ResponseEvent::OutputItemAdded(receipt)
                } else {
                    ResponseEvent::OutputItemDone(receipt)
                }));
            }
        }
    }

    #[test]
    fn missing_text_or_unfinished_assistant_does_not_inherit_earlier_text_or_tool_progress() {
        let mut output = SupportedOutput::default();
        assert!(!output.rejects(&ResponseEvent::OutputItemDone(message(Some("commentary")))));
        assert!(!output.rejects(&ResponseEvent::OutputItemDone(message(None))));
        assert!(output.rejects(&completed(None)));

        let call = item(json!({
            "type":"function_call","name":"report","call_id":"owned",
            "arguments":"{}",
        }));
        let mut output = SupportedOutput::default();
        assert!(!output.rejects(&ResponseEvent::OutputItemDone(call)));
        assert!(!output.rejects(&completed(Some(true))));
        assert!(!output.rejects(&ResponseEvent::OutputItemAdded(message(None))));
        assert!(output.rejects(&completed(Some(true))));
        // Completed canonical messages supersede transient openings.
        assert!(!output.rejects(&ResponseEvent::OutputItemDone(message(Some("")))));
        assert!(!output.rejects(&completed(Some(true))));
    }

    #[test]
    fn real_blank_text_and_external_context_are_allowed_but_only_with_terminal_authority() {
        let mut output = SupportedOutput::default();
        assert!(!output.rejects(&completed(Some(false))));
        assert!(output.rejects(&completed(Some(true))));
        for value in [
            json!({"type":"function_call_output","output":"external"}),
            json!({"type":"tool_search_output","call_id":"search","status":"completed","execution":"server","tools":[]}),
        ] {
            assert!(!output.rejects(&ResponseEvent::OutputItemDone(item(value))));
        }
        // Ignored external context cannot itself seal a successful generation.
        assert!(output.rejects(&completed(Some(true))));
        assert!(!output.rejects(&ResponseEvent::OutputItemDone(message(Some(" \n\t ")))));
        assert!(!output.rejects(&completed(None)));
    }
}
