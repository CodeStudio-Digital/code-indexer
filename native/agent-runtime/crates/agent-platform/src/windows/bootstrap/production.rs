//! Production Windows bootstrap backed by private one-shot Named Pipes.
//!
//! This path is deliberately separate from the synchronous `CreatePipe` probe.
//! Pipe names exist only while both endpoints are opened in this process; the
//! child receives synchronous handles exclusively through `HANDLE_LIST`.

mod io;
#[allow(unsafe_code)]
mod sys;

use std::fmt::{self, Debug, Formatter};
use std::io as std_io;

use zeroize::Zeroize;

use super::{WindowsBootstrapChildStdio, sys as probe_sys};

pub use io::{
    ProductionWindowsBootstrapReader, ProductionWindowsBootstrapWriter, WindowsBootstrapCleanup,
    WindowsBootstrapCleanupFailure, WindowsBootstrapIoError, WindowsBootstrapIoFailure,
    WindowsBootstrapIoStartFailure, WindowsBootstrapPendingRead, WindowsBootstrapPendingWrite,
    WindowsBootstrapReadCompletion, WindowsBootstrapWriteCompletion,
};

const PIPE_BUFFER_BYTES: u32 = 64 * 1024;

/// Non-cloneable bootstrap buffer that scrubs its allocation before release.
pub struct WindowsBootstrapIoBuffer(Box<[u8]>);

impl WindowsBootstrapIoBuffer {
    const fn new(bytes: Box<[u8]>) -> Self {
        Self(bytes)
    }

    #[must_use]
    pub fn bytes(&self) -> &[u8] {
        &self.0
    }

    pub(super) fn bytes_mut(&mut self) -> &mut [u8] {
        &mut self.0
    }

    pub(super) fn scrub(&mut self) {
        self.0.zeroize();
    }
}

impl Debug for WindowsBootstrapIoBuffer {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WindowsBootstrapIoBuffer")
            .field("length", &self.0.len())
            .finish_non_exhaustive()
    }
}

impl Drop for WindowsBootstrapIoBuffer {
    fn drop(&mut self) {
        self.scrub();
    }
}

/// Owns both production bootstrap directions before a contained spawn.
pub struct PreparedProductionWindowsBootstrap {
    parent: ProductionWindowsBootstrapParent,
    child_stdio: WindowsBootstrapChildStdio,
}

impl Debug for PreparedProductionWindowsBootstrap {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PreparedProductionWindowsBootstrap")
            .finish_non_exhaustive()
    }
}

impl PreparedProductionWindowsBootstrap {
    /// Separates the overlapped supervisor channel from synchronous child
    /// handles. The child owner can only enter a spawn through its allowlist.
    #[must_use]
    pub fn into_parts(self) -> (ProductionWindowsBootstrapParent, WindowsBootstrapChildStdio) {
        (self.parent, self.child_stdio)
    }
}

/// Supervisor-owned production bootstrap channel.
///
/// Both handles were created with `FILE_FLAG_OVERLAPPED`. The type is linear
/// and never exposes the ephemeral Named Pipe paths.
pub struct ProductionWindowsBootstrapParent {
    from_child: ProductionWindowsBootstrapReader,
    to_child: ProductionWindowsBootstrapWriter,
}

impl Debug for ProductionWindowsBootstrapParent {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProductionWindowsBootstrapParent")
            .finish_non_exhaustive()
    }
}

impl ProductionWindowsBootstrapParent {
    /// Separates the response reader from the handoff writer.
    #[must_use]
    pub fn into_parts(
        self,
    ) -> (
        ProductionWindowsBootstrapReader,
        ProductionWindowsBootstrapWriter,
    ) {
        (self.from_child, self.to_child)
    }
}

/// Creates two private Named Pipe pairs and an inheritable NUL stderr handle.
///
/// Each server is single-instance, rejects remote clients and uses a logon-SID
/// DACL. Server ends are overlapped and non-inheritable. Synchronous child
/// clients are opened before this function returns and no pipe name escapes.
///
/// # Errors
///
/// Returns an error if random-name generation, ACL construction, Named Pipe
/// creation, child-client opening or NUL setup fails. Already-created handles
/// are revoked by linear rollback.
pub fn prepare_production_windows_bootstrap() -> std_io::Result<PreparedProductionWindowsBootstrap>
{
    let request = sys::create_private_pair(sys::ParentDirection::Writes, PIPE_BUFFER_BYTES)?;
    let response = sys::create_private_pair(sys::ParentDirection::Reads, PIPE_BUFFER_BYTES)?;
    let child_stderr = probe_sys::inheritable_null_writer()?;

    Ok(PreparedProductionWindowsBootstrap {
        parent: ProductionWindowsBootstrapParent {
            from_child: ProductionWindowsBootstrapReader::new(response.parent),
            to_child: ProductionWindowsBootstrapWriter::new(request.parent),
        },
        child_stdio: WindowsBootstrapChildStdio {
            stdin: request.child,
            stdout: response.child,
            stderr: child_stderr,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::WindowsBootstrapIoBuffer;

    #[test]
    fn bootstrap_buffer_redacts_and_scrubs_with_one_primitive() {
        let mut buffer = WindowsBootstrapIoBuffer::new(
            b"launch-token-must-not-survive-cleanup"
                .to_vec()
                .into_boxed_slice(),
        );
        let rendered = format!("{buffer:?}");
        assert!(!rendered.contains("launch-token"));
        buffer.scrub();
        assert!(buffer.bytes().iter().all(|byte| *byte == 0));
    }
}
