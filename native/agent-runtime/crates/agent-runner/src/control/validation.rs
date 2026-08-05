use agent_protocol::frame::CONTROL_FRAME_MAX_BYTES;
use agent_protocol::generated::v1 as wire;
use agent_protocol::semantic_hash::semantic_sha256;
use agent_protocol::wire_identity::identity_from_wire;
use prost::Message;

use super::error::{ControlError, TextFieldError};
use super::launch::RunnerLaunchContext;
use super::manifest::validate_snapshot_manifest;
use super::model::{PreparedCache, ValidatedPrepare};
use super::spec_validation::{
    RESOLVED_ATTEMPT_SPEC_SCHEMA_V1, SpecValidationContext, validate_resolved_attempt_spec_v1,
};
use super::{MAX_ACTIVATION_NONCE_BYTES, MAX_IDEMPOTENCY_KEY_BYTES};

mod termination;

pub(super) use termination::{validate_cancel, validate_fence};

const RESOLVED_SPEC_SCHEMA_ID: &str = "codestudio.agent.v1.ResolvedAttemptSpec";
const MIN_ACTIVATION_NONCE_BYTES: usize = 16;

pub(super) fn validate_prepare(
    request: &wire::PrepareAttempt,
    launch: &RunnerLaunchContext,
    observed_at_unix_ms: i64,
) -> Result<ValidatedPrepare, ControlError> {
    validate_control_size(request)?;
    validate_text(&request.idempotency_key, MAX_IDEMPOTENCY_KEY_BYTES)
        .map_err(ControlError::InvalidIdempotencyKey)?;
    if request.spec_schema_version != RESOLVED_ATTEMPT_SPEC_SCHEMA_V1 {
        return Err(ControlError::UnsupportedSpecSchemaVersion(
            request.spec_schema_version,
        ));
    }

    let wire_identity = request
        .identity
        .as_ref()
        .ok_or(ControlError::MissingIdentity)?;
    let identity = identity_from_wire(wire_identity).map_err(ControlError::InvalidIdentity)?;
    if &identity != launch.identity() || wire_identity != launch.wire_identity() {
        return Err(ControlError::LaunchAuthorityMismatch);
    }
    if request.encoded_spec.is_empty() {
        return Err(ControlError::EmptyEncodedSpec);
    }
    if request.expected_spec_sha256.len() != 32 {
        return Err(ControlError::InvalidExpectedSpecHashLength(
            request.expected_spec_sha256.len(),
        ));
    }
    let spec_sha256 = semantic_sha256(
        RESOLVED_SPEC_SCHEMA_ID,
        request.spec_schema_version,
        &request.encoded_spec,
    )?;
    if !digest_equal(&request.expected_spec_sha256, &spec_sha256) {
        return Err(ControlError::SpecHashMismatch);
    }

    let spec = wire::ResolvedAttemptSpec::decode(request.encoded_spec.as_slice())
        .map_err(|_| ControlError::MalformedResolvedSpec)?;
    if spec.schema_version != request.spec_schema_version {
        return Err(ControlError::SpecSchemaVersionMismatch {
            outer: request.spec_schema_version,
            decoded: spec.schema_version,
        });
    }
    let validated = validate_resolved_attempt_spec_v1(
        spec,
        SpecValidationContext {
            expected_identity: launch.wire_identity(),
            launch_resource_budget: launch.resource_budget(),
            launch_hard_deadline_at_unix_ms: launch.hard_deadline_at_unix_ms(),
            observed_at_unix_ms,
        },
    )?;
    let expected_snapshots = validated
        .required_snapshots()
        .into_iter()
        .cloned()
        .collect::<Vec<_>>();
    validate_snapshot_manifest(
        &request.expected_snapshots,
        &expected_snapshots,
        "expected_snapshots",
    )?;
    let expected_artifacts = validated.required_artifacts().cloned().collect();
    let immutable_deadline_at_unix_ms = validated.as_wire().deadline_at_unix_ms;
    let execution_seed = validated.into_execution_seed();

    Ok(ValidatedPrepare {
        identity,
        wire_identity: wire_identity.clone(),
        immutable_deadline_at_unix_ms,
        spec_sha256,
        expected_snapshots,
        expected_artifacts,
        execution_seed,
    })
}

