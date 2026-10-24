use super::{DuplexChunk, DuplexWrite};
use std::io::{self, Read, Write};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::time::Duration;
use tokio::sync::mpsc as async_mpsc;

#[allow(
    clippy::needless_pass_by_value,
    reason = "worker owns IO endpoints and cancellation through physical cleanup"
)]
pub(super) fn input(
    mut stream: impl Write,
    requests: mpsc::Receiver<DuplexWrite>,
    cancel: &AtomicBool,
) {
    while !cancel.load(Ordering::Acquire) {
        let request = match requests.recv_timeout(Duration::from_millis(10)) {
            Ok(request) => request,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        if cancel.load(Ordering::Acquire) {
            break;
        }
        let result = stream
            .write_all(&request.bytes)
            .and_then(|()| stream.flush());
        let failed = result.is_err();
        let _ = request
            .receipt
            .send(result.map_err(|error| error.to_string()));
        if failed {
            cancel.store(true, Ordering::Release);
            break;
        }
    }
}

#[allow(
    clippy::needless_pass_by_value,
    reason = "worker owns IO endpoints and cancellation through physical cleanup"
)]
pub(super) fn output(
    mut stream: impl Read,
    send: async_mpsc::Sender<DuplexChunk>,
    cancel: &AtomicBool,
    stderr: bool,
) -> io::Result<()> {
    let mut buffer = [0_u8; 16 * 1024];
    while !cancel.load(Ordering::Acquire) {
        let count = match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::BrokenPipe => break,
            Err(error) => return Err(error),
        };
        let mut chunk = DuplexChunk {
            bytes: buffer[..count].to_vec(),
            stderr,
        };
        loop {
            if cancel.load(Ordering::Acquire) {
                return Ok(());
            }
            match send.try_send(chunk) {
                Ok(()) => break,
                Err(async_mpsc::error::TrySendError::Full(bytes)) => {
                    chunk = bytes;
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(async_mpsc::error::TrySendError::Closed(_)) => {
                    cancel.store(true, Ordering::Release);
                    return Ok(());
                }
            }
        }
    }
    Ok(())
}
