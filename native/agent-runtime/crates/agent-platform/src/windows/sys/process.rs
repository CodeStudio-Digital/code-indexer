use std::mem::size_of;
use std::os::windows::io::{FromRawHandle, OwnedHandle};
use std::ptr;

use windows_sys::Win32::Foundation::{WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::System::JobObjects::IsProcessInJob;
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
    EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, PROCESS_INFORMATION, ResumeThread,
    STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW, WaitForSingleObject,
};

#[cfg(test)]
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
};

use crate::containment::ChildHandleAllowlist;

use super::super::WindowsContainmentError;
use super::super::launch::PreparedLaunch;
use super::ProcessAttributeList;
#[cfg(test)]
use super::handle::own_handle;
use super::handle::raw;

const FAILED_RESUME: u32 = u32::MAX;

#[derive(Debug)]
pub(in crate::windows) struct RunningProcess {
    pub handle: OwnedHandle,
    pub process_id: u32,
}

#[derive(Debug)]
pub(in crate::windows) enum ProcessSpawnFailure {
    Clean(WindowsContainmentError),
    Owned {
        process: RunningProcess,
        error: WindowsContainmentError,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::windows) enum SpawnFault {
    None,
    #[cfg(test)]
    AfterCreate,
    #[cfg(test)]
    AfterCreateWithCleanupFailure,
}

impl SpawnFault {
    const fn after_create(self) -> bool {
        #[cfg(test)]
        {
            !matches!(self, Self::None)
        }
        #[cfg(not(test))]
        {
            let _ = self;
            false
        }
    }

