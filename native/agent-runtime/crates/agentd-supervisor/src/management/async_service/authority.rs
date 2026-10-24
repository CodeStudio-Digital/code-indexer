use agent_platform::containment::ContainmentPort;
use agent_protocol::management_channel::{
    AsyncPendingManagementInbound, ValidatedManagementPayload,
};

use super::write::PendingWriteCompletion;
use super::{SupervisorAsyncService, SupervisorAsyncServiceAdvance};
use crate::management::{
    ProtectedLaunchProvisionPort, SupervisorLifecycleClock, SupervisorOnlineLifecycleTimer,
};

impl<P, V, C, T> SupervisorAsyncService<P, V, C, T>
where
    P: ContainmentPort + Send + Sync + 'static,
    P::Group: Send + 'static,
    V: ProtectedLaunchProvisionPort + Send + Sync + 'static,
    C: SupervisorLifecycleClock,
    T: SupervisorOnlineLifecycleTimer,
{
    pub(super) async fn dispatch_authority_update(
        &mut self,
        pending: AsyncPendingManagementInbound,
        payload: &ValidatedManagementPayload,
        digest: [u8; 32],
    ) -> SupervisorAsyncServiceAdvance<P::Error> {
        let now = self.lifecycle.owner_now_unix_ms();
        let (key, step) = match self
            .lifecycle
            .owner_mut()
            .update_authority(payload, digest, now)
        {
            Ok(result) => result,
            Err(error) => {
                if let Err(actor_error) = pending.reject() {
                    return self.fail_channel(actor_error);
                }
                return self.fail_driver(error, None);
            }
        };
        let queued = match pending.acknowledge() {
            Ok(queued) => queued,
            Err(error) => return self.close_after_write_failure(error, Some(key)),
        };
        self.retain_write(queued, PendingWriteCompletion::Authority(step), Some(key));
        self.resume_pending_write().await
    }
}
