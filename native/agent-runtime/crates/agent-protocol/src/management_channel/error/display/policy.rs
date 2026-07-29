use std::fmt::{self, Formatter};

use crate::management_channel::ManagementChannelError;

pub(super) fn format_policy_error(
    error: &ManagementChannelError,
    formatter: &mut Formatter<'_>,
) -> fmt::Result {
    match error {
        ManagementChannelError::InvalidContract => {
            formatter.write_str("management contract coordinates are invalid")
        }
        ManagementChannelError::MissingSupervisorProvenance => {
            formatter.write_str("expected supervisor provenance is missing")
        }
        ManagementChannelError::InvalidProvenance(field) => {
            write!(formatter, "runtime provenance field {field} is invalid")
        }
        ManagementChannelError::MissingSupervisorLimits => {
            formatter.write_str("supervisor limits are missing")
        }
        ManagementChannelError::InvalidSupervisorLimits => {
            formatter.write_str("supervisor limits are invalid")
        }
        ManagementChannelError::InvalidFrameLimits => {
            formatter.write_str("management frame limits are invalid")
        }
        ManagementChannelError::InvalidManagementToken => {
            formatter.write_str("management session token is invalid")
        }
        ManagementChannelError::InvalidContainment => {
            formatter.write_str("required containment level is invalid")
        }
        ManagementChannelError::InvalidLaunchNonce => {
            formatter.write_str("supervisor launch nonce is invalid")
        }
        ManagementChannelError::SupervisorContractMismatch => {
            formatter.write_str("supervisor contract does not match host selection")
        }
        ManagementChannelError::SupervisorProvenanceMismatch => {
            formatter.write_str("supervisor provenance does not match host policy")
        }
        ManagementChannelError::SupervisorNonceMismatch => {
            formatter.write_str("supervisor launch nonce does not match provisioned nonce")
        }
        ManagementChannelError::InvalidFeatureNegotiation => {
            formatter.write_str("supervisor does not support the host-selected feature set")
        }
        ManagementChannelError::InsufficientContainment => {
            formatter.write_str("supervisor does not provide required containment")
        }
        _ => unreachable!("only bootstrap policy errors are delegated"),
    }
}
