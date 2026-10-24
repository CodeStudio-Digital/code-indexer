//! Host commands with unique, kill-on-close ownership of the entire process tree.
pub(crate) mod capture;
mod lifecycle;
#[cfg(test)]
mod tests;

use std::ffi::OsString;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::Duration;

use agent_platform::budget::ResourceBudget;
use agent_platform::containment::{
    ChildHandleAllowlist, ContainedLaunch, ContainmentPort, ResourceGroupId, SpawnFailure,
};
use agent_platform::windows::WindowsContainment;
use agent_platform::windows::bootstrap::prepare_windows_command_streams;
pub use capture::CommandCapture;

#[derive(Debug)]
pub struct HostCommandSpec {
    pub executable: PathBuf,
    pub arguments: Vec<OsString>,
    pub cwd: PathBuf,
    pub environment: Vec<(OsString, OsString)>,
    pub stdin: Vec<u8>,
    pub timeout_ms: u32,
    pub maximum_output_bytes: u32,
}

#[derive(Debug)]
pub struct HostCommandResult {
    pub stdout: CommandCapture,
    pub stderr: CommandCapture,
    pub process_id: u32,
    pub exit_code: u32,
    pub cancelled: bool,
    pub timed_out: bool,
    pub reaped: bool,
}

/// Dropping the Host owner requests termination. A worker retains the Job
/// until physical reap; abrupt Host death closes its last OS handle.
#[derive(Debug)]
pub struct HostCommand {
    process_id: u32,
    cancel: Arc<AtomicBool>,
    worker: Option<JoinHandle<io::Result<HostCommandResult>>>,
}

impl HostCommand {
    /// Spawns suspended, assigns the Job, proves membership, then resumes.
    /// # Errors
    /// Invalid limits or failed spawn do not produce a usable owner.
    pub fn start(spec: HostCommandSpec) -> io::Result<Self> {
        if spec.timeout_ms == 0
            || spec.timeout_ms > 600_000
            || spec.maximum_output_bytes == 0
            || spec.maximum_output_bytes > 1_048_576
            || spec.stdin.len() > 1_048_576
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Host command bounds",
            ));
        }
        let (streams, child) = prepare_windows_command_streams()?;
        let mut handles = ChildHandleAllowlist::new();
        handles
            .install_windows_bootstrap(child)
            .map_err(io::Error::other)?;
        let launch = ContainedLaunch {
            executable: spec.executable,
            arguments: spec.arguments,
            working_directory: spec.cwd,
            environment: spec.environment,
        };
        let group = match WindowsContainment::new().spawn_runner_contained_with_handles(
            ResourceGroupId("host-command".into()),
            &budget(spec.timeout_ms),
            &launch,
            handles,
        ) {
            Ok(spawned) => spawned.group,
            Err(SpawnFailure::Clean(error)) => return Err(io::Error::other(error)),
            Err(SpawnFailure::Owned { spawned, error }) => {
                let containment = WindowsContainment::new();
                let _ = containment.terminate_group(&spawned.group, 1);
                let _ = containment.reap_group(spawned.group, Duration::from_secs(5));
                return Err(io::Error::other(error));
            }
        };
        let process_id = group.process_id().0;
        let cancel = Arc::new(AtomicBool::new(false));
        let cancellation = Arc::clone(&cancel);
        let worker = std::thread::Builder::new()
            .name("host-command".into())
            .spawn(move || {
                lifecycle::execute(
                    group,
                    streams,
                    spec.stdin,
                    spec.maximum_output_bytes as usize,
                    Duration::from_millis(u64::from(spec.timeout_ms)),
                    &cancellation,
                )
            })?;
        Ok(Self {
            process_id,
            cancel,
            worker: Some(worker),
        })
    }

    #[must_use]
    pub const fn process_id(&self) -> u32 {
        self.process_id
    }

    #[must_use]
    pub fn cancellation(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancel)
    }

    /// Waits outside the JS thread; success includes physical tree reap.
    /// # Errors
    /// A missing/failed worker or unproven reap never reports success.
    pub fn wait(mut self) -> io::Result<HostCommandResult> {
        self.worker
            .take()
            .ok_or_else(|| io::Error::other("Host command already awaited"))?
            .join()
            .map_err(|_| io::Error::other("Host command worker panicked"))?
    }
}

impl Drop for HostCommand {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
    }
}

fn budget(timeout_ms: u32) -> ResourceBudget {
    ResourceBudget {
        soft_memory_bytes: 1 << 30,
        hard_memory_bytes: u64::from(crate::resource_bounds::COMMAND_MEMORY_BYTES),
        cpu_time_ms: 600_000,
        max_wall_ms: u64::from(timeout_ms),
        max_processes: crate::resource_bounds::COMMAND_PROCESSES,
        max_threads: 1024,
        max_open_handles: 4096,
        max_hot_transcript_bytes: 1 << 20,
        max_ipc_frames: 16,
        max_ipc_bytes: 1 << 20,
        max_spool_bytes: 1 << 20,
        max_artifact_bytes: 1 << 20,
        max_concurrent_tools: 1,
        max_blocking_tasks: 4,
        cancel_grace_ms: u64::from(timeout_ms.min(1000)),
    }
}