    pub(in crate::windows) const fn retain_after_create(self) -> bool {
        #[cfg(test)]
        {
            matches!(self, Self::AfterCreateWithCleanupFailure)
        }
        #[cfg(not(test))]
        {
            let _ = self;
            false
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::windows) enum WaitState {
    Signaled,
    TimedOut,
}

struct SuspendedProcess {
    process: OwnedHandle,
    thread: OwnedHandle,
    process_id: u32,
}

impl SuspendedProcess {
    fn failed(self, error: WindowsContainmentError) -> ProcessSpawnFailure {
        ProcessSpawnFailure::Owned {
            process: RunningProcess {
                handle: self.process,
                process_id: self.process_id,
            },
            error,
        }
    }
}

pub(in crate::windows) fn spawn_in_job(
    job: &OwnedHandle,
    launch: &mut PreparedLaunch,
    child_handles: &ChildHandleAllowlist,
    fault: SpawnFault,
) -> Result<RunningProcess, ProcessSpawnFailure> {
    let suspended = create_suspended_in_job(job, launch, child_handles)?;
    if fault.after_create() {
        return Err(suspended.failed(WindowsContainmentError::InvalidLaunch(
            "injected post-create validation failure",
        )));
    }
    match is_member(job, &suspended.process) {
        Ok(true) => {}
        Ok(false) => return Err(suspended.failed(WindowsContainmentError::MembershipNotProven)),
        Err(error) => return Err(suspended.failed(error)),
    }
    resume(suspended)
}

pub(in crate::windows) fn is_member(
    job: &OwnedHandle,
    process: &OwnedHandle,
) -> Result<bool, WindowsContainmentError> {
    let mut membership = 0;
    // SAFETY: the owned Job and process handles remain live for the call.
    if unsafe { IsProcessInJob(raw(process), raw(job), ptr::from_mut(&mut membership)) } == 0 {
        return Err(WindowsContainmentError::last_os_error("IsProcessInJob"));
    }
    Ok(membership != 0)
}

fn create_suspended_in_job(
    job: &OwnedHandle,
    launch: &mut PreparedLaunch,
    child_handles: &ChildHandleAllowlist,
) -> Result<SuspendedProcess, ProcessSpawnFailure> {
    let attributes =
        ProcessAttributeList::new(job, child_handles).map_err(ProcessSpawnFailure::Clean)?;
    let mut startup_info = STARTUPINFOW {
        cb: u32::try_from(size_of::<STARTUPINFOEXW>())
            .map_err(|_| WindowsContainmentError::LimitOverflow("STARTUPINFOEXW"))
            .map_err(ProcessSpawnFailure::Clean)?,
        ..STARTUPINFOW::default()
    };
    if let Some(stdio) = child_handles.windows_bootstrap_stdio() {
        startup_info.dwFlags = STARTF_USESTDHANDLES;
        startup_info.hStdInput = stdio.stdin;
        startup_info.hStdOutput = stdio.stdout;
        startup_info.hStdError = stdio.stderr;
    }
    let startup = STARTUPINFOEXW {
        StartupInfo: startup_info,
        lpAttributeList: attributes.as_ptr(),
    };
    let mut information = PROCESS_INFORMATION::default();
    let flags = CREATE_SUSPENDED
        | CREATE_UNICODE_ENVIRONMENT
        | CREATE_NO_WINDOW
        | EXTENDED_STARTUPINFO_PRESENT;

    // SAFETY: all buffers and the attribute list remain live for the call.
    // Job membership and the exact inherited-handle set are supplied through
    // the extended startup attribute list.
    let created = unsafe {
        CreateProcessW(
            launch.application.as_ptr(),
            launch.command_line.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            i32::from(!child_handles.is_empty()),
            flags,
            launch.environment.as_ptr().cast(),
            launch.working_directory.as_ptr(),
            ptr::from_ref(&startup.StartupInfo),
            ptr::from_mut(&mut information),
        )
    };
    if created == 0 {
        return Err(ProcessSpawnFailure::Clean(
            WindowsContainmentError::last_os_error("CreateProcessW(JOB_LIST)"),
        ));
    }

    // SAFETY: successful CreateProcessW guarantees two new non-null ownership
    // handles. Wrapping them cannot introduce a fallible post-create gap.
    let process = unsafe { OwnedHandle::from_raw_handle(information.hProcess) };
    // SAFETY: same successful CreateProcessW contract as above.
    let thread = unsafe { OwnedHandle::from_raw_handle(information.hThread) };
    Ok(SuspendedProcess {
        process,
        thread,
        process_id: information.dwProcessId,
    })
}

fn resume(suspended: SuspendedProcess) -> Result<RunningProcess, ProcessSpawnFailure> {
    // SAFETY: this is the live primary-thread handle created suspended above.
    let previous = unsafe { ResumeThread(raw(&suspended.thread)) };
    if previous == FAILED_RESUME {
        return Err(suspended.failed(WindowsContainmentError::last_os_error("ResumeThread")));
    }
    if previous != 1 {
        return Err(suspended.failed(WindowsContainmentError::UnexpectedSuspendCount(previous)));
    }
    Ok(RunningProcess {
        handle: suspended.process,
        process_id: suspended.process_id,
    })
}

pub(in crate::windows) fn wait_process(
    process: &OwnedHandle,
    timeout_ms: u32,
) -> Result<WaitState, WindowsContainmentError> {
    // SAFETY: `process` is live for the entire bounded wait.
    match unsafe { WaitForSingleObject(raw(process), timeout_ms) } {
        WAIT_OBJECT_0 => Ok(WaitState::Signaled),
        WAIT_TIMEOUT => Ok(WaitState::TimedOut),
        WAIT_FAILED => Err(WindowsContainmentError::last_os_error(
            "WaitForSingleObject",
        )),
        _ => Err(WindowsContainmentError::InvalidLaunch(
            "unexpected process wait result",
        )),
    }
}

pub(in crate::windows) fn exit_code(process: &OwnedHandle) -> Result<u32, WindowsContainmentError> {
    let mut exit_code = 0;
    // SAFETY: `process` is live and `exit_code` is writable for the call.
    if unsafe { GetExitCodeProcess(raw(process), ptr::from_mut(&mut exit_code)) } == 0 {
        return Err(WindowsContainmentError::last_os_error("GetExitCodeProcess"));
    }
    Ok(exit_code)
}

#[cfg(test)]
pub(in crate::windows) fn open_process_for_wait(
    process_id: u32,
) -> Result<OwnedHandle, WindowsContainmentError> {
    // SAFETY: OpenProcess returns a new non-inheritable ownership handle.
    let access = PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION;
    let handle = unsafe { OpenProcess(access, 0, process_id) };
    own_handle(handle, "OpenProcess")
}
