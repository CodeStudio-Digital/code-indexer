use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use agent_tools::capability::{
    CapabilityExecutionOutcome, CapabilityExecutorPort, CapabilityInvocation, ExecutionClass,
    NativeFilesystemReadBinding, SealedExecutionGrant,
};
use sha2::{Digest, Sha256};

use crate::native_tools::NativeToolExecutor;

/// Measures the real native read executor.
///
/// Includes validation, blocking-pool dispatch, filesystem read and encoding.
/// The caller owns an isolated directory containing exactly the expected file.
///
/// # Errors
/// Returns an error on invalid bounds, failed execution or a changed fixture.
pub async fn probe_native_read_dispatch(
    root: &Path,
    expected_content: &str,
    warmup: usize,
    samples: usize,
) -> Result<Vec<Duration>, String> {
    if warmup > 10_000 || samples == 0 || samples > 100_000 || expected_content.len() > 4_096 {
        return Err("dispatch probe bounds are invalid".into());
    }
    let now = i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_millis(),
    )
    .map_err(|error| error.to_string())?;
    let input = br#"{"path":"dispatch-fixture.txt"}"#;
    let invocation = CapabilityInvocation {
        operation_id: "dispatch-probe:1".into(),
        provider_operation_id: "provider-probe:1".into(),
        tool_use_id: "tool-probe:1".into(),
        capability_id: "native.read_file".into(),
        capability_version: "1".into(),
        execution_class: ExecutionClass::NativeRead,
        mutates: false,
        encoded_json_input: input.to_vec(),
        input_sha256: Sha256::digest(input).into(),
        capability_set_sha256: [9; 32],
        idempotency_key: "dispatch-probe-prepare:1".into(),
        deadline_at_unix_ms: now + 300_000,
    };
    let grant = SealedExecutionGrant {
        grant_id: "dispatch-probe-grant:1".into(),
        decision_id: "dispatch-probe-decision:1".into(),
        capability_id: invocation.capability_id.clone(),
        capability_version: invocation.capability_version.clone(),
        operation_id: invocation.operation_id.clone(),
        tool_use_id: invocation.tool_use_id.clone(),
        effective_input_sha256: invocation.input_sha256,
        execution_class: invocation.execution_class,
        mutates: false,
        environment_id: "dispatch-probe-environment:1".into(),
        environment_version: 1,
        workspace_lease_id: None,
        workspace_lease_version: None,
        workspace_fencing_epoch: None,
        resource_binding_id: "dispatch-probe-binding:1".into(),
        constraints_sha256: [8; 32],
        policy_version: "dispatch-probe-policy:1".into(),
        nonce: vec![1; 16],
        issued_at_unix_ms: now,
        expires_at_unix_ms: now + 300_000,
        native_filesystem_read: Some(NativeFilesystemReadBinding {
            canonical_root_path: root.to_string_lossy().into_owned(),
            max_read_bytes: 4_096,
            max_output_bytes: 8_192,
            require_utf8: true,
        }),
    };
    let mut executor = NativeToolExecutor;
    let mut durations = Vec::with_capacity(samples);
    for index in 0..warmup + samples {
        let started = Instant::now();
        let result = executor
            .execute(&invocation, &grant)
            .await
            .map_err(|error| error.to_string())?;
        let elapsed = started.elapsed();
        let CapabilityExecutionOutcome::Succeeded(output) = result else {
            return Err(format!("dispatch fixture failed: {result:?}"));
        };
        let value: serde_json::Value =
            serde_json::from_slice(&output.encoded_result).map_err(|error| error.to_string())?;
        if value["content"].as_str() != Some(expected_content) || output.truncated {
            return Err("dispatch fixture content changed or was truncated".into());
        }
        if index >= warmup {
            durations.push(elapsed);
        }
    }
    Ok(durations)
}
