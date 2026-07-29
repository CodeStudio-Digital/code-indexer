use std::collections::HashSet;

use agent_protocol::activation_authority::ActivationAuthoritySeal;
use agent_protocol::bootstrap_limits::{BOOTSTRAP_SECRET_MIN_BYTES, SESSION_TOKEN_MAX_BYTES};
use agent_protocol::frame::{CONTROL_FRAME_MAX_BYTES, DATA_FRAME_MAX_BYTES, PULSE_FRAME_MAX_BYTES};
use agent_protocol::generated::v1 as wire;
use agent_protocol::wire_identity::identity_from_wire;
use prost::Message;
use zeroize::{Zeroize, Zeroizing};

use crate::binding::DurableHostAttemptBinding;
use crate::endpoint::EndpointPlan;
use crate::error::HostBridgeError;
use crate::request_validation::{provenance_matches, validate_budget, validate_containment};

pub const HOST_BRIDGE_OPEN_MAX_BYTES: usize = 256 * 1024;
const MAX_TEXT_BYTES: usize = 512;
pub struct HostBridgePlan {
    pub binding: DurableHostAttemptBinding,
    pub control: EndpointPlan,
    pub data: EndpointPlan,
    pub open_deadline_at_unix_ms: i64,
}

impl HostBridgePlan {
    pub(crate) fn decode(encoded: Vec<u8>, observed_at: i64) -> Result<Self, HostBridgeError> {
        if encoded.is_empty() {
            return Err(HostBridgeError::EmptyRequest);
        }
        if encoded.len() > HOST_BRIDGE_OPEN_MAX_BYTES {
            return Err(HostBridgeError::RequestTooLarge {
                length: encoded.len(),
                maximum: HOST_BRIDGE_OPEN_MAX_BYTES,
            });
        }
        let encoded = Zeroizing::new(encoded);
        let request = wire::HostAttemptBridgeOpenRequest::decode(encoded.as_slice())
            .map_err(HostBridgeError::MalformedRequest)?;
        let request = ScrubbedRequest(request);
        validate_request(&request.0, observed_at)
    }
}

fn validate_request(
    request: &wire::HostAttemptBridgeOpenRequest,
    observed_at: i64,
) -> Result<HostBridgePlan, HostBridgeError> {
    let launch = required(request.launch.as_ref(), "launch")?;
    let accepted = required(request.accepted.as_ref(), "accepted")?;
    let spawned = required(request.spawned.as_ref(), "spawned")?;
    let containment = required(request.containment.as_ref(), "containment")?;
    let launch_identity = required(launch.identity.as_ref(), "launch.identity")?;
    let identity = identity_from_wire(launch_identity)
        .map_err(|_| HostBridgeError::InvalidRequest("identity"))?;
    for candidate in [
        accepted.identity.as_ref(),
        spawned.identity.as_ref(),
        containment.identity.as_ref(),
    ] {
        if candidate != Some(launch_identity) {
            return invalid("durable_identity");
        }
    }
    validate_deadlines(request, launch, accepted, containment, observed_at)?;
    validate_facts(launch, accepted, spawned, containment)?;
    let (control, data, endpoint_ids) = validate_endpoints(&launch.protected_endpoints)?;
    if !exact_set(&spawned.endpoint_ids, &endpoint_ids) {
        return invalid("spawned.endpoint_ids");
    }
    let provenance = required(spawned.runner_provenance.as_ref(), "runner_provenance")?;
    let expected = required(
        launch.expected_runner_provenance.as_ref(),
        "expected_runner_provenance",
    )?;
    if !provenance_matches(expected, provenance)
        || containment.runtime_instance_id != provenance.runtime_instance_id
    {
        return invalid("runner_provenance");
    }
    let report = required(
        containment.effective_containment.as_ref(),
        "effective_containment",
    )?;
    validate_containment(
        report,
        request.required_containment_level,
        &launch.required_enforced_limits,
    )?;
    Ok(HostBridgePlan {
        binding: DurableHostAttemptBinding {
            identity,
            reservation_id: accepted.reservation_id.clone(),
            resource_group_id: spawned.resource_group_id.clone(),
            runtime_instance_id: provenance.runtime_instance_id.clone(),
            runner_pid: provenance.pid,
            hard_deadline_at_unix_ms: launch.hard_deadline_at_unix_ms,
        },
        control,
        data,
        open_deadline_at_unix_ms: request.open_deadline_at_unix_ms,
    })
}

const fn validate_deadlines(
    request: &wire::HostAttemptBridgeOpenRequest,
    launch: &wire::LaunchAttemptProcess,
    accepted: &wire::LaunchAccepted,
    containment: &wire::AttemptContainmentReport,
    observed_at: i64,
) -> Result<(), HostBridgeError> {
    let deadline = request.open_deadline_at_unix_ms;
    if observed_at <= 0
        || deadline <= observed_at
        || deadline > launch.hard_deadline_at_unix_ms
        || deadline > launch.authority_lease_expires_at_unix_ms
        || launch.authority_lease_expires_at_unix_ms > launch.hard_deadline_at_unix_ms
        || accepted.hard_deadline_at_unix_ms != launch.hard_deadline_at_unix_ms
        || accepted.accepted_at_unix_ms <= 0
        || containment.reported_at_unix_ms < accepted.accepted_at_unix_ms
        || containment.reported_at_unix_ms >= deadline
    {
        return invalid("deadlines");
    }
    Ok(())
}

