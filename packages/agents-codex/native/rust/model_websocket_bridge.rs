use std::sync::{Arc, Weak};

use anyhow::{Context, Result, ensure};
use codex_api::{ApiError, ResponsesWebsocketCommand, ResponsesWebsocketMessageTransport};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, frame::coding::CloseCode};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

use crate::engine::EngineState;
use crate::model_websocket::{
    Frame, MAX_REQUEST_BYTES, NativeModelWebSocket, open_message_transport, project_response_items,
};
use crate::model_websocket_prefix::Prefix;
use crate::native_interception::{self, Control, SentinelFailure};

pub(crate) async fn connect(
    engine: Arc<EngineState>,
    control: Arc<Control>,
    expected_url: String,
    request: http::Request<()>,
) -> Result<ResponsesWebsocketMessageTransport, ApiError> {
    let stopped = control.stopped_token().clone();
    let engine = Arc::downgrade(&engine);
    let (commands, command_rx) = mpsc::channel(32);
    let (message_tx, messages) = mpsc::unbounded_channel();
    let (mut ready, connected) = oneshot::channel();
    let owner = Arc::clone(&control);
    let retired = || ApiError::Stream("Native WebSocket owner ended".into());
    let driver = control
        .track_websocket_driver(async move {
            let Some(opening_engine) = engine.upgrade() else {
                let _ = ready.send(Err(retired()));
                return;
            };
            let result = tokio::select! {
                biased;
                () = stopped.cancelled() => return,
                () = ready.closed() => return,
                result = open_message_transport(&opening_engine, &expected_url, request) => result,
            };
            drop(opening_engine);
            let (provider, socket, headers) = match result {
                Ok(result) => result,
                Err(error) => {
                    let _ = ready.send(Err(error));
                    return;
                }
            };
            if ready.send(Ok(headers)).is_ok() {
                let mut bridge = Bridge {
                    engine: &engine,
                    owner: &owner,
                    provider: &provider,
                    socket: &socket,
                    prefix: Prefix::default(),
                    pending: None,
                    generation: None,
                };
                let result = tokio::select! {
                    biased;
                    () = stopped.cancelled() => Ok(()),
                    () = message_tx.closed() => Ok(()),
                    result = bridge.run(command_rx, &message_tx) => result,
                };
                if let Some((ticket, oversized)) = bridge.pending.take()
                    && let Some(engine) = engine.upgrade()
                {
                    let _ = native_interception::sentinel_failed(
                        &engine,
                        &provider,
                        &ticket,
                        SentinelFailure::WebSocket { oversized },
                    );
                }
                if result.is_err() {
                    let _ = message_tx.send(Ok(Message::Close(Some(CloseFrame {
                        code: CloseCode::Error,
                        reason: "Native provider request failed".into(),
                    }))));
                }
            }
            let _ = socket.close(1000, String::new()).await;
        })
        .map_err(|_| retired())?;
    let headers = connected.await.map_err(|_| retired())??;
    Ok(ResponsesWebsocketMessageTransport {
        commands,
        messages,
        driver,
        headers,
    })
}

struct Generation {
    request: Value,
    model: String,
    warmup: bool,
    content_item_kinds: bool,
    output: Vec<Value>,
}

struct Bridge<'a> {
    engine: &'a Weak<EngineState>,
    owner: &'a Control,
    provider: &'a str,
    socket: &'a NativeModelWebSocket,
    prefix: Prefix,
    pending: Option<(Value, bool)>,
    generation: Option<Generation>,
}

