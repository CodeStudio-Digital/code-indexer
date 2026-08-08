use std::io;

/// Small, content-free snapshot of the current runner process and immediate
/// Job membership.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CurrentProcessResourceSample {
    pub resident_memory_bytes: u64,
    pub peak_resident_memory_bytes: u64,
    pub cpu_time_ms: u64,
    pub process_count: u32,
    pub open_handle_count: u32,
}

/// Samples the current process without retaining a process handle or buffer.
///
/// `process_count` is the active count of the immediate Windows Job when the
/// caller is contained, otherwise one for the current process.
///
/// # Errors
///
/// Returns the first Win32 sampling failure. Partial samples are never
/// reported as complete resource evidence.
pub fn sample_current_process_resources() -> io::Result<CurrentProcessResourceSample> {
    let raw = super::sys::sample_current_process()?;
    Ok(CurrentProcessResourceSample {
        resident_memory_bytes: raw.resident_memory_bytes,
        peak_resident_memory_bytes: raw.peak_resident_memory_bytes,
        cpu_time_ms: raw.cpu_time_ms,
        process_count: raw.job_process_count.unwrap_or(1),
        open_handle_count: raw.open_handle_count,
    })
}
