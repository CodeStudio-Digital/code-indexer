//! Bounded duplex stdio with kill-on-close ownership of every descendant.
mod io_workers;
mod lifecycle;
#[cfg(test)]
mod tests;
mod transport;

use crate::command::CommandCapture;
use agent_platform::budget::ResourceBudget;
use agent_platform::containment::{
    ContainedLaunch, ContainmentPort, ResourceGroupId, SpawnFailure,
};
use agent_platform::windows::WindowsContainment;
use std::ffi::OsString;
use std::io;
use std::path::PathBuf;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::thread::JoinHandle;
use std::time::Duration;
use tokio::sync::{Mutex, mpsc as async_mpsc, oneshot};

#[derive(Debug)]
pub struct DuplexChunk {
    pub bytes: Vec<u8>,
    pub stderr: bool,
}
pub type DuplexOutput = Arc<Mutex<async_mpsc::Receiver<DuplexChunk>>>;
pub type WriteCompletion = oneshot::Receiver<Result<(), String>>;

#[derive(Debug)]
pub struct DuplexProcessSpec {
    pub executable: PathBuf,
    pub arguments: Vec<OsString>,
    pub cwd: PathBuf,
    pub environment: Vec<(OsString, OsString)>,
    pub timeout_ms: u32,
    pub stream_stderr: bool,
    pub pseudoconsole: Option<(u16, u16)>,
}
#[derive(Debug)]
pub struct DuplexProcessResult {
    pub process_id: u32,
    pub exit_code: u32,
    pub cancelled: bool,
    pub timed_out: bool,
    pub reaped: bool,
    pub stderr: CommandCapture,
}
#[derive(Debug)]
pub struct DuplexWrite {
    bytes: zeroize::Zeroizing<Vec<u8>>,
    receipt: oneshot::Sender<Result<(), String>>,
}

#[derive(Debug)]
pub struct HostDuplexProcess {
    process_id: u32,
    cancel: Arc<AtomicBool>,
    input: mpsc::SyncSender<DuplexWrite>,
    output: DuplexOutput,
    worker: Option<JoinHandle<io::Result<DuplexProcessResult>>>,
}
impl HostDuplexProcess {
    /// Starts suspended and assigns the OS Job before any application code.
    /// # Errors
    /// Invalid bounds, launch or containment failure reject ownership.
    pub fn start(spec: DuplexProcessSpec) -> io::Result<Self> {
        if spec.timeout_ms == 0 || spec.timeout_ms > 86_400_000 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "duplex process lifetime",
            ));
        }
        let (transport, handles) = transport::DuplexTransport::prepare(spec.pseudoconsole)?;
        let launch = ContainedLaunch {
            executable: spec.executable,
            arguments: spec.arguments,
            working_directory: spec.cwd,
            environment: spec.environment,
        };
        let containment = WindowsContainment::new();
        let group = match containment.spawn_runner_contained_with_handles(
            ResourceGroupId("host-duplex".into()),
            &budget(spec.timeout_ms),
            &launch,
            handles,
        ) {
            Ok(spawned) => spawned.group,
            Err(SpawnFailure::Clean(error)) => return Err(io::Error::other(error)),
            Err(SpawnFailure::Owned { spawned, error }) => {
                let _ = containment.terminate_group(&spawned.group, 1);
                let _ = containment.reap_group(spawned.group, Duration::from_secs(5));
                return Err(io::Error::other(error));
            }
        };
        let process_id = group.process_id().0;
        let cancel = Arc::new(AtomicBool::new(false));
        let cancellation = Arc::clone(&cancel);
        // Four bounded 1 MiB writes, plus 32 x 16 KiB output chunks.
        let (input, requests) = mpsc::sync_channel(4);
        let (output_send, output) = async_mpsc::channel(32);
        let worker = std::thread::Builder::new()
            .name("host-duplex".into())
            .spawn(move || {
                lifecycle::execute(
                    group,
                    transport,
                    requests,
                    output_send,
                    cancellation,
                    Duration::from_millis(u64::from(spec.timeout_ms)),
                    spec.stream_stderr,
                )
            })?;
        Ok(Self {
            process_id,
            cancel,
            input,
            output: Arc::new(Mutex::new(output)),
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
    #[must_use]
    pub fn output(&self) -> DuplexOutput {
        Arc::clone(&self.output)
    }
    #[must_use]
    pub fn input(&self) -> mpsc::SyncSender<DuplexWrite> {
        self.input.clone()
    }

    /// Waits off the JS thread. Successful completion includes physical reap.
    /// # Errors
    /// A missing worker, panic or unproven cleanup never reports success.
    pub fn wait(mut self) -> io::Result<DuplexProcessResult> {
        self.worker
            .take()
            .ok_or_else(|| io::Error::other("duplex already awaited"))?
            .join()
            .map_err(|_| io::Error::other("duplex worker panicked"))?
    }
}
impl Drop for HostDuplexProcess {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
    }
}

/// Synchronous, bounded admission adjacent to the Host effect authorization.
/// # Errors
/// A closed/full queue or oversized frame is rejected without enqueueing bytes.
pub fn enqueue_write(
    input: &mpsc::SyncSender<DuplexWrite>,
    cancel: &AtomicBool,
    bytes: Vec<u8>,
) -> io::Result<WriteCompletion> {
    if bytes.is_empty() || bytes.len() > 1_048_576 || cancel.load(Ordering::Acquire) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "duplex write unavailable",
        ));
    }
    let (receipt, completion) = oneshot::channel();
    input
        .try_send(DuplexWrite {
            bytes: zeroize::Zeroizing::new(bytes),
            receipt,
        })
        .map_err(|error| match error {
            mpsc::TrySendError::Full(_) => {
                io::Error::new(io::ErrorKind::WouldBlock, "duplex input queue full")
            }
            mpsc::TrySendError::Disconnected(_) => {
                io::Error::new(io::ErrorKind::BrokenPipe, "duplex input closed")
            }
        })?;
    Ok(completion)
}
fn budget(timeout_ms: u32) -> ResourceBudget {
    ResourceBudget {
        soft_memory_bytes: 1 << 30,
        hard_memory_bytes: u64::from(crate::resource_bounds::DUPLEX_MEMORY_BYTES),
        cpu_time_ms: u64::from(timeout_ms),
        max_wall_ms: u64::from(timeout_ms),
        max_processes: crate::resource_bounds::DUPLEX_PROCESSES,
        max_threads: 256,
        max_open_handles: 2048,
        max_hot_transcript_bytes: 1 << 20,
        max_ipc_frames: 32,
        max_ipc_bytes: 8 << 20,
        max_spool_bytes: 1 << 20,
        max_artifact_bytes: 1 << 20,
        max_concurrent_tools: 1,
        max_blocking_tasks: 4,
        cancel_grace_ms: u64::from(timeout_ms.min(1000)),
    }
}
