//! Read the account's plan usage without refreshing the saved login.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, ensure};
use chrono::Utc;
use codex_app_server_protocol::RateLimitSnapshot;
use codex_backend_client::{Client, RateLimitsWithResetCredits};
use codex_http_client::HttpClientFactory;
use codex_login::token_data::parse_jwt_expiration;
use codex_login::{AuthManager, CodexAuth, TokenData, default_client::get_codex_user_agent};
use codex_model_provider::BearerAuthProvider;
use serde::Serialize;

const ACCOUNT_BASE_URL: &str = "https://chatgpt.com/backend-api";
const READ_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanUsage<'a> {
    account_id: Option<&'a str>,
    identity_verified: bool,
    observed_at: f64,
    ordinary_usage_allowed: Option<bool>,
    rate_limits: Vec<RateLimitSnapshot>,
    reset_credits_available: Option<i64>,
}

// Keep the route pool across reads. Each read attaches its own auth snapshot.
#[derive(Clone)]
pub(crate) struct PlanUsageReader(Client);

impl PlanUsageReader {
    pub(crate) fn new(manager: &AuthManager) -> Self {
        Self::with_client(ACCOUNT_BASE_URL, manager.http_client_factory())
    }

    fn with_client(base_url: &str, factory: HttpClientFactory) -> Self {
        Self(
            Client::new_without_redirects(base_url, factory)
                .with_user_agent(get_codex_user_agent()),
        )
    }

    pub(crate) async fn read(&self, manager: &AuthManager) -> Result<String> {
        let Some(auth @ CodexAuth::Chatgpt(_)) = manager.auth_cached() else {
            anyhow::bail!("Saved Codex login is unavailable");
        };
        // The saved manager constrains reloads to the original owner. Capture
        // credentials and identity together from its current cached state.
        let tokens = auth
            .get_token_data()
            .map_err(|_| anyhow::anyhow!("Saved Codex login is unavailable"))?;
        self.read_tokens(tokens).await
    }

    async fn read_tokens(&self, tokens: TokenData) -> Result<String> {
        let account_id = tokens.account_id.as_deref();
        let user_id = tokens
            .id_token
            .chatgpt_user_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .context("Saved Codex user ID is unavailable")?;
        ensure!(
            !tokens.id_token.is_fedramp_account(),
            "Codex plan usage is unavailable for this account route"
        );
        ensure!(
            !tokens.access_token.is_empty()
                && tokens
                    .access_token
                    .bytes()
                    .all(|byte| (0x21..=0x7e).contains(&byte))
                && account_id
                    .is_none_or(|id| !id.is_empty() && http::HeaderValue::from_str(id).is_ok()),
            "Saved Codex login is unavailable"
        );
        if let Ok(Some(expiry)) = parse_jwt_expiration(&tokens.access_token) {
            ensure!(expiry > Utc::now(), "Saved Codex login has expired");
        }
        let client = self
            .0
            .clone()
            .with_auth_provider(Arc::new(BearerAuthProvider {
                token: Some(tokens.access_token),
                account_id: tokens.account_id.clone(),
                is_fedramp_account: false,
            }));
        let response =
            tokio::time::timeout(READ_TIMEOUT, client.get_rate_limits_with_reset_credits())
                .await
                .context("Codex plan usage read timed out")?
                // Backend errors can include the response body. Never carry them across this boundary.
                .map_err(|_| anyhow::anyhow!("Unable to read Codex plan usage"))?;
        Ok(serde_json::to_string(&snapshot(
            response, account_id, user_id,
        )?)?)
    }
}

#[cfg(test)]
mod tests {
    use std::convert::Infallible;

    use bytes::Bytes;
    use http::{Method, Response, StatusCode};
    use http_body_util::Full;
    use hyper::server::conn::http1;
    use hyper::service::service_fn;
    use hyper_util::rt::TokioIo;
    use serde_json::{Value, json};
    use tokio::net::TcpListener;

    use super::*;

