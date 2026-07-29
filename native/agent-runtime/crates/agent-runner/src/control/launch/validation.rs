use std::collections::BTreeSet;

use agent_protocol::generated::v1 as wire;
use agent_protocol::wire_identity::MAX_WIRE_IDENTIFIER_BYTES;

use super::LaunchContextError;
use crate::control::MAX_RUNTIME_INSTANCE_ID_BYTES;

pub(super) fn validate_runtime_id(value: &str) -> Result<(), LaunchContextError> {
    if value.trim().is_empty()
        || value.contains('\0')
        || value.len() > MAX_RUNTIME_INSTANCE_ID_BYTES
    {
        return Err(LaunchContextError::InvalidRuntimeInstanceId);
    }
    Ok(())
}

pub(super) fn validate_expected_connection_id(value: &str) -> Result<(), LaunchContextError> {
    if value.contains('\0') || value.len() > MAX_WIRE_IDENTIFIER_BYTES {
        return Err(LaunchContextError::InvalidExpectedConnectionId);
    }
    Ok(())
}

pub(super) const fn validate_level(
    level: wire::ContainmentLevel,
) -> Result<(), LaunchContextError> {
    if matches!(
        level,
        wire::ContainmentLevel::Unspecified | wire::ContainmentLevel::Unavailable
    ) {
        return Err(LaunchContextError::InvalidContainmentLevel);
    }
    Ok(())
}

pub(super) fn validate_limits(
    limits: &[wire::ResourceLimitKind],
) -> Result<(), LaunchContextError> {
    if limits.is_empty() {
        return Err(LaunchContextError::EmptyRequiredLimits);
    }
    let mut unique = BTreeSet::new();
    for limit in limits {
        if *limit == wire::ResourceLimitKind::Unspecified {
            return Err(LaunchContextError::InvalidRequiredLimit);
        }
        if !unique.insert(*limit as i32) {
            return Err(LaunchContextError::DuplicateRequiredLimit(*limit));
        }
    }
    Ok(())
}

#[cfg(test)]
pub(super) fn constant_time_equal(left: &[u8; 32], right: &[u8; 32]) -> bool {
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}
