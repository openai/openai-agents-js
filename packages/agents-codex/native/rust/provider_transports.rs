//! Provider-lifetime HTTP transports; root authority and WebSockets stay Engine-owned.

use std::sync::Mutex;

use codex_http_client::{
    ClientRouteClass, HttpClientBuilder, HttpClientFactory, ReqwestTransport, RouteAwareClientPool,
};

#[derive(Default)]
pub(crate) struct ProviderTransports {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    closed: bool,
    // Exactly the wrapper's fixed default-header/TLS recipe and two redirect modes.
    slots: [Option<Entry>; 2],
}

struct Entry {
    factory: HttpClientFactory,
    transport: ReqwestTransport,
}

impl ProviderTransports {
    pub(crate) fn check_open(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            !self
                .state
                .lock()
                .expect("provider transports poisoned")
                .closed,
            "Provider transports are closed"
        );
        Ok(())
    }

    pub(crate) fn transport(
        &self,
        factory: &HttpClientFactory,
        no_redirects: bool,
        builder: HttpClientBuilder,
    ) -> anyhow::Result<ReqwestTransport> {
        let mut state = self.state.lock().expect("provider transports poisoned");
        anyhow::ensure!(!state.closed, "Provider transports are closed");
        let slot = &mut state.slots[usize::from(no_redirects)];
        if let Some(entry) = slot.as_ref() {
            if entry.factory == *factory {
                return Ok(entry.transport.clone());
            }
        }
        // Pool construction is inert; actual clients still build lazily in Core.
        let pool =
            RouteAwareClientPool::with_builder(factory.clone(), ClientRouteClass::Api, builder);
        let transport = ReqwestTransport::from_route_aware_client_pool(pool);
        *slot = Some(Entry {
            factory: factory.clone(),
            transport: transport.clone(),
        });
        Ok(transport)
    }

    pub(crate) fn close(&self) {
        let mut state = self.state.lock().expect("provider transports poisoned");
        state.closed = true;
        state.slots = [None, None];
        // Borrowing Engines retain their clones. This neither revokes nor drains them.
    }
}
