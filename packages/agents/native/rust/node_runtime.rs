use std::future::Future;
use std::pin::Pin;
use std::sync::RwLock;

use napi::bindgen_prelude::{AsyncRuntime, AsyncRuntimeRejection, AsyncRuntimeTask};
use tokio::runtime::Runtime;

#[derive(Default)]
pub(crate) struct NodeRuntime {
    runtime: RwLock<Option<Runtime>>,
}

// Napi invokes shutdown before the last owning Node environment may unload
// this image. Dropping Runtime joins Tokio threads and blocking tasks; the
// background Tokio shutdown used by napi's built-in backend cannot do that.
unsafe impl AsyncRuntime for NodeRuntime {
    fn start(&self) -> napi::Result<()> {
        let mut slot = self.runtime.write().map_err(crate::native_error)?;
        if slot.is_none() {
            *slot = Some(
                tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .thread_stack_size(codex_async_utils::THREAD_STACK_SIZE_BYTES)
                    .build()
                    .map_err(crate::native_error)?,
            );
        }
        Ok(())
    }

    fn spawn(&self, task: AsyncRuntimeTask) -> Result<(), AsyncRuntimeRejection<AsyncRuntimeTask>> {
        let slot = self
            .runtime
            .read()
            .unwrap_or_else(|error| error.into_inner());
        match slot.as_ref() {
            Some(runtime) => {
                runtime.spawn(task);
                Ok(())
            }
            None => Err(AsyncRuntimeRejection::new(
                task,
                crate::native_error("Codex native runtime is closed"),
            )),
        }
    }

    fn block_on(&self, future: Pin<&mut dyn Future<Output = ()>>) -> napi::Result<()> {
        let slot = self.runtime.read().map_err(crate::native_error)?;
        let runtime = slot
            .as_ref()
            .ok_or_else(|| crate::native_error("Codex native runtime is closed"))?;
        runtime.block_on(future);
        Ok(())
    }

    fn shutdown(&self) -> napi::Result<()> {
        // Close admissions under the lock, then join without holding it.
        // Finalizers may attempt emergency spawns and must find a closed slot.
        let runtime = self
            .runtime
            .write()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        drop(runtime);
        Ok(())
    }
}
