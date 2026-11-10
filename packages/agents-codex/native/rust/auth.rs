//! SDK-owned authentication for model requests and Apps.

use std::num::NonZeroU64;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result, ensure};
use codex_core_api::Config;
use codex_login::{
    AuthManager, CodexAuth, ExternalAuth, ExternalAuthFuture, ExternalAuthRefreshContext,
};
use codex_protocol::config_types::ModelProviderAuthInfo;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SavedCodexLogin {
    codex_home: Option<PathBuf>,
    account_id: Option<String>,
}

impl SavedCodexLogin {
    pub(crate) async fn open(self, config: &Config) -> Result<(Arc<AuthManager>, PathBuf)> {
        let codex_home = match self.codex_home {
            Some(path) => path,
            None => codex_core::config::find_codex_home()
                .context("Cannot locate the Codex login directory")?
                .to_path_buf(),
        }
        .canonicalize()
        .context("Cannot open the Codex login directory")?;
        let auth_file = codex_home.join("auth.json");
        ensure!(
            auth_file
                .symlink_metadata()
                .is_ok_and(|metadata| metadata.is_file()),
            "No file-backed Codex login. Sign in with ChatGPT using codex login first."
        );
        let manager = AuthManager::shared_saved_chatgpt(codex_home, config.auth_route_config())
            .await
            .map_err(|_| anyhow::anyhow!(
                "No usable saved Codex OAuth login. Sign in with ChatGPT using codex login first."
            ))?;
        let account = manager
            .auth_cached()
            .context("Saved Codex OAuth login is unavailable")?
            .get_account_id();
        ensure!(
            self.account_id
                .as_ref()
                .is_none_or(|expected| account.as_ref() == Some(expected)),
            "Saved Codex login does not match the expected account"
        );
        Ok((manager, auth_file))
    }

    pub(crate) fn check_provider(config: &Config) -> Result<()> {
        let provider = &config.model_provider;
        ensure!(
            config.model_provider_id == "native_agent"
                && provider.base_url.as_deref() == Some("https://chatgpt.com/backend-api/codex")
                && config.chatgpt_base_url.trim_end_matches('/')
                    == "https://chatgpt.com/backend-api"
                && provider.requires_openai_auth
                && !provider.supports_websockets
                && !provider.has_request_routing_overrides()
                && provider.model_catalog_url.is_none()
                && provider.auth.is_none()
                && provider.gateway_oauth.is_none()
                && provider.env_key.is_none()
                && provider.experimental_bearer_token.is_none()
                && !provider.is_amazon_bedrock(),
            "Saved Codex login requires native streaming HTTP with default ChatGPT routing"
        );
        ensure!(
            !crate::config::web_search_tool(config)
                .is_some_and(|name| !name.is_default_namespace()),
            "Saved Codex login does not support standalone web search. Use webSearch({{ route: 'hosted' }}) with a model that supports hosted web search."
        );
        Ok(())
    }
}

struct ApiKey {
    auth: CodexAuth,
}

impl ExternalAuth for ApiKey {
    fn resolve(&self) -> ExternalAuthFuture<'_, CodexAuth> {
        Box::pin(async { Ok(self.auth.clone()) })
    }

    fn refresh(&self, _context: ExternalAuthRefreshContext) -> ExternalAuthFuture<'_, CodexAuth> {
        self.resolve()
    }
}

fn isolated_manager(config: &Config) -> Arc<AuthManager> {
    AuthManager::external_bearer_only(ModelProviderAuthInfo {
        command: String::new(),
        args: Vec::new(),
        timeout_ms: NonZeroU64::MIN,
        refresh_interval_ms: 0,
        cwd: config.cwd.clone(),
    })
}

pub fn plan_manager(config: &Config) -> Arc<AuthManager> {
    let manager = isolated_manager(config);
    manager.clear_external_auth();
    manager
}

pub async fn manager(config: &Config, api_key: Option<String>) -> Result<Arc<AuthManager>> {
    let api_key = match api_key {
        Some(key) => {
            ensure!(!key.trim().is_empty(), "api_key must not be empty");
            Some(key.trim().to_owned())
        }
        None => codex_login::read_openai_api_key_from_env(),
    };
    ensure!(
        api_key.is_some() || !config.model_provider.requires_openai_auth,
        "Provide api_key or set OPENAI_API_KEY"
    );

    // This constructor alone skips all environment and stored-login discovery.
    // Its command provider is replaced before the manager can resolve any auth.
    let manager = isolated_manager(config);
    match api_key {
        Some(key) => {
            manager
                .set_external_auth(Arc::new(ApiKey {
                    auth: CodexAuth::from_api_key(&key),
                }))
                .await?;
        }
        None => manager.clear_external_auth(),
    }
    Ok(manager)
}

// One explicit application-owned Apps principal; model authentication is untouched.
struct AppsBearer(CodexAuth);
impl ExternalAuth for AppsBearer {
    fn resolve(&self) -> ExternalAuthFuture<'_, CodexAuth> {
        Box::pin(async { Ok(self.0.clone()) })
    }
    fn refresh(&self, _context: ExternalAuthRefreshContext) -> ExternalAuthFuture<'_, CodexAuth> {
        Box::pin(async {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "ChatGPT Apps credentials expired; open a fresh Session",
            ))
        })
    }
}
pub fn apps_auth(access_token: &str, account_id: &str) -> Result<CodexAuth> {
    ensure!(
        !access_token.is_empty()
            && access_token
                .bytes()
                .all(|byte| (0x21..=0x7e).contains(&byte))
            && !account_id.is_empty()
            && account_id.len() <= 1024
            && account_id.trim() == account_id
            && !account_id
                .chars()
                .any(|value| value < '\u{20}' || value == '\u{7f}'),
        "Invalid ChatGPT Apps credentials"
    );
    let auth = CodexAuth::from_external_chatgpt_tokens(access_token, account_id, None)
        .map_err(|_| anyhow::anyhow!("Invalid ChatGPT Apps credentials"))?;
    ensure!(
        auth.get_account_id().as_deref() == Some(account_id)
            && auth.get_chatgpt_user_id().is_some(),
        "ChatGPT Apps identity is unavailable"
    );
    Ok(auth)
}

pub async fn apps_manager(config: &Config, auth: CodexAuth) -> Result<Arc<AuthManager>> {
    let manager = isolated_manager(config);
    manager
        .set_external_auth(Arc::new(AppsBearer(auth)))
        .await
        .map_err(|_| anyhow::anyhow!("Invalid ChatGPT Apps credentials"))?;
    Ok(manager)
}
