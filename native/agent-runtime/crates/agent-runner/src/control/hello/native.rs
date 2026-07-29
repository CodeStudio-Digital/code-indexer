use std::collections::BTreeSet;

use agent_protocol::generated::v1 as wire;

use crate::control::error::ControlError;

const MAX_NATIVE_CAPABILITIES: usize = 128;
const MAX_NATIVE_TEXT_BYTES: usize = 512;

pub(super) fn validate_native_capabilities(
    capabilities: &[wire::NativeCapabilityProvenance],
) -> Result<(), ControlError> {
    if capabilities.len() > MAX_NATIVE_CAPABILITIES {
        return Err(ControlError::InvalidAgentHello(
            "native capability count exceeds 128",
        ));
    }
    let mut identifiers = BTreeSet::new();
    for capability in capabilities {
        for value in [
            capability.capability_id.as_str(),
            capability.version.as_str(),
            capability.origin.as_str(),
        ] {
            if value.trim().is_empty()
                || value.contains('\0')
                || value.len() > MAX_NATIVE_TEXT_BYTES
            {
                return Err(ControlError::InvalidAgentHello(
                    "native capability provenance is invalid",
                ));
            }
        }
        if capability.descriptor_sha256.len() != 32 {
            return Err(ControlError::InvalidAgentHello(
                "native capability descriptor hash must have 32 bytes",
            ));
        }
        if !identifiers.insert(capability.capability_id.as_str()) {
            return Err(ControlError::InvalidAgentHello(
                "native capability ID is duplicated",
            ));
        }
    }
    Ok(())
}
