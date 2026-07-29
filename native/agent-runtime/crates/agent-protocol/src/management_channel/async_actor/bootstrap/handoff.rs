use tokio::io::{AsyncRead, AsyncWrite};

use super::{AsyncBootstrapManagementActor, BootstrapRole};
use crate::management_channel::async_actor::actor::ManagementActor;
use crate::management_channel::async_actor::{
    AsyncEstablishedManagementActor, AsyncManagementActorError, AsyncManagementPolicy,
};
use crate::management_channel::bootstrap::BootstrapSelection;
use crate::management_channel::receiver::ManagementReceiver;
use crate::management_channel::sender::ManagementOutboundAuthority;
use crate::management_channel::{
    ManagementChannelError, ManagementDirection, ManagementReceiverContext,
};

impl<S: AsyncRead + AsyncWrite + Unpin + Send + 'static> AsyncBootstrapManagementActor<S> {
    pub(super) fn finish(
        mut self,
        selection: BootstrapSelection,
        bootstrap_message_id: String,
    ) -> Result<AsyncEstablishedManagementActor, AsyncManagementActorError> {
        let policy = AsyncManagementPolicy::derive(&selection.policy)?;
        let maximum = selection.maximum_frame_bytes;
        let inbound = match self.role {
            BootstrapRole::Host => ManagementDirection::SupervisorToHost,
            BootstrapRole::Supervisor => ManagementDirection::HostToSupervisor,
        };
        let receiver = ManagementReceiver::from_context(
            ManagementReceiverContext {
                protocol: selection.protocol,
                connection: self.expected_connection.clone(),
                direction: inbound,
                maximum_frame_bytes: maximum,
                bootstrap_message_id,
            },
            policy.replay_limits(),
        )?;
        let frame = selection.policy.frame_limits();
        let sender = ManagementOutboundAuthority::new(
            selection.protocol,
            self.expected_connection,
            inbound.reverse(),
            maximum,
            frame.write_timeout_ms,
            frame.max_in_flight_frames,
            frame.max_in_flight_bytes,
        )?;
        let maximum =
            u32::try_from(maximum).map_err(|_| ManagementChannelError::InvalidNegotiatedMaximum)?;
        let transport = self
            .transport
            .take()
            .ok_or(ManagementChannelError::BootstrapConsumed)?
            .narrow(maximum)?;
        let (reader, writer) = transport.into_split()?;
        let actor = ManagementActor::new(
            writer,
            receiver,
            sender,
            selection.policy,
            self.clock,
            policy.clone(),
            self.role == BootstrapRole::Host,
        )?;
        Ok(AsyncEstablishedManagementActor::spawn(
            actor, reader, policy,
        ))
    }
}
