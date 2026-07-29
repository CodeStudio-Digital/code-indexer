use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::{Duration, Instant, timeout_at};
use zeroize::Zeroize;

use super::io::{read_first_byte, read_frame_after_first};
use super::{AsyncDelimitedFrameChannel, AsyncFramingError};

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> AsyncDelimitedFrameChannel<S> {
    /// Waits for the first byte until the hard deadline, then bounds progress.
    ///
    /// An idle control channel is healthy. Once a peer starts a frame, every
    /// remaining byte must arrive within `progress_timeout` and before the
    /// immutable hard deadline.
    pub(crate) async fn receive_idle_progress_bounded(
        &mut self,
        hard_deadline: Instant,
        progress_timeout: Duration,
    ) -> Result<Vec<u8>, AsyncFramingError> {
        if Instant::now() >= hard_deadline {
            self.poison();
            return Err(AsyncFramingError::ReadDeadlineElapsed);
        }
        let mut stream = self.begin_operation()?;
        let first = match timeout_at(hard_deadline, read_first_byte(&mut stream)).await {
            Ok(Ok(first)) if Instant::now() < hard_deadline => first,
            Ok(Ok(_)) | Err(_) => {
                return Err(AsyncFramingError::ReadDeadlineElapsed);
            }
            Ok(Err(error)) => return Err(error),
        };
        let progress_deadline = Instant::now()
            .checked_add(progress_timeout)
            .map_or(hard_deadline, |deadline| deadline.min(hard_deadline));
        if Instant::now() >= progress_deadline {
            return Err(AsyncFramingError::ReadDeadlineElapsed);
        }
        let result = timeout_at(
            progress_deadline,
            read_frame_after_first(&mut stream, self.codec, first),
        )
        .await;
        match result {
            Ok(Ok(frame))
                if Instant::now() < progress_deadline && Instant::now() < hard_deadline =>
            {
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
}
