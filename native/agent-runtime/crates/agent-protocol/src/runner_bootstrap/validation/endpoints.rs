use crate::bootstrap_limits::{BOOTSTRAP_SECRET_MIN_BYTES, SESSION_TOKEN_MAX_BYTES};
use crate::frame::{CONTROL_FRAME_MAX_BYTES, DATA_FRAME_MAX_BYTES, PULSE_FRAME_MAX_BYTES};
use crate::generated::v1 as wire;

use super::super::RunnerBootstrapError;
use super::super::error::invalid;
use super::valid_text;

const HANDOFF: &str = "RunnerLaunchHandoff";

pub(super) fn validate_endpoints_and_peers(
    value: &wire::RunnerLaunchHandoff,
) -> Result<(), RunnerBootstrapError> {
    let expected_kinds = [
        wire::AttemptEndpointKind::Control,
        wire::AttemptEndpointKind::Data,
        wire::AttemptEndpointKind::RunnerPulse,
    ];
    if value.endpoints.len() != expected_kinds.len() {
        return Err(invalid(HANDOFF, "endpoints"));
    }
    for (endpoint, expected_kind) in value.endpoints.iter().zip(expected_kinds) {
        validate_endpoint(endpoint, expected_kind)?;
    }
    validate_unique_endpoint_text(&value.endpoints)?;
    validate_uniform_provisioning(value)
}

fn validate_endpoint(
    value: &wire::RunnerLaunchEndpoint,
    expected_kind: wire::AttemptEndpointKind,
) -> Result<(), RunnerBootstrapError> {
    let kind = wire::AttemptEndpointKind::try_from(value.kind)
        .map_err(|_| invalid(HANDOFF, "endpoint.kind"))?;
    if kind != expected_kind
        || !valid_text(&value.endpoint_id)
        || !valid_text(&value.address)
        || !valid_text(&value.connection_id)
        || !(BOOTSTRAP_SECRET_MIN_BYTES..=SESSION_TOKEN_MAX_BYTES)
            .contains(&value.connection_token.len())
        || value.max_frame_bytes != frame_maximum(kind)
    {
        return Err(invalid(HANDOFF, "endpoints"));
    }
    let role = wire::RunnerExpectedPeerRole::try_from(value.expected_peer_role)
        .map_err(|_| invalid(HANDOFF, "endpoint.expected_peer_role"))?;
    if role != expected_role(kind) {
        return Err(invalid(HANDOFF, "endpoint.expected_peer_role"));
    }
    wire::RunnerEndpointProvisioning::try_from(value.provisioning)
        .map_err(|_| invalid(HANDOFF, "endpoint.provisioning"))?;
    wire::RunnerListenerSlot::try_from(value.listener_slot)
        .map_err(|_| invalid(HANDOFF, "endpoint.listener_slot"))?;
    Ok(())
}

fn validate_uniform_provisioning(
    value: &wire::RunnerLaunchHandoff,
) -> Result<(), RunnerBootstrapError> {
    let mode = wire::RunnerEndpointProvisioning::try_from(value.endpoints[0].provisioning)
        .map_err(|_| invalid(HANDOFF, "endpoint.provisioning"))?;
    if mode == wire::RunnerEndpointProvisioning::Unspecified
        || value.endpoints.iter().any(|endpoint| {
            wire::RunnerEndpointProvisioning::try_from(endpoint.provisioning) != Ok(mode)
        })
    {
        return Err(invalid(HANDOFF, "endpoint.provisioning"));
    }
    let host = value
        .expected_host_peer
        .as_ref()
        .ok_or_else(|| invalid(HANDOFF, "expected_host_peer"))?;
    let supervisor = value
        .expected_supervisor_peer
        .as_ref()
        .ok_or_else(|| invalid(HANDOFF, "expected_supervisor_peer"))?;
    if host.process_id == 0
        || supervisor.process_id == 0
        || host.process_id == supervisor.process_id
        || host.process_id == value.runner_process_id
        || supervisor.process_id == value.runner_process_id
    {
        return Err(invalid(HANDOFF, "expected_peers"));
    }
    match mode {
        wire::RunnerEndpointProvisioning::WindowsCreateNamedPipe => {
            if host.unix_user_id.is_some()
                || supervisor.unix_user_id.is_some()
                || value.endpoints.iter().any(|endpoint| {
                    endpoint.listener_slot != wire::RunnerListenerSlot::Unspecified as i32
                })
            {
                return Err(invalid(HANDOFF, "windows_endpoint_mapping"));
            }
        }
        wire::RunnerEndpointProvisioning::UnixReceiveBoundSocket => {
            if host.unix_user_id.is_none()
                || supervisor.unix_user_id.is_none()
                || value
                    .endpoints
                    .iter()
                    .any(|endpoint| endpoint.listener_slot != expected_slot(endpoint.kind) as i32)
            {
                return Err(invalid(HANDOFF, "unix_endpoint_mapping"));
            }
        }
        wire::RunnerEndpointProvisioning::Unspecified => unreachable!(),
    }
    Ok(())
}

fn validate_unique_endpoint_text(
    endpoints: &[wire::RunnerLaunchEndpoint],
) -> Result<(), RunnerBootstrapError> {
    for (index, endpoint) in endpoints.iter().enumerate() {
        if endpoints[..index].iter().any(|previous| {
            previous.endpoint_id == endpoint.endpoint_id
                || previous.address == endpoint.address
                || previous.connection_id == endpoint.connection_id
                || previous.connection_token == endpoint.connection_token
        }) {
            return Err(invalid(HANDOFF, "endpoints"));
        }
    }
    Ok(())
}

const fn frame_maximum(kind: wire::AttemptEndpointKind) -> u64 {
    match kind {
        wire::AttemptEndpointKind::Control => CONTROL_FRAME_MAX_BYTES as u64,
        wire::AttemptEndpointKind::Data => DATA_FRAME_MAX_BYTES as u64,
        wire::AttemptEndpointKind::RunnerPulse => PULSE_FRAME_MAX_BYTES as u64,
        wire::AttemptEndpointKind::Unspecified => 0,
    }
}

const fn expected_role(kind: wire::AttemptEndpointKind) -> wire::RunnerExpectedPeerRole {
    match kind {
        wire::AttemptEndpointKind::Control | wire::AttemptEndpointKind::Data => {
            wire::RunnerExpectedPeerRole::Host
        }
        wire::AttemptEndpointKind::RunnerPulse => wire::RunnerExpectedPeerRole::Supervisor,
        wire::AttemptEndpointKind::Unspecified => wire::RunnerExpectedPeerRole::Unspecified,
    }
}

const fn expected_slot(kind: i32) -> wire::RunnerListenerSlot {
    if kind == wire::AttemptEndpointKind::Control as i32 {
        wire::RunnerListenerSlot::Control
    } else if kind == wire::AttemptEndpointKind::Data as i32 {
        wire::RunnerListenerSlot::Data
    } else if kind == wire::AttemptEndpointKind::RunnerPulse as i32 {
        wire::RunnerListenerSlot::RunnerPulse
    } else {
        wire::RunnerListenerSlot::Unspecified
    }
}
