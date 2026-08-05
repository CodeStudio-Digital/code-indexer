use agent_protocol::generated::v1 as wire;

use super::super::SupervisorPhysicalDriver;
use super::super::plan::LaunchPlan;
use super::fakes::{FakeContainment, FakeProvisioner};
use super::support::{TestWriter, established, launch_attempt, peer_authority, trusted_runner};
use crate::management::ManagementEnvelopeReceipt;
use crate::process_table::{OwnershipKey, reaped_attempt_for_test};

#[test]
fn physical_reap_facts_advance_only_after_each_exact_host_ack() {
    let channel = established(Vec::new(), TestWriter::default());
    let (containment, _) = FakeContainment::healthy();
    let driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        FakeProvisioner::successful(),
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");
    let mut core = driver.core;
    let plan = LaunchPlan::from_validated(&launch_attempt(), [9; 32]).expect("plan");
    let reaped = reaped_attempt_for_test(plan.metadata(), 64 * 1024 * 1024);
    let key = OwnershipKey::from_metadata(reaped.metadata());
    assert!(core.stage_reaped_lifecycle(&key, &reaped, wire::PhysicalExitCause::Cancelled, 2_100,));

    let mut exited = core.take_lifecycle_fact().expect("Exited ready");
    let wire::management_payload::Body::AttemptProcessExited(payload) =
        exited.take_payload().body.expect("Exited body")
    else {
        panic!("first lifecycle fact must be Exited");
    };
    assert_eq!(payload.cause, wire::PhysicalExitCause::Cancelled as i32);
    assert_eq!(payload.exited_at_unix_ms, 2_000);
    assert_eq!(payload.runner_provenance.expect("provenance").pid, 41);
    assert_eq!(
        payload
            .final_resources
            .expect("final resources")
            .peak_resident_memory_bytes,
        64 * 1024 * 1024
    );
    let exited_receipt = ManagementEnvelopeReceipt::for_test("fact:exited", [3; 32]);
    core.track_prepared_fact(&exited_receipt, exited)
        .expect("track Exited");
    assert!(
        core.acknowledge_management_fact(&ack("fact:wrong", [3; 32]), 2_200)
            .is_err()
    );
    let mut reaped = core
        .acknowledge_management_fact(&ack("fact:exited", [3; 32]), 2_200)
        .expect("exact Exited ACK")
        .expect("Reaped successor");

    let wire::management_payload::Body::AttemptProcessReaped(payload) =
        reaped.take_payload().body.expect("Reaped body")
    else {
        panic!("second lifecycle fact must be Reaped");
    };
    assert_eq!(payload.reaped_at_unix_ms, 2_100);
    assert_eq!(payload.runtime_instance_id, plan.runtime_instance_id());
    assert_eq!(payload.released_resources.len(), 2);
    let reaped_receipt = ManagementEnvelopeReceipt::for_test("fact:reaped", [4; 32]);
    core.track_prepared_fact(&reaped_receipt, reaped)
        .expect("track Reaped");
    assert!(
        core.acknowledge_management_fact(&ack("fact:reaped", [4; 32]), 2_300)
            .expect("exact Reaped ACK")
            .is_none()
    );
    assert_eq!(core.pending_management_facts(), 0);
}

fn ack(message_id: &str, digest: [u8; 32]) -> wire::ManagementAck {
    wire::ManagementAck {
        acknowledged_message_id: message_id.into(),
        acknowledged_payload_sha256: digest.to_vec(),
        acknowledged_at_unix_ms: 2_200,
    }
}
