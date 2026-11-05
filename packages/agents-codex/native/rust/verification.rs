//! Explicit application registration, never recovered from saved credentials.
use anyhow::{Result, ensure};
use codex_config::McpServerConfig;
use codex_login::CodexAuth;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Declaration {
    Verification { server: Value },
    Chatgpt { server: Value, auth: Credentials },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Credentials {
    access_token: String,
    account_id: String,
}

pub(crate) struct Prepared {
    registration: McpServerConfig,
    auth: Option<CodexAuth>,
}
impl Prepared {
    pub async fn bind(self, config: &Config) -> Result<ApplicationApps> {
        Ok(match self.auth {
            Some(auth) => {
                let mut registration = codex_mcp::codex_apps_mcp_server_config(
                    &config.chatgpt_base_url,
                    config.apps_mcp_product_sku.as_deref(),
                    None,
                );
                // The account manager is the only credential source. Never use
                // the CLI helper's optional ambient bearer override.
                if let McpServerTransportConfig::StreamableHttp {
                    bearer_token_env_var,
                    ..
                } = &mut registration.transport
                {
                    *bearer_token_env_var = None;
                }
                ApplicationApps::chatgpt(
                    registration,
                    crate::auth::apps_manager(config, auth).await?,
                )
            }
            None => ApplicationApps::verification(self.registration),
        })
    }
}

// Validate before native services open. No declaration or credential JSON is retained.
pub(crate) fn prepare(source: Option<&str>) -> Result<Option<Prepared>> {
    let Some(source) = source else {
        return Ok(None);
    };
    let declaration: Declaration = serde_json::from_str(source)
        .map_err(|_| anyhow::anyhow!("Invalid application Apps declaration"))?;
    let (server, auth) = match declaration {
        Declaration::Verification { server } => (server, None),
        Declaration::Chatgpt { server, auth } => (
            server,
            Some(crate::auth::apps_auth(
                &auth.access_token,
                &auth.account_id,
            )?),
        ),
    };
    let registration = crate::mcp_roster::decode(serde_json::json!({"codex_apps": server}))?
        .remove("codex_apps")
        .ok_or_else(|| anyhow::anyhow!("Missing Apps registration"))?;
    ensure!(
        registration.is_local_environment(),
        "Apps registration requires the host environment"
    );
    let McpServerTransportConfig::StreamableHttp {
        url,
        bearer_token_env_var,
        http_headers,
        env_http_headers,
        http_headers_helper,
    } = &registration.transport
    else {
        anyhow::bail!("Apps registration requires an HTTP service");
    };
    if auth.is_some() {
        ensure!(
            registration.auth == McpServerAuth::ChatGpt
                && url == "https://chatgpt.com/backend-api/ps/mcp"
                && bearer_token_env_var.is_none()
                && http_headers.is_none()
                && env_http_headers.is_none()
                && http_headers_helper.is_none(),
            "Personal Apps requires the fixed ChatGPT transport without header overrides"
        );
    } else {
        ensure!(
            registration.auth != McpServerAuth::ChatGpt,
            "Personal Apps requires explicit credentials"
        );
    }
    Ok(Some(Prepared { registration, auth }))
}

use codex_config::{McpServerAuth, McpServerTransportConfig};
use codex_core_api::Config;
use codex_extension_api::{
    ExtensionFuture, McpServerContribution, McpServerContributionContext, McpServerContributor,
};
use codex_mcp::{APPLICATION_APPS_CONTRIBUTOR_ID, ApplicationApps};

pub struct Contributor;
impl McpServerContributor<Config> for Contributor {
    fn id(&self) -> &'static str {
        APPLICATION_APPS_CONTRIBUTOR_ID
    }
    fn contribute<'a>(
        &'a self,
        context: McpServerContributionContext<'a, Config>,
    ) -> ExtensionFuture<'a, Vec<McpServerContribution>> {
        Box::pin(async move {
            let Some(application) = context
                .thread_init()
                .and_then(|init| init.get::<ApplicationApps>())
            else {
                return Vec::new();
            };
            let Some(current) = context
                .config()
                .mcp_servers
                .get()
                .get("codex_apps")
                .cloned()
            else {
                return Vec::new();
            };
            let mut current = current;
            if application.personal_auth().is_some() {
                // Public ChatGPTAppsMCP has one fixed native target and no header/bearer knobs.
                let McpServerTransportConfig::StreamableHttp {
                    url,
                    bearer_token_env_var: None,
                    http_headers: None,
                    env_http_headers: None,
                    http_headers_helper: None,
                } = &current.transport
                else {
                    return Vec::new();
                };
                if current.auth != McpServerAuth::ChatGpt
                    || !current.is_local_environment()
                    || url != "https://chatgpt.com/backend-api/ps/mcp"
                {
                    return Vec::new();
                }
                current.transport = application.registration().transport.clone();
                current.auth = application.registration().auth.clone();
                current.environment_id = application.registration().environment_id.clone();
            } else if current.transport != application.registration().transport
                || current.auth != application.registration().auth
                || current.environment_id != application.registration().environment_id
            {
                return Vec::new();
            }
            vec![McpServerContribution::HostedApps {
                config: Box::new(current),
                protocol_mode: None,
            }]
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use serde_json::json;

    fn token() -> String {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"none","typ":"JWT"}"#);
        let claims = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&json!({
                "exp": 4102444800_u64,
                "https://api.openai.com/auth": {
                    "chatgpt_account_id": "synthetic-account", "chatgpt_user_id": "synthetic-user",
                    "chatgpt_plan_type": "plus"
                }
            }))
            .unwrap(),
        );
        format!("{header}.{claims}.synthetic-only")
    }
    fn personal() -> Value {
        json!({"kind":"chatgpt", "server":{
            "url":"https://chatgpt.com/backend-api/ps/mcp", "auth":"chatgpt", "enabled_tools":["search"]
        }, "auth":{"access_token":token(), "account_id":"synthetic-account"}})
    }
    #[test]
    fn no_declaration_has_no_apps_capability() {
        assert!(prepare(None).unwrap().is_none());
    }
    #[test]
    fn verification_registration_has_no_personal_principal() {
        let source = json!({"kind":"verification", "server":{"url":"http://127.0.0.1:12345/mcp", "enabled_tools":["search"]}}).to_string();
        let app = prepare(Some(&source)).unwrap().unwrap();
        assert!(app.auth.is_none());
        assert!(app.registration.is_local_environment());
    }
    #[test]
    fn personal_registration_uses_only_explicit_identity_and_the_fixed_target() {
        let source = personal().to_string();
        let app = prepare(Some(&source)).unwrap().unwrap();
        let auth = app.auth.unwrap();
        assert_eq!(auth.get_account_id().as_deref(), Some("synthetic-account"));
        assert_eq!(
            auth.get_chatgpt_user_id().as_deref(),
            Some("synthetic-user")
        );
        let mut bad = personal();
        bad["auth"]["access_token"] = json!("a-model-api-key");
        assert!(prepare(Some(&bad.to_string())).is_err());
        let mut bad = personal();
        bad["server"]["url"] = json!("http://127.0.0.1:12345/mcp");
        assert!(prepare(Some(&bad.to_string())).is_err());
        let mut bad = personal();
        bad["server"]["http_headers"] = json!({"Authorization":"Bearer other-principal"});
        assert!(prepare(Some(&bad.to_string())).is_err());
    }
}
