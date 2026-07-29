use super::*;

#[test]
fn expired_termination_deadlines_reach_the_owner_ledger_as_pending() {
    let identity = super::super::super::support::attempt_identity();
    let commands = [
        wire::management_payload::Body::CancelAttemptProcess(wire::CancelAttemptProcess {
            identity: Some(identity.clone()),
            grace_deadline_at_unix_ms: NOW + 1,
            reason_code: "test.cancel".into(),
            idempotency_key: "cancel:expired".into(),
        }),
        wire::management_payload::Body::ReapAttemptProcess(wire::ReapAttemptProcess {
            identity: Some(identity),
            runtime_instance_id: "runtime:test".into(),
            reap_deadline_at_unix_ms: NOW + 1,
            reason_code: "test.reap".into(),
            idempotency_key: "reap:expired".into(),
        }),
    ];

    for (index, body) in commands.into_iter().enumerate() {
        let mut channel = supervisor_channel(
            vec![frame(body, &format!("expired-command:{index}"), 2)],
            RecordingWriter::default(),
            limits(),
        );
        assert!(matches!(
            channel.begin_receive_with_clock(|| NOW + 2),
            Ok(Some(ManagementReceiveOutcome::Pending(_)))
        ));
    }
}

#[test]
fn nonpositive_termination_deadlines_still_fail_before_pending() {
    let identity = super::super::super::support::attempt_identity();
    let commands = [
        wire::management_payload::Body::CancelAttemptProcess(wire::CancelAttemptProcess {
            identity: Some(identity.clone()),
            grace_deadline_at_unix_ms: 0,
            reason_code: "test.cancel".into(),
            idempotency_key: "cancel:invalid".into(),
        }),
        wire::management_payload::Body::ReapAttemptProcess(wire::ReapAttemptProcess {
            identity: Some(identity),
            runtime_instance_id: "runtime:test".into(),
            reap_deadline_at_unix_ms: 0,
            reason_code: "test.reap".into(),
            idempotency_key: "reap:invalid".into(),
        }),
    ];

    for (index, body) in commands.into_iter().enumerate() {
        let mut channel = supervisor_channel(
            vec![frame(body, &format!("invalid-command:{index}"), 2)],
            RecordingWriter::default(),
            limits(),
        );
        assert!(matches!(
            channel.begin_receive_with_clock(|| NOW + 2),
            Err(ManagementChannelError::InvalidManagementPayload { .. })
        ));
        assert!(channel.is_poisoned());
    }
}
