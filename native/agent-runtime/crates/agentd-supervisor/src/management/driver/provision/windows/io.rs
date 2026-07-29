use std::cell::RefCell;
use std::io::{self, Read, Write};
use std::time::Instant;

use agent_platform::ipc::EndpointCancellation;
use agent_platform::windows::bootstrap::{
    ProductionWindowsBootstrapReader, ProductionWindowsBootstrapWriter, WindowsBootstrapCleanup,
    WindowsBootstrapIoError, WindowsBootstrapIoFailure,
};

pub(super) struct OverlappedBootstrapReader<'a> {
    owner: Option<ProductionWindowsBootstrapReader>,
    deadline: Instant,
    cancellation: &'a EndpointCancellation,
    cleanups: &'a RefCell<Vec<WindowsBootstrapCleanup>>,
}

pub(super) struct OverlappedBootstrapWriter<'a> {
    owner: Option<ProductionWindowsBootstrapWriter>,
    deadline: Instant,
    cancellation: &'a EndpointCancellation,
    cleanups: &'a RefCell<Vec<WindowsBootstrapCleanup>>,
}

impl<'a> OverlappedBootstrapReader<'a> {
    pub(super) const fn new(
        owner: ProductionWindowsBootstrapReader,
        deadline: Instant,
        cancellation: &'a EndpointCancellation,
        cleanups: &'a RefCell<Vec<WindowsBootstrapCleanup>>,
    ) -> Self {
        Self {
            owner: Some(owner),
            deadline,
            cancellation,
            cleanups,
        }
    }
}

impl<'a> OverlappedBootstrapWriter<'a> {
    pub(super) const fn new(
        owner: ProductionWindowsBootstrapWriter,
        deadline: Instant,
        cancellation: &'a EndpointCancellation,
        cleanups: &'a RefCell<Vec<WindowsBootstrapCleanup>>,
    ) -> Self {
        Self {
            owner: Some(owner),
            deadline,
            cancellation,
            cleanups,
        }
    }
}

impl Read for OverlappedBootstrapReader<'_> {
    fn read(&mut self, target: &mut [u8]) -> io::Result<usize> {
        if target.is_empty() {
            return Ok(0);
        }
        let owner = self
            .owner
            .take()
            .ok_or_else(|| io::Error::other("bootstrap reader ownership was consumed"))?;
        let pending = match owner.start_read(target.len()) {
            Ok(value) => value,
            Err(failure) => {
                self.owner = Some(failure.owner);
                return Err(into_io_error(failure.error));
            }
        };
        match pending.wait_until(self.deadline, self.cancellation) {
            Ok(completion) => {
                let bytes = completion.bytes();
                if bytes.len() > target.len() {
                    return Err(io::Error::other("bootstrap read exceeded requested bytes"));
                }
                target[..bytes.len()].copy_from_slice(bytes);
                let transferred = bytes.len();
                let (owner, buffer, _) = completion.into_parts();
                self.owner = Some(owner);
                drop(buffer);
                Ok(transferred)
            }
            Err(WindowsBootstrapIoFailure::Clean { owner, error }) => {
                self.owner = Some(owner);
                Err(into_io_error(error))
            }
            Err(WindowsBootstrapIoFailure::Owned { owner, error }) => {
                self.cleanups.borrow_mut().push(owner);
                Err(into_io_error(error))
            }
        }
    }
}

impl Write for OverlappedBootstrapWriter<'_> {
    fn write(&mut self, source: &[u8]) -> io::Result<usize> {
        if source.is_empty() {
            return Ok(0);
        }
        let owner = self
            .owner
            .take()
            .ok_or_else(|| io::Error::other("bootstrap writer ownership was consumed"))?;
        let pending = match owner.start_write(source.to_vec().into_boxed_slice()) {
            Ok(value) => value,
            Err(failure) => {
                self.owner = Some(failure.owner);
                return Err(into_io_error(failure.error));
            }
        };
        match pending.wait_until(self.deadline, self.cancellation) {
            Ok(completion) => {
                let transferred = completion.transferred();
                let (owner, buffer, _) = completion.into_parts();
                self.owner = Some(owner);
                drop(buffer);
                if transferred > source.len() {
                    return Err(io::Error::other("bootstrap write exceeded supplied bytes"));
                }
                Ok(transferred)
            }
            Err(WindowsBootstrapIoFailure::Clean { owner, error }) => {
                self.owner = Some(owner);
                Err(into_io_error(error))
            }
            Err(WindowsBootstrapIoFailure::Owned { owner, error }) => {
                self.cleanups.borrow_mut().push(owner);
                Err(into_io_error(error))
            }
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        self.owner
            .as_ref()
            .map(|_| ())
            .ok_or_else(|| io::Error::other("bootstrap writer ownership was consumed"))
    }
}

fn into_io_error(error: WindowsBootstrapIoError) -> io::Error {
    match error {
        WindowsBootstrapIoError::Cancelled => {
            io::Error::new(io::ErrorKind::Interrupted, "bootstrap cancelled")
        }
        WindowsBootstrapIoError::DeadlineElapsed => {
            io::Error::new(io::ErrorKind::TimedOut, "bootstrap deadline elapsed")
        }
        WindowsBootstrapIoError::CleanupPending => {
            io::Error::new(io::ErrorKind::WouldBlock, "bootstrap cleanup pending")
        }
        WindowsBootstrapIoError::Io(source) => source,
    }
}
