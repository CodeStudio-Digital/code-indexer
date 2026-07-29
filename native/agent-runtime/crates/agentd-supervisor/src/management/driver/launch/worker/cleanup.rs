use std::fmt::{self, Debug, Formatter};
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Duration;

use super::guard::reap_finished_or_fail_stop;
use crate::management::driver::provision::{
    ProtectedLaunchCleanupPort, ProtectedLaunchCleanupProof,
};

const CLEANUP_PROXY_TIMEOUT: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy)]
pub(super) enum RemoteCleanupCommand {
    Try,
}

#[derive(Debug, Clone, Copy)]
pub(super) enum RemoteCleanupResult {
    Completed,
    Retry,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::management) enum RemoteLaunchCleanupError {
    WorkerUnavailable,
    RetryPending,
}

pub(in crate::management) struct RemoteLaunchCleanup {
    commands: mpsc::SyncSender<RemoteCleanupCommand>,
    results: mpsc::Receiver<RemoteCleanupResult>,
    thread: Option<JoinHandle<()>>,
    in_flight: bool,
    completion_observed: bool,
}

impl RemoteLaunchCleanup {
    pub(super) const fn new(
        commands: mpsc::SyncSender<RemoteCleanupCommand>,
        results: mpsc::Receiver<RemoteCleanupResult>,
        thread: JoinHandle<()>,
    ) -> Self {
        Self {
            commands,
            results,
            thread: Some(thread),
            in_flight: false,
            completion_observed: false,
        }
    }

    fn start_attempt(&mut self) -> Result<(), RemoteLaunchCleanupError> {
        if self.in_flight {
            return Ok(());
        }
        match self.commands.try_send(RemoteCleanupCommand::Try) {
            Ok(()) | Err(mpsc::TrySendError::Full(_)) => {
                self.in_flight = true;
                Ok(())
            }
            Err(mpsc::TrySendError::Disconnected(_)) => {
                Err(RemoteLaunchCleanupError::WorkerUnavailable)
            }
        }
    }

    fn finish_completed_worker(
        &mut self,
    ) -> Result<ProtectedLaunchCleanupProof, RemoteLaunchCleanupError> {
        let worker = self
            .thread
            .as_ref()
            .ok_or(RemoteLaunchCleanupError::WorkerUnavailable)?;
        if !worker.is_finished() {
            return Err(RemoteLaunchCleanupError::RetryPending);
        }
        self.thread
            .take()
            .expect("completed cleanup worker retains join ownership")
            .join()
            .map_err(|_| RemoteLaunchCleanupError::WorkerUnavailable)?;
        Ok(ProtectedLaunchCleanupProof::completed())
    }
}

impl ProtectedLaunchCleanupPort for RemoteLaunchCleanup {
    type Error = RemoteLaunchCleanupError;

    fn try_cleanup(&mut self) -> Result<ProtectedLaunchCleanupProof, Self::Error> {
        if self.completion_observed {
            return self.finish_completed_worker();
        }
        self.start_attempt()?;
        match self.results.recv_timeout(CLEANUP_PROXY_TIMEOUT) {
            Ok(RemoteCleanupResult::Completed) => {
                self.in_flight = false;
                self.completion_observed = true;
                self.finish_completed_worker()
            }
            Ok(RemoteCleanupResult::Retry) => {
                self.in_flight = false;
                Err(RemoteLaunchCleanupError::RetryPending)
            }
            Err(mpsc::RecvTimeoutError::Timeout) => Err(RemoteLaunchCleanupError::RetryPending),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                self.in_flight = false;
                Err(RemoteLaunchCleanupError::WorkerUnavailable)
            }
        }
    }
}

impl Drop for RemoteLaunchCleanup {
    fn drop(&mut self) {
        reap_finished_or_fail_stop(&mut self.thread);
    }
}

impl Debug for RemoteLaunchCleanup {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RemoteLaunchCleanup")
            .field("thread_owned", &self.thread.is_some())
            .field("cleanup_in_flight", &self.in_flight)
            .field("completion_observed", &self.completion_observed)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests;
