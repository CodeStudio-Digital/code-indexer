mod types;
use napi::bindgen_prelude::Buffer;
use napi::{Error, Result, Status};
use napi_derive::napi;
pub use types::{NativeDuplexOptions, NativeDuplexOutput, NativeDuplexResult};

#[derive(Debug)]
#[napi]
pub struct NativeStdinWrite {
    completion:
        std::sync::Mutex<Option<tokio::sync::oneshot::Receiver<std::result::Result<(), String>>>>,
}
#[napi]
impl NativeStdinWrite {
    /// Waits for the pipe writer without blocking the JavaScript event loop.
    /// # Errors
    /// Dropped/failed writes are uncertain; this API never resends bytes.
    #[napi]
    pub async fn wait(&self) -> Result<()> {
        let completion = self
            .completion
            .lock()
            .map_err(|_| invalid("stdin receipt lock poisoned"))?
            .take()
            .ok_or_else(|| invalid("stdin receipt already awaited"))?;
        completion
            .await
            .map_err(|_| invalid("stdin write retired without confirmation"))?
            .map_err(|message| Error::new(Status::GenericFailure, message))
    }
}

#[derive(Debug)]
#[napi]
pub struct NativeHostDuplexProcess {
    #[cfg(windows)]
    owner: std::sync::Mutex<Option<agent_host_bridge::duplex_process::HostDuplexProcess>>,
    #[cfg(windows)]
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    #[cfg(windows)]
    input: std::sync::mpsc::SyncSender<agent_host_bridge::duplex_process::DuplexWrite>,
    #[cfg(windows)]
    output: agent_host_bridge::duplex_process::DuplexOutput,
    process_id: u32,
    stream_stderr: bool,
}
#[napi]
impl NativeHostDuplexProcess {
    #[napi(getter)]
    #[must_use]
    pub const fn process_id(&self) -> u32 {
        self.process_id
    }

    #[napi]
    pub fn cancel(&self) {
        #[cfg(windows)]
        self.cancel
            .store(true, std::sync::atomic::Ordering::Release);
    }

    /// Enqueues one bounded write synchronously at the Host authorization boundary.
    /// # Errors
    /// Rejects closed/full queues or frames beyond 1 MiB without sending bytes.
    #[napi]
    pub fn write(&self, mut bytes: Buffer) -> Result<NativeStdinWrite> {
        if bytes.is_empty() || bytes.len() > 1_048_576 {
            return Err(invalid("duplex input frame bound"));
        }
        #[cfg(windows)]
        {
            let payload = bytes.to_vec();
            bytes.fill(0);
            let completion = agent_host_bridge::duplex_process::enqueue_write(
                &self.input,
                &self.cancel,
                payload,
            )
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?;
            Ok(NativeStdinWrite {
                completion: std::sync::Mutex::new(Some(completion)),
            })
        }
        #[cfg(not(windows))]
        Err(invalid("contained duplex requires Windows"))
    }

    /// One outstanding reader; bounded output chunks never block the JS thread.
    /// # Errors
    /// Concurrent readers are rejected instead of adding an unbounded queue.
    #[napi]
    pub async fn read(&self) -> Result<Option<Buffer>> {
        if self.stream_stderr {
            return Err(invalid("streamed stderr requires readOutput"));
        }
        #[cfg(windows)]
        {
            let mut reader = self
                .output
                .clone()
                .try_lock_owned()
                .map_err(|_| invalid("duplex reader already active"))?;
            Ok(reader.recv().await.map(|chunk| chunk.bytes.into()))
        }
        #[cfg(not(windows))]
        Err(invalid("contained duplex requires Windows"))
    }

    /// Tagged stdout/stderr chunks preserve separate UTF-8 decoder state.
    /// # Errors
    /// Concurrent readers are rejected; the consumer must keep draining.
    #[napi]
    pub async fn read_output(&self) -> Result<Option<NativeDuplexOutput>> {
        #[cfg(windows)]
        {
            let mut reader = self
                .output
                .clone()
                .try_lock_owned()
                .map_err(|_| invalid("duplex reader already active"))?;
            Ok(reader.recv().await.map(|chunk| NativeDuplexOutput {
                bytes: chunk.bytes.into(),
                stderr: chunk.stderr,
            }))
        }
        #[cfg(not(windows))]
        Err(invalid("contained duplex requires Windows"))
    }

    /// Completes only after the process tree has been physically reaped.
    /// # Errors
    /// Duplicate waits, failed IO and unproven cleanup fail closed.
    #[napi]
    pub async fn wait(&self) -> Result<NativeDuplexResult> {
        #[cfg(windows)]
        {
            let owner = self
                .owner
                .lock()
                .map_err(|_| invalid("duplex owner lock poisoned"))?
                .take()
                .ok_or_else(|| invalid("duplex process already awaited"))?;
            let result = tokio::task::spawn_blocking(move || owner.wait())
                .await
                .map_err(|_| invalid("duplex process wait failed"))?
                .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?;
            #[allow(clippy::cast_precision_loss)]
            Ok(NativeDuplexResult {
                process_id: result.process_id,
                exit_code: result.exit_code,
                cancelled: result.cancelled,
                timed_out: result.timed_out,
                reaped: result.reaped,
                stderr_head: result.stderr.head.into(),
                stderr_tail: result.stderr.tail.into(),
                stderr_total_bytes: result.stderr.total_bytes as f64,
            })
        }
        #[cfg(not(windows))]
        Err(invalid("contained duplex requires Windows"))
    }
}
impl Drop for NativeHostDuplexProcess {
    fn drop(&mut self) {
        self.cancel();
    }
}

/// Loads no shell and inherits only explicitly installed standard handles.
/// # Errors
/// Unsupported platform, bounds or containment failure reject the owner.
#[napi]
pub fn start_native_host_duplex_process(
    options: NativeDuplexOptions,
) -> Result<NativeHostDuplexProcess> {
    #[cfg(windows)]
    {
        use agent_host_bridge::duplex_process::{DuplexProcessSpec, HostDuplexProcess};
        let owner = HostDuplexProcess::start(DuplexProcessSpec {
            executable: options.executable.into(),
            arguments: options.arguments.into_iter().map(Into::into).collect(),
            cwd: options.cwd.into(),
            environment: options
                .environment
                .into_iter()
                .map(|(key, value)| (key.into(), value.into()))
                .collect(),
            timeout_ms: options.timeout_ms,
            stream_stderr: options.stream_stderr.unwrap_or(false),
            pseudoconsole: options
                .tty
                .unwrap_or(false)
                .then_some((options.columns.unwrap_or(120), options.rows.unwrap_or(30))),
        })
        .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?;
        Ok(NativeHostDuplexProcess {
            process_id: owner.process_id(),
            stream_stderr: options.stream_stderr.unwrap_or(false),
            cancel: owner.cancellation(),
            input: owner.input(),
            output: owner.output(),
            owner: std::sync::Mutex::new(Some(owner)),
        })
    }
    #[cfg(not(windows))]
    {
        let _ = options;
        Err(invalid("contained duplex requires Windows"))
    }
}
fn invalid(message: &'static str) -> Error {
    Error::new(Status::GenericFailure, message)
}
