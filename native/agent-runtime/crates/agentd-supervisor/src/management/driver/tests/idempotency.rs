use std::sync::atomic::Ordering;

use agent_protocol::generated::v1 as wire;

use super::super::{SupervisorDriverStep, SupervisorPhysicalDriver};
use super::fakes::{FakeContainment, FakeProvisioner};
use super::support::{
    TestWriter, ack_frame_for_output, decoded_bodies, established_appendable, launch_attempt,
    launch_frame, peer_authority, trusted_runner,
};

mod capacity;
mod late_ack;
mod replay_states;

#[test]
fn semantic_retry_is_correlated_without_reprovision_or_out_of_order_advance() {
    let launch = launch_attempt();
    let writer = TestWriter::default();
    let (channel, reader) = established_appendable(
        vec![launch_frame(launch.clone(), "launch:first", 2)],
        writer.clone(),
        4,
    );
    let (containment, state) = FakeContainment::healthy();
    let provisioner = FakeProvisioner::successful();
    let provision_calls = provisioner.calls.clone();
    let complete_calls = provisioner.complete_calls.clone();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        provisioner,
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");
    driver.process_next().expect("first launch");

    reader.append_frame(launch_frame(launch, "launch:semantic-retry", 3));
    assert_eq!(
        driver.process_next().expect("semantic retry"),
        SupervisorDriverStep::LaunchAccepted {
            reused_existing: true
        }
    );
    assert_eq!(provision_calls.load(Ordering::SeqCst), 1);
    assert_eq!(complete_calls.load(Ordering::SeqCst), 1);
    assert_eq!(state.spawn_calls.load(Ordering::SeqCst), 1);
    assert_eq!(driver.pending_management_facts(), 2);

    reader.append_frame(ack_frame_for_output(&writer, 1, "ack:first", 4));
    driver.process_next().expect("first accepted ack");
    assert!(matches!(
        decoded_bodies(&writer).last(),
        Some(wire::management_payload::Body::AttemptProcessSpawned(_))
    ));
    assert_eq!(driver.pending_management_facts(), 2);

    reader.append_frame(ack_frame_for_output(&writer, 2, "ack:retry", 5));
    driver.process_next().expect("retry accepted ack");
    assert_eq!(decoded_bodies(&writer).len(), 4);
    assert_eq!(driver.pending_management_facts(), 1);
    assert!(!driver.is_channel_poisoned());
}

#[test]
fn same_idempotency_with_changed_payload_is_rejected_before_any_new_effect() {
    let launch = launch_attempt();
    let writer = TestWriter::default();
    let (channel, reader) = established_appendable(
        vec![launch_frame(launch.clone(), "launch:first", 2)],
        writer.clone(),
        1,
    );
    let (containment, state) = FakeContainment::healthy();
    let provisioner = FakeProvisioner::successful();
    let provision_calls = provisioner.calls.clone();
    let complete_calls = provisioner.complete_calls.clone();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        provisioner,
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");
    driver.process_next().expect("first launch");
    acknowledge_output(&mut driver, &reader, &writer, 1, "ack:accepted", 3);
    acknowledge_output(&mut driver, &reader, &writer, 2, "ack:spawned", 4);
    acknowledge_output(&mut driver, &reader, &writer, 3, "ack:containment", 5);

    let mut conflicting = launch;
    conflicting.launch_nonce = vec![9; 32];
    reader.append_frame(launch_frame(conflicting, "launch:conflict", 6));
    assert_eq!(
        driver.process_next().expect("conflict rejection"),
        SupervisorDriverStep::LaunchRejected {
            reason_code: "SUPERVISOR_DUPLICATE_CONFLICT"
        }
    );
    assert_eq!(provision_calls.load(Ordering::SeqCst), 1);
    assert_eq!(complete_calls.load(Ordering::SeqCst), 1);
    assert_eq!(state.spawn_calls.load(Ordering::SeqCst), 1);
    assert_eq!(driver.pending_management_facts(), 1);

    acknowledge_output(&mut driver, &reader, &writer, 4, "ack:rejected", 7);
    assert_eq!(driver.pending_management_facts(), 0);
    assert!(!driver.is_channel_poisoned());
}

