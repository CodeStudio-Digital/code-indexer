use std::fmt::{self, Debug, Formatter};
use std::sync::atomic::{AtomicU64, Ordering};

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::{Duration, Instant};

use super::AsyncManagementActorError;
use crate::framing::DelimitedFrameCodec;
use crate::framing::asynchronous::AsyncDelimitedFrameChannel;
use crate::generated::v1 as wire;
use crate::identity::ConnectionId;
use crate::management_channel::async_actor::scrub::{ScrubbedBytes, ScrubbedManagementPayload};
use crate::management_channel::bootstrap::{
    BootstrapSelection, SecretDigest, seal_nonce, seal_token, validate_wire_bootstrap,
};
use crate::management_channel::clock::ManagementClockAuthority;
use crate::management_channel::sender::encode_bootstrap;
use crate::management_channel::{ManagementChannelError, ManagementDirection, management_hard_cap};

const BOOTSTRAP_TIMEOUT: Duration = Duration::from_secs(10);
static NEXT_ASYNC_BOOTSTRAP_ID: AtomicU64 = AtomicU64::new(1);

mod establish;
mod handoff;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BootstrapRole {
    Host,
    Supervisor,
}

/// Single-use owner of the physical stream and both management Hello steps.
pub struct AsyncBootstrapManagementActor<S> {
    transport: Option<AsyncDelimitedFrameChannel<S>>,
    expected_connection: ConnectionId,
    expected_nonce: SecretDigest,
    expected_token: SecretDigest,
    role: BootstrapRole,
    channel_id: u64,
    clock: ManagementClockAuthority,
}

impl<S> Debug for AsyncBootstrapManagementActor<S> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AsyncBootstrapManagementActor")
            .field("expected_connection", &self.expected_connection)
            .field("role", &self.role)
            .field("channel_id", &self.channel_id)
            .field("transport_open", &self.transport.is_some())
            .finish_non_exhaustive()
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin + Send + 'static> AsyncBootstrapManagementActor<S> {
    /// # Errors
    ///
    /// Rejects invalid provisioned identity, nonce, token, or framing state.
    pub fn host(
        stream: S,
        expected_connection: ConnectionId,
        expected_supervisor_launch_nonce: Vec<u8>,
        expected_management_session_token: Vec<u8>,
    ) -> Result<Self, AsyncManagementActorError> {
        Self::new(
            stream,
            expected_connection,
            expected_supervisor_launch_nonce,
            expected_management_session_token,
            BootstrapRole::Host,
        )
    }

    /// # Errors
    ///
    /// Rejects invalid provisioned identity, nonce, token, or framing state.
    pub fn supervisor(
        stream: S,
        expected_connection: ConnectionId,
        expected_supervisor_launch_nonce: Vec<u8>,
        expected_management_session_token: Vec<u8>,
    ) -> Result<Self, AsyncManagementActorError> {
        Self::new(
            stream,
            expected_connection,
            expected_supervisor_launch_nonce,
            expected_management_session_token,
            BootstrapRole::Supervisor,
        )
    }

    fn new(
        stream: S,
        expected_connection: ConnectionId,
        nonce: Vec<u8>,
        token: Vec<u8>,
        role: BootstrapRole,
    ) -> Result<Self, AsyncManagementActorError> {
        let sealed_nonce = seal_nonce(nonce);
        let sealed_token = seal_token(token);
        let expected_nonce = sealed_nonce?;
        let expected_token = sealed_token?;
        let channel_id = NEXT_ASYNC_BOOTSTRAP_ID
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.checked_add(1)
            })
            .map_err(|_| ManagementChannelError::ChannelIdExhausted)?;
        let maximum = u32::try_from(management_hard_cap())
            .map_err(|_| ManagementChannelError::InvalidNegotiatedMaximum)?;
        Ok(Self {
            transport: Some(AsyncDelimitedFrameChannel::new(
                DelimitedFrameCodec::new(maximum)?,
                stream,
            )),
            expected_connection,
            expected_nonce,
            expected_token,
            role,
            channel_id,
            clock: ManagementClockAuthority::system()?,
        })
    }

    async fn receive_hello(
        &mut self,
        direction: ManagementDirection,
        selection: Option<&BootstrapSelection>,
        timeout: Duration,
    ) -> Result<String, AsyncManagementActorError> {
        Ok(self
            .receive_bootstrap(direction, selection, timeout)
            .await?
            .message_id)
    }

    async fn receive_bootstrap(
        &mut self,
        direction: ManagementDirection,
        selection: Option<&BootstrapSelection>,
        timeout: Duration,
    ) -> Result<crate::management_channel::bootstrap::ReceivedBootstrap, AsyncManagementActorError>
    {
        let bytes = ScrubbedBytes::new(
            self.transport_mut()?
                .receive(Instant::now() + timeout)
                .await?,
        );
        let result = validate_wire_bootstrap(
            bytes.as_slice(),
            &self.expected_connection,
            direction,
            selection,
            self.expected_nonce,
            self.expected_token,
            self.clock.now_unix_ms(),
        );
        Ok(result?)
    }

    async fn send_hello(
        &mut self,
        protocol: crate::version::ProtocolVersion,
        direction: ManagementDirection,
        body: wire::management_payload::Body,
        timeout: Duration,
    ) -> Result<(), AsyncManagementActorError> {
        let payload = ScrubbedManagementPayload::new(wire::ManagementPayload { body: Some(body) });
        let encoded = ScrubbedBytes::new(encode_bootstrap(
            protocol,
            &self.expected_connection,
            direction,
            self.channel_id,
            payload.get(),
            self.clock.now_unix_ms(),
        )?);
        self.transport_mut()?
            .send(encoded.as_slice(), Instant::now() + timeout)
            .await?;
        Ok(())
    }

    fn transport_mut(
        &mut self,
    ) -> Result<&mut AsyncDelimitedFrameChannel<S>, ManagementChannelError> {
        self.transport
            .as_mut()
            .ok_or(ManagementChannelError::BootstrapConsumed)
    }
}
