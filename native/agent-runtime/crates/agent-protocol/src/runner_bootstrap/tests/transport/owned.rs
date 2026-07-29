use std::io::{self, Cursor, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::framing::{DelimitedFrameCodec, FramingError};
use crate::runner_bootstrap::{
    AwaitingPhysicalRunnerReady, RUNNER_ENDPOINTS_READY_MAX_BYTES, RunnerBootstrapError,
    RunnerBootstrapTransportError, SupervisorPhysicalBootstrapSender,
    prepare_runner_launch_handoff,
};

use super::super::support;
use super::framed_ready;

#[derive(Debug)]
struct FaultWriter {
    fail_write: bool,
    fail_flush: bool,
    bytes: Vec<u8>,
}

impl FaultWriter {
    fn write_failure() -> Self {
        Self {
            fail_write: true,
            fail_flush: false,
            bytes: Vec::new(),
        }
    }

    fn flush_failure() -> Self {
        Self {
            fail_write: false,
            fail_flush: true,
            bytes: Vec::new(),
        }
    }
}

impl Write for FaultWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.fail_write {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "write fixture"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        if self.fail_flush {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "flush fixture"));
        }
        Ok(())
    }
}

#[derive(Debug)]
struct DropWriter {
    dropped: Arc<AtomicBool>,
}

impl Write for DropWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for DropWriter {
    fn drop(&mut self) {
        self.dropped.store(true, Ordering::SeqCst);
    }
}

#[test]
fn owned_send_recovers_reader_and_writer_after_write_failure() {
    let input = vec![9, 8, 7];
    let prepared =
        prepare_runner_launch_handoff(support::windows_handoff()).expect("valid handoff");
    let failure = SupervisorPhysicalBootstrapSender::new(
        Cursor::new(input.clone()),
        FaultWriter::write_failure(),
    )
    .send_owned(prepared)
    .expect_err("write must fail");

    assert!(matches!(
        failure.error(),
        RunnerBootstrapTransportError::Framing(FramingError::Io(error))
            if error.kind() == io::ErrorKind::BrokenPipe
    ));
    let (reader, writer, error) = failure.into_parts();
    assert_eq!(reader.into_inner(), input);
    assert!(writer.bytes.is_empty());
    assert!(matches!(
        error,
        RunnerBootstrapTransportError::Framing(FramingError::Io(error))
            if error.kind() == io::ErrorKind::BrokenPipe
    ));
}

#[test]
fn owned_send_recovers_reader_and_partially_used_writer_after_flush_failure() {
    let prepared =
        prepare_runner_launch_handoff(support::windows_handoff()).expect("valid handoff");
    let failure = SupervisorPhysicalBootstrapSender::new(
        Cursor::new(vec![4, 5, 6]),
        FaultWriter::flush_failure(),
    )
    .send_owned(prepared)
    .expect_err("flush must fail");

    let (reader, writer, error) = failure.into_parts();
    assert_eq!(reader.into_inner(), vec![4, 5, 6]);
    assert!(!writer.bytes.is_empty(), "handoff was written before flush");
    assert!(matches!(
        error,
        RunnerBootstrapTransportError::Flush(error)
            if error.kind() == io::ErrorKind::TimedOut
    ));
}

#[test]
fn successful_owned_send_closes_writer_before_returning_ready_owner() {
    let handoff = support::windows_handoff();
    let prepared = prepare_runner_launch_handoff(handoff.clone()).expect("valid handoff");
    let dropped = Arc::new(AtomicBool::new(false));
    let pending = SupervisorPhysicalBootstrapSender::new(
        Cursor::new(framed_ready(&handoff)),
        DropWriter {
            dropped: Arc::clone(&dropped),
        },
    )
    .send_owned(prepared)
    .expect("send succeeds");

    assert!(dropped.load(Ordering::SeqCst), "writer must close for EOF");
    pending.receive_owned().expect("ready matches");
}

#[test]
fn owned_receive_recovers_reader_after_framing_failure() {
    let bytes = vec![0x80];
    let failure = pending(bytes.clone())
        .receive_owned()
        .expect_err("truncated frame length must fail");

    assert!(matches!(
        failure.error(),
        RunnerBootstrapTransportError::Framing(FramingError::TruncatedLength)
    ));
    let (reader, error) = failure.into_parts();
    assert_eq!(reader.into_inner(), bytes);
    assert!(matches!(
        error,
        RunnerBootstrapTransportError::Framing(FramingError::TruncatedLength)
    ));
}

#[test]
fn owned_receive_recovers_reader_after_malformed_ready() {
    let bytes = framed_raw(&[0xff]);
    let failure = pending(bytes.clone())
        .receive_owned()
        .expect_err("malformed Ready must fail");

    let (reader, error) = failure.into_parts();
    assert_eq!(reader.into_inner(), bytes);
    assert!(matches!(
        error,
        RunnerBootstrapTransportError::Protocol(RunnerBootstrapError::MalformedMessage {
            message: "RunnerEndpointsReady",
            ..
        })
    ));
}

#[test]
fn owned_receive_recovers_reader_after_trailing_ready_frame() {
    let handoff = support::windows_handoff();
    let mut bytes = framed_ready(&handoff);
    bytes.extend(framed_ready(&handoff));
    let failure = pending_for(handoff, bytes.clone())
        .receive_owned()
        .expect_err("trailing Ready must fail");

    let (reader, error) = failure.into_parts();
    assert_eq!(reader.into_inner(), bytes);
    assert!(matches!(
        error,
        RunnerBootstrapTransportError::TrailingFrame("RunnerEndpointsReady")
    ));
}

#[test]
fn owned_receive_recovers_reader_after_missing_ready_eof() {
    let failure = pending(Vec::new())
        .receive_owned()
        .expect_err("missing Ready must fail");

    let (reader, error) = failure.into_parts();
    assert!(reader.into_inner().is_empty());
    assert!(matches!(
        error,
        RunnerBootstrapTransportError::UnexpectedEof("RunnerEndpointsReady")
    ));
}

fn pending(bytes: Vec<u8>) -> AwaitingPhysicalRunnerReady<Cursor<Vec<u8>>> {
    pending_for(support::windows_handoff(), bytes)
}

fn pending_for(
    handoff: crate::generated::v1::RunnerLaunchHandoff,
    bytes: Vec<u8>,
) -> AwaitingPhysicalRunnerReady<Cursor<Vec<u8>>> {
    let prepared = prepare_runner_launch_handoff(handoff).expect("valid handoff");
    SupervisorPhysicalBootstrapSender::new(Cursor::new(bytes), Vec::<u8>::new())
        .send_owned(prepared)
        .expect("handoff send")
}

fn framed_raw(body: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::new();
    DelimitedFrameCodec::new(u32::try_from(RUNNER_ENDPOINTS_READY_MAX_BYTES).expect("ready cap"))
        .expect("codec")
        .write_raw(&mut bytes, body)
        .expect("fixture");
    bytes
}
