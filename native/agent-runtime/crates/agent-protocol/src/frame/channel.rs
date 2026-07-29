use crate::generated::v1 as wire;

use super::FrameValidationError;

pub(super) const fn validate_payload_channel(
    channel: wire::TransportChannel,
    body: &wire::frame_payload::Body,
) -> Result<(), FrameValidationError> {
    use wire::frame_payload::Body;

    match (channel, body) {
        (
            wire::TransportChannel::Control,
            Body::AgentHello(_)
            | Body::HostHello(_)
            | Body::PrepareAttempt(_)
            | Body::AttemptPrepared(_)
            | Body::ActivateAttempt(_)
            | Body::Heartbeat(_)
            | Body::CancelAttempt(_)
            | Body::FenceAttempt(_)
            | Body::TerminalProposal(_)
            | Body::TerminalCommitted(_)
            | Body::Ack(_),
        )
        | (
            wire::TransportChannel::Data,
            Body::BindAttemptChannel(_)
            | Body::AttemptChannelBound(_)
            | Body::HydrationManifest(_)
            | Body::HydrationProgress(_)
            | Body::HydrationChunk(_)
            | Body::HydrationComplete(_)
            | Body::HydrationCommitted(_),
        ) => Ok(()),
        (
            wire::TransportChannel::Control,
            Body::BindAttemptChannel(_)
            | Body::AttemptChannelBound(_)
            | Body::HydrationManifest(_)
            | Body::HydrationProgress(_)
            | Body::HydrationChunk(_)
            | Body::HydrationComplete(_)
            | Body::HydrationCommitted(_),
        )
        | (
            wire::TransportChannel::Data,
            Body::AgentHello(_)
            | Body::HostHello(_)
            | Body::PrepareAttempt(_)
            | Body::AttemptPrepared(_)
            | Body::ActivateAttempt(_)
            | Body::Heartbeat(_)
            | Body::CancelAttempt(_)
            | Body::FenceAttempt(_)
            | Body::TerminalProposal(_)
            | Body::TerminalCommitted(_)
            | Body::Ack(_),
        ) => Err(FrameValidationError::PayloadNotAllowed {
            channel,
            payload: payload_name(body),
        }),
        (wire::TransportChannel::Management | wire::TransportChannel::Pulse, _) => {
            Err(FrameValidationError::DedicatedFrameRequired(channel))
        }
        (wire::TransportChannel::Unspecified, _) => Err(FrameValidationError::UnspecifiedChannel),
    }
}

pub(super) const fn payload_name(body: &wire::frame_payload::Body) -> &'static str {
    use wire::frame_payload::Body;

    match body {
        Body::AgentHello(_) => "AgentHello",
        Body::HostHello(_) => "HostHello",
        Body::PrepareAttempt(_) => "PrepareAttempt",
        Body::AttemptPrepared(_) => "AttemptPrepared",
        Body::ActivateAttempt(_) => "ActivateAttempt",
        Body::Heartbeat(_) => "Heartbeat",
        Body::CancelAttempt(_) => "CancelAttempt",
        Body::FenceAttempt(_) => "FenceAttempt",
        Body::TerminalProposal(_) => "TerminalProposal",
        Body::TerminalCommitted(_) => "TerminalCommitted",
        Body::Ack(_) => "Ack",
        Body::BindAttemptChannel(_) => "BindAttemptChannel",
        Body::AttemptChannelBound(_) => "AttemptChannelBound",
        Body::HydrationManifest(_) => "HydrationManifest",
        Body::HydrationProgress(_) => "HydrationProgress",
        Body::HydrationChunk(_) => "HydrationChunk",
        Body::HydrationComplete(_) => "HydrationComplete",
        Body::HydrationCommitted(_) => "HydrationCommitted",
    }
}
