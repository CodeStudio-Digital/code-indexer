use std::error::Error;
use std::fmt::{self, Debug, Display, Formatter};
use tokio::io::{AsyncRead, AsyncWrite, ReadHalf, WriteHalf};
use tokio::time::{Instant, timeout_at};
use zeroize::Zeroize;

use super::{DelimitedFrameCodec, FramingError};

mod halves;
mod idle;
mod io;

pub use halves::{AsyncFrameReader, AsyncFrameWriter};
pub(crate) use idle::IdleReceiveOutcome;
use io::{read_frame, write_frame};

type AsyncFrameHalves<S> = (
    AsyncFrameReader<ReadHalf<S>>,
    AsyncFrameWriter<WriteHalf<S>>,
);

#[derive(Debug)]
pub enum AsyncFramingError {
    ChannelPoisoned,
    PeerClosed,
    ReadDeadlineElapsed,
    WriteDeadlineElapsed,
    Framing(FramingError),
}

impl Display for AsyncFramingError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::ChannelPoisoned => {
                formatter.write_str("async frame channel is permanently poisoned")
            }
            Self::PeerClosed => formatter.write_str("frame transport closed before a frame"),
            Self::ReadDeadlineElapsed => formatter.write_str("frame read deadline elapsed"),
            Self::WriteDeadlineElapsed => formatter.write_str("frame write deadline elapsed"),
            Self::Framing(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for AsyncFramingError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Framing(error) => Some(error),
            _ => None,
        }
    }
}

impl From<FramingError> for AsyncFramingError {
    fn from(value: FramingError) -> Self {
        Self::Framing(value)
    }
}

/// Single-owner async length-delimited transport.
///
/// Each operation removes the stream from `self` before its first await. A
/// timeout, I/O failure, framing failure, or cancellation therefore drops the
/// stream and leaves the channel permanently poisoned.
///
/// Borrowed stream aliases cannot become physical owners:
///
/// ```compile_fail
/// use agent_protocol::framing::{AsyncDelimitedFrameChannel, DelimitedFrameCodec};
///
/// let (mut stream, _peer) = tokio::io::duplex(64);
/// let codec = DelimitedFrameCodec::new(64).unwrap();
/// let _borrowed = AsyncDelimitedFrameChannel::new(codec, &mut stream);
/// ```
pub struct AsyncDelimitedFrameChannel<S> {
    codec: DelimitedFrameCodec,
    stream: Option<S>,
    poisoned: bool,
}

impl<S> Debug for AsyncDelimitedFrameChannel<S> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AsyncDelimitedFrameChannel")
            .field("maximum_frame_bytes", &self.codec.maximum_frame_bytes())
            .field("stream_open", &self.stream.is_some())
            .field("poisoned", &self.poisoned)
            .finish()
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> AsyncDelimitedFrameChannel<S> {
    #[must_use]
    pub(crate) const fn new(codec: DelimitedFrameCodec, stream: S) -> Self {
        Self {
            codec,
            stream: Some(stream),
            poisoned: false,
        }
    }

    /// Consumes this owner and transfers the same stream to a lower physical
    /// cap. Invalid or widening transitions drop the stream.
    ///
    /// # Errors
    ///
    /// Rejects zero and any cap larger than the current cap.
    pub(crate) fn narrow(self, maximum_frame_bytes: u32) -> Result<Self, AsyncFramingError> {
        if self.poisoned || self.stream.is_none() {
            return Err(AsyncFramingError::ChannelPoisoned);
        }
        let codec = DelimitedFrameCodec::new(maximum_frame_bytes)?;
        if maximum_frame_bytes > self.codec.maximum_frame_bytes() {
            return Err(FramingError::FrameTooLarge {
                declared: maximum_frame_bytes,
                maximum: self.codec.maximum_frame_bytes(),
            }
            .into());
        }
        Ok(Self {
            codec,
            stream: self.stream,
            poisoned: false,
        })
    }

    /// Transfers the same physical stream into private, single-owner halves.
    ///
    /// The split is crate-private so no public caller can recover the stream or
    /// construct established protocol state without semantic Hello validation.
    pub(crate) fn into_split(mut self) -> Result<AsyncFrameHalves<S>, AsyncFramingError> {
        let stream = self.begin_operation()?;
        let (reader, writer) = tokio::io::split(stream);
        Ok((
            AsyncFrameReader::new(self.codec, reader),
            AsyncFrameWriter::new(self.codec, writer),
        ))
    }

    /// Reads one exact frame body under one absolute monotonic deadline.
    ///
    /// # Errors
    ///
    /// Any timeout, EOF, I/O, framing error, or prior failure fails closed.
    pub(crate) async fn receive(
        &mut self,
        deadline: Instant,
    ) -> Result<Vec<u8>, AsyncFramingError> {
        if Instant::now() >= deadline {
            self.poison();
            return Err(AsyncFramingError::ReadDeadlineElapsed);
        }
        let mut stream = self.begin_operation()?;
        let result = timeout_at(deadline, read_frame(&mut stream, self.codec)).await;
        match result {
            Ok(Ok(frame)) if Instant::now() < deadline => {
                self.finish_operation(stream);
                Ok(frame)
            }
            Ok(Ok(mut frame)) => {
                frame.zeroize();
                Err(AsyncFramingError::ReadDeadlineElapsed)
            }
            Ok(Err(error)) => Err(error),
            Err(_) => Err(AsyncFramingError::ReadDeadlineElapsed),
        }
    }

    /// Writes one exact frame under one absolute monotonic deadline.
    ///
    /// # Errors
    ///
    /// Invalid length, timeout, I/O failure, or prior failure fails closed.
    pub(crate) async fn send(
        &mut self,
        frame: &[u8],
        deadline: Instant,
    ) -> Result<(), AsyncFramingError> {
        if Instant::now() >= deadline {
            self.poison();
            return Err(AsyncFramingError::WriteDeadlineElapsed);
        }
        let mut stream = self.begin_operation()?;
        let result = timeout_at(deadline, write_frame(&mut stream, self.codec, frame)).await;
        match result {
            Ok(Ok(())) if Instant::now() < deadline => {
                self.finish_operation(stream);
                Ok(())
            }
            Ok(Ok(())) | Err(_) => Err(AsyncFramingError::WriteDeadlineElapsed),
            Ok(Err(error)) => Err(error),
        }
    }

    #[must_use]
    pub(crate) const fn maximum_frame_bytes(&self) -> u32 {
        self.codec.maximum_frame_bytes()
    }

    #[must_use]
    pub(crate) const fn is_poisoned(&self) -> bool {
        self.poisoned || self.stream.is_none()
    }

    pub(crate) fn poison(&mut self) {
        self.poisoned = true;
        self.stream = None;
    }

    fn begin_operation(&mut self) -> Result<S, AsyncFramingError> {
        if self.poisoned {
            return Err(AsyncFramingError::ChannelPoisoned);
        }
        self.poisoned = true;
        self.stream.take().ok_or(AsyncFramingError::ChannelPoisoned)
    }

    fn finish_operation(&mut self, stream: S) {
        self.stream = Some(stream);
        self.poisoned = false;
    }
}

#[cfg(test)]
mod tests;