    fn fixture_tokens() -> TokenData {
        TokenData {
            account_id: Some("fixture-account".into()),
            id_token: codex_login::token_data::IdTokenInfo {
                chatgpt_user_id: Some("fixture-user".into()),
                ..Default::default()
            },
            access_token: "fixture-access".into(),
            ..Default::default()
        }
    }

    async fn feed(
        status: StatusCode,
        payload: Value,
    ) -> (PlanUsageReader, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let factory =
            HttpClientFactory::new(codex_http_client::OutboundProxyPolicy::ReqwestDefault);
        let reader =
            PlanUsageReader::with_client(&format!("http://{address}/backend-api"), factory);
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let body = Bytes::from(payload.to_string());
            let service = service_fn(|request: hyper::Request<hyper::body::Incoming>| {
                let body = body.clone();
                async move {
                    assert_eq!(request.method(), Method::GET);
                    assert_eq!(request.uri(), "/backend-api/wham/usage");
                    assert_eq!(request.headers()["authorization"], "Bearer fixture-access");
                    assert_eq!(request.headers()["chatgpt-account-id"], "fixture-account");
                    assert!(
                        !request
                            .headers()
                            .contains_key("x-openai-codex-luna-reserve")
                    );
                    Ok::<_, Infallible>(
                        Response::builder()
                            .status(status)
                            .header("content-type", "application/json")
                            .header("connection", "close")
                            .header("location", "/fixture-redirect")
                            .body(Full::new(body))
                            .unwrap(),
                    )
                }
            });
            http1::Builder::new()
                .serve_connection(TokioIo::new(socket), service)
                .await
                .unwrap();
            if status.is_redirection() {
                assert!(
                    tokio::time::timeout(Duration::from_millis(100), listener.accept())
                        .await
                        .is_err(),
                    "Account usage followed a redirect"
                );
            }
        });
        (reader, server)
    }

    #[tokio::test]
    async fn passive_read_reports_the_bound_accounts_windows_and_reset_credit_count() {
        let (reader, server) = feed(
            StatusCode::OK,
            json!({
                "account_id": "fixture-account",
                "user_id": "fixture-user",
                "plan_type": "plus",
                "rate_limit": {
                    "allowed": false,
                    "limit_reached": true,
                    "primary_window": {
                        "used_percent": 0, "limit_window_seconds": 18000,
                        "reset_after_seconds": 60, "reset_at": 2_000_000_000_i64
                    },
                    "secondary_window": {
                        "used_percent": 10, "limit_window_seconds": 604800,
                        "reset_after_seconds": 120, "reset_at": 2_000_000_060_i64
                    }
                },
                "credits": { "has_credits": true, "unlimited": false, "balance": "4.25" },
                "spend_control": {
                    "reached": false,
                    "individual_limit": {
                        "limit": "25000", "used": "8000", "remaining": "17000",
                        "used_percent": 32, "remaining_percent": 68,
                        "reset_after_seconds": 3600, "reset_at": 2_000_000_300_i64
                    }
                },
                "additional_rate_limits": [{
                    "limit_name": "Fixture feature",
                    "metered_feature": "fixture-feature",
                    "normal_model_slug": "fixture-model"
                }],
                "rate_limit_reset_credits": { "available_count": 0 },
                "rate_limit_upsell": { "title": "fixture-private-value" }
            }),
        )
        .await;
        let before = Utc::now().timestamp_millis() as f64 / 1000.0;
        let wire = reader.read_tokens(fixture_tokens()).await.unwrap();
        let result: Value = serde_json::from_str(&wire).unwrap();
        let after = Utc::now().timestamp_millis() as f64 / 1000.0;
        server.await.unwrap();
        assert_eq!(result["accountId"], "fixture-account");
        assert_eq!(result["identityVerified"], true);
        assert_eq!(result["ordinaryUsageAllowed"], false);
        assert!((before..=after).contains(&result["observedAt"].as_f64().unwrap()));
        assert_eq!(result["resetCreditsAvailable"], 0);
        assert_eq!(
            result["rateLimits"][0]["primary"],
            json!({ "usedPercent": 0, "windowDurationMins": 300, "resetsAt": 2_000_000_000_i64 })
        );
        assert_eq!(result["rateLimits"][0]["secondary"]["usedPercent"], 10);
        assert_eq!(result["rateLimits"][0]["credits"]["balance"], "4.25");
        assert_eq!(result["rateLimits"][0]["spendControlReached"], false);
        assert_eq!(
            result["rateLimits"][0]["individualLimit"],
            json!({ "limit": "25000", "used": "8000", "remainingPercent": 68, "resetsAt": 2_000_000_300_i64 })
        );
        assert_eq!(result["rateLimits"][1]["limitId"], "fixture-feature");
        assert_eq!(result["rateLimits"][1]["normalModelSlug"], "fixture-model");
        assert_eq!(result["rateLimits"][1]["primary"], Value::Null);
        assert!(!wire.contains("fixture-private-value") && !wire.contains("fixture-user"));
    }

    #[tokio::test]
    async fn missing_identity_suppresses_the_usage_decision() {
        let (reader, server) = feed(
            StatusCode::OK,
            json!({
                "account_id": "fixture-account",
                "plan_type": "plus",
                "rate_limit": { "allowed": true, "limit_reached": false }
            }),
        )
        .await;
        let wire = reader.read_tokens(fixture_tokens()).await.unwrap();
        let result: Value = serde_json::from_str(&wire).unwrap();
        server.await.unwrap();
        assert_eq!(result["identityVerified"], false);
        assert_eq!(result["ordinaryUsageAllowed"], Value::Null);
        assert_eq!(result["resetCreditsAvailable"], Value::Null);
    }

    #[tokio::test]
    async fn mismatched_identity_and_redirects_fail_without_response_details() {
        for (status, message) in [
            (
                StatusCode::OK,
                "Codex plan usage did not match the Session's saved login",
            ),
            (
                StatusCode::TEMPORARY_REDIRECT,
                "Unable to read Codex plan usage",
            ),
        ] {
            let (reader, server) = feed(
                status,
                json!({ "user_id": "fixture-wrong-user", "plan_type": "plus" }),
            )
            .await;
            let error = reader.read_tokens(fixture_tokens()).await.unwrap_err();
            assert_eq!(format!("{error:#}"), message);
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn known_expired_credentials_fail_before_account_io() {
        let (reader, server) = feed(StatusCode::OK, json!({ "plan_type": "plus" })).await;
        let mut tokens = fixture_tokens();
        // A synthetic JWT envelope whose payload is {"exp": 1}.
        tokens.access_token = "fixture.eyJleHAiOjF9.signature".into();
        let error = reader.read_tokens(tokens).await.unwrap_err();
        server.abort();
        assert_eq!(error.to_string(), "Saved Codex login has expired");
    }
}

fn snapshot<'a>(
    response: RateLimitsWithResetCredits,
    account_id: Option<&'a str>,
    user_id: &str,
) -> Result<PlanUsage<'a>> {
    ensure!(
        response
            .account_id
            .as_deref()
            .zip(account_id)
            .is_none_or(|(reported, bound)| reported == bound)
            && response
                .user_id
                .as_deref()
                .is_none_or(|reported| reported == user_id),
        "Codex plan usage did not match the Session's saved login"
    );
    let identity_verified =
        account_id.is_some() && response.account_id.is_some() && response.user_id.is_some();
    Ok(PlanUsage {
        account_id,
        identity_verified,
        observed_at: Utc::now().timestamp_millis() as f64 / 1000.0,
        ordinary_usage_allowed: response
            .ordinary_usage_allowed
            .filter(|_| identity_verified),
        rate_limits: response.rate_limits.into_iter().map(Into::into).collect(),
        reset_credits_available: response
            .rate_limit_reset_credits
            .map(|summary| summary.available_count),
    })
}
