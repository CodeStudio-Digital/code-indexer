use std::fmt::{self, Debug, Formatter};
use std::io::{Read, Write};

use prost::Message;

use super::{DelimitedFrameCodec, FramingError};

/// Stateful transport owner. Any framing or I/O failure permanently poisons
/// the channel so a desynchronized byte stream cannot be reused.
pub struct DelimitedFrameChannel<R, W> {
    codec: DelimitedFrameCodec,
    reader: Option<R>,
    writer: Option<W>,
    poisoned: bool,
}

impl<R, W> Debug for DelimitedFrameChannel<R, W> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DelimitedFrameChannel")
            .field("maximum_frame_bytes", &self.codec.maximum_frame_bytes())
            .field(
                "streams_open",
                &(self.reader.is_some() && self.writer.is_some()),
            )
            .field("poisoned", &self.poisoned)
            .finish()
    }
}

impl<R: Read, W: Write> DelimitedFrameChannel<R, W> {
    #[must_use]
    pub const fn new(codec: DelimitedFrameCodec, reader: R, writer: W) -> Self {
        Self {
            codec,
            reader: Some(reader),
            writer: Some(writer),
            poisoned: false,
        }
    }

    /// Reads one message and poisons the channel after any non-EOF failure.
    ///
    /// # Errors
    ///
    /// Returns [`FramingError::ChannelPoisoned`] after an earlier failure, or
    /// the first framing/transport/decode failure after poisoning the channel.
    pub fn read<M: Message + Default>(&mut self) -> Result<Option<M>, FramingError> {
        if self.poisoned {
            return Err(FramingError::ChannelPoisoned);
        }
        let reader = self.reader.as_mut().ok_or(FramingError::ChannelPoisoned)?;
        let result = self.codec.read(reader);
        if result.is_err() {
            self.poison();
        }
        result
    }

    /// Reads exact envelope bytes without a Protobuf decode boundary.
    ///
    /// # Errors
    ///
    /// Returns the first framing or transport failure and poisons the channel.
    pub fn read_raw(&mut self) -> Result<Option<Vec<u8>>, FramingError> {
        if self.poisoned {
            return Err(FramingError::ChannelPoisoned);
        }
        let reader = self.reader.as_mut().ok_or(FramingError::ChannelPoisoned)?;
        let result = self.codec.read_raw(reader);
        if result.is_err() {
            self.poison();
        }
        result
    }

    /// Writes one message and poisons the channel after any failure, including
    /// a writer that accepted only a prefix or partial body.
    ///
    /// # Errors
    ///
    /// Returns [`FramingError::ChannelPoisoned`] after an earlier failure, or
    /// the first framing/transport/encode failure after poisoning the channel.
    pub fn write<M: Message>(&mut self, message: &M) -> Result<(), FramingError> {
        if self.poisoned {
            return Err(FramingError::ChannelPoisoned);
        }
        let writer = self.writer.as_mut().ok_or(FramingError::ChannelPoisoned)?;
        let result = self.codec.write(writer, message);
        if result.is_err() {
            self.poison();
        }
        result
    }

    /// Writes exact encoded envelope bytes and poisons after any partial write.
    ///
    /// # Errors
    ///
    /// Rejects invalid frame lengths and propagates transport failures.
    pub fn write_raw(&mut self, frame: &[u8]) -> Result<(), FramingError> {
        if self.poisoned {
            return Err(FramingError::ChannelPoisoned);
        }
        let writer = self.writer.as_mut().ok_or(FramingError::ChannelPoisoned)?;
        let result = self.codec.write_raw(writer, frame);
        if result.is_err() {
            self.poison();
        }
        result
    }

    /// Permanently invalidates the transport after a semantic protocol error.
    pub fn poison(&mut self) {
        self.poisoned = true;
        self.reader = None;
        self.writer = None;
    }

    #[must_use]
    pub const fn maximum_frame_bytes(&self) -> u32 {
        self.codec.maximum_frame_bytes()
    }

    #[must_use]
    pub const fn is_poisoned(&self) -> bool {
        self.poisoned
    }

    /// Returns the owned streams only while the channel remains synchronized.
    ///
    /// # Errors
    ///
    /// A poisoned channel consumes and drops both streams instead of exposing
    /// potentially desynchronized transport state for reuse.
    pub fn into_inner(mut self) -> Result<(R, W), FramingError> {
        if self.poisoned {
            Err(FramingError::ChannelPoisoned)
        } else {
            let reader = self.reader.take().ok_or(FramingError::ChannelPoisoned)?;
            let writer = self.writer.take().ok_or(FramingError::ChannelPoisoned)?;
            Ok((reader, writer))
        }
    }
}
