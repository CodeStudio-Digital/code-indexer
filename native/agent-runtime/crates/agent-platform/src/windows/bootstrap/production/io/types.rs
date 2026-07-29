/// Completed overlapped read and its reusable reader.
#[derive(Debug)]
pub struct WindowsBootstrapReadCompletion {
    reader: ProductionWindowsBootstrapReader,
    buffer: WindowsBootstrapIoBuffer,
    transferred: usize,
}

impl WindowsBootstrapReadCompletion {
    #[must_use]
    pub fn bytes(&self) -> &[u8] {
        &self.buffer.bytes()[..self.transferred]
    }

    #[must_use]
    pub fn into_parts(
        self,
    ) -> (
        ProductionWindowsBootstrapReader,
        WindowsBootstrapIoBuffer,
        usize,
    ) {
        (self.reader, self.buffer, self.transferred)
    }
}

/// Completed overlapped write and its reusable writer.
#[derive(Debug)]
pub struct WindowsBootstrapWriteCompletion {
    writer: ProductionWindowsBootstrapWriter,
    buffer: WindowsBootstrapIoBuffer,
    transferred: usize,
}

impl WindowsBootstrapWriteCompletion {
    #[must_use]
    pub const fn transferred(&self) -> usize {
        self.transferred
    }

    #[must_use]
    pub fn into_parts(
        self,
    ) -> (
        ProductionWindowsBootstrapWriter,
        WindowsBootstrapIoBuffer,
        usize,
    ) {
        (self.writer, self.buffer, self.transferred)
    }
}

/// Reaper-owned pending operation. It retains the pipe, pinned `OVERLAPPED`,
/// event and buffer until the kernel proves completion or cancellation.
#[derive(Debug)]
#[must_use = "cleanup ownership must be retried until reaped"]
pub struct WindowsBootstrapCleanup {
    operation: RawOverlappedOperation,
    cancel_error: Option<std::io::Error>,
}

impl WindowsBootstrapCleanup {
    fn new(mut operation: RawOverlappedOperation) -> Self {
        let cancel_error = operation.request_cancel().err();
        Self {
            operation,
            cancel_error,
        }
    }

    /// Polls cancellation completion without blocking or spawning a worker.
    ///
    /// # Errors
    ///
    /// Returns the same owner when the kernel still reports pending I/O or a
    /// cancellation request failed before completion could be proven.
    pub fn try_reap(mut self) -> Result<(), WindowsBootstrapCleanupFailure> {
        let retry_error = self.operation.request_cancel().err();
        match self.operation.poll() {
            OperationPoll::Complete(_) | OperationPoll::Failed(_) => {
                self.operation.scrub_buffer();
                Ok(())
            }
            OperationPoll::Pending => {
                let error = retry_error
                    .or_else(|| self.cancel_error.take())
                    .map_or(WindowsBootstrapIoError::CleanupPending, WindowsBootstrapIoError::Io);
                Err(WindowsBootstrapCleanupFailure { owner: self, error })
            }
        }
    }
}

fn owned_read_failure(
    pending: WindowsBootstrapPendingRead,
    error: WindowsBootstrapIoError,
) -> WindowsBootstrapIoFailure<ProductionWindowsBootstrapReader> {
    WindowsBootstrapIoFailure::Owned {
        owner: pending.cancel(),
        error,
    }
}

fn owned_write_failure(
    pending: WindowsBootstrapPendingWrite,
    error: WindowsBootstrapIoError,
) -> WindowsBootstrapIoFailure<ProductionWindowsBootstrapWriter> {
    WindowsBootstrapIoFailure::Owned {
        owner: pending.cancel(),
        error,
    }
}

fn wait_slice(deadline: Instant) -> Duration {
    deadline
        .saturating_duration_since(Instant::now())
        .min(CANCEL_POLL_INTERVAL)
}
