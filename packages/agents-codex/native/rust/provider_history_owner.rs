//! Read-only history checks through the live native provider dispatcher.

use std::sync::Arc;

use base64::Engine as _;
use codex_extension_api::ModelProviderHistoryRoute;
use http::HeaderMap;

pub(crate) async fn resolve(
    engine: Arc<crate::engine::EngineState>,
    url: String,
    headers: HeaderMap,
) -> Result<ModelProviderHistoryRoute, String> {
    let unavailable = || "Provider history requires a current native HTTP provider".to_owned();
    let _operation = engine.operation(false).map_err(|_| unavailable())?;
    if engine.plan_authorization.is_some()
        || engine.manager.auth_manager().auth_mode() != Some(codex_protocol::auth::AuthMode::ApiKey)
    {
        return Err(unavailable());
    }
    let base = engine
        .sentinel
        .read()
        .expect("sentinel poisoned")
        .as_ref()
        .ok_or_else(unavailable)?
        .0
        .clone();
    let prefix = format!("{}/p-", base.trim_end_matches('/'));
    let encoded = url
        .strip_prefix(&prefix)
        .and_then(|path| path.strip_suffix("/responses"))
        .filter(|value| !value.is_empty())
        .ok_or_else(unavailable)?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| unavailable())?;
    if base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&decoded) != encoded {
        return Err(unavailable());
    }
    let provider_id = std::str::from_utf8(&decoded).map_err(|_| unavailable())?;
    let forwarded: Vec<_> = headers
        .iter()
        .map(|(name, value)| {
            (
                name.as_str(),
                value
                    .as_bytes()
                    .trim_ascii()
                    .iter()
                    .copied()
                    .map(char::from)
                    .collect::<String>(),
            )
        })
        .collect();
    let forwarded = serde_json::to_string(&forwarded).map_err(|_| unavailable())?;
    // Existing validation binds the provider ID to this Engine's current grant.
    let route = engine
        .sentinel_route(provider_id, &forwarded)
        .map_err(|_| unavailable())?;
    let mut provider = route
        .provider
        .api_provider()
        .await
        .map_err(|_| unavailable())?;
    let headers = crate::model_websocket::sentinel_headers(&forwarded, &provider)
        .map_err(|_| unavailable())?;
    // Scope identity uses the actual provider, never the private loopback URL.
    // Current credentials remain live memory and are excluded from snapshots.
    provider.headers = headers.clone();
    // Wire attribution stays outside the durable provider identity.
    let mut request_headers = codex_login::default_client::default_headers();
    request_headers.extend(headers);
    Ok(ModelProviderHistoryRoute {
        provider,
        transport: route.transport.clone(),
        headers: request_headers,
    })
}
