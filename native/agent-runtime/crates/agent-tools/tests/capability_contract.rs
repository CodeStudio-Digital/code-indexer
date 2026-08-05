use agent_tools::capability::{CapabilityInvocation, ExecutionClass, InvocationValidationError};

#[test]
fn pre_dispatch_invocation_is_bounded_and_has_no_effect_authority() {
    let invocation = invocation();

    assert_eq!(invocation.validate(16), Ok(()));
    assert_eq!(invocation.encoded_json_input, b"{}");
}

#[test]
fn mutation_cannot_be_disguised_as_native_read() {
    let mut invocation = invocation();
    invocation.mutates = true;

    assert_eq!(
        invocation.validate(16),
        Err(InvocationValidationError::ContradictoryExecutionClass)
    );
}

#[test]
fn input_and_deadline_limits_fail_closed() {
    let mut oversized = invocation();
    oversized.encoded_json_input = vec![1; 17];
    assert_eq!(
        oversized.validate(16),
        Err(InvocationValidationError::InvalidInput)
    );
    let mut expired = invocation();
    expired.deadline_at_unix_ms = 0;
    assert_eq!(
        expired.validate(16),
        Err(InvocationValidationError::InvalidDeadline)
    );
}

fn invocation() -> CapabilityInvocation {
    CapabilityInvocation {
        operation_id: "capability/tool/1".into(),
        provider_operation_id: "provider/1".into(),
        tool_use_id: "tool/1".into(),
        capability_id: "native.read_file".into(),
        capability_version: "1".into(),
        execution_class: ExecutionClass::NativeRead,
        mutates: false,
        encoded_json_input: b"{}".to_vec(),
        input_sha256: [1; 32],
        capability_set_sha256: [2; 32],
        idempotency_key: "capability-prepare/tool/1".into(),
        deadline_at_unix_ms: 1_000,
    }
}
