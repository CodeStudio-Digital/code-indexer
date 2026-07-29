use tokio::io::{AsyncRead, AsyncWrite};

use crate::bootstrap_limits::{BOOTSTRAP_SECRET_MIN_BYTES, SESSION_TOKEN_MAX_BYTES};
use crate::frame::bootstrap::NegotiatedReceiverSeed;
use crate::frame::secrets::ScrubbedFrameBody;
use crate::frame::{
    AsyncEstablishedAttemptChannel, AttemptFrameReceiver, DATA_FRAME_MAX_BYTES, FrameDirection,
    FrameReceiveOutcome,
};
use crate::framing::DelimitedFrameCodec;
use crate::framing::asynchronous::AsyncDelimitedFrameChannel;
use crate::generated::v1 as wire;
use crate::identity::{AttemptIdentity, ConnectionId, RuntimeInstanceId};
use crate::runner_bootstrap::RunnerEndpointTokenVerifier;
use crate::version::ProtocolVersion;
use crate::wire_identity::identity_to_wire;

use super::{AsyncBoundDataAttemptChannel, DataChannelError, DataChannelLimits};

mod model;
pub use model::{AsyncPendingDataAttemptChannel, DataBindDeadlines, RunnerDataBindAuthority};

const DATA_BOOTSTRAP_TOMBSTONE_ID: &str = "00000000-0000-4000-8000-000000000000";
const DATA_REPLAY_WINDOW_ENTRIES: usize = 8;
const DATA_TRACKED_MESSAGE_IDS: usize = 65_536;

