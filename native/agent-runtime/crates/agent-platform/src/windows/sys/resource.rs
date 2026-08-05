use std::io;
use std::mem::size_of;

use windows_sys::Win32::Foundation::FILETIME;
use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetProcessHandleCount, GetProcessTimes,
};

pub(in crate::windows) struct RawCurrentProcessSample {
    pub(in crate::windows) resident_memory_bytes: u64,
    pub(in crate::windows) peak_resident_memory_bytes: u64,
    pub(in crate::windows) cpu_time_ms: u64,
    pub(in crate::windows) open_handle_count: u32,
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
    })
}

const fn filetime_ticks(value: FILETIME) -> u64 {
    (value.dwHighDateTime as u64) << 32 | value.dwLowDateTime as u64
}
