use agent_protocol::generated::v1 as wire;
use prost::Message;
use sha2::{Digest, Sha256};

use super::super::ProviderContextMaterial;

const DEFINITION_SCHEMA: &str = "codestudio.agent.v1.AgentDefinitionSnapshotV1";
const CAPABILITY_SCHEMA: &str = "codestudio.agent.v1.CapabilitySetSnapshotV1";
const PRESET_SCHEMA: &str = "codestudio.agent.v1.ProviderPresetSnapshotV1";

pub(super) struct Material {
    pub snapshots: Vec<(wire::SnapshotRef, Vec<u8>)>,
    artifacts: Vec<(wire::ArtifactRef, Vec<u8>)>,
}

pub(super) struct Fixture {
    pub spec: wire::ResolvedAttemptSpec,
    pub material: Material,
}

impl Fixture {
    pub(super) fn valid() -> Self {
        let definition = wire::AgentDefinitionSnapshotV1 {
            schema_version: 1,
            agent_definition_id: "native-coder".into(),
            system_prompt_utf8: "You are the native coder.".into(),
        };
        let capabilities = wire::CapabilitySetSnapshotV1 {
            schema_version: 1,
            tools: vec![tool("filesystem.read")],
        };
        let preset = wire::ProviderPresetSnapshotV1 {
            schema_version: 1,
            effective_preset: Some("coding".into()),
            thinking: true,
            thinking_budget_tokens: Some(2_048),
        };
        let mut snapshots = generic_snapshots();
        snapshots[1] = encoded_snapshot("capabilities", CAPABILITY_SCHEMA, &capabilities);
        snapshots[5] = encoded_snapshot("preset", PRESET_SCHEMA, &preset);
        snapshots[6] = encoded_snapshot("agent-definition", DEFINITION_SCHEMA, &definition);
        let attachment = artifact("attachment", "text/plain", b"attachment");
        let spec = spec(
            &snapshots,
            wire::task_input::Body::InlineUtf8("Do the task.".into()),
            vec![attachment.clone()],
        );
        Self {
            spec,
            material: Material {
                snapshots,
                artifacts: vec![(attachment, b"attachment".to_vec())],
            },
        }
    }

    pub(super) fn with_task_artifact(text: &str) -> Self {
        let mut fixture = Self::valid();
        let reference = artifact("task", "text/plain", text.as_bytes());
        fixture.spec.task.as_mut().expect("task").body =
            Some(wire::task_input::Body::Artifact(reference.clone()));
        fixture
            .material
            .artifacts
            .push((reference, text.as_bytes().to_vec()));
        fixture
    }

    pub(super) fn capability_payload(&self) -> wire::CapabilitySetSnapshotV1 {
        wire::CapabilitySetSnapshotV1::decode(self.material.snapshots[1].1.as_slice())
            .expect("capability payload")
    }

    pub(super) fn preset_payload(&self) -> wire::ProviderPresetSnapshotV1 {
        wire::ProviderPresetSnapshotV1::decode(self.material.snapshots[5].1.as_slice())
            .expect("preset payload")
    }

    pub(super) fn replace_capabilities(&mut self, payload: &wire::CapabilitySetSnapshotV1) {
        self.replace_snapshot(1, "capabilities", CAPABILITY_SCHEMA, payload);
        self.spec.capability_set_snapshot = Some(self.material.snapshots[1].0.clone());
    }

    pub(super) fn replace_preset(&mut self, payload: &wire::ProviderPresetSnapshotV1) {
        self.replace_snapshot(5, "preset", PRESET_SCHEMA, payload);
        self.spec.preset_snapshot = Some(self.material.snapshots[5].0.clone());
    }

    fn replace_snapshot(
        &mut self,
        index: usize,
        label: &str,
        schema: &str,
        payload: &impl Message,
    ) {
        self.material.snapshots[index] = encoded_snapshot(label, schema, payload);
    }
}

impl ProviderContextMaterial for Material {
    fn snapshot_payload(&self, reference: &wire::SnapshotRef) -> Option<&[u8]> {
        self.snapshots
            .iter()
            .find(|(candidate, _)| candidate == reference)
            .map(|(_, bytes)| bytes.as_slice())
    }