impl RunnerDataBindAuthority {
    /// Binds a non-cloneable endpoint verifier to immutable attempt context.
    ///
    /// # Errors
    ///
    /// Rejects a verifier minted for another handoff, endpoint, or connection.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        identity: AttemptIdentity,
        connection: ConnectionId,
        protocol: ProtocolVersion,
        runtime_instance_id: RuntimeInstanceId,
        handoff_digest: &[u8; 32],
        token_verifier: RunnerEndpointTokenVerifier,
        limits: DataChannelLimits,
    ) -> Result<Self, DataChannelError> {
        if protocol.major == 0 {
            return Err(DataChannelError::InvalidAuthority(
                "protocol major cannot be zero",
            ));
        }
        if !token_verifier.is_bound_to(
            handoff_digest,
            wire::AttemptEndpointKind::Data,
            connection.as_str(),
        ) {
            return Err(DataChannelError::InvalidAuthority(
                "endpoint token verifier does not match the data endpoint",
            ));
        }
        Ok(Self {
            identity,
            connection,
            protocol,
            runtime_instance_id,
            token_verifier,
            limits,
        })
    }

    /// Transfers the authority into the sole owner of a physical stream.
    ///
    /// # Errors
    ///
    /// Rejects invalid framing or replay budgets.
    pub fn attach<S>(self, stream: S) -> Result<AsyncPendingDataAttemptChannel<S>, DataChannelError>
    where
        S: AsyncRead + AsyncWrite + Unpin + 'static,
    {
        let maximum = self.limits.maximum_frame_bytes();
        let seed = NegotiatedReceiverSeed {
            protocol: self.protocol,
            connection: self.connection.clone(),
            identity: self.identity.clone(),
            channel: wire::TransportChannel::Data,
            direction: FrameDirection::HostToRunner,
            maximum_frame_bytes: maximum,
            stream_watermark: 0,
            bootstrap_message_id: DATA_BOOTSTRAP_TOMBSTONE_ID.into(),
            bootstrap_channel_id: 0,
        };
        let receiver = AttemptFrameReceiver::from_seed(
            seed,
            DATA_REPLAY_WINDOW_ENTRIES,
            DATA_TRACKED_MESSAGE_IDS,
            maximum.checked_mul(DATA_REPLAY_WINDOW_ENTRIES).ok_or(
                DataChannelError::InvalidLimits("replay byte budget overflow"),
            )?,
        )
        .map_err(crate::frame::AsyncEstablishedChannelError::Inbound)?;
        let sender = receiver
            .outbound_authority(0)
            .map_err(crate::frame::AsyncEstablishedChannelError::Outbound)?;
        let maximum = u32::try_from(maximum)
            .map_err(|_| DataChannelError::InvalidLimits("frame cap exceeds the physical codec"))?;
        debug_assert!(maximum as usize <= DATA_FRAME_MAX_BYTES);
        let codec =
            DelimitedFrameCodec::new(maximum).map_err(crate::framing::AsyncFramingError::from)?;
        let transport = AsyncDelimitedFrameChannel::new(codec, stream);
        let channel = AsyncEstablishedAttemptChannel::from_handoff(transport, receiver, sender)?;
        Ok(AsyncPendingDataAttemptChannel {
            channel,
            authority: self,
        })
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> AsyncPendingDataAttemptChannel<S> {
    /// Authenticates and commits the one-shot Host→runner data bind.
    ///
    /// The endpoint token is zeroized before the `AttemptChannelBound` write.
    /// Any rejection, timeout, cancellation, or ambiguous write drops the sole
    /// stream and verifier owners.
    ///
    /// # Errors
    ///
    /// Rejects any first payload other than an exact, token-authenticated data
    /// bind for this runtime instance.
    pub async fn bind<F>(
        mut self,
        deadlines: DataBindDeadlines,
        mut clock: F,
    ) -> Result<AsyncBoundDataAttemptChannel<S>, DataChannelError>
    where
        F: FnMut() -> i64,
    {
        let outcome = self
            .channel
            .begin_receive(
                deadlines.read,
                deadlines.replay_hard,
                deadlines.replay_write_timeout,
                &mut clock,
            )
            .await?;
        let FrameReceiveOutcome::Pending(mut pending) = outcome else {
            return Err(DataChannelError::UnexpectedReplay);
        };
        let (body, _) = pending.take_body_and_digest().map_err(|error| {
            DataChannelError::Established(crate::frame::AsyncEstablishedChannelError::Inbound(
                error,
            ))
        })?;
        let scrubbed = ScrubbedFrameBody::new(body);
        let wire::frame_payload::Body::BindAttemptChannel(binding) = scrubbed.as_ref() else {
            self.channel.reject(*pending)?;
            return Err(DataChannelError::InvalidBinding(
                "the first payload is not BindAttemptChannel",
            ));
        };
        if binding.runtime_instance_id != self.authority.runtime_instance_id.as_str() {
            self.channel.reject(*pending)?;
            return Err(DataChannelError::InvalidBinding(
                "runtime instance differs from launch authority",
            ));
        }
        if binding.channel != wire::TransportChannel::Data as i32 {
            self.channel.reject(*pending)?;
            return Err(DataChannelError::InvalidBinding(
                "binding does not name the data channel",
            ));
        }
        if !(BOOTSTRAP_SECRET_MIN_BYTES..=SESSION_TOKEN_MAX_BYTES)
            .contains(&binding.connection_session_token.len())
            || !self
                .authority
                .token_verifier
                .matches(&binding.connection_session_token)
        {
            self.channel.reject(*pending)?;
            return Err(DataChannelError::InvalidBinding(
                "endpoint token does not match launch authority",
            ));
        }
        drop(scrubbed);
        let bound_at_unix_ms = clock();
        if bound_at_unix_ms <= 0 || deadlines.semantic_at_unix_ms <= bound_at_unix_ms {
            self.channel.reject(*pending)?;
            return Err(DataChannelError::InvalidBinding(
                "bound timestamp or semantic deadline is invalid",
            ));
        }
        let payload = wire::FramePayload {
            body: Some(wire::frame_payload::Body::AttemptChannelBound(
                wire::AttemptChannelBound {
                    identity: Some(identity_to_wire(&self.authority.identity)),
                    runtime_instance_id: self.authority.runtime_instance_id.as_str().into(),
                    channel: wire::TransportChannel::Data as i32,
                    effective_limits: Some(*self.authority.limits.as_wire()),
                    bound_at_unix_ms,
                },
            )),
        };
        self.channel
            .commit_response(
                *pending,
                &payload,
                deadlines.semantic_at_unix_ms,
                deadlines.write,
                clock,
            )
            .await?;
        Ok(AsyncBoundDataAttemptChannel {
            channel: self.channel,
            limits: self.authority.limits,
        })
    }
}
