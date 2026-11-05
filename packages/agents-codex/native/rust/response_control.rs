//! Preserve checkpoint budget data and project native transport errors onto the
//! provider URL supplied by the application.

use std::sync::{Arc, Mutex, OnceLock};

use codex_core_api::{CodexThread, Config};
use codex_extension_api::{
    ExtensionFuture, ThreadLifecycleContributor, ThreadStartInput, TurnErrorInput,
    TurnLifecycleContributor, TurnStartInput,
};
use codex_protocol::error::{CodexErr, CodexErrorDetails};
use codex_protocol::protocol::{CodexErrorInfo, ErrorEvent, Event, EventMsg};
use serde::{Deserialize, Serialize};
use url::Url;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BudgetSnapshot {
    pub turn_id: String,
    pub admitted: u64,
    pub limit: u64,
}

#[derive(Debug)]
struct ReportedError {
    turn_id: String,
    original: ErrorEvent,
    message: String,
}

#[derive(Debug, Default)]
struct State {
    restored_budget: Option<BudgetSnapshot>,
    reported_errors: Vec<ReportedError>,
}

#[derive(Debug)]
pub struct ResponseControl {
    reporting_base: Option<(String, Url)>,
    state: Mutex<State>,
}

impl ResponseControl {
    pub fn supports_manual_checkpoint(&self) -> bool {
        self.state
            .lock()
            .expect("response state poisoned")
            .restored_budget
            .is_none()
    }

    pub(crate) fn restore_budget(&self, budget: Option<BudgetSnapshot>) {
        self.state
            .lock()
            .expect("response state poisoned")
            .restored_budget = budget;
    }

    pub(crate) fn checkpoint_budget(&self) -> Option<BudgetSnapshot> {
        self.state
            .lock()
            .expect("response state poisoned")
            .restored_budget
            .clone()
    }

    // Called only on the actual CodexThread's native event queue.
    pub async fn report_event(thread: &CodexThread, mut event: Event) -> Event {
        let Some(control) = thread.thread_extension_data().get::<Self>() else {
            return event;
        };
        let mut state = control.state.lock().expect("response state poisoned");
        if let EventMsg::StreamError(retry) = &mut event.msg {
            if let Some(details) = &mut retry.additional_details
                && let Some(record) = state.reported_errors.iter().find(|record| {
                    let (
                        Some(CodexErrorInfo::HttpConnectionFailed {
                            http_status_code: Some(original_status),
                        }),
                        Some(CodexErrorInfo::ResponseStreamDisconnected {
                            http_status_code: Some(retry_status),
                        }),
                    ) = (&record.original.codex_error_info, &retry.codex_error_info)
                    else {
                        return false;
                    };
                    record.turn_id == event.id
                        && original_status == retry_status
                        && record.original.message == *details
                })
            {
                details.clone_from(&record.message);
            }
            return event;
        }
        let (error, terminal) = match &mut event.msg {
            EventMsg::Error(error) => (Some(error), false),
            EventMsg::TurnComplete(done) if done.turn_id == event.id => (done.error.as_mut(), true),
            _ => return event,
        };
        if let Some(error) = error
            && let Some(record) = state
                .reported_errors
                .iter()
                .find(|record| record.turn_id == event.id && record.original == *error)
        {
            error.message.clone_from(&record.message);
        }
        if terminal {
            state
                .reported_errors
                .retain(|record| record.turn_id != event.id);
        }
        event
    }
}

type ReportingProjection = Arc<dyn Fn(&Config) -> Option<(String, Url)> + Send + Sync>;

#[derive(Default)]
pub struct ResponseContributor {
    reporting_projection: OnceLock<ReportingProjection>,
}

impl std::fmt::Debug for ResponseContributor {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ResponseContributor")
            .finish_non_exhaustive()
    }
}

impl ResponseContributor {
    pub(crate) fn set_reporting_projection(&self, project: ReportingProjection) {
        assert!(self.reporting_projection.set(project).is_ok());
    }
}

impl ThreadLifecycleContributor<Config> for ResponseContributor {
    fn on_thread_start<'a>(
        &'a self,
        input: ThreadStartInput<'a, Config>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            input.thread_store.get_or_init(|| ResponseControl {
                reporting_base: self
                    .reporting_projection
                    .get()
                    .and_then(|project| project(input.config)),
                state: Mutex::new(State::default()),
            });
        })
    }
}

impl TurnLifecycleContributor for ResponseContributor {
    fn on_turn_start<'a>(&'a self, input: TurnStartInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if let Some(control) = input.thread_store.get::<ResponseControl>() {
                control.restore_budget(None);
            }
        })
    }

    fn on_turn_error<'a>(&'a self, input: TurnErrorInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            let Some(control) = input.thread_store.get::<ResponseControl>() else {
                return;
            };
            let Some((native, entered)) = control.reporting_base.as_ref() else {
                return;
            };
            let projected = (|| {
                let CodexErrorDetails::UnexpectedStatus(unexpected) = input.error_details else {
                    return None;
                };
                let (Ok(base), Some(Ok(request))) = (
                    Url::parse(native),
                    unexpected.url.as_deref().map(Url::parse),
                ) else {
                    return None;
                };
                // Origin and full parsed base path, not a string/suffix host match.
                // A URL-looking body, request id, redirect or adjacent path is not
                // transport identity and must remain exactly as Codex formatted it.
                if request.origin() != base.origin()
                    || request.username() != base.username()
                    || request.password() != base.password()
                {
                    return None;
                }
                let path = request
                    .path()
                    .strip_prefix(base.path().trim_end_matches('/'))?;
                if !path.is_empty() && !path.starts_with('/') {
                    return None;
                }
                let original =
                    CodexErr::from(CodexErrorDetails::UnexpectedStatus(unexpected.clone()));
                let mut public = entered.clone();
                public.set_path(&format!("{}{}", entered.path().trim_end_matches('/'), path));
                public.set_query(request.query());
                public.set_fragment(request.fragment());
                let mut displayed = unexpected.clone();
                displayed.url = Some(public.into());
                let displayed = CodexErr::from(CodexErrorDetails::UnexpectedStatus(displayed));
                // Exactly the two proven producers: ordinary run_turn and
                // Core V2 remote compact. Native formats both originals.
                let ordinary = (
                    original.to_error_event(None),
                    displayed.to_error_event(None).message,
                );
                let prefix = Some("Error running remote compact task".to_owned());
                let compact = (
                    original.to_error_event(prefix.clone()),
                    displayed.to_error_event(prefix).message,
                );
                Some([ordinary, compact])
            })();
            if let Some(records) = projected {
                control
                    .state
                    .lock()
                    .expect("response state poisoned")
                    .reported_errors
                    .extend(
                        records
                            .into_iter()
                            .map(|(original, message)| ReportedError {
                                turn_id: input.turn_id.to_owned(),
                                original,
                                message,
                            }),
                    );
            }
        })
    }
}
