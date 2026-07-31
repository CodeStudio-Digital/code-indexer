//! Async single-stream management owner.
//!
//! Established state has no public constructor and cannot be cloned:
//!
//! ```compile_fail
//! use agent_protocol::management_channel::AsyncEstablishedManagementActor;
//!
//! fn requires_clone<T: Clone>() {}
//! requires_clone::<AsyncEstablishedManagementActor>();
//! ```
//!
//! ```compile_fail
//! use agent_protocol::management_channel::AsyncEstablishedManagementActor;
//!
//! let _forged = AsyncEstablishedManagementActor {};
//! ```

mod actor;
mod bootstrap;
mod command;
mod error;
mod event;
mod policy;
mod scrub;
mod semantics;
mod worker;

pub use bootstrap::AsyncBootstrapManagementActor;
pub use command::{
    AsyncManagementCommandPort, AsyncQueuedManagementWrite, AsyncSentManagementFrame,
};
pub use error::AsyncManagementActorError;
pub use event::{
    AsyncAcknowledgedManagementInbound, AsyncManagementEvent, AsyncPendingManagementInbound,
};
pub use policy::AsyncManagementPolicy;

use crate::framing::asynchronous::AsyncFrameReader;
use crate::management_channel::ManagementSessionPolicy;
use actor::ManagementActor;
use command::CommandQueues;
use event::EventQueue;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::task::JoinHandle;

/// Handle to the sole background owner of established management state.
///
/// Command ports may have multiple producers, but sequence/header authority and
/// the physical stream remain inside one actor task.
pub struct AsyncEstablishedManagementActor {
    commands: Option<AsyncManagementCommandPort>,
    events: EventQueue,
    task: JoinHandle<()>,
    policy: AsyncManagementPolicy,
}

impl std::fmt::Debug for AsyncEstablishedManagementActor {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AsyncEstablishedManagementActor")
            .field("policy", &self.policy)
            .field("task_finished", &self.task.is_finished())
            .finish_non_exhaustive()
    }
}

impl AsyncEstablishedManagementActor {
    fn spawn<R, W>(
        actor: ManagementActor<W>,
        reader: AsyncFrameReader<R>,
        policy: AsyncManagementPolicy,
    ) -> Self
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (commands, command_receivers) = CommandQueues::new(&policy);
        let (event_sender, events) = EventQueue::new(policy.event_queue_frames());
        let task = tokio::spawn(actor.run(reader, command_receivers, event_sender));
        Self {
            commands: Some(commands),
            events,
            task,
            policy,
        }
    }

    /// # Panics
    ///
    /// Only test instrumentation can explicitly close the retained port.
    #[must_use]
    pub fn command_port(&self) -> AsyncManagementCommandPort {
        self.commands
            .as_ref()
            .expect("management command port remains open")
            .clone()
    }

    pub async fn receive(
        &mut self,
    ) -> Option<Result<AsyncManagementEvent, AsyncManagementActorError>> {
        self.events.receive().await
    }

    #[must_use]
    pub const fn policy(&self) -> &AsyncManagementPolicy {
        &self.policy
    }

    #[must_use]
    pub const fn session_policy(&self) -> &ManagementSessionPolicy {
        self.policy.session_policy()
    }

    #[cfg(test)]
    fn close_commands_for_test(&mut self) {
        drop(self.commands.take());
    }
}

impl Drop for AsyncEstablishedManagementActor {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[cfg(test)]
mod tests;
