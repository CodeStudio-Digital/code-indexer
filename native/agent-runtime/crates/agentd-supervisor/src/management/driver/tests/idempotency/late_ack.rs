use std::mem;
use std::sync::atomic::Ordering;

use agent_protocol::generated::v1 as wire;
use agent_protocol::management_frame::validate_management_frame;

use super::super::super::{
    AdmissionClosureReason, SupervisorDriverError, SupervisorDriverStep, SupervisorLifecycleCore,
    SupervisorPhysicalDriver,
};
use super::super::fakes::{FakeContainment, FakeProvisioner};
use super::super::support::{
    TestWriter, ack_frame_for_output, established_appendable, launch_attempt, launch_frame,
    peer_authority, trusted_runner,
};
use crate::process_table::OwnershipError;

const LAUNCHED_AT: i64 = 1_000;
const EXPIRED_AT: i64 = 4_102_444_800_000;

#[derive(Clone, Copy)]
enum PendingStage {
    Accepted,
    Spawned,
}

#[test]
fn late_launch_fact_acks_after_confirmed_reap_never_recreate_cleanup() {
    for stage in [PendingStage::Accepted, PendingStage::Spawned] {
        assert_late_ack_is_cleanup_free(stage);
    }
}

fn assert_late_ack_is_cleanup_free(stage: PendingStage) {
    let writer = TestWriter::default();
    let (channel, reader) = established_appendable(
        vec![launch_frame(launch_attempt(), "launch:late-ack", 2)],
        writer.clone(),
        4,
    );
    let (containment, _) = FakeContainment::healthy();
    let mut launched = SupervisorPhysicalDriver::new(
        channel,
        containment,
        FakeProvisioner::successful(),
        trusted_runner(),
        peer_authority(),
    )
    .expect("launched driver");
    assert_eq!(
        launched.process_next_at(LAUNCHED_AT).expect("launch"),
        SupervisorDriverStep::LaunchAccepted {
            reused_existing: false
        }
    );
    let output_index = match stage {
        PendingStage::Accepted => 1,
        PendingStage::Spawned => {
            reader.append_frame(ack_frame_for_output(
                &writer,
                1,
                "ack:accepted-before-reap",
                3,
            ));
            assert_eq!(
                launched
                    .process_next_at(LAUNCHED_AT + 1)
                    .expect("accepted ack"),
                SupervisorDriverStep::ManagementAcknowledged
            );
            2
        }
    };
    let late_ack = acknowledgement_for_output(&writer, output_index);
    let key = launched
        .core
        .launch_registry
        .ownership_key_for_test("launch:test")
        .expect("launch ownership key")
        .clone();

    let (containment, reaped_state) = FakeContainment::healthy();
    let mut reaped = SupervisorLifecycleCore::new(
        launched.core.policy.clone(),
        containment,
        FakeProvisioner::successful(),
        trusted_runner(),
        peer_authority(),
    )
    .expect("reaped lifecycle core");
    mem::swap(
        &mut reaped.launch_registry,
        &mut launched.core.launch_registry,
    );
    mem::swap(&mut reaped.fact_flow, &mut launched.core.fact_flow);
    reaped.launch_registry.mark_physical_reaped(&key);

    assert_eq!(reaped.owned_attempts(), 0);
    assert_eq!(reaped.pending_management_facts(), 1);
    assert!(
        reaped
            .acknowledge_management_fact(&late_ack, EXPIRED_AT)
            .expect("late fact ack")
            .is_none()
    );
    assert_eq!(reaped.pending_management_facts(), 0);
    assert_eq!(reaped.state().pending_cleanup_count(), 0);

    reaped
        .close_for_management_loss(
            AdmissionClosureReason::PostSpawnWriteFailure,
            EXPIRED_AT + 1,
            Some(key),
        )
        .expect("stale write-failure key is already physically reaped");
    assert_eq!(reaped.owned_attempts(), 0);
    assert_eq!(reaped.state().pending_cleanup_count(), 0);
    assert_eq!(reaped_state.terminate_calls.load(Ordering::SeqCst), 0);
}

#[test]
fn missing_cleanup_owner_without_reap_proof_remains_an_invariant_error() {
    let writer = TestWriter::default();
    let (channel, _) = established_appendable(Vec::new(), writer, 1);
    let (containment, _) = FakeContainment::healthy();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        FakeProvisioner::successful(),
        trusted_runner(),
        peer_authority(),
    )
    .expect("empty driver");
    let key = launch_plan().ownership_key();

    assert!(matches!(
        driver.core.close_for_management_loss(
            AdmissionClosureReason::PostSpawnWriteFailure,
            LAUNCHED_AT,
            Some(key),
        ),
        Err(SupervisorDriverError::Ownership(
            OwnershipError::MissingAttempt
        ))
    ));
    assert_eq!(driver.state().pending_cleanup_count(), 0);
}

fn acknowledgement_for_output(writer: &TestWriter, output_index: usize) -> wire::ManagementAck {
    let encoded = ack_frame_for_output(writer, output_index, "ack:late", 99);
    let mut validated = validate_management_frame(&encoded).expect("validated late ack");
    match validated.payload.body.take().expect("management ack body") {
        wire::management_payload::Body::ManagementAck(acknowledgement) => acknowledgement,
        _ => panic!("management ack"),
    }
}

fn launch_plan() -> super::super::super::plan::LaunchPlan {
    let launch = launch_attempt();
    let encoded = launch_frame(launch.clone(), "launch:plan", 2);
    let validated = validate_management_frame(&encoded).expect("validated launch plan");
    let digest = validated
        .frame
        .header
        .as_ref()
        .expect("launch header")
        .payload_sha256
        .as_slice()
        .try_into()
        .expect("launch digest");
    super::super::super::plan::LaunchPlan::from_validated(&launch, digest).expect("launch plan")
}
