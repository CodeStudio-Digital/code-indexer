use std::fmt::{self, Debug, Formatter};
use std::fs::File;
use std::io::{self, Read, Write};
#[cfg(test)]
use std::os::windows::io::AsHandle;
use std::os::windows::io::OwnedHandle;

#[cfg(test)]
use super::sys;

/// Supervisor-owned duplex bootstrap channel.
///
/// `Write` sends bytes to child stdin and `Read` receives bytes from child
/// stdout. This owner is deliberately non-cloneable.
pub struct WindowsBootstrapParent {
    from_child: WindowsBootstrapReader,
    to_child: WindowsBootstrapWriter,
}

impl WindowsBootstrapParent {
    pub(super) fn new(from_child: OwnedHandle, to_child: OwnedHandle) -> Self {
        Self {
            from_child: WindowsBootstrapReader(File::from(from_child)),
            to_child: WindowsBootstrapWriter(File::from(to_child)),
        }
    }

    /// Separates response reading from request writing so either direction can
    /// be closed and proven independently.
    #[must_use]
    pub fn into_parts(self) -> (WindowsBootstrapReader, WindowsBootstrapWriter) {
        (self.from_child, self.to_child)
    }
}

impl Debug for WindowsBootstrapParent {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WindowsBootstrapParent")
            .finish_non_exhaustive()
    }
}

impl Read for WindowsBootstrapParent {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.from_child.read(buffer)
    }
}

impl Write for WindowsBootstrapParent {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.to_child.write(buffer)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.to_child.flush()
    }
}

/// Child-owned view of inherited bootstrap stdin/stdout.
pub struct WindowsBootstrapChild {
    from_parent: WindowsBootstrapReader,
    to_parent: WindowsBootstrapWriter,
    creator_process_id: u32,
}

impl WindowsBootstrapChild {
    pub(super) fn new(
        from_parent: OwnedHandle,
        to_parent: OwnedHandle,
        creator_process_id: u32,
    ) -> Self {
        Self {
            from_parent: WindowsBootstrapReader(File::from(from_parent)),
            to_parent: WindowsBootstrapWriter(File::from(to_parent)),
            creator_process_id,
        }
    }

    /// PID physically reported by both inherited anonymous pipes.
    #[must_use]
    pub const fn creator_process_id(&self) -> u32 {
        self.creator_process_id
    }

    /// Separates handoff reading from Ready writing so the writer can close and
    /// produce supervisor-observable EOF while the runner remains alive.
    #[must_use]
    pub fn into_parts(self) -> (WindowsBootstrapReader, WindowsBootstrapWriter) {
        (self.from_parent, self.to_parent)
    }
}

impl Debug for WindowsBootstrapChild {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WindowsBootstrapChild")
            .finish_non_exhaustive()
    }
}

impl Read for WindowsBootstrapChild {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.from_parent.read(buffer)
    }
}

impl Write for WindowsBootstrapChild {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.to_parent.write(buffer)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.to_parent.flush()
    }
}

/// Owned bootstrap read half.
pub struct WindowsBootstrapReader(File);

impl Debug for WindowsBootstrapReader {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("WindowsBootstrapReader")
            .finish_non_exhaustive()
    }
}

impl Read for WindowsBootstrapReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.0.read(buffer)
    }
}

impl WindowsBootstrapReader {
    #[cfg(test)]
    pub(crate) fn bytes_available(&self) -> io::Result<u32> {
        sys::pipe_bytes_available(self.0.as_handle())
    }
}

/// Owned bootstrap write half.
pub struct WindowsBootstrapWriter(File);

impl Debug for WindowsBootstrapWriter {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("WindowsBootstrapWriter")
            .finish_non_exhaustive()
    }
}

impl Write for WindowsBootstrapWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.0.write(buffer)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}
