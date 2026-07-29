mod error;

use std::fmt::{self, Debug, Formatter};
use std::os::windows::io::OwnedHandle;
use std::time::{Duration, Instant};

use crate::ipc::EndpointCancellation;

pub use error::{
    WindowsBootstrapCleanupFailure, WindowsBootstrapIoError, WindowsBootstrapIoFailure,
    WindowsBootstrapIoStartFailure,
};

use super::WindowsBootstrapIoBuffer;
use super::sys::{OperationPoll, RawOverlappedOperation};

const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(10);

/// Overlapped supervisor read half for the child's Ready response.
pub struct ProductionWindowsBootstrapReader(OwnedHandle);

impl Debug for ProductionWindowsBootstrapReader {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("ProductionWindowsBootstrapReader")
            .finish_non_exhaustive()
    }
}

impl ProductionWindowsBootstrapReader {
    pub(super) const fn new(handle: OwnedHandle) -> Self {
        Self(handle)
    }

    /// Starts one overlapped read while moving the handle and buffer into a
    /// pinned operation owner.
    ///
    /// # Errors
    ///
    /// Returns the untouched reader if the size is zero, exceeds `u32`, or the
    /// OS rejects operation setup before any I/O becomes pending.
    pub fn start_read(
        self,
        maximum_bytes: usize,
    ) -> Result<WindowsBootstrapPendingRead, WindowsBootstrapIoStartFailure<Self>> {
        if maximum_bytes == 0 || u32::try_from(maximum_bytes).is_err() {
            return Err(WindowsBootstrapIoStartFailure {
                owner: self,
                error: WindowsBootstrapIoError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "bootstrap read size must fit non-zero u32",
                )),
            });
        }
        let Self(handle) = self;
        let buffer = WindowsBootstrapIoBuffer::new(vec![0_u8; maximum_bytes].into_boxed_slice());
        RawOverlappedOperation::start_read(handle, buffer)
            .map(|operation| WindowsBootstrapPendingRead { operation })
            .map_err(|(handle, error)| WindowsBootstrapIoStartFailure {
                owner: Self(handle),
                error: WindowsBootstrapIoError::Io(error),
            })
    }
}

/// Overlapped supervisor write half for the launch handoff.
pub struct ProductionWindowsBootstrapWriter(OwnedHandle);

impl Debug for ProductionWindowsBootstrapWriter {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("ProductionWindowsBootstrapWriter")
            .finish_non_exhaustive()
    }
}

impl ProductionWindowsBootstrapWriter {
    pub(super) const fn new(handle: OwnedHandle) -> Self {
        Self(handle)
    }

    /// Starts one overlapped write while transferring the payload into the
    /// pending owner.
    ///
    /// # Errors
    ///
    /// Returns the untouched writer if the payload is empty, exceeds `u32`, or
    /// the OS rejects operation setup before any I/O becomes pending.
    pub fn start_write(
        self,
        mut bytes: Box<[u8]>,
    ) -> Result<WindowsBootstrapPendingWrite, WindowsBootstrapIoStartFailure<Self>> {
        if bytes.is_empty() || u32::try_from(bytes.len()).is_err() {
            bytes.fill(0);
            return Err(WindowsBootstrapIoStartFailure {
                owner: self,
                error: WindowsBootstrapIoError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "bootstrap write size must fit non-zero u32",
                )),
            });
        }
        let Self(handle) = self;
        RawOverlappedOperation::start_write(handle, WindowsBootstrapIoBuffer::new(bytes))
            .map(|operation| WindowsBootstrapPendingWrite { operation })
            .map_err(|(handle, error)| WindowsBootstrapIoStartFailure {
                owner: Self(handle),
                error: WindowsBootstrapIoError::Io(error),
            })
    }
}

/// Linear owner of one submitted Ready read.
#[derive(Debug)]
#[must_use = "pending Windows I/O must be completed or transferred to cleanup"]
pub struct WindowsBootstrapPendingRead {
    operation: RawOverlappedOperation,
}

