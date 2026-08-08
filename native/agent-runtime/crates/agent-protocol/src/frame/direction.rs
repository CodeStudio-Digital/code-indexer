use std::error::Error;
use std::fmt::{self, Display, Formatter};

use crate::generated::v1 as wire;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameDirection {
    HostToRunner,
    RunnerToHost,
}

impl FrameDirection {
    pub(super) const fn reverse(self) -> Self {
        match self {
            Self::HostToRunner => Self::RunnerToHost,
            Self::RunnerToHost => Self::HostToRunner,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DirectionError {
    pub direction: FrameDirection,
    pub channel: wire::TransportChannel,
    pub payload: &'static str,
}

impl Display for DirectionError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "payload {} is forbidden for {:?} on {:?}",
            self.payload, self.direction, self.channel
        )
    }
}

impl Error for DirectionError {}

pub(super) const fn validate_payload_direction(
    direction: FrameDirection,
    channel: wire::TransportChannel,
    body: &wire::frame_payload::Body,
) -> Result<(), DirectionError> {
    use wire::frame_payload::Body;

    let allowed = matches!(
        (direction, channel, body),
        (
            FrameDirection::HostToRunner,
            wire::TransportChannel::Control,
            Body::PrepareAttempt(_)
                | Body::ActivateAttempt(_)
                | Body::CancelAttempt(_)
                | Body::FenceAttempt(_)
                | Body::TerminalCommitted(_)
                | Body::Ack(_),
        ) | (
            FrameDirection::RunnerToHost,
            wire::TransportChannel::Control,
            Body::AttemptPrepared(_)
                | Body::Heartbeat(_)
                | Body::TerminalProposal(_)
                | Body::Ack(_),
        ) | (
            FrameDirection::RunnerToHost,
            wire::TransportChannel::Data,
            Body::AttemptChannelBound(_)
                | Body::HydrationProgress(_)
                | Body::HydrationCommitted(_)
                | Body::ProviderStart(_)
                | Body::ProviderCancel(_)
                | Body::EngineEventProposal(_)
                | Body::CapabilityPrepare(_)
                | Body::CapabilityExecute(_),
        ) | (
            FrameDirection::HostToRunner,
            wire::TransportChannel::Data,
            Body::BindAttemptChannel(_)
                | Body::HydrationManifest(_)
                | Body::HydrationChunk(_)
                | Body::HydrationComplete(_)
                | Body::ProviderAccepted(_)
                | Body::ProviderTextDelta(_)
                | Body::ProviderThinkingDelta(_)
                | Body::ProviderToolCall(_)
                | Body::ProviderUsage(_)
                | Body::ProviderTerminal(_)
                | Body::EngineEventCommitted(_)
                | Body::CapabilityUpdate(_)
                | Body::CapabilityExecutionResult(_),
        )
    );
    if allowed {
        Ok(())
    } else {
        Err(DirectionError {
            direction,
            channel,
            payload: super::channel::payload_name(body),
        })
    }
}
