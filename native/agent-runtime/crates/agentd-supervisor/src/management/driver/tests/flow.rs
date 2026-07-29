use std::sync::atomic::Ordering;
use std::time::Duration;

use agent_protocol::generated::v1 as wire;
use agent_protocol::management_channel::ManagementChannelError;

use super::super::{SupervisorDriverError, SupervisorDriverStep, SupervisorPhysicalDriver};
use super::fakes::{FakeContainment, FakeProvisioner};
use super::support::{
    TestWriter, ack_frame_for_output, decoded_bodies, established_appendable, launch_attempt,
    launch_frame, output_sent_at_unix_ms, peer_authority, trusted_runner,
    wrong_digest_ack_frame_for_output,
};

#[test]
fn one_frame_window_sequences_facts_by_ack_after_physical_spawn() {
    let writer = TestWriter::default();
    let (channel, reader) = established_appendable(
        vec![launch_frame(launch_attempt(), "launch", 2)],
        writer.clone(),
        1,
    );
    let (containment, _state) = FakeContainment::delayed_spawn(Duration::from_millis(10));
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        FakeProvisioner::successful(),
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");
    let bootstrap_sent_at = output_sent_at_unix_ms(&writer, 0);

    assert_eq!(
        driver.process_next().expect("launch"),
        SupervisorDriverStep::LaunchAccepted {
            reused_existing: false
        }
    );
    let bodies = decoded_bodies(&writer);
    let wire::management_payload::Body::LaunchAccepted(accepted) = &bodies[1] else {
        panic!("launch accepted");
    };
    // The accepted timestamp shares the channel's monotonic clock authority
    // with bootstrap, so the delayed spawn must be reflected without comparing
    // against a separately sampled wall clock.
    let after_spawn = bootstrap_sent_at + 5;
    assert!(accepted.accepted_at_unix_ms >= after_spawn);
    assert_eq!(bodies.len(), 2);
    assert_eq!(driver.pending_management_facts(), 1);

    reader.append_frame(ack_frame_for_output(&writer, 1, "ack:accepted", 3));
    assert_eq!(
        driver.process_next().expect("accepted ack"),
        SupervisorDriverStep::ManagementAcknowledged
    );
    let bodies = decoded_bodies(&writer);
    let wire::management_payload::Body::AttemptProcessSpawned(spawned) = &bodies[2] else {
        panic!("spawned fact");
    };
    assert!(spawned.spawned_at_unix_ms >= after_spawn);
    assert_eq!(bodies.len(), 3);
    assert_eq!(driver.pending_management_facts(), 1);

    reader.append_frame(ack_frame_for_output(&writer, 2, "ack:spawned", 4));
    assert_eq!(
        driver.process_next().expect("spawned ack"),
        SupervisorDriverStep::ManagementAcknowledged
    );
    let bodies = decoded_bodies(&writer);
    let wire::management_payload::Body::AttemptContainmentReport(report) = &bodies[3] else {
        panic!("containment fact");
    };
    assert!(report.reported_at_unix_ms >= after_spawn);
    assert_eq!(driver.pending_management_facts(), 1);

    reader.append_frame(ack_frame_for_output(&writer, 3, "ack:containment", 5));
    assert_eq!(
        driver.process_next().expect("containment ack"),
        SupervisorDriverStep::ManagementAcknowledged
    );
    assert_eq!(driver.pending_management_facts(), 0);
    assert!(!driver.is_channel_poisoned());
}

#[test]
fn wrong_ack_does_not_advance_the_fact_machine() {
    let writer = TestWriter::default();
    let (channel, reader) = established_appendable(
        vec![launch_frame(launch_attempt(), "launch", 2)],
        writer.clone(),
        1,
    );
    let (containment, _state) = FakeContainment::healthy();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        FakeProvisioner::successful(),
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");
    driver.process_next().expect("launch");

    reader.append_frame(wrong_digest_ack_frame_for_output(
        &writer,
        1,
        "ack:wrong",
        3,
    ));
    assert!(matches!(
        driver.process_next(),
        Err(SupervisorDriverError::Channel(
            ManagementChannelError::InvalidAcknowledgement
        ))
    ));
    assert_eq!(decoded_bodies(&writer).len(), 2);
    assert_eq!(driver.pending_management_facts(), 1);
    assert!(driver.is_channel_poisoned());
    assert_eq!(
        driver.launch_registry.state_for_test("launch:test"),
        Some((1, false, true, false, false))
    );
}