impl WindowsBootstrapPendingRead {
    /// Waits without a helper thread and preserves cleanup ownership on every
    /// timeout, cancellation or wait failure.
    ///
    /// # Errors
    ///
    /// Returns a clean channel owner after a completed I/O error, or the
    /// complete pending cleanup owner after timeout, cancellation or wait
    /// failure.
    pub fn wait_until(
        mut self,
        deadline: Instant,
        cancellation: &EndpointCancellation,
    ) -> Result<
        WindowsBootstrapReadCompletion,
        WindowsBootstrapIoFailure<ProductionWindowsBootstrapReader>,
    > {
        loop {
            if cancellation.is_cancelled() {
                return Err(owned_read_failure(self, WindowsBootstrapIoError::Cancelled));
            }
            if Instant::now() >= deadline {
                return Err(owned_read_failure(
                    self,
                    WindowsBootstrapIoError::DeadlineElapsed,
                ));
            }
            match self.operation.poll() {
                OperationPoll::Complete(transferred) => {
                    let (handle, buffer) = self.operation.into_parts();
                    return Ok(WindowsBootstrapReadCompletion {
                        reader: ProductionWindowsBootstrapReader(handle),
                        buffer,
                        transferred: transferred as usize,
                    });
                }
                OperationPoll::Failed(error) => {
                    let (handle, _) = self.operation.into_parts();
                    return Err(WindowsBootstrapIoFailure::Clean {
                        owner: ProductionWindowsBootstrapReader(handle),
                        error: WindowsBootstrapIoError::Io(error),
                    });
                }
                OperationPoll::Pending => {}
            }
            if let Err(error) = self.operation.wait_event(wait_slice(deadline)) {
                return Err(owned_read_failure(self, WindowsBootstrapIoError::Io(error)));
            }
        }
    }

    pub fn cancel(self) -> WindowsBootstrapCleanup {
        WindowsBootstrapCleanup::new(self.operation)
    }
}

/// Linear owner of one submitted handoff write.
#[derive(Debug)]
#[must_use = "pending Windows I/O must be completed or transferred to cleanup"]
pub struct WindowsBootstrapPendingWrite {
    operation: RawOverlappedOperation,
}

impl WindowsBootstrapPendingWrite {
    /// Waits with the same monotonic deadline and cancellation observer used by
    /// the complete bootstrap attempt.
    ///
    /// # Errors
    ///
    /// Returns a clean channel owner after a completed I/O error, or the
    /// complete pending cleanup owner after timeout, cancellation or wait
    /// failure.
    pub fn wait_until(
        mut self,
        deadline: Instant,
        cancellation: &EndpointCancellation,
    ) -> Result<
        WindowsBootstrapWriteCompletion,
        WindowsBootstrapIoFailure<ProductionWindowsBootstrapWriter>,
    > {
        loop {
            if cancellation.is_cancelled() {
                return Err(owned_write_failure(
                    self,
                    WindowsBootstrapIoError::Cancelled,
                ));
            }
            if Instant::now() >= deadline {
                return Err(owned_write_failure(
                    self,
                    WindowsBootstrapIoError::DeadlineElapsed,
                ));
            }
            match self.operation.poll() {
                OperationPoll::Complete(transferred) => {
                    let (handle, buffer) = self.operation.into_parts();
                    return Ok(WindowsBootstrapWriteCompletion {
                        writer: ProductionWindowsBootstrapWriter(handle),
                        buffer,
                        transferred: transferred as usize,
                    });
                }
                OperationPoll::Failed(error) => {
                    let (handle, _) = self.operation.into_parts();
                    return Err(WindowsBootstrapIoFailure::Clean {
                        owner: ProductionWindowsBootstrapWriter(handle),
                        error: WindowsBootstrapIoError::Io(error),
                    });
                }
                OperationPoll::Pending => {}
            }
            if let Err(error) = self.operation.wait_event(wait_slice(deadline)) {
                return Err(owned_write_failure(
                    self,
                    WindowsBootstrapIoError::Io(error),
                ));
            }
        }
    }

    pub fn cancel(self) -> WindowsBootstrapCleanup {
        WindowsBootstrapCleanup::new(self.operation)
    }
}

include!("io/types.rs");
