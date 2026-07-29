use std::sync::atomic::Ordering;

use agent_protocol::generated::v1 as wire;

use super::super::super::{SupervisorDriverStep, SupervisorPhysicalDriver};
use super::super::fakes::{FakeContainment, FakeProvisioner};
use super::super::support::{
    TestWriter, established_appendable, launch_attempt, launch_frame, peer_authority,
    trusted_runner,
};
use super::acknowledge_output;

#[test]
fn registry_capacity_is_active_plus_pending_and_evicts_only_a_durable_rejection() {
    let frames = (1_u64..=8)
        .map(|index| {
            launch_frame(
                distinct_launch(index),
                &format!("launch:{index}"),
                index + 1,
            )
        })
        .collect();
    let writer = TestWriter::default();
    let (channel, reader) = established_appendable(frames, writer.clone(), 16);
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

    for _ in 0..8 {
        assert!(matches!(
            driver.process_next().expect("registered rejection"),
            SupervisorDriverStep::LaunchRejected {
                reason_code: "SUPERVISOR_PROTECTED_HANDOFF_UNAVAILABLE"
            }
        ));
    }
    assert_eq!(provision_calls.load(Ordering::SeqCst), 8);
    assert_eq!(complete_calls.load(Ordering::SeqCst), 0);

    reader.append_frame(launch_frame(distinct_launch(9), "launch:9", 10));
    assert_eq!(
        driver.process_next().expect("registry full"),
        SupervisorDriverStep::LaunchRejected {
            reason_code: "SUPERVISOR_BUDGET_UNAVAILABLE"
        }
    );
    assert_eq!(provision_calls.load(Ordering::SeqCst), 8);
    assert_eq!(complete_calls.load(Ordering::SeqCst), 0);

    acknowledge_output(&mut driver, &reader, &writer, 1, "ack:first", 11);
    reader.append_frame(launch_frame(distinct_launch(10), "launch:10", 12));
    assert_eq!(
        driver.process_next().expect("evict durable rejection"),
        SupervisorDriverStep::LaunchRejected {
            reason_code: "SUPERVISOR_PROTECTED_HANDOFF_UNAVAILABLE"
        }
    );
    assert_eq!(provision_calls.load(Ordering::SeqCst), 9);
    assert_eq!(complete_calls.load(Ordering::SeqCst), 0);
    assert_eq!(state.spawn_calls.load(Ordering::SeqCst), 0);
    assert!(!driver.is_channel_poisoned());
}

fn distinct_launch(index: u64) -> wire::LaunchAttemptProcess {
    let mut launch = launch_attempt();
    let identity = launch.identity.as_mut().expect("launch identity");
    identity.command_id = format!("22222222-2222-4222-8222-{index:012x}");
    identity.attempt_id = format!("44444444-4444-4444-8444-{index:012x}");
    identity.correlation_id = format!("55555555-5555-4555-8555-{index:012x}");
    launch.idempotency_key = format!("intent:{index}");
    launch.launch_nonce[0] = u8::try_from(index).expect("small fixture index");
    launch
}
