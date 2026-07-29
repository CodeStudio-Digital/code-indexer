use std::fmt::{self, Debug, Formatter};

use agent_platform::containment::ContainmentPort;
use agent_protocol::management_channel::AsyncPendingManagementInbound;

use crate::management::driver::{
    PendingPhysicalLaunchWorker, PhysicalLaunchState, PhysicalLaunchWorkerCommand,
    PreparedLaunchEmission,
};
use crate::management::{ProtectedLaunchProvisionPort, SupervisorDriverError};

pub(in crate::management::async_service) enum PendingLaunchPhase {
    Preparing,
    Spawning,
    Completing,
    Stopping,
}

pub(in crate::management::async_service) struct PendingServiceLaunch<P, V>
where
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    pub(in crate::management::async_service) inbound: Option<AsyncPendingManagementInbound>,
    pub(in crate::management::async_service) state: PhysicalLaunchState,
    pub(in crate::management::async_service) worker: Option<PendingPhysicalLaunchWorker<P, V>>,
    pub(in crate::management::async_service) phase: PendingLaunchPhase,
    pub(in crate::management::async_service) stop_result:
        Option<Result<PreparedLaunchEmission, SupervisorDriverError<P::Error>>>,
}

impl<P, V> PendingServiceLaunch<P, V>
where
    P: ContainmentPort + Send + Sync + 'static,
    P::Group: Send + 'static,
    V: ProtectedLaunchProvisionPort + Send + Sync + 'static,
{
    pub(in crate::management::async_service) fn send_command(
        &self,
        command: PhysicalLaunchWorkerCommand,
    ) -> Result<(), PhysicalLaunchWorkerCommand> {
        self.worker
            .as_ref()
            .expect("launch worker")
            .command(command)
    }

    pub(in crate::management::async_service) fn join_worker(&mut self) -> std::thread::Result<()> {
        let mut worker = self.worker.take().expect("launch worker");
        worker.join_finished()
    }
}

impl<P, V> Debug for PendingServiceLaunch<P, V>
where
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PendingServiceLaunch")
            .field("inbound_owned", &self.inbound.is_some())
            .field("worker", &self.worker)
            .field("phase", &self.phase)
            .field("stop_result_owned", &self.stop_result.is_some())
            .finish_non_exhaustive()
    }
}

impl<P, V> Drop for PendingServiceLaunch<P, V>
where
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    fn drop(&mut self) {
        if self.worker.is_some() {
            std::process::abort();
        }
    }
}

impl Debug for PendingLaunchPhase {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Preparing => "Preparing",
            Self::Spawning => "Spawning",
            Self::Completing => "Completing",
            Self::Stopping => "Stopping",
        })
    }
}
