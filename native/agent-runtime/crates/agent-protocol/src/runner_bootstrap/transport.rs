use std::fmt::{self, Debug, Formatter};
use std::io::{Read, Write};

use crate::framing::DelimitedFrameCodec;
use crate::generated::v1 as wire;
use zeroize::Zeroize;

use super::{
    RUNNER_ENDPOINTS_READY_MAX_BYTES, RUNNER_LAUNCH_HANDOFF_MAX_BYTES,
    ShapeValidatedRunnerLaunchHandoff, decode_runner_launch_handoff,
};

mod error;
mod ownership;
mod supervisor;

pub use error::RunnerBootstrapTransportError;
pub use ownership::{RunnerBootstrapReceiveFailure, RunnerBootstrapSendFailure};
pub use supervisor::{AwaitingPhysicalRunnerReady, SupervisorPhysicalBootstrapSender};

impl<R, W> Debug for RunnerPhysicalBootstrapReceiver<R, W> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RunnerPhysicalBootstrapReceiver")
            .field("transport", &"[PROTECTED]")
            .finish_non_exhaustive()
    }
}

impl<W> Debug for ReceivedPhysicalRunnerHandoff<W> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReceivedPhysicalRunnerHandoff")
            .field("handoff", &self.handoff)
            .field("response", &"[PROTECTED]")
            .finish_non_exhaustive()
    }
}

impl<W> Debug for RunnerReadyTransport<W> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RunnerReadyTransport")
            .field("transport", &"[PROTECTED]")
            .finish_non_exhaustive()
    }
}

pub struct RunnerPhysicalBootstrapReceiver<R, W> {
    reader: R,
    writer: W,
}

pub struct ReceivedPhysicalRunnerHandoff<W> {
    handoff: ShapeValidatedRunnerLaunchHandoff,
    response: RunnerReadyTransport<W>,
}

pub struct RunnerReadyTransport<W> {
    writer: W,
}

impl<R, W> RunnerPhysicalBootstrapReceiver<R, W> {
    #[must_use]
    pub const fn new(reader: R, writer: W) -> Self {
        Self { reader, writer }
    }
}

impl<R: Read, W: Write> RunnerPhysicalBootstrapReceiver<R, W> {
    /// Receives exactly one handoff and proves EOF before returning authority
    /// to bind any attempt endpoint.
    ///
    /// # Errors
    ///
    /// Missing, extra, malformed or oversized handoffs fail closed.
    pub fn receive(
        self,
    ) -> Result<ReceivedPhysicalRunnerHandoff<W>, RunnerBootstrapTransportError> {
        let Self { mut reader, writer } = self;
        let encoded = read_exactly_one(&mut reader, handoff_codec(), "RunnerLaunchHandoff")?;
        let handoff = decode_runner_launch_handoff(encoded)?;
        Ok(ReceivedPhysicalRunnerHandoff {
            handoff,
            response: RunnerReadyTransport { writer },
        })
    }
}

impl<W> ReceivedPhysicalRunnerHandoff<W> {
    #[must_use]
    pub fn into_parts(self) -> (ShapeValidatedRunnerLaunchHandoff, RunnerReadyTransport<W>) {
        (self.handoff, self.response)
    }
}

impl<W: Write> RunnerReadyTransport<W> {
    /// Writes, flushes and closes the sole Ready frame.
    ///
    /// # Errors
    ///
    /// Oversized/empty Ready messages and write/flush failures consume the
    /// response transport.
    pub fn send(
        mut self,
        ready: &wire::RunnerEndpointsReady,
    ) -> Result<(), RunnerBootstrapTransportError> {
        ready_codec().write(&mut self.writer, ready)?;
        self.writer
            .flush()
            .map_err(RunnerBootstrapTransportError::Flush)
    }

    /// Writes an already encoded Ready body under the same physical cap.
    ///
    /// This is the handoff seam for an endpoint materializer that privately
    /// minted Ready only after binding every listener.
    ///
    /// # Errors
    ///
    /// Empty/oversized bodies and write/flush failures consume the transport.
    pub fn send_raw(mut self, encoded_ready: &[u8]) -> Result<(), RunnerBootstrapTransportError> {
        ready_codec().write_raw(&mut self.writer, encoded_ready)?;
        self.writer
            .flush()
            .map_err(RunnerBootstrapTransportError::Flush)
    }
}

pub(super) fn read_exactly_one(
    reader: &mut impl Read,
    codec: DelimitedFrameCodec,
    message: &'static str,
) -> Result<Vec<u8>, RunnerBootstrapTransportError> {
    let mut encoded = codec
        .read_raw(reader)?
        .ok_or(RunnerBootstrapTransportError::UnexpectedEof(message))?;
    match codec.read_raw(reader) {
        Ok(None) => Ok(encoded),
        Ok(Some(mut trailing)) => {
            encoded.zeroize();
            trailing.zeroize();
            Err(RunnerBootstrapTransportError::TrailingFrame(message))
        }
        Err(error) => {
            encoded.zeroize();
            Err(error.into())
        }
    }
}

pub(super) fn handoff_codec() -> DelimitedFrameCodec {
    codec(RUNNER_LAUNCH_HANDOFF_MAX_BYTES)
}

pub(super) fn ready_codec() -> DelimitedFrameCodec {
    codec(RUNNER_ENDPOINTS_READY_MAX_BYTES)
}

fn codec(maximum: usize) -> DelimitedFrameCodec {
    let maximum = u32::try_from(maximum).expect("runner bootstrap caps fit uint32");
    DelimitedFrameCodec::new(maximum).expect("runner bootstrap caps are non-zero")
}
