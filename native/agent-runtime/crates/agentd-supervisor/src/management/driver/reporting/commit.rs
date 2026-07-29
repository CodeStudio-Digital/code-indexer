use std::io::{Read, Write};

use agent_platform::containment::ContainmentPort;
use agent_protocol::management_channel::PendingManagementInbound;

use super::PreparedLaunchEmission;
use crate::management::SupervisorLifecycleClock;
use crate::management::driver::provision::ProtectedLaunchProvisionPort;
use crate::management::driver::state::AdmissionClosureReason;
use crate::management::driver::{
    SupervisorDriverError, SupervisorDriverStep, SupervisorPhysicalDriver,
};

impl<R, W, P, V> SupervisorPhysicalDriver<R, W, P, V>
where
    R: Read,
    W: Write,
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    pub(in crate::management::driver) fn commit_prepared_launch(
        &mut self,
        pending: PendingManagementInbound,
        mut emission: PreparedLaunchEmission,
    ) -> Result<SupervisorDriverStep, SupervisorDriverError<P::Error>> {
        let failure_key = emission.write_failure_key().cloned();
        let payload = emission.take_payload();
        let sent = match self.channel.respond_launch(pending, &payload) {
            Ok(sent) => sent,
            Err(error) => {
                let now_unix_ms = self
                    .lifecycle_clock
                    .now_unix_ms()
                    .max(self.channel.owner_now_unix_ms());
                self.core.close_for_management_loss(
                    if failure_key.is_some() {
                        AdmissionClosureReason::PostSpawnWriteFailure
                    } else {
                        AdmissionClosureReason::ChannelPoisoned
                    },
                    now_unix_ms,
                    failure_key,
                )?;
                return Err(SupervisorDriverError::Channel(error));
            }
        };
        self.core.track_prepared_launch(&sent, emission)
    }
}
