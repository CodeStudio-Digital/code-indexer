use super::*;

mod activation_authority;
mod budget;
mod commands;
mod containment;
mod endpoints;

fn valid_runtime() -> wire::RuntimeProvenance {
    let expected = super::super::support::expected_provenance();
    wire::RuntimeProvenance {
        build_id: expected.build_id,
        source_commit: expected.source_commit,
        binary_sha256: expected.binary_sha256,
        runtime_instance_id: "runtime:attempt".into(),
        pid: 42,
        operating_system: expected.operating_system,
        architecture: expected.architecture,
    }
}

fn valid_sample() -> wire::ResourceSample {
    wire::ResourceSample {
        resident_memory_bytes: 100,
        peak_resident_memory_bytes: 200,
        cpu_time_ms: 10,
        process_count: 1,
        open_file_count: 2,
        spool_bytes: 0,
    }
}

fn valid_snapshot(
    identity: wire::AttemptIdentity,
    resources: bool,
) -> wire::AttemptProcessSnapshot {
    wire::AttemptProcessSnapshot {
        identity: Some(identity),
        runner_provenance: Some(valid_runtime()),
        resource_group_id: "group:test".into(),
        phase: wire::AttemptProcessPhase::Running as i32,
        hard_deadline_at_unix_ms: NOW + 1_000,
        authority_lease_expires_at_unix_ms: NOW + 900,
        last_pulse_at_unix_ms: NOW + 1,
        resources: resources.then(valid_sample),
    }
}

fn supervisor_resources() -> wire::SupervisorResourceSample {
    wire::SupervisorResourceSample {
        active_attempts: 1,
        pending_launches: 0,
        process_count: 1,
        reserved_memory_bytes: 128 * 1024 * 1024,
        resident_memory_bytes: 100,
        peak_resident_memory_bytes: 200,
        cpu_time_ms: 10,
        open_handle_count: 2,
        scratch_bytes: 0,
        sampled_at_unix_ms: NOW + 2,
    }
}

fn query_channel(
    query: wire::QuerySupervisorState,
) -> (
    crate::management_channel::EstablishedManagementChannel<
        super::super::support::AppendableReader,
        RecordingWriter,
    >,
    super::super::support::AppendableReader,
    String,
) {
    let writer = RecordingWriter::default();
    let (mut channel, reader) = appendable_host_channel(writer.clone(), limits());
    channel
        .send_new_with_clock(
            &super::super::support::payload(wire::management_payload::Body::QuerySupervisorState(
                query,
            )),
            deadline(50),
            || NOW + 2,
        )
        .expect("query");
    let (header, _) = decode_frame(&decode_delimited(&writer.bytes())[1]);
    (channel, reader, header.message_id)
}

fn append_state(
    reader: &super::super::support::AppendableReader,
    reply_to: &str,
    state: wire::SupervisorState,
) {
    reader.append(&delimited(&[frame_with_reply(
        wire::management_payload::Body::SupervisorState(state),
        "state",
        2,
        protocol(),
        CONNECTION,
        None,
        Some(reply_to),
    )]));
}

#[test]
fn query_correlation_seals_identity_filter_and_resource_shape() {
    let expected = super::super::support::attempt_identity();
    let query = wire::QuerySupervisorState {
        identity_filter: Some(expected.clone()),
        include_resource_samples: false,
    };
    let (mut channel, reader, reply_to) = query_channel(query);
    let mut wrong = expected;
    wrong.attempt_id = "99999999-9999-4999-8999-999999999999".into();
    append_state(
        &reader,
        &reply_to,
        wire::SupervisorState {
            connection_id: CONNECTION.into(),
            accepting_launches: true,
            attempts: vec![valid_snapshot(wrong, false)],
            resources: None,
            observed_at_unix_ms: NOW + 2,
        },
    );
    assert!(matches!(
        channel.begin_receive_with_clock(|| NOW + 3),
        Err(ManagementChannelError::InvalidResponseSemantics {
            payload: "SupervisorState",
            field: "query_filter_or_resource_shape",
        })
    ));

    let query = wire::QuerySupervisorState {
        identity_filter: None,
        include_resource_samples: true,
    };
    let (mut channel, reader, reply_to) = query_channel(query);
    append_state(
        &reader,
        &reply_to,
        wire::SupervisorState {
            connection_id: CONNECTION.into(),
            accepting_launches: true,
            attempts: Vec::new(),
            resources: None,
            observed_at_unix_ms: NOW + 2,
        },
    );
    assert!(matches!(
        channel.begin_receive_with_clock(|| NOW + 3),
        Err(ManagementChannelError::InvalidResponseSemantics { .. })
    ));
}

#[test]
fn complete_filtered_state_is_pending_only_when_query_shape_matches() {
    let identity = super::super::support::attempt_identity();
    let query = wire::QuerySupervisorState {
        identity_filter: Some(identity.clone()),
        include_resource_samples: true,
    };
    let (mut channel, reader, reply_to) = query_channel(query);
    append_state(
        &reader,
        &reply_to,
        wire::SupervisorState {
            connection_id: CONNECTION.into(),
            accepting_launches: true,
            attempts: vec![valid_snapshot(identity, true)],
            resources: Some(supervisor_resources()),
            observed_at_unix_ms: NOW + 2,
        },
    );
    assert!(matches!(
        channel.begin_receive_with_clock(|| NOW + 3),
        Ok(Some(ManagementReceiveOutcome::Pending(_)))
    ));
}

#[test]
fn incomplete_physical_facts_fail_before_pending() {
    let identity = super::super::support::attempt_identity();
    let cases = [
        wire::management_payload::Body::AttemptProcessSpawned(wire::AttemptProcessSpawned {
            identity: Some(identity.clone()),
            resource_group_id: "group:test".into(),
            reservation_id: "reservation:test".into(),
            spawned_at_unix_ms: NOW + 1,
            ..wire::AttemptProcessSpawned::default()
        }),
        wire::management_payload::Body::AttemptContainmentReport(wire::AttemptContainmentReport {
            identity: Some(identity.clone()),
            runtime_instance_id: "runtime:test".into(),
            reported_at_unix_ms: NOW + 1,
            ..wire::AttemptContainmentReport::default()
        }),
        wire::management_payload::Body::AttemptProcessExited(wire::AttemptProcessExited {
            identity: Some(identity.clone()),
            cause: wire::PhysicalExitCause::Crashed as i32,
            exited_at_unix_ms: NOW + 1,
            ..wire::AttemptProcessExited::default()
        }),
        wire::management_payload::Body::AttemptProcessReaped(wire::AttemptProcessReaped {
            identity: Some(identity),
            runtime_instance_id: "runtime:test".into(),
            resource_group_id: "group:test".into(),
            reaped_at_unix_ms: NOW + 1,
            ..wire::AttemptProcessReaped::default()
        }),
    ];
    for (index, body) in cases.into_iter().enumerate() {
        let mut channel = host_channel(
            vec![frame(body, &format!("invalid-fact-{index}"), 2)],
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
