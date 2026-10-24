use super::HostSupervisorLaunchPlan;
use agent_protocol::generated::v1 as wire;
use agent_protocol::supervisor_bootstrap::SUPERVISOR_BOOTSTRAP_SCHEMA_VERSION;

impl HostSupervisorLaunchPlan {
    pub(in crate::supervisor) fn mint_handoff(
        &mut self,
        supervisor_process_id: u32,
        management_endpoint_address: &str,
        containment: wire::ContainmentCapabilities,
    ) -> wire::SupervisorProcessHandoff {
        let protocol = self.selected_protocol;
        wire::SupervisorProcessHandoff {
            schema_version: SUPERVISOR_BOOTSTRAP_SCHEMA_VERSION,
            host_process_id: std::process::id(),
            management_connection_id: self.connection_id.as_str().to_owned(),
            management_endpoint_address: management_endpoint_address.to_owned(),
            management_session_token: std::mem::take(&mut self.management_session_token),
            supervisor_launch_nonce: std::mem::take(&mut self.supervisor_launch_nonce),
            supervisor_provenance: Some(wire::RuntimeProvenance {
                build_id: self.trusted_supervisor.build_id.clone(),
                source_commit: self.trusted_supervisor.source_commit.clone(),
                binary_sha256: self.trusted_supervisor.binary_sha256.clone(),
                runtime_instance_id: format!("supervisor:{}", self.connection_id.as_str()),
                pid: supervisor_process_id,
                operating_system: self.trusted_supervisor.operating_system.clone(),
                architecture: self.trusted_supervisor.architecture.clone(),
            }),
            supported_protocols: Some(wire::ProtocolVersionRange {
                minimum: Some(protocol),
                maximum: Some(protocol),
            }),
            containment: Some(containment),
            supported_feature_bits: 0,
            runner_executable: self.runner_executable.to_string_lossy().into_owned(),
            runner_working_directory: self.package_directory.to_string_lossy().into_owned(),
            runner_environment: Vec::new(),
            trusted_runner_provenance: Some(self.trusted_runner.clone()),
            lifecycle_outbox_directory: self.lifecycle_outbox_directory.clone(),
        }
    }
}
