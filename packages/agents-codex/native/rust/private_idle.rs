//! The joined, private-only Engine lifetime. No JavaScript is needed by close.
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, Weak};

use crate::{Engine, EngineOwner, native_error};

const ACTIVE: u8 = 0;
const IDLE: u8 = 1;
const CLOSING: u8 = 2;
const CLOSED: u8 = 3;

thread_local! {
    static ENVIRONMENTS: RefCell<HashMap<usize, Weak<Registry>>> = RefCell::default();
}

#[derive(Default)]
struct Registry {
    owners: Mutex<HashMap<usize, Arc<Owner>>>,
}

impl Registry {
    fn for_env(env: napi::Env) -> napi::Result<Arc<Self>> {
        let key = env.raw() as usize;
        if let Some(registry) = ENVIRONMENTS
            .with(|environments| environments.borrow().get(&key).and_then(Weak::upgrade))
        {
            return Ok(registry);
        }
        let registry = Arc::new(Self::default());
        // This exported call runs after napi module registration. Its runtime
        // cleanup hook is older, so our synchronous join runs first (LIFO).
        env.add_env_cleanup_hook(Arc::clone(&registry), move |registry| {
            ENVIRONMENTS.with(|environments| environments.borrow_mut().remove(&key));
            let owners: Vec<_> = registry
                .owners
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .values()
                .cloned()
                .collect();
            for owner in owners {
                // Only joined idle owners, or their already-started close, are
                // registered. Never wait for a JS Promise or an active Session.
                let runtime = owner.runtime.clone();
                if let Err(error) = runtime.block_on(owner.close()) {
                    eprintln!("Private Engine shutdown failed: {error}");
                }
            }
        })?;
        ENVIRONMENTS.with(|environments| {
            environments
                .borrow_mut()
                .insert(key, Arc::downgrade(&registry));
        });
        Ok(registry)
    }
}

#[derive(Default)]
struct Completion {
    closed: bool,
    diagnostic: Option<String>,
}

pub(crate) struct Owner {
    engine: Arc<Mutex<EngineOwner>>,
    runtime: tokio::runtime::Handle,
    home: PathBuf,
    registry: Weak<Registry>,
    state: AtomicU8,
    completion: tokio::sync::Mutex<Completion>,
}

impl Owner {
    pub(crate) fn new(
        env: napi::Env,
        engine: Arc<Mutex<EngineOwner>>,
        runtime: tokio::runtime::Handle,
        home: PathBuf,
    ) -> napi::Result<Arc<Self>> {
        let registry = Registry::for_env(env)?;
        Ok(Arc::new(Self {
            engine,
            runtime,
            home,
            registry: Arc::downgrade(&registry),
            state: AtomicU8::new(ACTIVE),
            completion: tokio::sync::Mutex::new(Completion::default()),
        }))
    }

    pub(crate) fn arm(self: &Arc<Self>, home: &std::path::Path) -> napi::Result<bool> {
        if home != self.home {
            return Err(native_error("Private Engine home changed"));
        }
        let registry = self
            .registry
            .upgrade()
            .ok_or_else(|| native_error("Private Engine environment is closed"))?;
        if self
            .state
            .compare_exchange(ACTIVE, IDLE, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Ok(false);
        }
        registry
            .owners
            .lock()
            .map_err(native_error)?
            .insert(Arc::as_ptr(self) as usize, Arc::clone(self));
        Ok(true)
    }

    pub(crate) fn activate(self: &Arc<Self>) -> napi::Result<bool> {
        if self
            .state
            .compare_exchange(IDLE, ACTIVE, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Ok(false);
        }
        self.unregister()?;
        Ok(true)
    }

    fn unregister(self: &Arc<Self>) -> napi::Result<()> {
        if let Some(registry) = self.registry.upgrade() {
            registry
                .owners
                .lock()
                .map_err(native_error)?
                .remove(&(Arc::as_ptr(self) as usize));
        }
        Ok(())
    }

    pub(crate) async fn close(self: &Arc<Self>) -> napi::Result<Option<String>> {
        // Closing is a fence, not completion. Every closer joins this mutex and
        // the full native close before any caller may remove the owned home.
        let _ = self
            .state
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |state| {
                (state != CLOSED).then_some(CLOSING)
            });
        let mut completion = self.completion.lock().await;
        if !completion.closed {
            let diagnostic = Engine::close_owner(Arc::clone(&self.engine)).await?;
            // Synchronous deletion cannot leave a detached fs task if the
            // caller's async future is cancelled. This is only our private home.
            match std::fs::remove_dir_all(&self.home) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(native_error(error)),
            }
            completion.diagnostic = diagnostic;
            completion.closed = true;
            self.state.store(CLOSED, Ordering::Release);
            self.unregister()?;
        }
        Ok(completion.diagnostic.clone())
    }
}
