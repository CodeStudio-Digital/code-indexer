use napi::bindgen_prelude::Buffer;
use napi::{Error, Result, Status};
use napi_derive::napi;
use std::collections::HashMap;

#[napi(object)]
pub struct NativeHostCommandOptions {
    pub executable: String,
    pub arguments: Vec<String>,
    pub cwd: String,
    pub environment: HashMap<String, String>,
    pub stdin: Buffer,
    pub timeout_ms: u32,
    pub maximum_output_bytes: u32,
}

#[napi(object)]
pub struct NativeHostCommandResult {
    pub stdout_head: Buffer,
    pub stdout_tail: Buffer,
    pub stdout_total_bytes: f64,
    pub stderr_head: Buffer,
    pub stderr_tail: Buffer,
    pub stderr_total_bytes: f64,
    pub process_id: u32,
    pub exit_code: u32,
    pub cancelled: bool,
    pub timed_out: bool,
    pub reaped: bool,
}

impl std::fmt::Debug for NativeHostCommandOptions {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NativeHostCommandOptions")
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for NativeHostCommandResult {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NativeHostCommandResult")
            .field("reaped", &self.reaped)
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
#[napi]
pub struct NativeHostCommand {
    #[cfg(windows)]
    owner: std::sync::Mutex<Option<agent_host_bridge::command::HostCommand>>,
    #[cfg(windows)]
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    process_id: u32,
}

#[napi]
impl NativeHostCommand {
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

    /// Settles only after the command and every descendant are reaped.
    /// # Errors
    /// Rejects duplicate waits, poisoned ownership or failed physical cleanup.
    #[napi]
    pub async fn wait(&self) -> Result<NativeHostCommandResult> {
        #[cfg(windows)]
        {
            let owner = self
                .owner
                .lock()
                .map_err(|_| invalid("Host command lock poisoned"))?
                .take()
                .ok_or_else(|| invalid("Host command already awaited"))?;
            let result = tokio::task::spawn_blocking(move || owner.wait())
                .await
                .map_err(|_| invalid("Host command wait failed"))?
                .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?;
            // Byte counts are bounded below Number.MAX_SAFE_INTEGER by the
            // ten-minute deadline and physical IO bandwidth.
            #[allow(clippy::cast_precision_loss)]
            Ok(NativeHostCommandResult {
                stdout_head: result.stdout.head.into(),
                stdout_tail: result.stdout.tail.into(),
                stdout_total_bytes: result.stdout.total_bytes as f64,
                stderr_head: result.stderr.head.into(),
                stderr_tail: result.stderr.tail.into(),
                stderr_total_bytes: result.stderr.total_bytes as f64,
                process_id: result.process_id,
                exit_code: result.exit_code,
                cancelled: result.cancelled,
                timed_out: result.timed_out,
                reaped: result.reaped,
            })
        }
        #[cfg(not(windows))]
        Err(invalid("contained Host command requires Windows"))
    }
}

impl Drop for NativeHostCommand {
    fn drop(&mut self) {
        self.cancel();
    }
}

/// The synchronous spawn is the Host policy's physical effect boundary.
/// # Errors
/// Unsupported platforms, invalid bounds and uncontained spawns fail closed.
#[napi]
pub fn start_native_host_command(options: NativeHostCommandOptions) -> Result<NativeHostCommand> {
    #[cfg(windows)]
    {
        use agent_host_bridge::command::{HostCommand, HostCommandSpec};
        let owner = HostCommand::start(HostCommandSpec {
            executable: options.executable.into(),
            arguments: options.arguments.into_iter().map(Into::into).collect(),
            cwd: options.cwd.into(),
            environment: options
                .environment
                .into_iter()
                .map(|(key, value)| (key.into(), value.into()))
                .collect(),
            stdin: options.stdin.to_vec(),
            timeout_ms: options.timeout_ms,
            maximum_output_bytes: options.maximum_output_bytes,
        })
        .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?;
        Ok(NativeHostCommand {
            process_id: owner.process_id(),
            cancel: owner.cancellation(),
            owner: std::sync::Mutex::new(Some(owner)),
        })
    }
    #[cfg(not(windows))]
    {
        let _ = options;
        Err(invalid("contained Host command requires Windows"))
    }
}

fn invalid(message: &'static str) -> Error {
    Error::new(Status::GenericFailure, message)
}
