use std::io::{Read, Write};

use agent_platform::containment::ContainmentPort;

use super::{ProtectedLaunchProvisionPort, SupervisorPhysicalDriver};

impl<R, W, P, V> SupervisorPhysicalDriver<R, W, P, V>
where
    R: Read,
    W: Write,
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    const fn retained_completion_cleanups(&self) -> usize {
        self.core.completion_cleanup.len()
    }

    fn physical_state_for_test(
        &self,
        idempotency_key: &str,
    ) -> Option<crate::process_table::PhysicalState> {
        let key = self
            .launch_registry
            .ownership_key_for_test(idempotency_key)?;
        self.ownership.state(key).ok()
    }

    #[cfg(windows)]
    fn physical_runtime_for_test(&self, idempotency_key: &str) -> Option<(u32, String)> {
        let key = self
            .launch_registry
            .ownership_key_for_test(idempotency_key)?;
        let receipt = self.ownership.physical_spawn_receipt(key).ok()?;
        Some((
            receipt.process_id().0,
            receipt.metadata().runtime_instance_id.as_str().to_owned(),
        ))
    }
}

mod async_service;
mod cleanup;
mod cleanup_pump;
mod completion_cleanup;
mod fakes;
mod flow;
mod idempotency;
mod launch;
mod launch_clock_failures;
mod provisioning;
mod registry;
mod state;
mod support;
mod termination;
#[cfg(windows)]
mod windows_physical;
mod write_failures;
