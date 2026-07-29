use crate::frame::{AsyncBootstrapAttemptChannel, AsyncBootstrapChannelError, BootstrapError};

use super::PendingRunnerAgentHello;

impl PendingRunnerAgentHello {
    /// Writes the sole nonce-bearing `AgentHello` on an async bounded stream.
    ///
    /// Cancelling this future drops the in-flight transport and scrubs the
    /// nonce owner; no committed Hello state is returned.
    ///
    /// # Errors
    ///
    /// Propagates bootstrap validation, timeout, EOF, or transport failure.
    pub fn commit_async<'a, S, F>(
        mut self,
        channel: &'a mut AsyncBootstrapAttemptChannel<S>,
        deadline: tokio::time::Instant,
        clock: F,
    ) -> impl std::future::Future<Output = Result<(), AsyncBootstrapChannelError>> + 'a
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + 'static,
        F: FnOnce() -> i64 + 'a,
    {
        let send = self
            .hello
            .take()
            .map(|hello| channel.send_owned_agent_hello(hello, deadline, clock));
        async move {
            match send {
                Some(send) => send.await,
                None => Err(AsyncBootstrapChannelError::Bootstrap(
                    BootstrapError::Consumed,
                )),
            }
        }
    }
}
