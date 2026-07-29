use std::fmt::{self, Debug, Formatter};

use crate::generated::v1 as wire;

use super::RUNNER_BOOTSTRAP_SCHEMA_VERSION;

#[derive(PartialEq)]
pub struct MatchedRunnerEndpointsReady {
    ready: wire::RunnerEndpointsReady,
}

impl MatchedRunnerEndpointsReady {
    pub(super) const fn new(ready: wire::RunnerEndpointsReady) -> Self {
        Self { ready }
    }

    #[must_use]
    pub const fn wire(&self) -> &wire::RunnerEndpointsReady {
        &self.ready
    }
}

impl Debug for MatchedRunnerEndpointsReady {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MatchedRunnerEndpointsReady")
            .field("ready", &"[WIRE-MATCHED; DIGEST REDACTED]")
            .finish()
    }
}

pub(super) fn expected_ready(
    handoff: &wire::RunnerLaunchHandoff,
    digest: [u8; 32],
) -> wire::RunnerEndpointsReady {
    wire::RunnerEndpointsReady {
        schema_version: RUNNER_BOOTSTRAP_SCHEMA_VERSION,
        identity: handoff.identity.clone(),
        runtime_instance_id: handoff.runtime_instance_id.clone(),
        runner_process_id: handoff.runner_process_id,
        acknowledged_handoff_sha256: digest.to_vec(),
        endpoints: handoff
            .endpoints
            .iter()
            .map(|endpoint| wire::RunnerReadyEndpoint {
                kind: endpoint.kind,
                endpoint_id: endpoint.endpoint_id.clone(),
                address: endpoint.address.clone(),
                connection_id: endpoint.connection_id.clone(),
            })
            .collect(),
    }
}
