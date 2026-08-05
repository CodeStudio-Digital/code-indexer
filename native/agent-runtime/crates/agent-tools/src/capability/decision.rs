use super::ExecutionClass;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityRejection {
    pub decision_id: String,
    pub reason_code: String,
    pub policy_version: String,
    pub decided_at_unix_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityApproval {
    pub decision_id: String,
    pub interaction_id: String,
    pub reason_code: String,
    pub policy_version: String,
    pub decided_at_unix_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedExecutionGrant {
    pub grant_id: String,
    pub decision_id: String,
    pub capability_id: String,
    pub capability_version: String,
    pub operation_id: String,
    pub tool_use_id: String,
    pub effective_input_sha256: [u8; 32],
    pub execution_class: ExecutionClass,
    pub mutates: bool,
    pub environment_id: String,
    pub environment_version: u64,
    pub workspace_lease_id: Option<String>,
    pub workspace_lease_version: Option<u64>,
    pub workspace_fencing_epoch: Option<u64>,
    pub resource_binding_id: String,
    pub constraints_sha256: [u8; 32],
    pub policy_version: String,
    pub nonce: Vec<u8>,
    pub issued_at_unix_ms: i64,
    pub expires_at_unix_ms: i64,
    pub native_filesystem_read: Option<NativeFilesystemReadBinding>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeFilesystemReadBinding {
    pub canonical_root_path: String,
    pub max_read_bytes: u64,
    pub max_output_bytes: u64,
    pub require_utf8: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CapabilityDecision {
    Rejected(CapabilityRejection),
    ApprovalRequired(CapabilityApproval),
    Accepted(Box<SealedExecutionGrant>),
}
