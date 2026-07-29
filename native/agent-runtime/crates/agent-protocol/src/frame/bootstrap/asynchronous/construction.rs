use tokio::io::{AsyncRead, AsyncWrite};

use crate::frame::FrameDirection;
use crate::framing::asynchronous::AsyncDelimitedFrameChannel;
use crate::framing::{AsyncFramingError, DelimitedFrameCodec, FramingError};
use crate::identity::{AttemptIdentity, ConnectionId};

use super::super::BootstrapReceiver;
use super::{AsyncBootstrapAttemptChannel, AsyncBootstrapChannelError};

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> AsyncBootstrapAttemptChannel<S> {
    /// Creates the sole async owner for one expected attempt connection.
    ///
    /// # Errors
    ///
    /// Rejects invalid semantic or physical frame caps.
    pub fn new(
        stream: S,
        expected_identity: AttemptIdentity,
        expected_connection: ConnectionId,
        hard_cap: usize,
    ) -> Result<Self, AsyncBootstrapChannelError> {
        let receiver = BootstrapReceiver::new(
            expected_identity.clone(),
            expected_connection.clone(),
            FrameDirection::HostToRunner,
            hard_cap,
        )
        .map_err(AsyncBootstrapChannelError::Bootstrap)?;
        let physical_cap = u32::try_from(hard_cap)
            .map_err(|_| FramingError::FrameTooLarge {
                declared: u32::MAX,
                maximum: u32::MAX,
            })
            .and_then(DelimitedFrameCodec::new)
            .map_err(AsyncFramingError::from)
            .map_err(AsyncBootstrapChannelError::Framing)?;
        Ok(Self {
            transport: AsyncDelimitedFrameChannel::new(physical_cap, stream),
            receiver,
            accepted_channel_id: None,
            expected_identity,
            expected_connection,
            hard_cap,
            outbound_hello_sent: false,
        })
    }
}
