use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use agent_protocol::generated::v1 as wire;
use agent_protocol::management_frame::validate_management_frame;

use super::super::super::{AdmissionClosureReason, SupervisorDriverStep};
use super::super::fakes::{ContainmentState, FakeContainment, FakeProvisioner};
use super::super::support::{
    AppendableReader, TestWriter, ack_frame_for_output, decoded_bodies, established_appendable,
    launch_attempt, launch_frame, peer_authority, trusted_runner,
};
use crate::management::driver::{SupervisorPhysicalDriver, plan::LaunchPlan};
use crate::process_table::PhysicalState;

const LAUNCHED_AT: i64 = 1_000;
const TERMINATED_AT: i64 = 1_100;
const RETRIED_AT: i64 = 1_101;

type TestDriver =
    SupervisorPhysicalDriver<AppendableReader, TestWriter, FakeContainment, FakeProvisioner>;
type Launched = (
    TestDriver,
    AppendableReader,
    TestWriter,
    Arc<ContainmentState>,
    Arc<AtomicUsize>,
    Arc<AtomicUsize>,
    wire::LaunchAttemptProcess,
);

#[test]
fn semantic_retry_in_cancelling_reuses_accepted_outcome() {
    let (mut driver, reader, writer, state, provision_calls, complete_calls, launch) = launched();
    acknowledge_initial_fact_chain(&mut driver, &reader, &writer);
    terminate_without_reap(&mut driver);

    assert_eq!(
        driver.physical_state_for_test("launch:test"),
        Some(PhysicalState::Cancelling)
    );
    retry_and_ack(&mut driver, &reader, &writer, launch);

    assert_eq!(driver.owned_attempts(), 1);
    assert_eq!(state.spawn_calls.load(Ordering::SeqCst), 1);
    assert_eq!(provision_calls.load(Ordering::SeqCst), 1);
    assert_eq!(complete_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn semantic_retry_after_reap_has_a_new_ack_and_no_fact_successor() {
    let launch = launch_attempt();
    let encoded = launch_frame(launch.clone(), "launch:semantic-retry", 2);
    let validated = validate_management_frame(&encoded).expect("validated launch");
    let digest = validated
        .frame
        .header
        .as_ref()
        .expect("launch header")
        .payload_sha256
        .as_slice()
        .try_into()
        .expect("launch digest");
    let plan = LaunchPlan::from_validated(&launch, digest).expect("launch plan");
    let writer = TestWriter::default();
    let (channel, reader) = established_appendable(Vec::new(), writer.clone(), 4);
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
    let intent = driver
        .launch_registry
        .reserve(&plan, plan.ownership_key())
        .expect("launch tombstone");
    assert!(driver.launch_registry.mark_owned_for_test(&intent, &plan));
    driver
        .launch_registry
        .mark_physical_reaped(&plan.ownership_key());
    reader.append_frame(encoded);

    assert_eq!(
        driver.process_next_at(RETRIED_AT).expect("semantic retry"),
        SupervisorDriverStep::LaunchAccepted {
            reused_existing: true
        }
    );
    assert_eq!(driver.pending_management_facts(), 1);
    reader.append_frame(ack_frame_for_output(&writer, 1, "ack:retry", 3));
    assert_eq!(
        driver
            .process_next_at(RETRIED_AT + 1)
            .expect("semantic retry ack"),
        SupervisorDriverStep::ManagementAcknowledged
    );
    let mut conflicting = launch;
    conflicting.launch_nonce[0] ^= 0xff;
    reader.append_frame(launch_frame(conflicting, "launch:conflict", 4));
    assert_eq!(
        driver
            .process_next_at(RETRIED_AT + 2)
            .expect("conflicting tombstone retry"),
        SupervisorDriverStep::LaunchRejected {
            reason_code: "SUPERVISOR_DUPLICATE_CONFLICT"
        }
    );
    reader.append_frame(ack_frame_for_output(&writer, 2, "ack:conflict", 5));
    assert_eq!(
        driver
            .process_next_at(RETRIED_AT + 3)
            .expect("conflict ack"),
        SupervisorDriverStep::ManagementAcknowledged
    );

    assert_eq!(driver.owned_attempts(), 0);
    assert_eq!(driver.pending_management_facts(), 0);
    assert_eq!(decoded_bodies(&writer).len(), 3);
    assert_eq!(state.spawn_calls.load(Ordering::SeqCst), 0);
    assert_eq!(state.reap_calls.load(Ordering::SeqCst), 0);
    assert_eq!(provision_calls.load(Ordering::SeqCst), 0);
    assert_eq!(complete_calls.load(Ordering::SeqCst), 0);
}

fn launched() -> Launched {
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
    assert_eq!(
        driver.process_next_at(LAUNCHED_AT).expect("fresh launch"),
        SupervisorDriverStep::LaunchAccepted {
            reused_existing: false
        }
    );
    (
        driver,
        reader,
        writer,
        state,
        provision_calls,
        complete_calls,
        launch,
    )
}

fn acknowledge_initial_fact_chain(
    driver: &mut TestDriver,
    reader: &AppendableReader,
    writer: &TestWriter,
) {
    for (output, message, sequence, now) in [
        (1, "ack:accepted", 3, LAUNCHED_AT + 1),
        (2, "ack:spawned", 4, LAUNCHED_AT + 2),
        (3, "ack:containment", 5, LAUNCHED_AT + 3),
    ] {
        reader.append_frame(ack_frame_for_output(writer, output, message, sequence));
        assert_eq!(
            driver.process_next_at(now).expect("lifecycle fact ack"),
            SupervisorDriverStep::ManagementAcknowledged
        );
    }
    assert_eq!(driver.pending_management_facts(), 0);
}

fn terminate_without_reap(driver: &mut TestDriver) {
    let key = driver
        .launch_registry
        .ownership_key_for_test("launch:test")
        .expect("launch ownership")
        .clone();
    driver
        .close_owned_attempt(
            AdmissionClosureReason::AuthorityExpired,
            &key,
            TERMINATED_AT,
        )
        .expect("immediate physical termination");
}

fn retry_and_ack(
    driver: &mut TestDriver,
    reader: &AppendableReader,
    writer: &TestWriter,
    launch: wire::LaunchAttemptProcess,
) {
    reader.append_frame(launch_frame(launch, "launch:semantic-retry", 6));
    assert_eq!(
        driver.process_next_at(RETRIED_AT).expect("semantic retry"),
        SupervisorDriverStep::LaunchAccepted {
            reused_existing: true
        }
    );
    assert!(matches!(
        decoded_bodies(writer).last(),
        Some(wire::management_payload::Body::LaunchAccepted(accepted))
            if accepted.accepted_at_unix_ms == RETRIED_AT
    ));
    assert_eq!(driver.pending_management_facts(), 1);

    reader.append_frame(ack_frame_for_output(writer, 4, "ack:retry", 7));
    assert_eq!(
        driver
            .process_next_at(RETRIED_AT + 1)
            .expect("semantic retry ack"),
        SupervisorDriverStep::ManagementAcknowledged
    );
    assert_eq!(driver.pending_management_facts(), 0);
    assert_eq!(decoded_bodies(writer).len(), 5);
}
