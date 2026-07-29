use std::time::Duration;

use agent_platform::containment::{ContainmentPort, SpawnedGroup};
use agent_platform::windows::{WindowsContainment, WindowsJobGroup};

const TEST_TERMINATION_EXIT_CODE: u32 = 0x00A6_1701;

pub(super) fn assert_alive_then_terminate_and_reap(spawned: SpawnedGroup<WindowsJobGroup>) {
    let adapter = WindowsContainment::new();
    let group = match adapter.reap_group(spawned.group, Duration::ZERO) {
        Ok(evidence) => panic!(
            "bootstrap child released its materialized endpoint owner and exited early: exit={}",
            evidence.exit_code()
        ),
        Err(failure) => failure.group,
    };
    adapter
        .terminate_group(&group, TEST_TERMINATION_EXIT_CODE)
        .expect("terminate live bootstrap test child");
    adapter
        .reap_group(group, Duration::from_secs(2))
        .expect("reap live bootstrap test child after termination");
}

pub(super) fn terminate(spawned: &SpawnedGroup<WindowsJobGroup>) {
    WindowsContainment::new()
        .terminate_group(&spawned.group, TEST_TERMINATION_EXIT_CODE)
        .expect("terminate bootstrap test child");
}

pub(super) fn reap_terminated(spawned: SpawnedGroup<WindowsJobGroup>) {
    WindowsContainment::new()
        .reap_group(spawned.group, Duration::from_secs(2))
        .expect("reap terminated bootstrap child");
}
