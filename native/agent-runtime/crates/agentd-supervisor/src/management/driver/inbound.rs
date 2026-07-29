use std::io::{Read, Write};

use agent_platform::containment::ContainmentPort;
use agent_protocol::management_channel::{
    ManagementChannelError, ManagementReceiveOutcome, PendingManagementInbound,
};

use super::provision::ProtectedLaunchProvisionPort;
use super::{SupervisorDriverError, SupervisorDriverStep, SupervisorPhysicalDriver};
use crate::management::SupervisorLifecycleClock;

impl<R, W, P, V> SupervisorPhysicalDriver<R, W, P, V>
where
    R: Read,
    W: Write,
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    pub(super) fn process_received(
        &mut self,
        received: Result<Option<ManagementReceiveOutcome>, ManagementChannelError>,
        now_unix_ms: i64,
        launch_received_at_unix_ms: i64,
        launch_clock: &dyn SupervisorLifecycleClock,
    ) -> Result<SupervisorDriverStep, SupervisorDriverError<P::Error>> {
        let outcome = match received {
            Ok(Some(outcome)) => outcome,
            Ok(None) => {
                let error = ManagementChannelError::UnexpectedEof;
                self.close_for_channel_failure(&error, now_unix_ms, None)?;
                return Err(SupervisorDriverError::Channel(error));
            }
            Err(error) => {
                self.close_for_channel_failure(&error, now_unix_ms, None)?;
                return Err(SupervisorDriverError::Channel(error));
            }
        };
        match outcome {
            ManagementReceiveOutcome::Replay(_) => Ok(SupervisorDriverStep::Replay),
            ManagementReceiveOutcome::Pending(pending) => self.handle_pending(
                *pending,
                now_unix_ms,
                launch_received_at_unix_ms,
                launch_clock,
            ),
        }
    }

    fn handle_pending(
        &mut self,
        mut pending: PendingManagementInbound,
        now_unix_ms: i64,
        launch_received_at_unix_ms: i64,
        launch_clock: &dyn SupervisorLifecycleClock,
    ) -> Result<SupervisorDriverStep, SupervisorDriverError<P::Error>> {
        let (payload, digest) = pending.take_validated_payload_and_digest()?;
        if payload.launch_attempt_process().is_some() {
            return self.handle_launch(
                pending,
                payload,
                digest,
                launch_received_at_unix_ms,
                launch_clock,
            );
        }
        if payload.cancel_attempt_process().is_some()
            || payload.fence_attempt_process().is_some()
            || payload.reap_attempt_process().is_some()
        {
            return self.handle_termination(pending, payload, digest, now_unix_ms);
        }
        if payload.management_ack().is_some() {
            return self.handle_management_ack(pending, payload, now_unix_ms);
        }
        let kind = payload.kind().name();
        drop(payload);
        let reject_result = self.channel.reject(pending);
        let error = SupervisorDriverError::UnsupportedInbound(kind);
        if let Err(channel_error) = reject_result {
            self.close_for_channel_failure(&channel_error, now_unix_ms, None)?;
        } else {
            self.close_for_channel_failure(
                &ManagementChannelError::ChannelPoisoned,
                now_unix_ms,
                None,
            )?;
        }
        Err(error)
    }
}
