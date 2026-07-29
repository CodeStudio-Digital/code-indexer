use std::io;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use zeroize::Zeroize;

use super::AsyncFramingError;
use crate::framing::{
    DelimitedFrameCodec, FramingError, MAX_U32_VARINT_BYTES, decode_length_byte, encode_length,
};

pub(super) async fn read_frame<S: AsyncRead + Unpin>(
    stream: &mut S,
    codec: DelimitedFrameCodec,
) -> Result<Vec<u8>, AsyncFramingError> {
    let first = read_first_byte(stream).await?;
    read_frame_after_first(stream, codec, first).await
}

pub(super) async fn read_first_byte<S: AsyncRead + Unpin>(
    stream: &mut S,
) -> Result<u8, AsyncFramingError> {
    let mut first = [0_u8; 1];
    match stream.read_exact(&mut first).await {
        Ok(_) => Ok(first[0]),
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {
            Err(AsyncFramingError::PeerClosed)
        }
        Err(error) => Err(FramingError::Io(error).into()),
    }
}

pub(super) async fn read_frame_after_first<S: AsyncRead + Unpin>(
    stream: &mut S,
    codec: DelimitedFrameCodec,
    first: u8,
) -> Result<Vec<u8>, AsyncFramingError> {
    let length = read_length_after_first(stream, first).await?;
    codec.validate_length(length)?;
    let mut frame = ScrubbedBuffer(vec![0_u8; length as usize]);
    if let Err(error) = stream.read_exact(&mut frame.0).await {
        return if error.kind() == io::ErrorKind::UnexpectedEof {
            Err(FramingError::TruncatedFrame { declared: length }.into())
        } else {
            Err(FramingError::Io(error).into())
        };
    }
    Ok(std::mem::take(&mut frame.0))
}

async fn read_length_after_first<S: AsyncRead + Unpin>(
    stream: &mut S,
    first: u8,
) -> Result<u32, AsyncFramingError> {
    let mut value = 0_u32;
    if let Some(length) = decode_length_byte(&mut value, 0, first)? {
        return Ok(length);
    }
    for index in 1..MAX_U32_VARINT_BYTES {
        let mut byte = [0_u8; 1];
        if let Err(error) = stream.read_exact(&mut byte).await {
            if error.kind() == io::ErrorKind::UnexpectedEof {
                return Err(FramingError::TruncatedLength.into());
            }
            return Err(FramingError::Io(error).into());
        }
        if let Some(length) = decode_length_byte(&mut value, index, byte[0])? {
            return Ok(length);
        }
    }
    Err(FramingError::LengthOverflow.into())
}

pub(super) async fn write_frame<S: AsyncWrite + Unpin>(
    stream: &mut S,
    codec: DelimitedFrameCodec,
    frame: &[u8],
) -> Result<(), AsyncFramingError> {
    let length = u32::try_from(frame.len()).map_err(|_| FramingError::FrameTooLarge {
        declared: u32::MAX,
        maximum: codec.maximum_frame_bytes(),
    })?;
    codec.validate_length(length)?;
    let (prefix, prefix_length) = encode_length(length);
    stream
        .write_all(&prefix[..prefix_length])
        .await
        .map_err(FramingError::Io)?;
    stream.write_all(frame).await.map_err(FramingError::Io)?;
    Ok(())
}

struct ScrubbedBuffer(Vec<u8>);

impl Drop for ScrubbedBuffer {
    fn drop(&mut self) {
        self.0.as_mut_slice().zeroize();
    }
}
