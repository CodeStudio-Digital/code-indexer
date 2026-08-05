use std::collections::BTreeSet;

use agent_protocol::generated::v1 as wire;
use prost::Message;
use sha2::{Digest, Sha256};

use super::{ProviderContextError, ProviderContextMaterial};

const SCHEMA_VERSION: u32 = 1;
const AGENT_DEFINITION_SCHEMA: &str = "codestudio.agent.v1.AgentDefinitionSnapshotV1";
const CAPABILITY_SET_SCHEMA: &str = "codestudio.agent.v1.CapabilitySetSnapshotV1";
const PROVIDER_PRESET_SCHEMA: &str = "codestudio.agent.v1.ProviderPresetSnapshotV1";
const MAX_TOOLS: usize = 256;
const MAX_IDENTIFIER_BYTES: usize = 256;
const MAX_DESCRIPTION_BYTES: usize = 64 * 1_024;
const MAX_TOOL_SCHEMA_BYTES: usize = 1_024 * 1_024;

pub(super) fn definition(
    spec: &wire::ResolvedAttemptSpec,
    material: &impl ProviderContextMaterial,
) -> Result<wire::AgentDefinitionSnapshotV1, ProviderContextError> {
    let reference = required_ref(
        spec.agent_definition_snapshot.as_ref(),
        AGENT_DEFINITION_SCHEMA,
        "agent_definition_snapshot",
    )?;
    let value: wire::AgentDefinitionSnapshotV1 =
        decode(reference, material, "agent_definition_snapshot")?;
    if value.schema_version != SCHEMA_VERSION
        || value.agent_definition_id != spec.agent_definition_id
    {
        return Err(ProviderContextError::AgentDefinitionMismatch);
    }
    if value.system_prompt_utf8.contains('\0') {
        return Err(ProviderContextError::InvalidSystemPrompt);
    }
    Ok(value)
}

pub(super) fn capabilities(
    spec: &wire::ResolvedAttemptSpec,
    material: &impl ProviderContextMaterial,
) -> Result<wire::CapabilitySetSnapshotV1, ProviderContextError> {
    let reference = required_ref(
        spec.capability_set_snapshot.as_ref(),
        CAPABILITY_SET_SCHEMA,
        "capability_set_snapshot",
    )?;
    let value: wire::CapabilitySetSnapshotV1 =
        decode(reference, material, "capability_set_snapshot")?;
    if value.schema_version != SCHEMA_VERSION {
        return Err(ProviderContextError::SnapshotContract(
            "capability_set_snapshot",
        ));
    }
    validate_tools(&value.tools)?;
    Ok(value)
}

pub(super) fn preset(
    spec: &wire::ResolvedAttemptSpec,
    material: &impl ProviderContextMaterial,
) -> Result<wire::ProviderPresetSnapshotV1, ProviderContextError> {
    let reference = required_ref(
        spec.preset_snapshot.as_ref(),
        PROVIDER_PRESET_SCHEMA,
        "preset_snapshot",
    )?;
    let value: wire::ProviderPresetSnapshotV1 = decode(reference, material, "preset_snapshot")?;
    let binding =
        spec.provider_binding
            .as_ref()
            .ok_or(ProviderContextError::MissingValidatedField(
                "provider_binding",
            ))?;
    if value.schema_version != SCHEMA_VERSION || value.effective_preset != binding.effective_preset
    {
        return Err(ProviderContextError::PresetMismatch);
    }
    if (!value.thinking && value.thinking_budget_tokens.is_some())
        || value.thinking_budget_tokens == Some(0)
    {
        return Err(ProviderContextError::InvalidInferenceOptions);
    }
    Ok(value)
}

fn required_ref<'a>(
    reference: Option<&'a wire::SnapshotRef>,
    schema: &str,
    field: &'static str,
) -> Result<&'a wire::SnapshotRef, ProviderContextError> {
    let reference = reference.ok_or(ProviderContextError::MissingValidatedField(field))?;
    if reference.schema_id != schema || reference.schema_version != SCHEMA_VERSION {
        return Err(ProviderContextError::SnapshotContract(field));
    }
    Ok(reference)
}

fn decode<T: Message + Default>(
    reference: &wire::SnapshotRef,
    material: &impl ProviderContextMaterial,
    field: &'static str,
) -> Result<T, ProviderContextError> {
    let bytes = material
        .snapshot_payload(reference)
        .ok_or(ProviderContextError::MissingMaterial(field))?;
    let value = T::decode(bytes).map_err(|_| ProviderContextError::MalformedSnapshot(field))?;
    if value.encode_to_vec() != bytes {
        return Err(ProviderContextError::NonCanonicalSnapshot(field));
    }
    Ok(value)
}

fn validate_tools(tools: &[wire::ProviderToolDescriptor]) -> Result<(), ProviderContextError> {
    if tools.len() > MAX_TOOLS {
        return Err(ProviderContextError::TooManyTools {
            count: tools.len(),
            maximum: MAX_TOOLS,
        });
    }
    let mut names = BTreeSet::new();
    for (index, tool) in tools.iter().enumerate() {
        if tool.capability_name.is_empty()
            || tool.capability_name.len() > MAX_IDENTIFIER_BYTES
            || tool.capability_name.contains('\0')
        {
            return Err(ProviderContextError::InvalidTool {
                index,
                reason: "capability name",
            });
        }
        if !names.insert(tool.capability_name.as_str()) {
            return Err(ProviderContextError::DuplicateTool { index });
        }
        if tool.capability_id.is_empty()
            || tool.capability_id.len() > MAX_IDENTIFIER_BYTES
            || tool.capability_id.contains('\0')
            || tool.capability_version.is_empty()
            || tool.capability_version.len() > MAX_IDENTIFIER_BYTES
            || tool.capability_version.contains('\0')
            || wire::CapabilityExecutionClass::try_from(tool.execution_class).ok()
                == Some(wire::CapabilityExecutionClass::Unspecified)
            || wire::CapabilityExecutionClass::try_from(tool.execution_class).is_err()
            || (tool.mutates
                && wire::CapabilityExecutionClass::try_from(tool.execution_class).ok()
                    == Some(wire::CapabilityExecutionClass::NativeRead))
        {
            return Err(ProviderContextError::InvalidTool {
                index,
                reason: "resolved capability authority",
            });
        }
        if tool.description.len() > MAX_DESCRIPTION_BYTES || tool.description.contains('\0') {
            return Err(ProviderContextError::InvalidTool {
                index,
                reason: "description",
            });
        }
        if tool.encoded_json_schema.is_empty()
            || tool.encoded_json_schema.len() > MAX_TOOL_SCHEMA_BYTES
            || tool.schema_sha256.len() != 32
        {
            return Err(ProviderContextError::InvalidTool {
                index,
                reason: "JSON schema bounds",
            });
        }
        if Sha256::digest(&tool.encoded_json_schema).as_slice() != tool.schema_sha256 {
            return Err(ProviderContextError::ToolSchemaHashMismatch { index });
        }
    }
    Ok(())
}
