use std::sync::atomic::Ordering;
use std::time::Duration;

use agent_protocol::generated::v1 as wire;

use super::super::{SupervisorDriverStep, SupervisorPhysicalDriver};
use super::fakes::{FakeContainment, FakeProvisioner};
use super::support::{
    AppendableReader, TestWriter, ack_frame_for_output, established_appendable, frame,
    launch_attempt, launch_frame, peer_authority, trusted_runner,
};

type Driver =
    SupervisorPhysicalDriver<AppendableReader, TestWriter, FakeContainment, FakeProvisioner>;

fn launched() -> (Driver, AppendableReader, TestWriter) {
    let writer = TestWriter::default();
    let (channel, reader) = established_appendable(
        vec![launch_frame(launch_attempt(), "launch", 2)],
        writer.clone(),
        16,
    );
    let (containment, _) = FakeContainment::healthy();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        FakeProvisioner::successful(),
        trusted_runner(),
        peer_authority(),
    )
    .unwrap();
    driver.process_next_at(1_000).unwrap();
    for index in 1..=3 {
        reader.append_frame(ack_frame_for_output(
            &writer,
            index,
            &format!("launch-ack:{index}"),
            index as u64 + 2,
        ));
        driver.process_next_at(1_001).unwrap();
    }
    (driver, reader, writer)
}

fn update() -> wire::UpdateAttemptAuthority {
    let launch = launch_attempt();
    wire::UpdateAttemptAuthority {
        identity: launch.identity,
        authority_lease_expires_at_unix_ms: launch.authority_lease_expires_at_unix_ms + 10_000,
        hard_deadline_at_unix_ms: launch.hard_deadline_at_unix_ms,
        updated_at_unix_ms: 1_500,
        idempotency_key: "renewal:1".into(),
    }
}

fn append(reader: &AppendableReader, value: wire::UpdateAttemptAuthority, sequence: u64) {
    reader.append_frame(frame(
        wire::management_payload::Body::UpdateAttemptAuthority(value),
        &format!("renewal:{sequence}"),
        sequence,
    ));
}

#[test]
fn renewal_and_exact_replay_preserve_hard_deadline_and_move_expiry() {
    let (mut driver, reader, _) = launched();
    let value = update();
    let key = driver
        .launch_registry
        .ownership_key_for_test("launch:test")
        .unwrap();
    assert!(driver.state.is_accepting_launches(), "{:?}", driver.state);
    assert!(driver.state.can_renew_authority(key, 2_000));
    assert!(
        driver.launch_registry.authority_ready(key),
        "{:?}",
        driver.launch_registry.state_for_test("launch:test")
    );
    assert_eq!(
        driver.ownership.metadata(key).unwrap().deadline_at_unix_ms,
        value.hard_deadline_at_unix_ms
    );
    append(&reader, value.clone(), 6);
    assert_eq!(
        driver.process_next_at(2_000).unwrap(),
        SupervisorDriverStep::AuthorityUpdated {
            reused_existing: false
        }
    );
    append(&reader, value.clone(), 7);
    assert_eq!(
        driver.process_next_at(2_001).unwrap(),
        SupervisorDriverStep::AuthorityUpdated {
            reused_existing: true
        }
    );
    assert_eq!(
        driver.next_physical_deadline_unix_ms(),
        Some(value.authority_lease_expires_at_unix_ms)
    );
    let old_expiry = launch_attempt().authority_lease_expires_at_unix_ms;
    assert_eq!(
        driver
            .drive_cleanup_at(old_expiry, Duration::ZERO)
            .unwrap()
            .termination_attempts,
        0
    );
    assert_eq!(
        driver
            .drive_cleanup_at(value.authority_lease_expires_at_unix_ms, Duration::ZERO)
            .unwrap()
            .termination_attempts,
        1
    );
}

#[test]
fn renewal_refuses_foreign_fence_hard_deadline_change_expiry_and_regression() {
    for variant in 0..5 {
        let (mut driver, reader, _) = launched();
        let mut value = update();
        let mut now = 2_000;
        match variant {
            0 => value.identity.as_mut().unwrap().fencing_epoch += 1,
            1 => value.hard_deadline_at_unix_ms += 1,
            2 => now = launch_attempt().authority_lease_expires_at_unix_ms,
            3 => {
                value.authority_lease_expires_at_unix_ms =
                    launch_attempt().authority_lease_expires_at_unix_ms - 1;
            }
            _ => value.updated_at_unix_ms = now + 1,
        }
        append(&reader, value, 6);
        assert!(
            driver.process_next_at(now).is_err(),
            "invalid variant {variant}"
        );
        assert!(driver.state().pending_cleanup_count() > 0);
    }
}

#[test]
fn renewal_rejects_conflicting_idempotency_and_does_not_revive_cancellation() {
    for cancel in [false, true] {
        let (mut driver, reader, _) = launched();
        let mut value = update();
        append(&reader, value.clone(), 6);
        driver.process_next_at(2_000).unwrap();
        if cancel {
            let key = driver
                .launch_registry
                .ownership_key_for_test("launch:test")
                .unwrap()
                .clone();
            driver
                .state
                .schedule_attempt_cleanup(2_001, 100, false, [key])
                .unwrap();
            value.idempotency_key = "renewal:2".into();
        }
        value.authority_lease_expires_at_unix_ms += 1;
        append(&reader, value, 7);
        assert!(driver.process_next_at(2_001).is_err());
        assert!(driver.state().pending_cleanup_count() > 0);
    }
}

#[test]
fn renewal_ack_loss_schedules_physical_cleanup_without_freeing_ownership() {
    let writer = TestWriter::default();
    let (channel, reader) = established_appendable(
        vec![launch_frame(launch_attempt(), "launch", 2)],
        writer.clone(),
        16,
    );
    let (containment, state) = FakeContainment::healthy();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        FakeProvisioner::successful(),
        trusted_runner(),
        peer_authority(),
    )
    .unwrap();
    driver.process_next_at(1_000).unwrap();
    for index in 1..=3 {
        reader.append_frame(ack_frame_for_output(
            &writer,
            index,
            &format!("ack:{index}"),
            index as u64 + 2,
        ));
        driver.process_next_at(1_001).unwrap();
    }
    writer.fail_on_next_write();
    append(&reader, update(), 6);
    assert!(driver.process_next_at(2_000).is_err());
    driver.drive_cleanup_at(2_000, Duration::ZERO).unwrap();
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 1);
    assert!(driver.reserved_memory_bytes() > 0);
}
