use super::*;

fn receive_launch(
    launch: wire::LaunchAttemptProcess,
) -> Result<Option<ManagementReceiveOutcome>, ManagementChannelError> {
    let mut channel = super::super::super::support::supervisor_channel(
        vec![frame(
            wire::management_payload::Body::LaunchAttemptProcess(launch),
            "budget-gate",
            2,
        )],
        RecordingWriter::default(),
        limits(),
    );
    channel.begin_receive_with_clock(|| NOW + 2)
}

fn assert_invalid_budget(launch: wire::LaunchAttemptProcess) {
    assert!(matches!(
        receive_launch(launch),
        Err(ManagementChannelError::InvalidManagementPayload {
            payload: "LaunchAttemptProcess",
            field: "resource_budget",
        })
    ));
}

#[test]
fn launch_rejects_cross_limit_budget_inconsistencies() {
    let mut artifact = super::super::super::support::launch_attempt();
    let artifact_budget = artifact.resource_budget.as_mut().expect("budget");
    artifact_budget.max_artifact_bytes = artifact_budget.max_spool_bytes + 1;
    assert_invalid_budget(artifact);

    let mut cancellation = super::super::super::support::launch_attempt();
    let cancellation_budget = cancellation.resource_budget.as_mut().expect("budget");
    cancellation_budget.cancel_grace_ms = cancellation_budget.max_wall_ms + 1;
    assert_invalid_budget(cancellation);

    let mut threads = super::super::super::support::launch_attempt();
    let threads_budget = threads.resource_budget.as_mut().expect("budget");
    threads_budget.max_threads = threads_budget.max_processes - 1;
    assert_invalid_budget(threads);
}

#[test]
fn launch_rejects_policy_and_original_observation_window_excess() {
    let mut memory = super::super::super::support::launch_attempt();
    memory
        .resource_budget
        .as_mut()
        .expect("budget")
        .hard_memory_bytes = super::super::super::support::host_hello()
        .limits
        .expect("limits")
        .max_reserved_memory_bytes
        + 1;
    assert_invalid_budget(memory);

    let mut processes = super::super::super::support::launch_attempt();
    let process_cap = super::super::super::support::host_hello()
        .limits
        .expect("limits")
        .max_reserved_processes;
    let processes_budget = processes.resource_budget.as_mut().expect("budget");
    processes_budget.max_processes = process_cap + 1;
    processes_budget.max_threads = process_cap + 1;
    assert_invalid_budget(processes);

    let mut wall = super::super::super::support::launch_attempt();
    let launch_window =
        u64::try_from(wall.hard_deadline_at_unix_ms - (NOW + 2)).expect("positive launch window");
    wall.resource_budget.as_mut().expect("budget").max_wall_ms = launch_window + 1;
    assert_invalid_budget(wall);
}