    fn artifact_payload(&self, reference: &wire::ArtifactRef) -> Option<&[u8]> {
        self.artifacts
            .iter()
            .find(|(candidate, _)| candidate == reference)
            .map(|(_, bytes)| bytes.as_slice())
    }
}

pub(super) fn tool(name: &str) -> wire::ProviderToolDescriptor {
    let schema = br#"{"type":"object","properties":{}}"#.to_vec();
    wire::ProviderToolDescriptor {
        capability_name: name.into(),
        description: "Read one file".into(),
        schema_sha256: Sha256::digest(&schema).to_vec(),
        encoded_json_schema: schema,
        capability_id: format!("native.{name}"),
        capability_version: "1".into(),
        execution_class: wire::CapabilityExecutionClass::NativeRead.into(),
        mutates: false,
    }
}

pub(super) fn rehash_snapshot(reference: &mut wire::SnapshotRef, bytes: &[u8]) {
    reference.content_sha256 = Sha256::digest(bytes).to_vec();
}

fn generic_snapshots() -> Vec<(wire::SnapshotRef, Vec<u8>)> {
    [
        "verifier",
        "capabilities",
        "environment",
        "workspace",
        "policy",
        "preset",
        "definition",
    ]
    .map(|label| {
        encoded_snapshot(
            label,
            "codestudio.test.v1",
            &wire::ProviderPresetSnapshotV1::default(),
        )
    })
    .into_iter()
    .collect()
}

fn encoded_snapshot(
    label: &str,
    schema: &str,
    payload: &impl Message,
) -> (wire::SnapshotRef, Vec<u8>) {
    let bytes = payload.encode_to_vec();
    (
        wire::SnapshotRef {
            r#ref: format!("snapshot:{label}"),
            version: 1,
            content_sha256: Sha256::digest(&bytes).to_vec(),
            origin: "provider-context-test".into(),
            schema_id: schema.into(),
            schema_version: 1,
        },
        bytes,
    )
}

fn artifact(id: &str, media_type: &str, bytes: &[u8]) -> wire::ArtifactRef {
    wire::ArtifactRef {
        artifact_id: format!("artifact:{id}"),
        kind: "provider-input".into(),
        content_sha256: Sha256::digest(bytes).to_vec(),
        media_type: media_type.into(),
        byte_length: u64::try_from(bytes.len()).expect("artifact length"),
        compression: wire::ArtifactCompression::None as i32,
        privacy_class: wire::ArtifactPrivacyClass::Internal as i32,
        redaction_policy_version: "v1".into(),
        owner_session_id: "session-1".into(),
    }
}

fn spec(
    snapshots: &[(wire::SnapshotRef, Vec<u8>)],
    body: wire::task_input::Body,
    attachments: Vec<wire::ArtifactRef>,
) -> wire::ResolvedAttemptSpec {
    wire::ResolvedAttemptSpec {
        schema_version: 1,
        spec_version: 1,
        ordinal: 1,
        trigger: wire::AttemptTrigger::Initial as i32,
        role: "coder".into(),
        agent_definition_id: "native-coder".into(),
        task: Some(wire::TaskInput {
            body: Some(body),
            attachments,
        }),
        provider_binding: Some(wire::ProviderBinding {
            effective_provider: "openai".into(),
            effective_model: "gpt-5".into(),
            effective_reasoning_effort: Some("high".into()),
            effective_preset: Some("coding".into()),
            ..wire::ProviderBinding::default()
        }),
        capability_set_snapshot: Some(snapshots[1].0.clone()),
        preset_snapshot: Some(snapshots[5].0.clone()),
        agent_definition_snapshot: Some(snapshots[6].0.clone()),
        resource_budget: Some(wire::ResourceBudget {
            max_hot_transcript_bytes: 1_048_576,
            max_ipc_bytes: 1_048_576,
            ..wire::ResourceBudget::default()
        }),
        ..wire::ResolvedAttemptSpec::default()
    }
}
