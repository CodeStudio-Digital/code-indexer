use agent_protocol::frame::{InboundBinding, PendingInbound};
use agent_protocol::generated::v1 as wire;

use super::RunnerControlSession;
use crate::control::error::ControlError;

impl RunnerControlSession {
    #[allow(
        dead_code,
        reason = "consumed only by the internal async driver before the Host control pump"
    )]
    pub(in crate::control) fn read_timeout_ms(&self) -> Result<u64, ControlError> {
        self.connection
            .as_ref()
            .map(|connection| connection.read_timeout_ms)
            .ok_or(ControlError::ConnectionNotEstablished)
    }

    pub(in crate::control) fn write_timeout_ms(&self) -> Result<u64, ControlError> {
        self.connection
            .as_ref()
            .map(|connection| connection.write_timeout_ms)
            .ok_or(ControlError::ConnectionNotEstablished)
    }

    pub(in crate::control) fn heartbeat_interval_ms(&self) -> Result<u64, ControlError> {
        self.connection
            .as_ref()
            .map(|connection| connection.heartbeat_interval_ms)
            .ok_or(ControlError::ConnectionNotEstablished)
    }

    pub(in crate::control) fn take_inbound(
        &self,
        frame: &mut PendingInbound,
    ) -> Result<(InboundBinding, wire::frame_payload::Body, [u8; 32]), ControlError> {
        self.validate_inbound_context(frame)?;
        let binding = frame.binding();
        let (body, digest) = frame.take_body_and_digest()?;
        Ok((binding, body, digest))
    }

    fn validate_inbound_context(&self, frame: &PendingInbound) -> Result<(), ControlError> {
        let connection = self
            .connection
            .as_ref()
            .ok_or(ControlError::ConnectionNotEstablished)?;
        if frame.channel() != wire::TransportChannel::Control
            || frame.header().protocol_version != connection.negotiated.version.to_wire()
            || frame.header().connection_id != connection.connection_id.as_str()
            || frame.identity() != self.launch.identity()
        {
            return Err(ControlError::ConnectionContextMismatch);
        }
        Ok(())
    }
}
