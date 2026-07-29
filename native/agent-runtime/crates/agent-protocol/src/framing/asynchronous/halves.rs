use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::{Duration, Instant, timeout_at};
use zeroize::Zeroize;

use super::io::{read_first_byte, read_frame_after_first};
use super::{AsyncFramingError, DelimitedFrameCodec, read_frame, write_frame};

pub struct AsyncFrameReader<R> {
    codec: DelimitedFrameCodec,
    reader: Option<R>,
}

impl<R: AsyncRead + Unpin> AsyncFrameReader<R> {
    pub(super) const fn new(codec: DelimitedFrameCodec, reader: R) -> Self {
        Self {
            codec,
            reader: Some(reader),
        }
    }

    pub(crate) async fn receive(
        &mut self,
        deadline: Instant,
    ) -> Result<Vec<u8>, AsyncFramingError> {
        if Instant::now() >= deadline {
            self.reader = None;
            return Err(AsyncFramingError::ReadDeadlineElapsed);
        }
        let mut reader = self
            .reader
            .take()
            .ok_or(AsyncFramingError::ChannelPoisoned)?;
        match timeout_at(deadline, read_frame(&mut reader, self.codec)).await {
            Ok(Ok(frame)) if Instant::now() < deadline => {
                self.reader = Some(reader);
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

    /// Waits idle without a deadline, then bounds all remaining frame bytes.
    pub(crate) async fn receive_progress_bounded(
        &mut self,
        progress_timeout: Duration,
    ) -> Result<Vec<u8>, AsyncFramingError> {
        let mut reader = self
            .reader
            .take()
            .ok_or(AsyncFramingError::ChannelPoisoned)?;
        let first = read_first_byte(&mut reader).await?;
        let deadline = Instant::now() + progress_timeout;
        match timeout_at(
            deadline,
            read_frame_after_first(&mut reader, self.codec, first),
        )
        .await
        {
            Ok(Ok(frame)) if Instant::now() < deadline => {
                self.reader = Some(reader);
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
}

pub struct AsyncFrameWriter<W> {
    codec: DelimitedFrameCodec,
    writer: Option<W>,
}

impl<W: AsyncWrite + Unpin> AsyncFrameWriter<W> {
    pub(super) const fn new(codec: DelimitedFrameCodec, writer: W) -> Self {
        Self {
            codec,
            writer: Some(writer),
        }
    }

    pub(crate) async fn send(
        &mut self,
        frame: &[u8],
        deadline: Instant,
    ) -> Result<(), AsyncFramingError> {
        if Instant::now() >= deadline {
            self.writer = None;
            return Err(AsyncFramingError::WriteDeadlineElapsed);
        }
        let mut writer = self
            .writer
            .take()
            .ok_or(AsyncFramingError::ChannelPoisoned)?;
        match timeout_at(deadline, write_frame(&mut writer, self.codec, frame)).await {
            Ok(Ok(())) if Instant::now() < deadline => {
                self.writer = Some(writer);
                Ok(())
            }
            Ok(Ok(())) | Err(_) => Err(AsyncFramingError::WriteDeadlineElapsed),
            Ok(Err(error)) => Err(error),
        }
    }
}
