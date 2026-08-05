use std::fmt::{Debug, Formatter};

use super::AsyncRunnerControlDriver;

impl<S> Debug for AsyncRunnerControlDriver<S> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AsyncRunnerControlDriver")
            .field("channel_open", &self.channel.is_some())
            .field("session", &self.session)
            .field("pending_prepare", &self.pending_prepare)
            .finish_non_exhaustive()
    }
}