pub(super) fn validate_activate(
    request: &wire::ActivateAttempt,
    prepared: &PreparedCache,
    launch: &RunnerLaunchContext,
    now_unix_ms: i64,
) -> Result<(), ControlError> {
    validate_control_size(request)?;
    validate_text(&request.idempotency_key, MAX_IDEMPOTENCY_KEY_BYTES)
        .map_err(ControlError::InvalidIdempotencyKey)?;
    validate_bytes(
        &request.activation_nonce,
        MIN_ACTIVATION_NONCE_BYTES,
        MAX_ACTIVATION_NONCE_BYTES,
    )
    .map_err(ControlError::InvalidActivationNonce)?;

    let identity = request
        .identity
        .as_ref()
        .ok_or(ControlError::MissingIdentity)?;
    let semantic_identity = identity_from_wire(identity).map_err(ControlError::InvalidIdentity)?;
    if identity != &prepared.wire_identity
        || identity != launch.wire_identity()
        || &semantic_identity != launch.identity()
    {
        return Err(ControlError::ActivationIdentityMismatch);
    }
    if request.spec_sha256.len() != 32 {
        return Err(ControlError::InvalidActivationSpecHashLength(
            request.spec_sha256.len(),
        ));
    }
    if !digest_equal(&request.spec_sha256, &prepared.spec_sha256) {
        return Err(ControlError::SpecHashMismatch);
    }
    if request.agent_run_version == 0 {
        return Err(ControlError::ZeroAgentRunVersion);
    }
    if request.attempt_version == 0 {
        return Err(ControlError::ZeroAttemptVersion);
    }
    let sealed = launch.activation_authority_seal();
    if request.agent_run_version != sealed.agent_run_version() {
        return Err(ControlError::ActivationAgentRunVersionMismatch {
            expected: sealed.agent_run_version(),
            actual: request.agent_run_version,
        });
    }
    if request.attempt_version != sealed.attempt_version() {
        return Err(ControlError::ActivationAttemptVersionMismatch {
            expected: sealed.attempt_version(),
            actual: request.attempt_version,
        });
    }
    if !sealed.matches(
        request.agent_run_version,
        request.attempt_version,
        &request.activation_nonce,
    ) {
        return Err(ControlError::ActivationNonceMismatch);
    }
    let immutable = prepared
        .immutable_deadline_at_unix_ms
        .min(launch.hard_deadline_at_unix_ms());
    if request.deadline_at_unix_ms <= 0
        || now_unix_ms <= 0
        || now_unix_ms >= request.deadline_at_unix_ms
    {
        return Err(ControlError::AttemptDeadlineExpired {
            deadline: request.deadline_at_unix_ms,
            now: now_unix_ms,
        });
    }
    if request.deadline_at_unix_ms > immutable {
        return Err(ControlError::ActivationDeadlineExceedsSpec {
            requested: request.deadline_at_unix_ms,
            immutable,
        });
    }
    Ok(())
}

fn validate_control_size(message: &impl Message) -> Result<(), ControlError> {
    let length = message.encoded_len();
    if length > CONTROL_FRAME_MAX_BYTES {
        return Err(ControlError::ControlMessageTooLarge {
            length,
            maximum: CONTROL_FRAME_MAX_BYTES,
        });
    }
    Ok(())
}

fn validate_text(value: &str, maximum: usize) -> Result<(), TextFieldError> {
    if value.trim().is_empty() {
        return Err(TextFieldError::Empty);
    }
    if value.contains('\0') {
        return Err(TextFieldError::ContainsNul);
    }
    if value.len() > maximum {
        return Err(TextFieldError::TooLong {
            length: value.len(),
            maximum,
        });
    }
    Ok(())
}

const fn validate_bytes(
    value: &[u8],
    minimum: usize,
    maximum: usize,
) -> Result<(), TextFieldError> {
    if value.is_empty() {
        return Err(TextFieldError::Empty);
    }
    if value.len() < minimum {
        return Err(TextFieldError::TooShort {
            length: value.len(),
            minimum,
        });
    }
    if value.len() > maximum {
        return Err(TextFieldError::TooLong {
            length: value.len(),
            maximum,
        });
    }
    Ok(())
}

fn digest_equal(expected: &[u8], actual: &[u8; 32]) -> bool {
    expected
        .iter()
        .zip(actual)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}
