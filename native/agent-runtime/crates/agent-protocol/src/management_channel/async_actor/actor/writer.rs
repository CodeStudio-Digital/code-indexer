use std::time::Duration;

use tokio::io::AsyncWrite;
use tokio::time::Instant;

use super::ManagementActor;
use crate::framing::asynchronous::AsyncFramingError;
use crate::management_channel::async_actor::AsyncManagementActorError;
use crate::management_channel::async_actor::command::OutboundCommand;

#[derive(Clone, Copy)]
pub(super) enum FrameWriteDeadline {
    Header(i64),
    Policy(Duration),
}

#[derive(Clone, Copy)]
enum DeadlineCause {
    Frame,
    Outstanding,
    Pending,
}

impl<W: AsyncWrite + Unpin> ManagementActor<W> {
    pub(super) async fn process_command(&mut self, mut command: OutboundCommand) -> bool {
        if command.is_expired() {
            command.finish(Err(AsyncManagementActorError::CommandQueueDeadlineElapsed));
            return true;
        }
        let payload = command.take_payload();
        let prepared = match self.semantics.prepare_new(payload) {
            Ok(prepared) => prepared,
            Err(error) => {
                command.finish(Err(error.into()));
                return false;
            }
        };
        let deadline = FrameWriteDeadline::Header(prepared.deadline_at_unix_ms());
        if let Err(error) = self.write_frame(prepared.encoded(), deadline, None).await {
            command.finish(Err(error));
            return false;
        }
        command.finish(Ok(self.semantics.commit_new(prepared)));
        true
    }

    pub(super) async fn replay(
        &mut self,
        response: Option<std::sync::Arc<[u8]>>,
    ) -> Result<(), AsyncManagementActorError> {
        let Some(response) = response else {
            return Ok(());
        };
        self.write_frame(
            &response,
            FrameWriteDeadline::Policy(self.policy.write_timeout()),
            None,
        )
        .await
    }

    pub(super) async fn write_frame(
        &mut self,
        encoded: &[u8],
        frame: FrameWriteDeadline,
        pending_at: Option<Instant>,
    ) -> Result<(), AsyncManagementActorError> {
        let now = Instant::now();
        let frame_wait = match frame {
            FrameWriteDeadline::Header(deadline) => self.semantics.write_wait(deadline)?,
            FrameWriteDeadline::Policy(wait) => wait,
        };
        let frame_at = now + frame_wait;
        let mut effective_at = frame_at;
        let mut cause = DeadlineCause::Frame;
        if let Some(wait) = self.semantics.outstanding_wait() {
            if wait.is_zero() {
                return Err(AsyncManagementActorError::OutstandingDeadlineElapsed);
            }
            let outstanding_at = now + wait;
            if outstanding_at <= effective_at {
                effective_at = outstanding_at;
                cause = DeadlineCause::Outstanding;
            }
        }
        if let Some(pending_at) = pending_at {
            if pending_at <= now {
                return Err(AsyncManagementActorError::PendingInboundDeadlineElapsed);
            }
            if pending_at <= effective_at {
                effective_at = pending_at;
                cause = DeadlineCause::Pending;
            }
        }
        let result = {
            let terminal = self
                .reader_terminal
                .as_mut()
                .ok_or(AsyncManagementActorError::ChannelPoisoned)?;
            let write = self.writer.send(encoded, effective_at);
            tokio::pin!(write);
            tokio::select! {
                biased;
                () = wait_for_reader_terminal(terminal) => {
                    return Err(AsyncManagementActorError::ChannelPoisoned);
                }
                result = &mut write => result,
            }
        };
        match result {
            Ok(()) => self.ensure_write_live(frame, frame_at, pending_at),
            Err(AsyncFramingError::WriteDeadlineElapsed) => Err(cause.error()),
            Err(error) => Err(error.into()),
        }
    }

    fn ensure_write_live(
        &self,
        frame: FrameWriteDeadline,
        frame_at: Instant,
        pending_at: Option<Instant>,
    ) -> Result<(), AsyncManagementActorError> {
        if pending_at.is_some_and(|deadline| Instant::now() >= deadline) {
            return Err(AsyncManagementActorError::PendingInboundDeadlineElapsed);
        }
        if self
            .semantics
            .outstanding_wait()
            .is_some_and(|wait| wait.is_zero())
        {
            return Err(AsyncManagementActorError::OutstandingDeadlineElapsed);
        }
        match frame {
            FrameWriteDeadline::Header(deadline) => {
                self.semantics.write_wait(deadline)?;
            }
            FrameWriteDeadline::Policy(_) if Instant::now() >= frame_at => {
                return Err(AsyncManagementActorError::PhysicalWriteDeadlineElapsed);
            }
            FrameWriteDeadline::Policy(_) => {}
        }
        Ok(())
    }
}

async fn wait_for_reader_terminal(terminal: &mut tokio::sync::watch::Receiver<bool>) {
    if *terminal.borrow() {
        return;
    }
    let _ = terminal.changed().await;
}

impl DeadlineCause {
    const fn error(self) -> AsyncManagementActorError {
        match self {
            Self::Frame => AsyncManagementActorError::PhysicalWriteDeadlineElapsed,
            Self::Outstanding => AsyncManagementActorError::OutstandingDeadlineElapsed,
            Self::Pending => AsyncManagementActorError::PendingInboundDeadlineElapsed,
        }
    }
}
