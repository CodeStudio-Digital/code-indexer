use crate::generated::v1 as wire;

use super::{bounded_time, invalid, required_identity, valid_code, valid_text};
use crate::management_channel::ManagementChannelError;

pub(super) fn validate(
    body: &wire::management_payload::Body,
    observed_at: i64,
) -> Result<(), ManagementChannelError> {
    use wire::management_payload::Body;

    match body {
        Body::UpdateAttemptAuthority(value) => {
            required_identity(value.identity.as_ref(), "UpdateAttemptAuthority")?;
            valid_text(
                &value.idempotency_key,
                "UpdateAttemptAuthority",
                "idempotency_key",
            )?;
            if value.updated_at_unix_ms <= 0
                || value.updated_at_unix_ms > observed_at
                || value.authority_lease_expires_at_unix_ms <= value.updated_at_unix_ms
                || value.hard_deadline_at_unix_ms < value.authority_lease_expires_at_unix_ms
            {
                return invalid("UpdateAttemptAuthority", "deadlines");
            }
            Ok(())
        }
        Body::CancelAttemptProcess(value) => {
            required_identity(value.identity.as_ref(), "CancelAttemptProcess")?;
            valid_code(&value.reason_code, "CancelAttemptProcess", "reason_code")?;
            valid_text(
                &value.idempotency_key,
                "CancelAttemptProcess",
                "idempotency_key",
            )?;
            if value.grace_deadline_at_unix_ms <= 0 {
                return invalid("CancelAttemptProcess", "grace_deadline");
            }
            Ok(())
        }
        Body::FenceAttemptProcess(value) => {
            let identity = required_identity(value.identity.as_ref(), "FenceAttemptProcess")?;
            if value.replacement_fencing_epoch <= identity.fencing_epoch {
                return invalid("FenceAttemptProcess", "replacement_fencing_epoch");
            }
            valid_code(&value.reason_code, "FenceAttemptProcess", "reason_code")?;
            valid_text(
                &value.idempotency_key,
                "FenceAttemptProcess",
                "idempotency_key",
            )?;
            bounded_time(
                value.fenced_at_unix_ms,
                observed_at,
                "FenceAttemptProcess",
                "fenced_at",
            )
        }
        Body::ReapAttemptProcess(value) => {
            required_identity(value.identity.as_ref(), "ReapAttemptProcess")?;
            valid_text(
                &value.runtime_instance_id,
                "ReapAttemptProcess",
                "runtime_instance_id",
            )?;
            valid_code(&value.reason_code, "ReapAttemptProcess", "reason_code")?;
            valid_text(
                &value.idempotency_key,
                "ReapAttemptProcess",
                "idempotency_key",
            )?;
            if value.reap_deadline_at_unix_ms <= 0 {
                return invalid("ReapAttemptProcess", "reap_deadline");
            }
            Ok(())
        }
        Body::QuerySupervisorState(value) => {
            if let Some(identity) = &value.identity_filter {
                crate::wire_identity::identity_from_wire(identity)
                    .map_err(ManagementChannelError::InvalidIdentifier)?;
            }
            Ok(())
        }
        Body::ShutdownSupervisor(value) => {
            if wire::SupervisorShutdownMode::try_from(value.mode).is_err()
                || value.mode == wire::SupervisorShutdownMode::Unspecified as i32
            {
                return invalid("ShutdownSupervisor", "mode");
            }
            valid_code(&value.reason_code, "ShutdownSupervisor", "reason_code")?;
            valid_text(
                &value.idempotency_key,
                "ShutdownSupervisor",
                "idempotency_key",
            )?;
            if value.shutdown_deadline_at_unix_ms <= observed_at {
                return invalid("ShutdownSupervisor", "shutdown_deadline");
            }
            Ok(())
        }
        _ => unreachable!("non-command routed to command validation"),
    }
}
