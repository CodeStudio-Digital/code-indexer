use tokio::io::AsyncRead;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use super::scrub::ScrubbedBytes;
use super::{AsyncManagementActorError, AsyncManagementPolicy};
use crate::framing::asynchronous::AsyncFrameReader;

pub(super) type ReadOutcome = Result<ScrubbedBytes, AsyncManagementActorError>;

pub(super) struct ReaderWorker {
    permits: mpsc::Sender<()>,
    task: Option<JoinHandle<()>>,
}

impl ReaderWorker {
    pub(super) fn spawn<R>(
        reader: AsyncFrameReader<R>,
        policy: &AsyncManagementPolicy,
    ) -> (Self, mpsc::Receiver<ReadOutcome>, watch::Receiver<bool>)
    where
        R: AsyncRead + Unpin + Send + 'static,
    {
        let (permits, permit_receiver) = mpsc::channel(1);
        let (outcomes, outcome_receiver) = mpsc::channel(1);
        let (terminal, terminal_receiver) = watch::channel(false);
        let timeout = policy.read_progress_timeout();
        let task = tokio::spawn(run_reader(
            reader,
            permit_receiver,
            outcomes,
            terminal,
            timeout,
        ));
        (
            Self {
                permits,
                task: Some(task),
            },
            outcome_receiver,
            terminal_receiver,
        )
    }

    pub(super) fn request_next(&self) -> Result<(), AsyncManagementActorError> {
        self.permits
            .try_send(())
            .map_err(|_| AsyncManagementActorError::ChannelPoisoned)
    }

    pub(super) async fn stop(mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
            let _ = task.await;
        }
    }
}

impl Drop for ReaderWorker {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

async fn run_reader<R>(
    mut reader: AsyncFrameReader<R>,
    mut permits: mpsc::Receiver<()>,
    outcomes: mpsc::Sender<ReadOutcome>,
    terminal_sender: watch::Sender<bool>,
    timeout: tokio::time::Duration,
) where
    R: AsyncRead + Unpin,
{
    while permits.recv().await.is_some() {
        let result = reader
            .receive_progress_bounded(timeout)
            .await
            .map(ScrubbedBytes::new)
            .map_err(Into::into);
        let is_terminal = result.is_err();
        if is_terminal {
            terminal_sender.send_replace(true);
        }
        if outcomes.send(result).await.is_err() || is_terminal {
            return;
        }
    }
}
