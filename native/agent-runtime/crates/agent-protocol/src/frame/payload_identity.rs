use crate::generated::v1 as wire;
use crate::identity::AttemptIdentity;
use crate::wire_identity::identity_from_wire;

use super::PayloadIdentityError;

pub(super) fn validate_payload_identity(
    header_identity: &AttemptIdentity,
    body: &wire::frame_payload::Body,
) -> Result<(), PayloadIdentityError> {
    let Some((payload_name, identity)) = identity_field(body) else {
        return Ok(());
    };
    let identity = identity.ok_or(PayloadIdentityError::MissingIdentity(payload_name))?;
    let semantic =
        identity_from_wire(identity).map_err(|source| PayloadIdentityError::InvalidIdentity {
            payload: payload_name,
            source,
        })?;
    if &semantic != header_identity {
        return Err(PayloadIdentityError::HeaderMismatch(payload_name));
    }
    Ok(())
}

const fn identity_field(
    body: &wire::frame_payload::Body,
) -> Option<(&'static str, Option<&wire::AttemptIdentity>)> {
    use wire::frame_payload::Body;

    match body {
        Body::AgentHello(_) | Body::HostHello(_) | Body::Ack(_) => None,
        Body::PrepareAttempt(value) => Some(("PrepareAttempt", value.identity.as_ref())),
        Body::AttemptPrepared(value) => Some(("AttemptPrepared", value.identity.as_ref())),
        Body::ActivateAttempt(value) => Some(("ActivateAttempt", value.identity.as_ref())),
        Body::Heartbeat(value) => Some(("Heartbeat", value.identity.as_ref())),
        Body::CancelAttempt(value) => Some(("CancelAttempt", value.identity.as_ref())),
        Body::FenceAttempt(value) => Some(("FenceAttempt", value.identity.as_ref())),
        Body::TerminalProposal(value) => Some(("TerminalProposal", value.identity.as_ref())),
        Body::TerminalCommitted(value) => Some(("TerminalCommitted", value.identity.as_ref())),
        Body::BindAttemptChannel(value) => Some(("BindAttemptChannel", value.identity.as_ref())),
        Body::AttemptChannelBound(value) => Some(("AttemptChannelBound", value.identity.as_ref())),
        Body::HydrationManifest(value) => Some(("HydrationManifest", value.identity.as_ref())),
        Body::HydrationProgress(value) => Some(("HydrationProgress", value.identity.as_ref())),
        Body::HydrationChunk(value) => Some(("HydrationChunk", value.identity.as_ref())),
        Body::HydrationComplete(value) => Some(("HydrationComplete", value.identity.as_ref())),
        Body::HydrationCommitted(value) => Some(("HydrationCommitted", value.identity.as_ref())),
        Body::ProviderStart(value) => Some(("ProviderStart", value.identity.as_ref())),
        Body::ProviderAccepted(value) => Some(("ProviderAccepted", value.identity.as_ref())),
        Body::ProviderCancel(value) => Some(("ProviderCancel", value.identity.as_ref())),
        Body::ProviderTextDelta(value) => Some(("ProviderTextDelta", value.identity.as_ref())),
        Body::ProviderThinkingDelta(value) => {
            Some(("ProviderThinkingDelta", value.identity.as_ref()))
        }
        Body::ProviderToolCall(value) => Some(("ProviderToolCall", value.identity.as_ref())),
        Body::ProviderUsage(value) => Some(("ProviderUsageEvent", value.identity.as_ref())),
        Body::ProviderTerminal(value) => Some(("ProviderTerminal", value.identity.as_ref())),
        Body::EngineEventProposal(value) => Some(("EngineEventProposal", value.identity.as_ref())),
        Body::EngineEventCommitted(value) => {
            Some(("EngineEventCommitted", value.identity.as_ref()))
        }
        Body::CapabilityPrepare(value) => Some(("CapabilityPrepare", value.identity.as_ref())),
        Body::CapabilityUpdate(value) => Some(("CapabilityUpdate", value.identity.as_ref())),
        Body::CapabilityExecute(value) => Some(("CapabilityExecute", value.identity.as_ref())),
        Body::CapabilityExecutionResult(value) => {
            Some(("CapabilityExecutionResult", value.identity.as_ref()))
        }
    }
}
