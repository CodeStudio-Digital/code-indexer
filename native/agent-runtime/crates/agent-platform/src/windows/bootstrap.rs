//! One-shot Windows runner bootstrap over inherited standard handles.
//!
//! The supervisor owns one anonymous-pipe reader and writer. The child sides
//! are installed atomically as stdin/stdout, while stderr is an inherited NUL
//! handle so diagnostics can never corrupt the binary stdout channel.

use std::fmt::{self, Debug, Formatter};
use std::io;
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use std::sync::atomic::{AtomicBool, Ordering};

use windows_sys::Win32::Foundation::HANDLE;

mod production;
mod stream;
#[allow(unsafe_code)]
mod sys;

pub use production::{
    PreparedProductionWindowsBootstrap, ProductionWindowsBootstrapParent,
    ProductionWindowsBootstrapReader, ProductionWindowsBootstrapWriter, WindowsBootstrapCleanup,
    WindowsBootstrapCleanupFailure, WindowsBootstrapIoBuffer, WindowsBootstrapIoError,
    WindowsBootstrapIoFailure, WindowsBootstrapIoStartFailure, WindowsBootstrapPendingRead,
    WindowsBootstrapPendingWrite, WindowsBootstrapReadCompletion, WindowsBootstrapWriteCompletion,
    prepare_production_windows_bootstrap,
};
pub use stream::{
    WindowsBootstrapChild, WindowsBootstrapParent, WindowsBootstrapReader, WindowsBootstrapWriter,
};

pub(crate) const WINDOWS_BOOTSTRAP_HANDLE_COUNT: usize = 3;

static CHILD_BOOTSTRAP_OPENED: AtomicBool = AtomicBool::new(false);

/// Owns both sides of a bootstrap before launch resources are separated.
pub struct PreparedWindowsBootstrap {
    parent: WindowsBootstrapParent,
    child_stdio: WindowsBootstrapChildStdio,
}

impl Debug for PreparedWindowsBootstrap {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PreparedWindowsBootstrap")
            .finish_non_exhaustive()
    }
}

impl PreparedWindowsBootstrap {
    /// Separates the supervisor channel from the child stdio authority.
    #[must_use]
    pub fn into_parts(self) -> (WindowsBootstrapParent, WindowsBootstrapChildStdio) {
        (self.parent, self.child_stdio)
    }
}

/// Child-side stdin/stdout/stderr authority consumed by one allowlisted spawn.
///
/// The fields remain opaque so callers cannot serialize handle values into
/// argv or env. Dropping this value before spawn revokes all three handles.
pub struct WindowsBootstrapChildStdio {
    stdin: OwnedHandle,
    stdout: OwnedHandle,
    stderr: OwnedHandle,
}

impl Debug for WindowsBootstrapChildStdio {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WindowsBootstrapChildStdio")
            .field("handle_count", &WINDOWS_BOOTSTRAP_HANDLE_COUNT)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy)]
pub(crate) struct RawBootstrapStdio {
    pub stdin: HANDLE,
    pub stdout: HANDLE,
    pub stderr: HANDLE,
}

impl WindowsBootstrapChildStdio {
    pub(crate) fn raw(&self) -> RawBootstrapStdio {
        RawBootstrapStdio {
            stdin: self.stdin.as_raw_handle(),
            stdout: self.stdout.as_raw_handle(),
            stderr: self.stderr.as_raw_handle(),
        }
    }

    pub(crate) fn raw_handles(&self) -> [HANDLE; WINDOWS_BOOTSTRAP_HANDLE_COUNT] {
        let raw = self.raw();
        [raw.stdin, raw.stdout, raw.stderr]
    }

    #[cfg(test)]
    pub(crate) fn raw_values(&self) -> [usize; WINDOWS_BOOTSTRAP_HANDLE_COUNT] {
        self.raw_handles().map(|handle| handle as usize)
    }
}

/// Creates two anonymous pipes and an inheritable NUL stderr handle.
///
/// # Errors
///
/// Returns the underlying Win32 error if any handle cannot be created or if a
/// supervisor-side pipe handle cannot be made non-inheritable.
pub fn prepare_windows_bootstrap() -> io::Result<PreparedWindowsBootstrap> {
    let (child_stdin, parent_writer) = sys::anonymous_pipe()?;
    let (parent_reader, child_stdout) = sys::anonymous_pipe()?;
    sys::clear_inherit(&parent_writer)?;
    sys::clear_inherit(&parent_reader)?;
    let child_stderr = sys::inheritable_null_writer()?;

    Ok(PreparedWindowsBootstrap {
        parent: WindowsBootstrapParent::new(parent_reader, parent_writer),
        child_stdio: WindowsBootstrapChildStdio {
            stdin: child_stdin,
            stdout: child_stdout,
            stderr: child_stderr,
        },
    })
}

/// Standard streams for an ordinary contained Host command. Unlike protocol
/// bootstrap, stderr is captured separately and stdin is closed after input.
#[derive(Debug)]
pub struct WindowsCommandStreams {
    pub stdin: std::fs::File,
    pub stdout: std::fs::File,
    pub stderr: std::fs::File,
}

/// Creates three anonymous pipes with only child endpoints inheritable.
/// # Errors
/// Returns an OS error without leaking any partially created handle.
pub fn prepare_windows_command_streams()
-> io::Result<(WindowsCommandStreams, WindowsBootstrapChildStdio)> {
    let (stdin, writer) = sys::anonymous_pipe()?;
    let (reader, stdout) = sys::anonymous_pipe()?;
    let (error_reader, stderr) = sys::anonymous_pipe()?;
    for handle in [&writer, &reader, &error_reader] {
        sys::clear_inherit(handle)?;
    }
    Ok((
        WindowsCommandStreams {
            stdin: writer.into(),
            stdout: reader.into(),
            stderr: error_reader.into(),
        },
        WindowsBootstrapChildStdio {
            stdin,
            stdout,
            stderr,
        },
    ))
}

/// Opens inherited bootstrap stdin/stdout once in the child process.
///
/// # Errors
///
/// Rejects a second open, unavailable standard handles, or standard handles
/// that are not anonymous/named pipes.
pub fn open_inherited_windows_bootstrap() -> io::Result<WindowsBootstrapChild> {
    if CHILD_BOOTSTRAP_OPENED.swap(true, Ordering::AcqRel) {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "Windows bootstrap standard handles were already opened",
        ));
    }
    let (from_parent, to_parent, creator_process_id) = sys::take_standard_pipes()?;
    Ok(WindowsBootstrapChild::new(
        from_parent,
        to_parent,
        creator_process_id,
    ))
}