impl Bridge<'_> {
    async fn run(
        &mut self,
        mut commands: mpsc::Receiver<ResponsesWebsocketCommand>,
        messages: &mpsc::UnboundedSender<Result<Message, WsError>>,
    ) -> Result<()> {
        let mut buffered = None;
        loop {
            tokio::select! {
                biased;
                command = commands.recv() => {
                    let Some(ResponsesWebsocketCommand::Send { message, tx_result }) = command else {
                        return Ok(());
                    };
                    // Acknowledge the local handoff, as the loopback socket did.
                    // Upstream failures retire the admitted request before closing.
                    if tx_result.send(Ok(())).is_err() {
                        return Ok(());
                    }
                    // Apply the carrier's message limit before any JSON parsing.
                    if message.len() > MAX_REQUEST_BYTES {
                        let _ = messages.send(Ok(Message::Close(Some(CloseFrame {
                            code: CloseCode::Size,
                            reason: Default::default(),
                        }))));
                        return Ok(());
                    }
                    let Message::Text(message) = message else {
                        ensure!(matches!(message, Message::Close(_)), "Invalid native WebSocket request");
                        return Ok(());
                    };
                    self.send(relay_json(message.as_str())?).await?;
                    if let Some(frame) = buffered.take() {
                        self.forward(Some(frame), messages)?;
                    }
                }
                received = self.socket.receive_frame(), if buffered.is_none() => {
                    let frame = received.map_err(|error| anyhow::anyhow!(error.reason))?;
                    if self.generation.is_some() {
                        self.forward(frame, messages)?;
                    } else {
                        match frame {
                            None | Some(Frame::Close(..) | Frame::Closed) => return Ok(()),
                            Some(frame) => buffered = Some(frame),
                        }
                    }
                }
            }
        }
    }

    fn forward(
        &mut self,
        frame: Option<Frame>,
        messages: &mpsc::UnboundedSender<Result<Message, WsError>>,
    ) -> Result<()> {
        let Some(Frame::Text(text)) = frame else {
            anyhow::bail!("Native provider ended before completion");
        };
        self.observe(relay_json(&text)?)?;
        messages
            .send(Ok(Message::Text(text.into())))
            .map_err(|_| anyhow::anyhow!("Native WebSocket consumer ended"))
    }

    async fn send(&mut self, mut body: Value) -> Result<()> {
        if body["type"] == "response.interrupt" {
            self.prefix
                .validate_interrupt(
                    &body,
                    self.generation
                        .as_ref()
                        .is_some_and(|generation| !generation.warmup),
                )
                .map_err(anyhow::Error::msg)?;
            self.socket
                .send_text(serde_json::to_string(&body)?)
                .await
                .map_err(|error| anyhow::anyhow!(error.reason))?;
            return Ok(());
        }
        ensure!(
            body["type"] == "response.create" && self.pending.is_none(),
            "Unexpected native WebSocket request"
        );
        let engine = self
            .engine
            .upgrade()
            .context("Native WebSocket owner ended")?;
        let permit = engine.operation(false)?;
        let metadata = body["client_metadata"].take();
        ensure!(metadata.is_object(), "Invalid native model metadata");
        ensure!(
            metadata.get("sdk_sentinel_thread").and_then(Value::as_str)
                == Some(self.owner.thread_id()),
            "Native WebSocket thread changed"
        );
        let ticket = json!({
            "sdk_sentinel_thread": metadata.get("sdk_sentinel_thread"),
            "sdk_sentinel_nonce": metadata.get("sdk_sentinel_nonce"),
        });
        let mut receipt = relay_json(
            &native_interception::sentinel_admit(&engine, self.provider, &metadata).await?,
        )?;
        let Value::String(model) = receipt["model"].take() else {
            anyhow::bail!("Invalid native model admission");
        };
        let model_matches = if receipt["model_omitted"] == true {
            body.get("model").is_none()
        } else {
            body["model"].as_str() == Some(model.as_str())
        };
        let warmup = receipt["kind"] == "warmup";
        ensure!(
            receipt["control"].as_str() == Some(self.owner.incarnation.as_str())
                && model_matches
                && (warmup || receipt["kind"] == "generation"),
            "Invalid native model admission"
        );
        self.pending = Some((ticket.clone(), false));
        let Value::Object(mut metadata) = metadata else {
            unreachable!("validated native model metadata is an object");
        };
        metadata.remove("sdk_sentinel_thread");
        metadata.remove("sdk_sentinel_nonce");
        body["client_metadata"] = Value::Object(metadata);
        let native_continuation = body["previous_response_id"].is_string();
        let mut body = self
            .prefix
            .reconstruct(body, &model, receipt.get("completion"))
            .map_err(anyhow::Error::msg)?;
        native_interception::sentinel_restore_schemas(&engine, self.provider, &ticket, &mut body)
            .await?;
        normalize_relay_numbers(&mut body)?;
        ensure!(body["input"].is_array(), "Invalid native Responses input");
        drop(permit);
        drop(engine);
        let wire = self
            .prefix
            .encode(&body, &model, native_continuation)
            .map_err(anyhow::Error::msg)?;
        let payload = serde_json::to_string(&wire)?;
        if payload.len() > MAX_REQUEST_BYTES {
            self.pending.as_mut().expect("native request admitted").1 = true;
            anyhow::bail!("Native WebSocket request exceeds transport limit");
        }
        self.socket
            .send_text(payload)
            .await
            .map_err(|error| anyhow::anyhow!(error.reason))?;
        self.generation = Some(Generation {
            request: body,
            model,
            warmup,
            content_item_kinds: receipt["content_item_kinds"] == true,
            output: Vec::new(),
        });
        Ok(())
    }

    fn observe(&mut self, event: Value) -> Result<()> {
        ensure!(event.is_object(), "Invalid native provider response");
        let generation = self
            .generation
            .as_mut()
            .context("Native WebSocket generation ended")?;
        let kind = event["type"].as_str();
        match kind {
            Some("response.created") => self
                .prefix
                .observe_created(&event["response"])
                .map_err(anyhow::Error::msg)?,
            Some("response.output_item.done") if !event["item"].is_null() => {
                generation.output.push(event["item"].clone())
            }
            _ => {}
        }
        let response = &event["response"];
        ensure!(
            response.is_null() || response.is_object(),
            "Invalid native provider response metadata"
        );
        let complete = response.is_object()
            && (kind == Some("response.completed")
                || (kind == Some("response.incomplete")
                    && response["incomplete_details"]["reason"] == "interrupted"));
        if complete {
            let generation = self.generation.take().expect("native generation exists");
            let response_id = response["id"]
                .as_str()
                .context("Native WebSocket completion has no response ID")?;
            let projected =
                project_response_items(generation.output, generation.content_item_kinds);
            let mut projected = serde_json::to_value(projected)?;
            normalize_relay_numbers(&mut projected)?;
            let Value::Array(projected) = projected else {
                unreachable!("projected response items are an array");
            };
            self.prefix
                .commit(
                    response_id.to_owned(),
                    generation.request,
                    projected,
                    generation.model,
                    generation.warmup,
                )
                .map_err(anyhow::Error::msg)?;
            self.pending = None;
        } else if matches!(
            kind,
            Some("error" | "response.failed" | "response.incomplete")
        ) {
            self.generation = None;
            self.pending = None;
            self.prefix.clear_provider_prefix();
        }
        Ok(())
    }
}

