use prost::Message;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::io::{self, Read, Write};
use zeroize::Zeroize;
/// Tokio framing stays private until semantic Hello negotiation completes.
///
/// ```compile_fail
/// use agent_protocol::framing::asynchronous::AsyncDelimitedFrameChannel;
/// ```
#[allow(
    dead_code,
    reason = "private physical substrate awaits semantic management owner integration"
)]
pub(crate) mod asynchronous;
mod channel;
pub use asynchronous::AsyncFramingError;
pub use channel::DelimitedFrameChannel;
pub(crate) const MAX_U32_VARINT_BYTES: usize = 5;
#[derive(Debug)]
pub enum FramingError {
    ChannelPoisoned,
    Io(io::Error),
    EmptyFrame,
    TruncatedLength,
    LengthOverflow,
    NonCanonicalLength,
    FrameTooLarge { declared: u32, maximum: u32 },
    TruncatedFrame { declared: u32 },
    MalformedFrame(prost::DecodeError),
}

impl Display for FramingError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::ChannelPoisoned => formatter.write_str("frame channel is permanently poisoned"),
            Self::Io(error) => write!(formatter, "frame transport I/O failed: {error}"),
            Self::EmptyFrame => formatter.write_str("zero-length frame is forbidden"),
            Self::TruncatedLength => formatter.write_str("frame length varint is truncated"),
            Self::LengthOverflow => formatter.write_str("frame length exceeds uint32"),
            Self::NonCanonicalLength => {
                formatter.write_str("frame length varint is not minimally encoded")
            }
            Self::FrameTooLarge { declared, maximum } => {
                write!(
                    formatter,
                    "frame length {declared} exceeds hard cap {maximum}"
                )
            }
            Self::TruncatedFrame { declared } => {
                write!(
                    formatter,
                    "frame body ended before declared length {declared}"
                )
            }
            Self::MalformedFrame(error) => write!(formatter, "malformed protobuf frame: {error}"),
        }
    }
}

impl Error for FramingError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::MalformedFrame(error) => Some(error),
            _ => None,
        }
    }
}
/// Synchronous Protobuf length-delimited codec with a hard pre-allocation cap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DelimitedFrameCodec {
    maximum_frame_bytes: u32,
}

impl DelimitedFrameCodec {
    /// Creates a codec with an immutable non-zero hard cap.
    ///
    /// # Errors
    ///
    /// Returns [`FramingError::EmptyFrame`] when the cap is zero.
    pub const fn new(maximum_frame_bytes: u32) -> Result<Self, FramingError> {
        if maximum_frame_bytes == 0 {
            return Err(FramingError::EmptyFrame);
        }
        Ok(Self {
            maximum_frame_bytes,
        })
    }

    #[must_use]
    pub const fn maximum_frame_bytes(self) -> u32 {
        self.maximum_frame_bytes
    }
    /// Reads and decodes one message. Clean EOF before a prefix returns `None`.
    ///
    /// # Errors
    ///
    /// Rejects malformed/non-canonical lengths, oversized or truncated bodies,
    /// transport errors and malformed Protobuf.
    pub fn read<M: Message + Default>(
        self,
        reader: &mut impl Read,
    ) -> Result<Option<M>, FramingError> {
        let Some(mut body) = self.read_raw(reader)? else {
            return Ok(None);
        };
        let decoded = M::decode(body.as_slice()).map_err(FramingError::MalformedFrame);
        body.zeroize();
        decoded.map(Some)
    }

    /// Reads one exact envelope body without decoding or reserializing it.
    ///
    /// This is the authoritative receive seam for security-sensitive frames:
    /// unknown Protobuf fields remain covered by the semantic receiver's hash.
    ///
    /// # Errors
    ///
    /// Rejects invalid lengths and propagates transport failures.
    pub fn read_raw(self, reader: &mut impl Read) -> Result<Option<Vec<u8>>, FramingError> {
        let Some(length) = read_length(reader)? else {
            return Ok(None);
        };
        self.validate_length(length)?;

        let mut body = vec![0_u8; length as usize];
        if let Err(error) = reader.read_exact(&mut body) {
            body.zeroize();
            return if error.kind() == io::ErrorKind::UnexpectedEof {
                Err(FramingError::TruncatedFrame { declared: length })
            } else {
                Err(FramingError::Io(error))
            };
        }
        Ok(Some(body))
    }

    /// Encodes and writes one length-delimited message.
    ///
    /// # Errors
    ///
    /// Rejects empty/oversized messages and propagates transport or encoding
    /// errors.
    pub fn write<M: Message>(
        self,
        writer: &mut impl Write,
        message: &M,
    ) -> Result<(), FramingError> {
        let mut body = Vec::with_capacity(message.encoded_len());
        let result = message
            .encode(&mut body)
            .map_err(|error| FramingError::Io(io::Error::other(error)))
            .and_then(|()| self.write_raw(writer, &body));
        body.zeroize();
        result
    }

    /// Writes already encoded envelope bytes under the immutable frame cap.
    ///
    /// # Errors
    ///
    /// Rejects empty or oversized bytes and propagates transport failures.
    pub fn write_raw(self, writer: &mut impl Write, body: &[u8]) -> Result<(), FramingError> {
        let length = u32::try_from(body.len()).map_err(|_| FramingError::FrameTooLarge {
            declared: u32::MAX,
            maximum: self.maximum_frame_bytes,
        })?;
        self.validate_length(length)?;
        let (prefix, prefix_length) = encode_length(length);
        writer
            .write_all(&prefix[..prefix_length])
            .map_err(FramingError::Io)?;
        writer.write_all(body).map_err(FramingError::Io)
    }

    pub(crate) const fn validate_length(self, length: u32) -> Result<(), FramingError> {
        if length == 0 {
            return Err(FramingError::EmptyFrame);
        }
        if length > self.maximum_frame_bytes {
            return Err(FramingError::FrameTooLarge {
                declared: length,
                maximum: self.maximum_frame_bytes,
            });
        }
        Ok(())
    }
}
fn read_length(reader: &mut impl Read) -> Result<Option<u32>, FramingError> {
    let mut value = 0_u32;
    for index in 0..MAX_U32_VARINT_BYTES {
        let mut byte = [0_u8; 1];
        match reader.read_exact(&mut byte) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof && index == 0 => {
                return Ok(None);
            }
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {
                return Err(FramingError::TruncatedLength);
            }
            Err(error) => return Err(FramingError::Io(error)),
        }

        if let Some(length) = decode_length_byte(&mut value, index, byte[0])? {
            return Ok(Some(length));
        }
    }
    Err(FramingError::LengthOverflow)
}

pub(crate) const fn decode_length_byte(
    value: &mut u32,
    index: usize,
    byte: u8,
) -> Result<Option<u32>, FramingError> {
    let payload = byte & 0x7f;
    if index == MAX_U32_VARINT_BYTES - 1 && (byte & 0xf0) != 0 {
        return Err(FramingError::LengthOverflow);
    }
    *value |= u32::from_le_bytes([payload, 0, 0, 0]) << (index * 7);
    if byte & 0x80 != 0 {
        return Ok(None);
    }
    if index > 0 && payload == 0 {
        return Err(FramingError::NonCanonicalLength);
    }
    Ok(Some(*value))
}

pub(crate) const fn encode_length(mut value: u32) -> ([u8; MAX_U32_VARINT_BYTES], usize) {
    let mut bytes = [0_u8; MAX_U32_VARINT_BYTES];
    let mut length = 0;
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        bytes[length] = byte;
        length += 1;
        if value == 0 {
            return (bytes, length);
        }
    }
}

#[cfg(test)]
mod tests;
