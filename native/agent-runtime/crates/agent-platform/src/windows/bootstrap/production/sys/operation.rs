mod support;

use std::io;
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use std::pin::Pin;
use std::ptr;
use std::time::Duration;

use windows_sys::Win32::Foundation::{
    ERROR_IO_INCOMPLETE, ERROR_IO_PENDING, ERROR_NOT_FOUND, HANDLE, WAIT_FAILED, WAIT_OBJECT_0,
    WAIT_TIMEOUT,
};
use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::Threading::WaitForSingleObject;

use super::super::WindowsBootstrapIoBuffer;
use support::{create_event, is_pipe_eof};
pub(in crate::windows::bootstrap::production) enum OperationPoll {
    Pending,
    Complete(u32),
    Failed(io::Error),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum OperationKind {
    Read,
    Write,
}

/// Keeps every address observed by the kernel stable until I/O completion.
pub(in crate::windows::bootstrap::production) struct RawOverlappedOperation {
    handle: Option<OwnedHandle>,
    event: OwnedHandle,
    overlapped: Pin<Box<OVERLAPPED>>,
    buffer: Option<WindowsBootstrapIoBuffer>,
    pending: bool,
    immediate: Option<Result<u32, io::Error>>,
    kind: OperationKind,
}

impl RawOverlappedOperation {
    pub(in crate::windows::bootstrap::production) fn start_read(
        handle: OwnedHandle,
        buffer: WindowsBootstrapIoBuffer,
    ) -> Result<Self, (OwnedHandle, io::Error)> {
        Self::start(handle, buffer, OperationKind::Read)
    }

    pub(in crate::windows::bootstrap::production) fn start_write(
        handle: OwnedHandle,
        buffer: WindowsBootstrapIoBuffer,
    ) -> Result<Self, (OwnedHandle, io::Error)> {
        Self::start(handle, buffer, OperationKind::Write)
    }

    fn start(
        handle: OwnedHandle,
        mut buffer: WindowsBootstrapIoBuffer,
        kind: OperationKind,
    ) -> Result<Self, (OwnedHandle, io::Error)> {
        let event = match create_event() {
            Ok(event) => event,
            Err(error) => {
                buffer.scrub();
                return Err((handle, error));
            }
        };
        let mut overlapped = Box::pin(OVERLAPPED::default());
        // SAFETY: the pinned allocation has not been submitted yet. Its event
        // handle remains owned by this operation for the complete kernel use.
        unsafe {
            Pin::as_mut(&mut overlapped).get_unchecked_mut().hEvent = event.as_raw_handle();
        }
        let Ok(length) = u32::try_from(buffer.bytes().len()) else {
            buffer.scrub();
            return Err((
                handle,
                io::Error::new(io::ErrorKind::InvalidInput, "bootstrap buffer exceeds u32"),
            ));
        };
        // SAFETY: handle, pinned OVERLAPPED, event and boxed buffer remain
        // owned by the operation until completion is observed. Windows
        // requires the byte-count pointer to be null for overlapped handles;
        // `GetOverlappedResult` is the sole transfer-count authority.
        let succeeded = unsafe {
            match kind {
                OperationKind::Read => ReadFile(
                    handle.as_raw_handle(),
                    buffer.bytes_mut().as_mut_ptr(),
                    length,
                    ptr::null_mut(),
                    Pin::as_mut(&mut overlapped).get_unchecked_mut(),
                ),
                OperationKind::Write => WriteFile(
                    handle.as_raw_handle(),
                    buffer.bytes().as_ptr(),
                    length,
                    ptr::null_mut(),
                    Pin::as_mut(&mut overlapped).get_unchecked_mut(),
                ),
            }
        };
        let (pending, immediate) = if succeeded != 0 {
            // Even immediate success is consumed through GetOverlappedResult,
            // so no stack byte-count can become completion evidence.
            (true, None)
        } else {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_IO_PENDING.cast_signed()) {
                (true, None)
            } else if kind == OperationKind::Read && is_pipe_eof(&error) {
                (false, Some(Ok(0)))
            } else {
                buffer.scrub();
                return Err((handle, error));
            }
        };
        Ok(Self {
            handle: Some(handle),
            event,
            overlapped,
            buffer: Some(buffer),
            pending,
            immediate,
            kind,
        })
    }

