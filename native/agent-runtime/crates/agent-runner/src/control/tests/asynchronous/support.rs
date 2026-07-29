use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use agent_protocol::frame::CONTROL_FRAME_MAX_BYTES;
use agent_protocol::framing::DelimitedFrameCodec;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::time::Instant;

use crate::control::authority::EffectClock;
use crate::control::{AsyncRunnerBootstrapDriver, AsyncRunnerControlDriver};

use super::super::support::{
    agent_hello_draft, host_hello_frame, launch_context, launch_nonce_authority,
};

#[derive(Clone)]
pub(in crate::control::tests) struct GateControl {
    block_writes: Arc<AtomicBool>,
    eof_reads: Arc<AtomicBool>,
    written: Arc<Mutex<Vec<u8>>>,
}

pub(in crate::control::tests) struct GateStream {
    input: Vec<u8>,
    position: usize,
    block_writes: Arc<AtomicBool>,
    eof_reads: Arc<AtomicBool>,
    written: Arc<Mutex<Vec<u8>>>,
}

impl AsyncRead for GateStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        _context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let remaining = &self.input[self.position..];
        if remaining.is_empty() {
            return if self.eof_reads.load(Ordering::SeqCst) {
                Poll::Ready(Ok(()))
            } else {
                Poll::Pending
            };
        }
        let count = remaining.len().min(buffer.remaining());
        buffer.put_slice(&remaining[..count]);
        self.position += count;
        Poll::Ready(Ok(()))
    }
}

impl AsyncWrite for GateStream {
    fn poll_write(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.block_writes.load(Ordering::SeqCst) {
            Poll::Pending
        } else {
            let Ok(mut written) = self.written.lock() else {
                return Poll::Ready(Err(io::Error::other("written bytes lock poisoned")));
            };
            written.extend_from_slice(buffer);
            drop(written);
            Poll::Ready(Ok(buffer.len()))
        }
    }

    fn poll_flush(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

pub(in crate::control::tests) async fn driver<C>(
    frames: impl IntoIterator<Item = Vec<u8>>,
    clock: C,
) -> (AsyncRunnerControlDriver<GateStream>, GateControl)
where
    C: EffectClock + 'static,
{
    let host_hello = host_hello_frame();
    driver_with_hello_and_raw_tail(frames, clock, &host_hello, &[]).await
}

pub(in crate::control::tests) async fn driver_with_hello_and_raw_tail<C>(
    frames: impl IntoIterator<Item = Vec<u8>>,
    clock: C,
    host_hello: &[u8],
    raw_tail: &[u8],
) -> (AsyncRunnerControlDriver<GateStream>, GateControl)
where
    C: EffectClock + 'static,
{
    let (stream, control) = stream(frames, host_hello, raw_tail);
    let bootstrap = AsyncRunnerBootstrapDriver::with_clock(stream, launch_context(), clock)
        .expect("async bootstrap");
    let driver = bootstrap
        .establish_with_nonce(
            agent_hello_draft(),
            launch_nonce_authority(),
            Instant::now() + Duration::from_secs(1),
        )
        .await
        .expect("HostHello handshake");
    (driver, control)
}

fn stream(
    frames: impl IntoIterator<Item = Vec<u8>>,
    host_hello: &[u8],
    raw_tail: &[u8],
) -> (GateStream, GateControl) {
    let codec = DelimitedFrameCodec::new(
        u32::try_from(CONTROL_FRAME_MAX_BYTES).expect("control frame cap fits u32"),
    )
    .expect("control codec");
    let mut input = Vec::new();
    codec
        .write_raw(&mut input, host_hello)
        .expect("HostHello framing");
    for frame in frames {
        codec
            .write_raw(&mut input, &frame)
            .expect("attempt frame framing");
    }
    input.extend_from_slice(raw_tail);
    let blocked = Arc::new(AtomicBool::new(false));
    let eof_reads = Arc::new(AtomicBool::new(false));
    let written = Arc::new(Mutex::new(Vec::new()));
    (
        GateStream {
            input,
            position: 0,
            block_writes: Arc::clone(&blocked),
            eof_reads: Arc::clone(&eof_reads),
            written: Arc::clone(&written),
        },
        GateControl {
            block_writes: blocked,
            eof_reads,
            written,
        },
    )
}

impl GateControl {
    pub(in crate::control::tests) fn block_writes(&self) {
        self.block_writes.store(true, Ordering::SeqCst);
    }

    pub(in crate::control::tests) fn allow_writes(&self) {
        self.block_writes.store(false, Ordering::SeqCst);
    }

    pub(in crate::control::tests) fn close_reads(&self) {
        self.eof_reads.store(true, Ordering::SeqCst);
    }

    pub(in crate::control::tests) fn written(&self) -> Vec<u8> {
        self.written.lock().expect("written bytes lock").clone()
    }
}
