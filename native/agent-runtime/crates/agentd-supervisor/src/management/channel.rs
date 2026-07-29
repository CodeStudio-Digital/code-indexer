use std::fmt::{self, Debug, Formatter};
use std::io::{Read, Write};

use agent_protocol::generated::v1 as wire;
#[cfg(test)]
use agent_protocol::management_channel::ManagementChannelResponse;
use agent_protocol::management_channel::ManagementDeadlinePolicy;
use agent_protocol::management_channel::{
    EstablishedManagementChannel, ManagementChannelError, ManagementReceiveOutcome,
    ManagementSessionPolicy, PendingManagementInbound,
};

use super::ManagementEnvelopeReceipt;

/// Supervisor-owned established management stream. The same internal clock is
/// used for every post-read observation and outbound timestamp.
///
/// Production callers cannot forge lifecycle facts from raw protobuf:
///
/// ```compile_fail
/// use std::io::{Read, Write};
/// use agent_protocol::generated::v1::ManagementPayload;
/// use agent_protocol::management_channel::{
///     ManagementDeadlinePolicy, PendingManagementInbound,
/// };
/// use agentd_supervisor::SupervisorManagementChannel;
///
/// fn forge<R: Read, W: Write>(
///     channel: &mut SupervisorManagementChannel<R, W>,
///     pending: PendingManagementInbound,
///     payload: &ManagementPayload,
///     deadline: ManagementDeadlinePolicy,
/// ) {
///     let _ = channel.commit_response(pending, payload, deadline);
/// }
/// ```
pub struct SupervisorManagementChannel<R, W> {
    channel: EstablishedManagementChannel<R, W>,
}

impl<R: Read, W: Write> Debug for SupervisorManagementChannel<R, W> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SupervisorManagementChannel")
            .field("channel", &self.channel)
            .finish()
    }
}

impl<R: Read, W: Write> SupervisorManagementChannel<R, W> {
    pub(super) const fn new(channel: EstablishedManagementChannel<R, W>) -> Self {
        Self { channel }
    }

    /// Reads and reserves one inbound management transaction.
    ///
    /// # Errors
    ///
    /// Physical, time, context, sequence, or payload failures poison the
    /// channel.
    pub(super) fn begin_receive(
        &mut self,
    ) -> Result<Option<ManagementReceiveOutcome>, ManagementChannelError> {
        self.channel.begin_receive()
    }

    /// Commits and writes a response with channel-owned sequence and time.
    ///
    /// # Errors
    ///
    /// Invalid authority, payload, deadline, budget, or writes fail closed.
    #[cfg(test)]
    pub(super) fn commit_response(
        &mut self,
        inbound: PendingManagementInbound,
        payload: &wire::ManagementPayload,
        deadline_policy: ManagementDeadlinePolicy,
    ) -> Result<ManagementChannelResponse, ManagementChannelError> {
        self.channel
            .commit_response(inbound, payload, deadline_policy)
    }

    pub(super) fn respond_launch(
        &mut self,
        inbound: PendingManagementInbound,
        payload: &wire::ManagementPayload,
    ) -> Result<ManagementEnvelopeReceipt, ManagementChannelError> {
        self.commit_typed_response(inbound, payload)
    }

    pub(super) fn respond_acknowledged(
        &mut self,
        inbound: PendingManagementInbound,
    ) -> Result<ManagementEnvelopeReceipt, ManagementChannelError> {
        let deadline =
            ManagementDeadlinePolicy::new(self.policy().frame_limits().write_timeout_ms)?;
        self.channel
            .commit_acknowledged(inbound, deadline)
            .map(|response| ManagementEnvelopeReceipt::from(response.sent_frame()))
    }

    pub(super) fn send_management_fact(
        &mut self,
        payload: &wire::ManagementPayload,
    ) -> Result<ManagementEnvelopeReceipt, ManagementChannelError> {
        self.send_typed_fact(payload)
    }

    /// Commits a channel-validated management acknowledgement without writing
    /// a response. The inner channel retains all reply and digest authority.
    pub(super) fn commit_accepted(
        &mut self,
        inbound: PendingManagementInbound,
    ) -> Result<(), ManagementChannelError> {
        self.channel.commit_accepted(inbound).map(|_| ())
    }

    /// Rejects pending work and permanently poisons both directions.
    ///
    /// # Errors
    ///
    /// Foreign or stale pending authority is reported.
    pub(super) fn reject(
        &mut self,
        inbound: PendingManagementInbound,
    ) -> Result<(), ManagementChannelError> {
        self.channel.reject(inbound)
    }

    #[must_use]
    pub const fn is_poisoned(&self) -> bool {
        self.channel.is_poisoned()
    }

    #[must_use]
    pub const fn policy(&self) -> &ManagementSessionPolicy {
        self.channel.policy()
    }

    pub(super) fn owner_now_unix_ms(&self) -> i64 {
        self.channel.owner_now_unix_ms()
    }

    fn commit_typed_response(
        &mut self,
        inbound: PendingManagementInbound,
        payload: &wire::ManagementPayload,
    ) -> Result<ManagementEnvelopeReceipt, ManagementChannelError> {
        let deadline =
            ManagementDeadlinePolicy::new(self.policy().frame_limits().write_timeout_ms)?;
        self.channel
            .commit_response(inbound, payload, deadline)
            .map(|response| ManagementEnvelopeReceipt::from(response.sent_frame()))
    }

    fn send_typed_fact(
        &mut self,
        payload: &wire::ManagementPayload,
    ) -> Result<ManagementEnvelopeReceipt, ManagementChannelError> {
        let deadline =
            ManagementDeadlinePolicy::new(self.policy().frame_limits().write_timeout_ms)?;
        self.channel
            .send_new(payload, deadline)
            .map(|sent| ManagementEnvelopeReceipt::from(&sent))
    }
}
