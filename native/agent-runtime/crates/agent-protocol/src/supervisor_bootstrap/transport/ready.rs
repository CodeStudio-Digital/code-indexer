use crate::generated::v1 as wire;

use super::SupervisorBootstrapError;

pub(super) fn validate(
    ready: &wire::SupervisorProcessReady,
    expected_supervisor_process_id: u32,
    expected_connection_id: &str,
    expected_endpoint_address: &str,
) -> Result<(), SupervisorBootstrapError> {
    for (matches, field) in [
        (
            ready.schema_version == super::super::SUPERVISOR_BOOTSTRAP_SCHEMA_VERSION,
            "ready.schema_version",
        ),
        (
            ready.supervisor_process_id != 0
                && ready.supervisor_process_id == expected_supervisor_process_id,
            "ready.supervisor_process_id",
        ),
        (
            ready.management_connection_id == expected_connection_id,
            "ready.management_connection_id",
        ),
        (
            ready.management_endpoint_address == expected_endpoint_address,
            "ready.management_endpoint_address",
        ),
    ] {
        if !matches {
            return Err(SupervisorBootstrapError::InvalidField(field));
        }
    }
    Ok(())
}