fn relay_json(source: &str) -> Result<Value> {
    let mut value = serde_json::from_str(source)?;
    normalize_relay_numbers(&mut value)?;
    Ok(value)
}

// The original carrier parses JSON through Node before editing or projecting it.
// Apply the same finite binary64 number semantics at those edit boundaries.
fn normalize_relay_numbers(value: &mut Value) -> Result<()> {
    match value {
        Value::Array(items) => {
            for item in items {
                normalize_relay_numbers(item)?;
            }
        }
        Value::Object(fields) => {
            for item in fields.values_mut() {
                normalize_relay_numbers(item)?;
            }
        }
        Value::Number(number) => {
            const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
            if let Some(integer) = number
                .as_i64()
                .filter(|value| value.unsigned_abs() <= MAX_SAFE_INTEGER)
            {
                if integer == 0 {
                    *number = 0.into();
                }
                return Ok(());
            }
            let parsed = number
                .as_f64()
                .filter(|value| value.is_finite())
                .context("Expected a finite JSON value")?;
            if parsed == 0.0 {
                *number = 0.into();
                return Ok(());
            }
            let rounded =
                serde_json::Number::from_f64(parsed).context("Expected a finite JSON value")?;
            if parsed.fract() == 0.0 && parsed.abs() < 1e21 {
                let source = rounded.to_string();
                if let Some(integer) = source.strip_suffix(".0") {
                    *number = integer.parse()?;
                    return Ok(());
                }
                if let Some((mantissa, exponent)) = source.split_once('e') {
                    let (integer, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
                    let zeros = exponent
                        .parse::<usize>()?
                        .checked_sub(fraction.len())
                        .context("Invalid integer representation")?;
                    *number = format!("{integer}{fraction}{}", "0".repeat(zeros)).parse()?;
                    return Ok(());
                }
            }
            *number = rounded;
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::relay_json;

    #[test]
    fn relay_projection_uses_finite_javascript_numbers() {
        let value = relay_json(r#"{"values":[-0,2.0,9007199254740993,1e-8]}"#).unwrap();
        assert_eq!(value["values"][0].to_string(), "0");
        assert_eq!(value["values"][1].to_string(), "2");
        assert_eq!(value["values"][2].to_string(), "9007199254740992");
        assert_eq!(value["values"][3].as_f64(), Some(1e-8));
        assert_eq!(
            relay_json("-601529457621085.2").unwrap().to_string(),
            "-601529457621085.2"
        );
        assert_eq!(
            relay_json("1.0000000000000001e20").unwrap().to_string(),
            "100000000000000020000"
        );
        assert!(relay_json(r#"{"value":1e400}"#).is_err());
    }
}
