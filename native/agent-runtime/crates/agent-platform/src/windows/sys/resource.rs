use std::io;
use std::mem::size_of;
use std::ptr;

use windows_sys::Win32::Foundation::FILETIME;
use windows_sys::Win32::System::JobObjects::{
    IsProcessInJob, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JobObjectBasicAccountingInformation,
    QueryInformationJobObject,
};
use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetProcessHandleCount, GetProcessTimes,
};

pub(in crate::windows) struct RawCurrentProcessSample {
    pub(in crate::windows) resident_memory_bytes: u64,
    pub(in crate::windows) peak_resident_memory_bytes: u64,
    pub(in crate::windows) cpu_time_ms: u64,
    pub(in crate::windows) open_handle_count: u32,
    pub(in crate::windows) job_process_count: Option<u32>,
}

pub(in crate::windows) fn sample_current_process() -> io::Result<RawCurrentProcessSample> {
    // SAFETY: GetCurrentProcess returns a process-local pseudo handle that is
    // valid for query APIs and must not be closed.
    let process = unsafe { GetCurrentProcess() };
    let mut memory = PROCESS_MEMORY_COUNTERS {
        cb: u32::try_from(size_of::<PROCESS_MEMORY_COUNTERS>())
            .map_err(|_| io::Error::other("process counter size overflow"))?,
        ..PROCESS_MEMORY_COUNTERS::default()
    };
    // SAFETY: memory points to a correctly-sized writable Win32 structure.
    if unsafe { K32GetProcessMemoryInfo(process, &raw mut memory, memory.cb) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: all FILETIME pointers are valid and writable for this call.
    if unsafe {
        GetProcessTimes(
            process,
            &raw mut creation,
            &raw mut exit,
            &raw mut kernel,
            &raw mut user,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let mut open_handle_count = 0_u32;
    // SAFETY: count is a valid writable u32 and process is the current process.
    if unsafe { GetProcessHandleCount(process, &raw mut open_handle_count) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let cpu_100ns = filetime_ticks(kernel)
        .checked_add(filetime_ticks(user))
        .ok_or_else(|| io::Error::other("process CPU time overflow"))?;
    Ok(RawCurrentProcessSample {
        resident_memory_bytes: u64::try_from(memory.WorkingSetSize)
            .map_err(|_| io::Error::other("resident memory overflow"))?,
        peak_resident_memory_bytes: u64::try_from(memory.PeakWorkingSetSize)
            .map_err(|_| io::Error::other("peak resident memory overflow"))?,
        cpu_time_ms: cpu_100ns / 10_000,
        open_handle_count,
        job_process_count: current_job_process_count(process)?,
    })
}

fn current_job_process_count(process: *mut core::ffi::c_void) -> io::Result<Option<u32>> {
    let mut in_job = 0;
    // SAFETY: process is the current-process pseudo handle and in_job is a
    // valid writable BOOL. A null job asks whether any job contains it.
    if unsafe { IsProcessInJob(process, ptr::null_mut(), &raw mut in_job) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if in_job == 0 {
        return Ok(None);
    }
    let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
    // SAFETY: a null Job handle selects the immediate job of the calling
    // process; accounting is a correctly sized writable structure.
    if unsafe {
        QueryInformationJobObject(
            ptr::null_mut(),
            JobObjectBasicAccountingInformation,
            (&raw mut accounting).cast(),
            u32::try_from(size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>())
                .map_err(|_| io::Error::other("job accounting size overflow"))?,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if accounting.ActiveProcesses == 0 {
        return Err(io::Error::other(
            "current job reported zero active processes",
        ));
    }
    Ok(Some(accounting.ActiveProcesses))
}

const fn filetime_ticks(value: FILETIME) -> u64 {
    (value.dwHighDateTime as u64) << 32 | value.dwLowDateTime as u64
}