#[test]
fn failed_provision_keeps_a_bounded_tombstone_and_rejection_ack_releases_slot() {
    let launch = launch_attempt();
    let writer = TestWriter::default();
    let (channel, reader) = established_appendable(
        vec![launch_frame(launch.clone(), "launch:first", 2)],
        writer.clone(),
        1,
    );
    let (containment, state) = FakeContainment::healthy();
    let provisioner = FakeProvisioner::failing();
    let provision_calls = provisioner.calls.clone();
    let complete_calls = provisioner.complete_calls.clone();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        provisioner,
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");
    assert_eq!(
        driver.process_next().expect("provision rejection"),
        SupervisorDriverStep::LaunchRejected {
            reason_code: "SUPERVISOR_PROTECTED_HANDOFF_UNAVAILABLE"
        }
    );
    assert_eq!(provision_calls.load(Ordering::SeqCst), 1);
    assert_eq!(complete_calls.load(Ordering::SeqCst), 0);
    assert_eq!(state.spawn_calls.load(Ordering::SeqCst), 0);
    let first_rejected_at = match &decoded_bodies(&writer)[1] {
        wire::management_payload::Body::LaunchRejected(rejected) => rejected.rejected_at_unix_ms,
        _ => panic!("initial launch rejection"),
    };

    acknowledge_output(&mut driver, &reader, &writer, 1, "ack:rejected", 3);
    assert_eq!(
        driver.launch_registry.state_for_test("launch:test"),
        Some((0, true, false, false, true))
    );
    reader.append_frame(launch_frame(launch, "launch:retry", 4));
    assert_eq!(
        driver.process_next().expect("tombstone rejection"),
        SupervisorDriverStep::LaunchRejected {
            reason_code: "SUPERVISOR_PROTECTED_HANDOFF_UNAVAILABLE"
        }
    );
    assert_eq!(provision_calls.load(Ordering::SeqCst), 1);
    assert_eq!(complete_calls.load(Ordering::SeqCst), 0);
    assert_eq!(state.spawn_calls.load(Ordering::SeqCst), 0);
    let bodies = decoded_bodies(&writer);
    let wire::management_payload::Body::LaunchRejected(retry) = &bodies[2] else {
        panic!("retry launch rejection");
    };
    assert_eq!(retry.rejected_at_unix_ms, first_rejected_at);

    acknowledge_output(&mut driver, &reader, &writer, 2, "ack:tombstone", 5);
    assert_eq!(driver.pending_management_facts(), 0);
    assert!(!driver.is_channel_poisoned());
}

#[test]
fn durable_rejection_after_physical_spawn_still_waits_for_reap() {
    let writer = TestWriter::default();
    let (channel, reader) = established_appendable(
        vec![launch_frame(launch_attempt(), "launch", 2)],
        writer.clone(),
        1,
    );
    let (containment, state) = FakeContainment::insufficient_containment();
    let provisioner = FakeProvisioner::successful();
    let complete_calls = provisioner.complete_calls.clone();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        provisioner,
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");

    assert_eq!(
        driver.process_next().expect("containment rejection"),
        SupervisorDriverStep::LaunchRejected {
            reason_code: "SUPERVISOR_CONTAINMENT_UNAVAILABLE"
        }
    );
    assert_eq!(state.spawn_calls.load(Ordering::SeqCst), 1);
    assert_eq!(complete_calls.load(Ordering::SeqCst), 0);
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 1);
    assert!(driver.state().is_accepting_launches());
    assert_eq!(
        driver.launch_registry.state_for_test("launch:test"),
        Some((1, false, true, false, false))
    );

    acknowledge_output(&mut driver, &reader, &writer, 1, "ack:rejected", 3);
    assert_eq!(
        driver.launch_registry.state_for_test("launch:test"),
        Some((0, true, true, false, false))
    );
}

pub(super) fn acknowledge_output(
    driver: &mut SupervisorPhysicalDriver<
        super::support::AppendableReader,
        TestWriter,
        FakeContainment,
        FakeProvisioner,
    >,
    reader: &super::support::AppendableReader,
    writer: &TestWriter,
    output_index: usize,
    message_id: &str,
    stream_seq: u64,
) {
    reader.append_frame(ack_frame_for_output(
        writer,
        output_index,
        message_id,
        stream_seq,
    ));
    assert_eq!(
        driver.process_next().expect("management ack"),
        SupervisorDriverStep::ManagementAcknowledged
    );
}