#[test]
fn exact_duplicate_ack_replays_without_skipping_a_fact() {
    let writer = TestWriter::default();
    let (channel, reader) = established_appendable(
        vec![launch_frame(launch_attempt(), "launch", 2)],
        writer.clone(),
        1,
    );
    let (containment, _state) = FakeContainment::healthy();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        FakeProvisioner::successful(),
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");
    driver.process_next().expect("launch");
    let accepted_ack = ack_frame_for_output(&writer, 1, "ack:accepted", 3);

    reader.append_frame(accepted_ack.clone());
    driver.process_next().expect("accepted ack");
    assert_eq!(decoded_bodies(&writer).len(), 3);
    reader.append_frame(accepted_ack);
    assert_eq!(
        driver.process_next().expect("exact ack replay"),
        SupervisorDriverStep::Replay
    );
    assert_eq!(decoded_bodies(&writer).len(), 3);
    assert_eq!(driver.pending_management_facts(), 1);
    assert_eq!(
        driver.launch_registry.state_for_test("launch:test"),
        Some((1, false, true, false, false))
    );

    reader.append_frame(ack_frame_for_output(&writer, 2, "ack:spawned", 4));
    driver.process_next().expect("spawned ack");
    assert!(matches!(
        decoded_bodies(&writer).last(),
        Some(wire::management_payload::Body::AttemptContainmentReport(_))
    ));
    assert_eq!(
        driver.launch_registry.state_for_test("launch:test"),
        Some((1, false, true, false, false))
    );
}

#[test]
fn accepted_ack_at_lease_expiry_closes_ownership_without_spawned_fact() {
    let launch = launch_attempt();
    let lease = launch.authority_lease_expires_at_unix_ms;
    let writer = TestWriter::default();
    let (channel, reader) =
        established_appendable(vec![launch_frame(launch, "launch", 2)], writer.clone(), 1);
    let (containment, state) = FakeContainment::healthy();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        FakeProvisioner::successful(),
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");
    driver.process_next().expect("launch");

    reader.append_frame(ack_frame_for_output(&writer, 1, "ack:expired", 3));
    assert_eq!(
        driver.process_next_at(lease).expect("expired ack"),
        SupervisorDriverStep::ManagementAcknowledged
    );
    assert_eq!(decoded_bodies(&writer).len(), 2);
    assert_eq!(driver.pending_management_facts(), 0);
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn spawned_ack_after_hard_deadline_closes_without_containment_fact() {
    let launch = launch_attempt();
    let lease = launch.authority_lease_expires_at_unix_ms;
    let after_deadline = launch.hard_deadline_at_unix_ms + 1;
    let writer = TestWriter::default();
    let (channel, reader) =
        established_appendable(vec![launch_frame(launch, "launch", 2)], writer.clone(), 1);
    let (containment, state) = FakeContainment::healthy();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        FakeProvisioner::successful(),
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");
    driver.process_next().expect("launch");
    reader.append_frame(ack_frame_for_output(&writer, 1, "ack:accepted", 3));
    driver
        .process_next_at(lease - 1)
        .expect("accepted before lease");
    assert_eq!(decoded_bodies(&writer).len(), 3);

    reader.append_frame(ack_frame_for_output(&writer, 2, "ack:expired", 4));
    assert_eq!(
        driver
            .process_next_at(after_deadline)
            .expect("expired spawned ack"),
        SupervisorDriverStep::ManagementAcknowledged
    );
    assert_eq!(decoded_bodies(&writer).len(), 3);
    assert_eq!(driver.pending_management_facts(), 0);
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 1);
}