fn validate_facts(
    launch: &wire::LaunchAttemptProcess,
    accepted: &wire::LaunchAccepted,
    spawned: &wire::AttemptProcessSpawned,
    containment: &wire::AttemptContainmentReport,
) -> Result<(), HostBridgeError> {
    let budget = required(launch.resource_budget.as_ref(), "resource_budget")?;
    validate_budget(budget)?;
    if accepted.reserved_budget.as_ref() != Some(budget)
        || containment.requested_budget.as_ref() != Some(budget)
        || accepted.reservation_id != spawned.reservation_id
        || spawned.spawned_at_unix_ms < accepted.accepted_at_unix_ms
        || containment.reported_at_unix_ms < spawned.spawned_at_unix_ms
        || !valid_text(&accepted.reservation_id)
        || !valid_text(&spawned.resource_group_id)
        || !valid_text(&containment.runtime_instance_id)
    {
        return invalid("durable_facts");
    }
    let seal = required(
        launch.activation_authority_seal.as_ref(),
        "activation_authority_seal",
    )?;
    ActivationAuthoritySeal::try_from(seal)
        .map_err(|_| HostBridgeError::InvalidRequest("activation_authority_seal"))?;
    Ok(())
}

fn validate_endpoints(
    values: &[wire::ProtectedAttemptEndpoint],
) -> Result<(EndpointPlan, EndpointPlan, Vec<String>), HostBridgeError> {
    if values.len() != 3 {
        return invalid("protected_endpoints");
    }
    let mut kinds = HashSet::with_capacity(3);
    let mut ids = HashSet::with_capacity(3);
    let mut connections = HashSet::with_capacity(3);
    let mut control = None;
    let mut data = None;
    for value in values {
        let kind = wire::AttemptEndpointKind::try_from(value.kind)
            .map_err(|_| HostBridgeError::InvalidRequest("endpoint.kind"))?;
        let maximum = endpoint_maximum(kind)?;
        if !kinds.insert(kind)
            || !ids.insert(value.endpoint_id.clone())
            || !connections.insert(value.connection_id.clone())
            || !valid_text(&value.endpoint_id)
            || !valid_text(&value.address)
            || !valid_text(&value.connection_id)
            || value.max_frame_bytes != u64::from(maximum)
            || !(BOOTSTRAP_SECRET_MIN_BYTES..=SESSION_TOKEN_MAX_BYTES)
                .contains(&value.connection_token.len())
        {
            return invalid("protected_endpoints");
        }
        let plan = EndpointPlan {
            endpoint_id: value.endpoint_id.clone(),
            address: value.address.clone(),
            connection_id: value.connection_id.clone(),
            maximum_frame_bytes: maximum,
        };
        match kind {
            wire::AttemptEndpointKind::Control => control = Some(plan),
            wire::AttemptEndpointKind::Data => data = Some(plan),
            wire::AttemptEndpointKind::RunnerPulse => {}
            wire::AttemptEndpointKind::Unspecified => return invalid("endpoint.kind"),
        }
    }
    Ok((
        required(control, "control_endpoint")?,
        required(data, "data_endpoint")?,
        ids.into_iter().collect(),
    ))
}

fn endpoint_maximum(kind: wire::AttemptEndpointKind) -> Result<u32, HostBridgeError> {
    let maximum = match kind {
        wire::AttemptEndpointKind::Control => CONTROL_FRAME_MAX_BYTES,
        wire::AttemptEndpointKind::Data => DATA_FRAME_MAX_BYTES,
        wire::AttemptEndpointKind::RunnerPulse => PULSE_FRAME_MAX_BYTES,
        wire::AttemptEndpointKind::Unspecified => return invalid("endpoint.kind"),
    };
    u32::try_from(maximum).map_err(|_| HostBridgeError::InvalidRequest("endpoint.maximum"))
}

fn exact_set(actual: &[String], expected: &[String]) -> bool {
    actual.len() == expected.len()
        && actual.iter().collect::<HashSet<_>>().len() == actual.len()
        && actual.iter().all(|item| expected.contains(item))
}

fn valid_text(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= MAX_TEXT_BYTES && !value.as_bytes().contains(&0)
}

fn required<T>(value: Option<T>, field: &'static str) -> Result<T, HostBridgeError> {
    value.ok_or(HostBridgeError::InvalidRequest(field))
}

const fn invalid<T>(field: &'static str) -> Result<T, HostBridgeError> {
    Err(HostBridgeError::InvalidRequest(field))
}

struct ScrubbedRequest(wire::HostAttemptBridgeOpenRequest);

impl Drop for ScrubbedRequest {
    fn drop(&mut self) {
        let Some(launch) = self.0.launch.as_mut() else {
            return;
        };
        launch.launch_nonce.zeroize();
        for endpoint in &mut launch.protected_endpoints {
            endpoint.connection_token.zeroize();
        }
        if let Some(seal) = launch.activation_authority_seal.as_mut() {
            seal.activation_nonce_sha256.zeroize();
        }
    }
}
