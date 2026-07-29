use std::time::Duration;

use agent_protocol::generated::v1 as wire;
use agent_protocol::management_channel::ManagementChannelError;

use super::super::{AdmissionClosureReason, SupervisorDriverError, SupervisorDriverStep};
use super::support::decoded_bodies;
use crate::process_table::PhysicalState;

mod fixtures;

use fixtures::{
    PhysicalDriver, physical_driver, physical_driver_binary, physical_driver_binary_with_host,
    physical_driver_with_cancel_retry,
};

#[test]
#[ignore = "run after cargo build -p agent-runner --examples"]
fn full_driver_accepts_then_reaps_to_zero_after_management_eof() {
    let (mut driver, writer, idempotency_key) =
        physical_driver("agent-runner-bootstrap-child", Duration::from_secs(5));
    assert_launch_accepts_then_reaps(&mut driver, &writer, &idempotency_key);
}

#[test]
#[ignore = "run after cargo build -p agent-runner --bins"]
fn production_runner_binary_accepts_then_reaps_to_zero() {
    let (mut driver, writer, idempotency_key) = physical_driver_binary(Duration::from_secs(5));
    assert_launch_accepts_then_reaps(&mut driver, &writer, &idempotency_key);
}

#[test]
#[ignore = "run after cargo build -p agent-runner --bins --examples"]
fn production_runner_completes_physical_agent_and_host_hello() {
    let (mut driver, writer, idempotency_key, launch, mut host) =
        physical_driver_binary_with_host(Duration::from_secs(5));
    assert_eq!(
        driver.process_next().expect("physical launch"),
        SupervisorDriverStep::LaunchAccepted {
            reused_existing: false
        }
    );
    let (runner_process_id, runtime_instance_id) = driver
        .physical_runtime_for_test(&idempotency_key)
        .expect("owned physical runtime");
    host.complete(&launch, runner_process_id, &runtime_instance_id);
    assert_eq!(
        driver.physical_state_for_test(&idempotency_key),
        Some(PhysicalState::Reserved),
        "Hello cannot grant execution authority"
    );
    assert!(matches!(
        decoded_bodies(&writer).as_slice(),
        [
            wire::management_payload::Body::SupervisorHello(_),
            wire::management_payload::Body::LaunchAccepted(_)
        ]
    ));
    assert!(matches!(
        driver.process_next(),
        Err(SupervisorDriverError::Channel(
            ManagementChannelError::UnexpectedEof
        ))
    ));
    std::thread::sleep(Duration::from_millis(1_100));
    let report = driver
        .drive_cleanup(Duration::from_secs(2))
        .expect("reap Hello-complete runner");
    assert_eq!(report.reaped, 1);
    assert_driver_released(&driver);
}

fn assert_launch_accepts_then_reaps(
    driver: &mut PhysicalDriver,
    writer: &super::support::TestWriter,
    idempotency_key: &str,
) {
    let step = driver.process_next().expect("physical launch");
    assert_eq!(
        step,
        SupervisorDriverStep::LaunchAccepted {
            reused_existing: false
        },
        "unexpected launch outcome: owned={}, cleanup={}, reserved_memory={}",
        driver.owned_attempts(),
        driver.retained_completion_cleanups(),
        driver.reserved_memory_bytes()
    );
    assert_eq!(driver.owned_attempts(), 1);
    assert!(driver.reserved_memory_bytes() > 0);
    assert!(driver.reserved_processes() > 0);
    assert_eq!(driver.retained_completion_cleanups(), 0);
    assert_eq!(
        driver.physical_state_for_test(idempotency_key),
        Some(PhysicalState::Reserved),
        "LaunchAccepted must not grant pre-Activate execution authority"
    );
    let bodies = decoded_bodies(writer);
    assert!(
        matches!(
            bodies.as_slice(),
            [
                wire::management_payload::Body::SupervisorHello(_),
                wire::management_payload::Body::LaunchAccepted(_)
            ]
        ),
        "unexpected management outputs: {bodies:?}"
    );

    assert!(matches!(
        driver.process_next(),
        Err(SupervisorDriverError::Channel(
            ManagementChannelError::UnexpectedEof
        ))
    ));
    assert_eq!(
        driver.state().closure_reason(),
        Some(AdmissionClosureReason::UnexpectedEof)
    );
    std::thread::sleep(Duration::from_millis(1_100));
    let report = driver
        .drive_cleanup(Duration::from_secs(2))
        .expect("terminate and reap physical launch");
    assert_eq!(report.termination_attempts, 1);
    assert_eq!(report.provision_cleanup_attempts, 0);
    assert_eq!(report.reaped, 1);
    assert_eq!(
        driver
            .launch_registry
            .state_for_test(idempotency_key)
            .map(|state| state.3),
        Some(true)
    );
    assert_driver_released(driver);
}

