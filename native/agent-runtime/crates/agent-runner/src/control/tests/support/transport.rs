use std::io::{self, Cursor, Write};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use agent_protocol::frame::CONTROL_FRAME_MAX_BYTES;
use agent_protocol::framing::DelimitedFrameCodec;

use crate::control::authority::EffectClock;
use crate::control::{RunnerBootstrapDriver, RunnerControlDriver};

use super::messages::host_hello_frame;
use super::{agent_hello_draft, launch_context, launch_nonce_authority};

#[derive(Debug, Clone)]
pub(in crate::control::tests) struct ManualClock {
    now: Arc<AtomicI64>,
}

impl ManualClock {
    pub(in crate::control::tests) fn new(now: i64) -> Self {
        Self {
            now: Arc::new(AtomicI64::new(now)),
        }
    }

    pub(in crate::control::tests) fn set(&self, now: i64) {
        self.now.store(now, Ordering::SeqCst);
    }

    pub(in crate::control::tests) fn now(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
}

impl EffectClock for ManualClock {
    fn now_unix_ms(&self) -> i64 {
        self.now()
    }
}

#[derive(Debug, Clone, Default)]
pub(in crate::control::tests) struct SharedWriter {
    bytes: Arc<Mutex<Vec<u8>>>,
}

impl SharedWriter {
    pub(in crate::control::tests) fn bytes(&self) -> Vec<u8> {
        self.bytes.lock().expect("writer lock").clone()
    }
}

impl Write for SharedWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.bytes
            .lock()
            .map_err(|_| io::Error::other("writer lock poisoned"))?
            .extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[derive(Debug)]
pub(in crate::control::tests) struct FailWriter {
    successful_writes: usize,
    fail_after_successful_writes: usize,
}

impl FailWriter {
    pub(in crate::control::tests) const fn after_successful_writes(
        fail_after_successful_writes: usize,
    ) -> Self {
        Self {
            successful_writes: 0,
            fail_after_successful_writes,
        }
    }
}

impl Default for FailWriter {
    fn default() -> Self {
        Self::after_successful_writes(2)
    }
}

impl Write for FailWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if self.successful_writes >= self.fail_after_successful_writes {
            return Err(io::Error::other("injected response write failure"));
        }
        self.successful_writes += 1;
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(in crate::control::tests) fn driver_with_frames<W: Write>(
    frames: Vec<Vec<u8>>,
    writer: W,
    clock: ManualClock,
) -> RunnerControlDriver<Cursor<Vec<u8>>, W> {
    driver_with_clock(frames, writer, clock)
}

pub(in crate::control::tests) fn driver_with_clock<W, C>(
    frames: Vec<Vec<u8>>,
    writer: W,
    clock: C,
) -> RunnerControlDriver<Cursor<Vec<u8>>, W>
where
    W: Write,
    C: EffectClock + 'static,
{
    let maximum = u32::try_from(CONTROL_FRAME_MAX_BYTES).expect("control cap fits u32");
    let codec = DelimitedFrameCodec::new(maximum).expect("control codec");
    let mut encoded_stream = Vec::new();
    codec
        .write_raw(&mut encoded_stream, &host_hello_frame())
        .expect("delimited HostHello");
    for frame in frames {
        codec
            .write_raw(&mut encoded_stream, &frame)
            .expect("delimited control frame");
    }

    RunnerBootstrapDriver::with_clock(Cursor::new(encoded_stream), writer, launch_context(), clock)
        .expect("runner bootstrap")
        .establish_with_nonce(agent_hello_draft(), launch_nonce_authority())
        .expect("same-stream handoff")
}
