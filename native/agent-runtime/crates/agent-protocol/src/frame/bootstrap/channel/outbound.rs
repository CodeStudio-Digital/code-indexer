use std::io::{Read, Write};

use crate::generated::v1 as wire;
use crate::version::ProtocolVersion;
use zeroize::Zeroizing;

use super::{BootstrapAttemptChannel, BootstrapChannelError};
use crate::frame::bootstrap::{BootstrapError, validate_host_selection};
use crate::frame::sender::encode_bootstrap_hello;
use crate::frame::{FrameDirection, OutboundFrameError, ScrubbedFrameBody};

impl<R: Read, W: Write> BootstrapAttemptChannel<R, W> {
    pub(crate) fn send_owned_agent_hello<F>(
        &mut self,
        hello: wire::AgentHello,
        clock: F,
    ) -> Result<(), BootstrapChannelError>
    where
        F: FnOnce() -> i64,
    {
        let mut body = ScrubbedFrameBody::new(wire::frame_payload::Body::AgentHello(hello));
        if self.inbound_direction != FrameDirection::HostToRunner {
            return self.fail_outbound(OutboundFrameError::WrongBootstrapDirection);
        }
        let wire::frame_payload::Body::AgentHello(hello) = body.as_ref() else {
            unreachable!("owned AgentHello body changed variant")
        };
        let protocol = match agent_hello_protocol(hello) {
            Ok(protocol) => protocol,
            Err(error) => return self.fail_bootstrap(error),
        };
        self.send_hello(protocol, body.take(), clock)
    }

    #[cfg(test)]
    pub(in crate::frame) fn send_agent_hello<F>(
        &mut self,
        hello: &wire::AgentHello,
        clock: F,
    ) -> Result<(), BootstrapChannelError>
    where
        F: FnOnce() -> i64,
    {
        self.send_owned_agent_hello(hello.clone(), clock)
    }

    /// Writes the host-owned `HostHello` as sequence one.
    ///
    /// # Errors
    ///
    /// Missing inbound authority, connection mismatch, repeated use, or write
    /// failure poison the bootstrap owner.
    pub fn send_host_hello<F>(
        &mut self,
        hello: &wire::HostHello,
        clock: F,
    ) -> Result<(), BootstrapChannelError>
    where
        F: FnOnce() -> i64,
    {
        if self.inbound_direction != FrameDirection::RunnerToHost
            || self.accepted_channel_id.is_none()
        {
            return self.fail_outbound(OutboundFrameError::WrongBootstrapDirection);
        }
        let (protocol, connection, _) = match validate_host_selection(hello, self.hard_cap) {
            Ok(selection) => selection,
            Err(error) => return self.fail_bootstrap(error),
        };
        if connection != self.expected_connection {
            return self.fail_bootstrap(BootstrapError::ConnectionMismatch);
        }
        self.send_hello(
            protocol,
            wire::frame_payload::Body::HostHello(hello.clone()),
            clock,
        )
    }

    fn send_hello<F>(
        &mut self,
        protocol: ProtocolVersion,
        body: wire::frame_payload::Body,
        clock: F,
    ) -> Result<(), BootstrapChannelError>
    where
        F: FnOnce() -> i64,
    {
        let mut body = ScrubbedFrameBody::new(body);
        if self.outbound_hello_sent {
            return self.fail_outbound(OutboundFrameError::BootstrapAlreadySent);
        }
        let encoded = Zeroizing::new(
            match encode_bootstrap_hello(
                protocol,
                &self.expected_connection,
                &self.expected_identity,
                self.inbound_direction.reverse(),
                body.take(),
                self.hard_cap,
                clock,
            ) {
                Ok(encoded) => encoded,
                Err(error) => return self.fail_outbound(error),
            },
        );
        if let Err(error) = self.transport.write_raw(encoded.as_slice()) {
            self.receiver.invalidate();
            self.transport.poison();
            return Err(BootstrapChannelError::Framing(error));
        }
        self.outbound_hello_sent = true;
        Ok(())
    }

    fn fail_outbound<T>(&mut self, error: OutboundFrameError) -> Result<T, BootstrapChannelError> {
        self.receiver.invalidate();
        self.transport.poison();
        Err(BootstrapChannelError::Outbound(error))
    }

    fn fail_bootstrap<T>(&mut self, error: BootstrapError) -> Result<T, BootstrapChannelError> {
        self.receiver.invalidate();
        self.transport.poison();
        Err(BootstrapChannelError::Bootstrap(error))
    }
}

fn agent_hello_protocol(hello: &wire::AgentHello) -> Result<ProtocolVersion, BootstrapError> {
    let maximum = hello
        .supported_protocols
        .as_ref()
        .and_then(|range| range.maximum.as_ref())
        .ok_or(BootstrapError::InvalidSelectedProtocol)?;
    let major =
        u16::try_from(maximum.major).map_err(|_| BootstrapError::InvalidSelectedProtocol)?;
    let minor =
        u16::try_from(maximum.minor).map_err(|_| BootstrapError::InvalidSelectedProtocol)?;
    let protocol = ProtocolVersion::new(major, minor);
    if protocol.major == 0 {
        return Err(BootstrapError::InvalidSelectedProtocol);
    }
    Ok(protocol)
}
