use agent_platform::containment::ContainmentPort;
use agent_protocol::management_channel::{
    AsyncManagementActorError, AsyncPendingManagementInbound, ValidatedManagementPayload,
};

use super::write::PendingWriteCompletion;
use super::{
    ServiceMode, SupervisorAsyncService, SupervisorAsyncServiceAdvance,
    SupervisorManagementTerminal,
};
use crate::management::{
    ProtectedLaunchProvisionPort, SupervisorDriverError, SupervisorLifecycleClock,
    SupervisorOnlineLifecycleTimer,
};

impl<P, V, C, T> SupervisorAsyncService<P, V, C, T>
where
    P: ContainmentPort + Send + Sync + 'static,
    P::Group: Send + 'static,
    V: ProtectedLaunchProvisionPort + Send + Sync + 'static,
    C: SupervisorLifecycleClock,
    T: SupervisorOnlineLifecycleTimer,
{
    pub(super) async fn dispatch_shutdown(
        &mut self,
        pending: AsyncPendingManagementInbound,
        payload: &ValidatedManagementPayload,
        payload_digest: [u8; 32],
    ) -> SupervisorAsyncServiceAdvance<P::Error> {
        let scheduled = {
            let (owner, clock) = self.lifecycle.owner_and_clock_mut();
            owner.schedule_shutdown(payload, payload_digest, clock)
        };
        if let Err(error) = scheduled {
            return self.reject_shutdown(pending, error);
        }

        // Admission and every physical deadline are committed before the ACK.
        // From this point onward cancellation or a write failure can only drain.
        self.mode = ServiceMode::Draining(SupervisorManagementTerminal::Shutdown);
        let queued = match pending.acknowledge() {
            Ok(queued) => queued,
            Err(error) => return self.close_committed_shutdown(error),
        };
        self.retain_write(queued, PendingWriteCompletion::Shutdown, None);
        self.resume_pending_write().await
    }

    fn reject_shutdown(
        &mut self,
        pending: AsyncPendingManagementInbound,
        error: SupervisorDriverError<P::Error>,
    ) -> SupervisorAsyncServiceAdvance<P::Error> {
        if let Err(actor_error) = pending.reject() {
            return self.fail_channel(actor_error);
        }
        self.fail_driver(error, None)
    }

    fn close_committed_shutdown(
        &mut self,
        error: AsyncManagementActorError,
    ) -> SupervisorAsyncServiceAdvance<P::Error> {
        self.close_after_write_failure(error, None)
    }
}
