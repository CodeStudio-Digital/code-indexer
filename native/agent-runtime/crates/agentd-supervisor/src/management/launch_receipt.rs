use std::fmt::{self, Debug, Formatter};

use agent_protocol::generated::v1 as wire;
use agent_protocol::management_channel::{ManagementChannelError, ManagementSessionPolicy};
use zeroize::Zeroize;

#[cfg(test)]
const MIN_LAUNCH_NONCE_BYTES: usize = 16;
#[cfg(test)]
const MAX_LAUNCH_NONCE_BYTES: usize = 256;

struct SecretBytes(Vec<u8>);

impl Debug for SecretBytes {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretBytes([REDACTED])")
    }
}

impl Drop for SecretBytes {
    fn drop(&mut self) {
        self.0.as_mut_slice().zeroize();
    }
}

impl SecretBytes {
    #[cfg(test)]
    fn new(mut value: Vec<u8>) -> Result<Self, ManagementChannelError> {
        if !(MIN_LAUNCH_NONCE_BYTES..=MAX_LAUNCH_NONCE_BYTES).contains(&value.len()) {
            value.as_mut_slice().zeroize();
            return Err(ManagementChannelError::InvalidLaunchNonce);
        }
        Ok(Self(value))
    }

    fn take(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.0)
    }
}

/// Opaque proof that the physical launcher provisioned this supervisor.
///
/// Construction remains crate-private until the platform launch path owns the
/// management pipe. Callers cannot synthesize a peer-controlled
/// `SupervisorHello`.
pub struct SupervisorLaunchReceipt {
    supported_protocols: wire::ProtocolVersionRange,
    build_id: String,
    source_commit: String,
    binary_sha256: Vec<u8>,
    runtime_instance_id: String,
    operating_system: String,
    architecture: String,
    containment: wire::ContainmentCapabilities,
    supported_feature_bits: u64,
    launch_nonce: Option<SecretBytes>,
}

impl Debug for SupervisorLaunchReceipt {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SupervisorLaunchReceipt")
            .field("supported_protocols", &self.supported_protocols)
            .field("build_id", &self.build_id)
            .field("source_commit", &self.source_commit)
            .field("binary_sha256_length", &self.binary_sha256.len())
            .field("runtime_instance_id", &self.runtime_instance_id)
            .field("operating_system", &self.operating_system)
            .field("architecture", &self.architecture)
            .field("containment", &self.containment)
            .field("supported_feature_bits", &self.supported_feature_bits)
            .field("launch_nonce", &"[REDACTED]")
            .finish()
    }
}

impl SupervisorLaunchReceipt {
    #[allow(clippy::too_many_arguments)]
    #[cfg(test)]
    pub(crate) fn new(
        supported_protocols: wire::ProtocolVersionRange,
        build_id: String,
        source_commit: String,
        binary_sha256: Vec<u8>,
        runtime_instance_id: String,
        operating_system: String,
        architecture: String,
        containment: wire::ContainmentCapabilities,
        supported_feature_bits: u64,
        launch_nonce: Vec<u8>,
    ) -> Result<Self, ManagementChannelError> {
        Ok(Self {
            supported_protocols,
            build_id,
            source_commit,
            binary_sha256,
            runtime_instance_id,
            operating_system,
            architecture,
            containment,
            supported_feature_bits,
            launch_nonce: Some(SecretBytes::new(launch_nonce)?),
        })
    }

    pub(super) fn take_supervisor_hello(
        &mut self,
        policy: &ManagementSessionPolicy,
    ) -> Result<wire::SupervisorHello, ManagementChannelError> {
        let launch_nonce = self
            .launch_nonce
            .as_mut()
            .ok_or(ManagementChannelError::BootstrapConsumed)?
            .take();
        self.launch_nonce = None;
        Ok(wire::SupervisorHello {
            supported_protocols: Some(self.supported_protocols),
            contract_version: policy.contract_version().to_owned(),
            contract_schema_version: policy.contract_schema_version(),
            provenance: Some(wire::RuntimeProvenance {
                build_id: self.build_id.clone(),
                source_commit: self.source_commit.clone(),
                binary_sha256: self.binary_sha256.clone(),
                runtime_instance_id: self.runtime_instance_id.clone(),
                pid: std::process::id(),
                operating_system: self.operating_system.clone(),
                architecture: self.architecture.clone(),
            }),
            launch_nonce,
            containment: Some(self.containment),
            supported_feature_bits: self.supported_feature_bits,
        })
    }

    pub(super) fn launch_nonce_copy(&self) -> Result<Vec<u8>, ManagementChannelError> {
        self.launch_nonce
            .as_ref()
            .map(|secret| secret.0.clone())
            .ok_or(ManagementChannelError::BootstrapConsumed)
    }
}
