use agent_protocol::generated::v1 as wire;
use agent_protocol::wire_identity::identity_to_wire;

use super::super::config::TrustedRunnerConfig;
use crate::process_table::ReapedAttempt;

#[derive(Debug)]
pub(in crate::management) struct AttemptExitedFact {
    payload: wire::AttemptProcessExited,
}

impl AttemptExitedFact {
    pub(in crate::management::driver) fn new(
        reaped: &ReapedAttempt,
        trusted: &TrustedRunnerConfig,
        cause: wire::PhysicalExitCause,
    ) -> Self {
        let metadata = reaped.metadata();
        Self {
            payload: wire::AttemptProcessExited {
                identity: Some(identity_to_wire(&metadata.identity)),
                runner_provenance: Some(
                    trusted.provenance().to_runtime_wire(
                        metadata.runtime_instance_id.as_str(),
                        reaped.process_id().0,
                    ),
                ),
                cause: cause as i32,
                exit_code: Some(i32::from_ne_bytes(reaped.exit_code().to_ne_bytes())),
                signal_number: None,
                exited_at_unix_ms: reaped.observed_exit().observed_at_unix_ms,
                final_resources: Some(wire::ResourceSample {
                    resident_memory_bytes: 0,
                    peak_resident_memory_bytes: reaped.peak_job_memory_bytes(),
                    cpu_time_ms: 0,
                    process_count: 0,
                    open_file_count: 0,
                    spool_bytes: 0,
                }),
            },
        }
    }

    pub(in crate::management) fn to_wire(&self) -> wire::ManagementPayload {
        wire::ManagementPayload {
            body: Some(wire::management_payload::Body::AttemptProcessExited(
                self.payload.clone(),
            )),
        }
    }
}

#[derive(Debug)]
pub(in crate::management) struct AttemptReapedFact {
    payload: wire::AttemptProcessReaped,
}

impl AttemptReapedFact {
    pub(in crate::management::driver) fn new(
        reaped: &ReapedAttempt,
        reaped_at_unix_ms: i64,
    ) -> Self {
        let metadata = reaped.metadata();
        let resource_group_id = metadata.resource_group_id.0.clone();
        Self {
            payload: wire::AttemptProcessReaped {
                identity: Some(identity_to_wire(&metadata.identity)),
                runtime_instance_id: metadata.runtime_instance_id.as_str().into(),
                resource_group_id: resource_group_id.clone(),
                released_resources: vec![
                    wire::ReleasedResource {
                        kind: wire::ReleasedResourceKind::Process as i32,
                        resource_id: format!("pid:{}", reaped.process_id().0),
                        released_count: 1,
                    },
                    wire::ReleasedResource {
                        kind: wire::ReleasedResourceKind::ResourceGroup as i32,
                        resource_id: resource_group_id,
                        released_count: 1,
                    },
                ],
                reaped_at_unix_ms,
            },
        }
    }

    pub(in crate::management) fn to_wire(&self) -> wire::ManagementPayload {
        wire::ManagementPayload {
            body: Some(wire::management_payload::Body::AttemptProcessReaped(
                self.payload.clone(),
            )),
        }
    }
}
