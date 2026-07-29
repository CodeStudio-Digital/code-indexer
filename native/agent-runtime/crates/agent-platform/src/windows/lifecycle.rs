use std::thread;
use std::time::{Duration, Instant};

use super::sys::{self, SpawnFault, WaitState};
use super::{WindowsContainmentError, WindowsJobGroup};

const POLL_INTERVAL: Duration = Duration::from_millis(10);
const STARTUP_CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);
const STARTUP_FAILURE_EXIT_CODE: u32 = 0xFFFF_FF03;

pub(super) fn cleanup_failed_spawn(
    group: &WindowsJobGroup,
    fault: SpawnFault,
) -> Result<(), WindowsContainmentError> {
    if fault.retain_after_create() {
        return Err(WindowsContainmentError::InvalidLaunch(
            "injected startup cleanup failure",
        ));
    }
    terminate_and_wait(group)
}

pub(super) fn cleanup_failed_descendant(
    group: &WindowsJobGroup,
) -> Result<(), WindowsContainmentError> {
    terminate_and_wait(group)
}

fn terminate_and_wait(group: &WindowsJobGroup) -> Result<(), WindowsContainmentError> {
    sys::terminate_job(&group.job, STARTUP_FAILURE_EXIT_CODE)?;
    wait_until_empty(group, STARTUP_CLEANUP_TIMEOUT).map(|_| ())
}

pub(super) fn wait_until_empty(
    group: &WindowsJobGroup,
    timeout: Duration,
) -> Result<(u32, u64), WindowsContainmentError> {
    let started = Instant::now();
    loop {
        let root_exited = sys::wait_process(&group.root_process, 0)? == WaitState::Signaled;
        let accounting = sys::query_accounting(&group.job)?;
        if root_exited && accounting.ActiveProcesses == 0 {
            let exit_code = sys::exit_code(&group.root_process)?;
            let peak_memory = sys::query_peak_memory(&group.job)?;
            return Ok((exit_code, peak_memory));
        }
        let elapsed = started.elapsed();
        if elapsed >= timeout {
            return Err(WindowsContainmentError::ReapTimedOut(timeout));
        }
        let remaining = timeout
            .checked_sub(elapsed)
            .ok_or(WindowsContainmentError::ReapTimedOut(timeout))?;
        thread::sleep(POLL_INTERVAL.min(remaining));
    }
}