    pub(in crate::windows::bootstrap::production) fn poll(&mut self) -> OperationPoll {
        if let Some(result) = self.immediate.take() {
            return match result {
                Ok(transferred) => OperationPoll::Complete(transferred),
                Err(error) => OperationPoll::Failed(error),
            };
        }
        if !self.pending {
            return OperationPoll::Failed(io::Error::other(
                "bootstrap operation completion was already consumed",
            ));
        }
        let mut transferred = 0_u32;
        // SAFETY: the handle and pinned OVERLAPPED remain owned and live.
        if unsafe {
            GetOverlappedResult(
                self.raw_handle(),
                self.overlapped.as_ref().get_ref(),
                ptr::from_mut(&mut transferred),
                0,
            )
        } != 0
        {
            self.pending = false;
            return OperationPoll::Complete(transferred);
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(ERROR_IO_INCOMPLETE.cast_signed()) {
            OperationPoll::Pending
        } else if self.kind == OperationKind::Read && is_pipe_eof(&error) {
            self.pending = false;
            OperationPoll::Complete(0)
        } else {
            self.pending = false;
            OperationPoll::Failed(error)
        }
    }

    pub(in crate::windows::bootstrap::production) fn wait_event(
        &self,
        duration: Duration,
    ) -> io::Result<()> {
        let millis = u32::try_from(duration.as_millis()).unwrap_or(u32::MAX - 1);
        // SAFETY: the event handle remains owned for the wait.
        match unsafe { WaitForSingleObject(self.event.as_raw_handle(), millis) } {
            WAIT_OBJECT_0 | WAIT_TIMEOUT => Ok(()),
            WAIT_FAILED => Err(io::Error::last_os_error()),
            state => Err(io::Error::other(format!(
                "unexpected bootstrap event wait state {state:#x}"
            ))),
        }
    }

    pub(in crate::windows::bootstrap::production) fn request_cancel(&mut self) -> io::Result<()> {
        if !self.pending {
            return Ok(());
        }
        // SAFETY: the exact submitted OVERLAPPED and its handle remain live.
        if unsafe { CancelIoEx(self.raw_handle(), self.overlapped.as_ref().get_ref()) } != 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(ERROR_NOT_FOUND.cast_signed()) {
            Ok(())
        } else {
            Err(error)
        }
    }

    pub(in crate::windows::bootstrap::production) fn into_parts(
        mut self,
    ) -> (OwnedHandle, WindowsBootstrapIoBuffer) {
        debug_assert!(!self.pending, "cannot release a pending OVERLAPPED");
        let handle = self.handle.take().expect("operation owns its handle");
        let buffer = self.buffer.take().expect("operation owns its buffer");
        (handle, buffer)
    }

    fn raw_handle(&self) -> HANDLE {
        self.handle
            .as_ref()
            .expect("operation owns its handle")
            .as_raw_handle()
    }

    pub(in crate::windows::bootstrap::production) fn scrub_buffer(&mut self) {
        if let Some(buffer) = &mut self.buffer {
            buffer.scrub();
        }
    }
}

impl Drop for RawOverlappedOperation {
    fn drop(&mut self) {
        if self.pending {
            let _ = self.request_cancel();
            if matches!(self.poll(), OperationPoll::Pending) {
                // Freeing the pinned OVERLAPPED or buffer would be a UAF, and
                // blocking Drop can wedge the supervisor forever. A leaked
                // pending owner is therefore a process-fatal invariant.
                std::process::abort();
            }
        }
        self.scrub_buffer();
    }
}
