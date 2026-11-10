//! Bounded provider details retained by the pinned native error types.
use codex_http_client::RetryAfter;
use codex_protocol::error::{CodexErr, CodexErrorDetails};
use serde_json::{Value, json};

pub(crate) struct Receipt {
    diagnostics: Option<Value>,
    retryable: bool,
    retry_after: Option<RetryAfter>,
}

impl Receipt {
    pub(crate) fn capture(error: &CodexErr) -> Self {
        Self {
            diagnostics: metadata(error.details()),
            retryable: error.is_retryable(),
            retry_after: error.retry_after(),
        }
    }

    pub(crate) fn to_json(&self) -> Value {
        let mut value = self.diagnostics.clone().unwrap_or_else(|| json!({}));
        value["retryable"] = json!(self.retryable);
        // Keep the original deadline through contributor and cleanup waits.
        // Round up so reporting does not shorten a positive server delay.
        value["retry_after_ms"] = json!(
            self.retry_after
                .map(|advice| (advice.remaining_delay().as_secs_f64() * 1000.0).ceil())
        );
        value
    }
}

pub(crate) fn metadata(details: &CodexErrorDetails) -> Option<Value> {
    let (status, code, request_id) = match details {
        CodexErrorDetails::UnexpectedStatus(error) => (
            error.status.as_u16(),
            provider_code(&error.body),
            error.request_id.as_deref(),
        ),
        // Other RetryLimit statuses can be synthetic transport failures.
        CodexErrorDetails::RetryLimit(error)
            if error.status == http::StatusCode::TOO_MANY_REQUESTS =>
        {
            (error.status.as_u16(), None, error.request_id.as_deref())
        }
        CodexErrorDetails::ConnectionFailed(error) => (error.source.status()?.as_u16(), None, None),
        CodexErrorDetails::ResponseStreamFailed(error) => {
            (error.source.status()?.as_u16(), None, None)
        }
        _ => return None,
    };
    Some(json!({
        "status_code": status,
        "code": code,
        "request_id": request_id.filter(|id| {
            !id.is_empty() && id.len() <= 256 && id.bytes().all(|byte| byte.is_ascii_graphic())
        }),
    }))
}

pub(super) fn provider_code(body: &str) -> Option<String> {
    if body.len() > 128 * 1024 {
        return None;
    }
    let body: Value = serde_json::from_str(body).ok()?;
    let code = body.get("error")?.get("code")?.as_str()?;
    (!code.is_empty()
        && code.len() <= 128
        && code
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte)))
    .then(|| code.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_protocol::error::{RetryLimitReachedError, UnexpectedResponseError};
    use std::time::Duration;

    #[tokio::test]
    async fn retry_receipt_preserves_deadline_without_http_diagnostics() {
        let advice = RetryAfter::from_delay(Duration::from_millis(10)).unwrap();
        let error = CodexErr::new(CodexErrorDetails::ServerOverloaded).with_retry_after(advice);
        let receipt = Receipt::capture(&error);
        assert_eq!(receipt.retry_after, Some(advice));
        assert!(receipt.retryable);
        assert!(receipt.diagnostics.is_none());
        tokio::time::sleep(Duration::from_millis(20)).await;
        let value = receipt.to_json();
        assert_eq!(value["retryable"], true);
        assert_eq!(value["retry_after_ms"].as_f64(), Some(0.0));
        assert!(value.get("status_code").is_none());
    }

    #[test]
    fn retry_receipt_keeps_absent_and_zero_advice_distinct() {
        let error = CodexErr::new(CodexErrorDetails::ServerOverloaded);
        let value = Receipt::capture(&error).to_json();
        assert_eq!(value["retryable"], false);
        assert!(value["retry_after_ms"].is_null());
        let error = error.with_retry_after(RetryAfter::from_delay(Duration::ZERO).unwrap());
        let value = Receipt::capture(&error).to_json();
        assert_eq!(value["retryable"], true);
        assert_eq!(value["retry_after_ms"].as_f64(), Some(0.0));
        let terminal = CodexErr::new(CodexErrorDetails::InvalidRequest("invalid".into()));
        let value = Receipt::capture(&terminal).to_json();
        assert_eq!(value["retryable"], false);
        assert!(value["retry_after_ms"].is_null());
    }

    pub(super) fn observed(body: String, request_id: Option<String>) -> CodexErrorDetails {
        CodexErrorDetails::UnexpectedStatus(UnexpectedResponseError {
            status: http::StatusCode::INTERNAL_SERVER_ERROR,
            body,
            user_message: None,
            url: None,
            cf_ray: None,
            request_id,
            identity_authorization_error: None,
            identity_error_code: None,
        })
    }

    #[test]
    fn retains_observed_status_and_discards_synthetic_retry_status() {
        let synthetic = CodexErrorDetails::RetryLimit(RetryLimitReachedError {
            status: http::StatusCode::INTERNAL_SERVER_ERROR,
            request_id: Some("synthetic".into()),
        });
        assert!(metadata(&synthetic).is_none());
        let rate_limit = CodexErrorDetails::RetryLimit(RetryLimitReachedError {
            status: http::StatusCode::TOO_MANY_REQUESTS,
            request_id: Some("observed-429".into()),
        });
        assert_eq!(
            metadata(&rate_limit),
            Some(json!({
                "status_code":429, "code":null, "request_id":"observed-429"
            }))
        );
        assert_eq!(
            metadata(&observed(
                r#"{"error":{"code":"server_error"}}"#.into(),
                Some("request-500".into())
            )),
            Some(json!({"status_code":500,"code":"server_error","request_id":"request-500"}))
        );
    }

    #[test]
    fn bounds_provider_code_shape_bytes_and_characters() {
        for value in [
            json!(null),
            json!({"code":"nested"}),
            json!(""),
            json!("bad\ncode"),
            json!("x".repeat(129)),
            json!("é".repeat(65)),
        ] {
            assert!(provider_code(&json!({"error":{"code":value}}).to_string()).is_none());
        }
        assert_eq!(
            provider_code(&json!({"error":{"code":"a_.-9"}}).to_string()).as_deref(),
            Some("a_.-9")
        );
        assert_eq!(
            provider_code(&json!({"error":{"code":"x".repeat(128)}}).to_string())
                .unwrap()
                .len(),
            128
        );
        let mut body = json!({"error":{"code":"valid"}}).to_string();
        body.push_str(&" ".repeat(128 * 1024 - body.len()));
        assert_eq!(provider_code(&body).as_deref(), Some("valid"));
        body.push(' ');
        assert!(provider_code(&body).is_none());
    }

    #[test]
    fn bounds_request_ids_without_dropping_the_observed_status() {
        for id in [
            "".to_owned(),
            "two words".into(),
            "control\n".into(),
            "é".into(),
            "x".repeat(257),
        ] {
            assert_eq!(
                metadata(&observed("{}".into(), Some(id))).unwrap(),
                json!({"status_code":500,"code":null,"request_id":null})
            );
        }
        let id = "x".repeat(256);
        assert_eq!(
            metadata(&observed("{}".into(), Some(id.clone()))).unwrap()["request_id"],
            id
        );
    }
}
