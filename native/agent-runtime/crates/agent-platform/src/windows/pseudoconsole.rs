//! Owned `ConPTY` launch authority. No pseudo-console handle crosses the Host ABI.
#[allow(unsafe_code)]
mod sys;

use std::fs::File;
use std::io;
use std::os::windows::io::OwnedHandle;
use std::sync::Arc;

use super::bootstrap::WindowsCommandStreams;

pub(crate) const fn creation_flags(terminal: bool) -> u32 {
    use windows_sys::Win32::System::Threading::{
        CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
        EXTENDED_STARTUPINFO_PRESENT,
    };
    CREATE_SUSPENDED
        | CREATE_UNICODE_ENVIRONMENT
        | EXTENDED_STARTUPINFO_PRESENT
        | if terminal { 0 } else { CREATE_NO_WINDOW }
}

#[derive(Debug)]
struct ConsoleOwner(isize);
impl Drop for ConsoleOwner {
    fn drop(&mut self) {
        sys::close(self.0);
    }
}

/// Retains the console while one child is created and proven inside its Job.
#[derive(Debug)]
pub struct WindowsPseudoConsoleChild {
    owner: Arc<ConsoleOwner>,
    endpoints: Option<(OwnedHandle, OwnedHandle)>,
}
impl WindowsPseudoConsoleChild {
    pub(crate) fn raw(&self) -> isize {
        self.owner.0
    }
}
impl Drop for WindowsPseudoConsoleChild {
    fn drop(&mut self) {
        drop(self.endpoints.take());
    }
}

/// Close on a worker while draining output, or after closing the output reader.
///
/// `ClosePseudoConsole` can flush a final frame; closing it on the reader thread
/// would deadlock older Windows versions when the pipe is full.
#[derive(Debug)]
pub struct WindowsPseudoConsole {
    owner: Arc<ConsoleOwner>,
    endpoints: Option<(OwnedHandle, OwnedHandle)>,
}
impl WindowsPseudoConsole {
    /// Transfers the creation endpoints to one contained launch.
    /// # Errors
    /// Rejects a second launch using the same console.
    pub fn child(&mut self) -> io::Result<WindowsPseudoConsoleChild> {
        let endpoints = self.endpoints.take().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "console launch already claimed",
            )
        })?;
        Ok(WindowsPseudoConsoleChild {
            owner: Arc::clone(&self.owner),
            endpoints: Some(endpoints),
        })
    }
}
impl Drop for WindowsPseudoConsole {
    fn drop(&mut self) {
        drop(self.endpoints.take());
    }
}

/// Creates UTF-8/VT input and output pipes. stderr shares the console screen;
/// the empty NUL reader preserves the common duplex IO lifecycle.
/// # Errors
/// Rejects out-of-bound geometry and failed OS creation without launching a child.
pub fn prepare_windows_pseudoconsole(
    columns: u16,
    rows: u16,
) -> io::Result<(WindowsCommandStreams, WindowsPseudoConsole)> {
    if columns == 0 || rows == 0 || columns > 500 || rows > 300 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "pseudo-console geometry",
        ));
    }
    let stderr = File::open("NUL")?;
    let (input_read, input_write) = sys::pipe()?;
    let (output_read, output_write) = sys::pipe()?;
    let owner = Arc::new(ConsoleOwner(sys::create(
        columns,
        rows,
        &input_read,
        &output_write,
    )?));
    // Keep creation endpoints through CreateProcess; the child authority drops
    // them after the suspended launch is proven in its Job and resumed.
    let console = WindowsPseudoConsole {
        owner,
        endpoints: Some((input_read, output_write)),
    };
    Ok((
        WindowsCommandStreams {
            stdin: File::from(input_write),
            stdout: File::from(output_read),
            stderr,
        },
        console,
    ))
}