#[test]
#[ignore = "run after cargo build -p agent-runner --examples"]
fn full_driver_timeout_retains_cleanup_until_termination_and_reap() {
    let (mut driver, writer, idempotency_key) = physical_driver(
        "agent-runner-bootstrap-stall-child",
        Duration::from_millis(30),
    );

    assert_eq!(
        driver.process_next().expect("typed bootstrap timeout"),
        SupervisorDriverStep::LaunchRejected {
            reason_code: "SUPERVISOR_PROTECTED_HANDOFF_UNAVAILABLE"
        }
    );
    assert!(driver.state().is_accepting_launches());
    assert_eq!(driver.owned_attempts(), 1);
    assert!(driver.reserved_memory_bytes() > 0);
    assert!(driver.reserved_processes() > 0);
    assert_eq!(driver.retained_completion_cleanups(), 1);
    assert_eq!(
        driver.physical_state_for_test(&idempotency_key),
        Some(PhysicalState::Cancelling)
    );
    assert_eq!(
        driver.launch_registry.state_for_test(&idempotency_key),
        Some((1, false, true, false, false))
    );
    assert!(matches!(
        decoded_bodies(&writer).as_slice(),
        [
            wire::management_payload::Body::SupervisorHello(_),
            wire::management_payload::Body::LaunchRejected(_)
        ]
    ));

    let report = driver
        .drive_cleanup(Duration::from_secs(2))
        .expect("cleanup retained bootstrap I/O then reap physical launch");
    assert_eq!(report.termination_attempts, 0);
    assert_eq!(report.provision_cleanup_attempts, 1);
    assert_eq!(report.provision_cleanup_failures, 0);
    assert_eq!(report.reaped, 1);
    assert_eq!(
        driver.launch_registry.state_for_test(&idempotency_key),
        Some((1, false, true, true, false))
    );
    assert_driver_released(&driver);
}

#[test]
#[ignore = "run after cargo build -p agent-runner --examples"]
fn semantic_cancel_retry_remains_acknowledgeable_after_physical_reap() {
    let (mut driver, _, _, grace_deadline) =
        physical_driver_with_cancel_retry("agent-runner-bootstrap-child", Duration::from_secs(5));
    driver.process_next().expect("physical launch");
    assert_eq!(
        driver
            .process_next_at(grace_deadline - 1_000)
            .expect("fresh cancel"),
        SupervisorDriverStep::CancelScheduled {
            reused_existing: false
        }
    );

    let report = driver
        .drive_cleanup_at(grace_deadline, Duration::from_secs(2))
        .expect("terminate and reap cancelled runner");
    assert_eq!(report.reaped, 1);
    assert_driver_released(&driver);

    assert_eq!(
        driver
            .process_next_at(grace_deadline + 1)
            .expect("semantic retry after reap"),
        SupervisorDriverStep::CancelScheduled {
            reused_existing: true
        }
    );
    assert_driver_released(&driver);

    assert!(matches!(
        driver.process_next_at(grace_deadline + 2),
        Err(SupervisorDriverError::TerminationConflict)
    ));
    assert!(driver.is_channel_poisoned());
    assert_driver_released(&driver);
}

fn assert_driver_released(driver: &PhysicalDriver) {
    assert_eq!(driver.owned_attempts(), 0);
    assert_eq!(driver.reserved_memory_bytes(), 0);
    assert_eq!(driver.reserved_processes(), 0);
    assert_eq!(driver.retained_completion_cleanups(), 0);
    assert_eq!(driver.state().pending_cleanup_count(), 0);
}
