use super::*;
use agent_tools::capability::NativeFilesystemReadBinding;

#[tokio::test]
async fn native_read_is_bounded_and_rejects_parent_traversal() {
    let root = std::env::temp_dir().join(format!(
        "codestudio-runner-native-read-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos(),
    ));
    std::fs::create_dir_all(&root).expect("temp root");
    std::fs::write(root.join("sample.txt"), b"abcdef").expect("fixture");
    let root = std::fs::canonicalize(root).expect("canonical temp root");
    let mut executor = NativeToolExecutor;

    let invocation = test_invocation(br#"{"path":"sample.txt","offset":1,"length":3}"#);
    let result = executor
        .execute(&invocation, &grant(&invocation, &root))
        .await
        .expect("native worker");
    let CapabilityExecutionOutcome::Succeeded(output) = result else {
        panic!("bounded read must succeed");
    };
    let value: Value = serde_json::from_slice(&output.encoded_result).expect("result json");
    assert_eq!(value["content"], "bcd");
    assert_eq!(value["truncated"], true);
    assert_eq!(output.bytes_read, 4);

    let traversal = test_invocation(br#"{"path":"../sample.txt"}"#);
    let rejected = executor
        .execute(&traversal, &grant(&traversal, &root))
        .await
        .expect("typed rejection");
    assert!(matches!(
        rejected,
        CapabilityExecutionOutcome::Failed(CapabilityFailure { reason_code, .. })
            if reason_code == "invalid_input"
    ));
    std::fs::remove_dir_all(root).expect("temp cleanup");
}

fn test_invocation(input: &[u8]) -> CapabilityInvocation {
    CapabilityInvocation {
        operation_id: "capability:tool:1".into(),
        provider_operation_id: "provider:1".into(),
        tool_use_id: "tool:1".into(),
        capability_id: "native.read_file".into(),
        capability_version: "1".into(),
        execution_class: ExecutionClass::NativeRead,
        mutates: false,
        encoded_json_input: input.to_vec(),
        input_sha256: Sha256::digest(input).into(),
        capability_set_sha256: [9; 32],
        idempotency_key: "capability-prepare:tool:1".into(),
        deadline_at_unix_ms: 1_000,
    }
}

fn grant(invocation: &CapabilityInvocation, root: &Path) -> SealedExecutionGrant {
    SealedExecutionGrant {
        grant_id: "grant/1".into(),
        decision_id: "decision/1".into(),
        capability_id: invocation.capability_id.clone(),
        capability_version: invocation.capability_version.clone(),
        operation_id: invocation.operation_id.clone(),
        tool_use_id: invocation.tool_use_id.clone(),
        effective_input_sha256: invocation.input_sha256,
        execution_class: invocation.execution_class,
        mutates: false,
        environment_id: "environment/1".into(),
        environment_version: 1,
        workspace_lease_id: None,
        workspace_lease_version: None,
        workspace_fencing_epoch: None,
        resource_binding_id: "binding/1".into(),
        constraints_sha256: [8; 32],
        policy_version: "policy/v1".into(),
        nonce: vec![1; 16],
        issued_at_unix_ms: 1,
        expires_at_unix_ms: 500,
        native_filesystem_read: Some(NativeFilesystemReadBinding {
            canonical_root_path: root.to_string_lossy().into_owned(),
            max_read_bytes: 4_096,
            max_output_bytes: 8_192,
            require_utf8: true,
        }),
    }
}
