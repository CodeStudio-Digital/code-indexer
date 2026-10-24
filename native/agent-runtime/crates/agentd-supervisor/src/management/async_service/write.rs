use std::fmt::{self, Debug, Formatter};
use std::future::Future;
use std::pin::Pin;

use agent_platform::containment::ContainmentPort;
use agent_protocol::management_channel::{
    AsyncManagementActorError, AsyncQueuedManagementWrite, AsyncSentManagementFrame,
};

use super::{ServiceMode, SupervisorAsyncService, SupervisorAsyncServiceAdvance};
use crate::management::driver::{PreparedFactEmission, PreparedLaunchEmission};
use crate::management::{
    ManagementEnvelopeReceipt, OnlineLifecycleAdvance, ProtectedLaunchProvisionPort,
    SupervisorDriverStep, SupervisorLifecycleClock, SupervisorOnlineLifecycleTimer,
};
use crate::process_table::OwnershipKey;

type WriteFuture = Pin<
    Box<
        dyn Future<Output = Result<AsyncSentManagementFrame, AsyncManagementActorError>>
            + Send
            + 'static,
    >,
>;

#[derive(Debug)]
pub(super) enum PendingWriteCompletion {
    Fact(Box<PreparedFactEmission>),
    Launch(Box<PreparedLaunchEmission>),
    Shutdown,
    Termination(SupervisorDriverStep),
    Authority(SupervisorDriverStep),
}

pub(super) struct PendingServiceWrite {
    written: WriteFuture,
    completion: PendingWriteCompletion,
    failure_key: Option<OwnershipKey>,
}

impl PendingServiceWrite {
    fn new(
        queued: AsyncQueuedManagementWrite,
        completion: PendingWriteCompletion,
        failure_key: Option<OwnershipKey>,
    ) -> Self {
        Self {
            written: Box::pin(queued.written()),
            completion,
            failure_key,
        }
    }
}

impl Debug for PendingServiceWrite {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PendingServiceWrite")
            .field("completion", &self.completion)
            .field("failure_key", &self.failure_key)
            .finish_non_exhaustive()
    }
}

impl<P, V, C, T> SupervisorAsyncService<P, V, C, T>
where
    P: ContainmentPort + Send + Sync + 'static,
    P::Group: Send + 'static,
    V: ProtectedLaunchProvisionPort + Send + Sync + 'static,
    C: SupervisorLifecycleClock,
    T: SupervisorOnlineLifecycleTimer,
{
    pub(super) async fn queue_next_lifecycle_fact(
        &mut self,
    ) -> Option<SupervisorAsyncServiceAdvance<P::Error>> {
        let mut emission = self.lifecycle.owner_mut().take_lifecycle_fact()?;
        let failure_key = emission.failure_key().clone();
        let payload = emission.take_payload();
        let command_port = self.actor.command_port();
        let queued = match command_port.enqueue(payload) {
            Ok(queued) => queued,
            Err(error) => {
                return Some(self.close_after_write_failure(error, Some(failure_key)));
            }
        };
        drop(command_port);
        self.retain_write(
            queued,
            PendingWriteCompletion::Fact(Box::new(emission)),
            Some(failure_key),
        );
        Some(self.resume_pending_write().await)
    }

    pub(super) fn retain_write(
        &mut self,
        queued: AsyncQueuedManagementWrite,
        completion: PendingWriteCompletion,
        failure_key: Option<OwnershipKey>,
    ) {
        assert!(
            self.pending_write.is_none(),
            "management writes are serialized"
        );
        self.pending_write = Some(PendingServiceWrite::new(queued, completion, failure_key));
    }

    pub(super) async fn resume_pending_write(&mut self) -> SupervisorAsyncServiceAdvance<P::Error> {
        if let ServiceMode::HardRestart(error) = self.mode {
            return SupervisorAsyncServiceAdvance::HardRestartRequired(error);
        }
        loop {
            let wake = {
                let lifecycle = &mut self.lifecycle;
                let pending = self.pending_write.as_mut().expect("pending write");
                tokio::select! {
                    biased;
                    lifecycle = lifecycle.advance() => WriteWake::Lifecycle(lifecycle),
                    result = pending.written.as_mut() => WriteWake::Written(result),
                }
            };
            match wake {
                WriteWake::Written(result) => return self.complete_pending_write(result),
                WriteWake::Lifecycle(outcome) => {
                    let step = self.apply_lifecycle(outcome);
                    if matches!(step, SupervisorAsyncServiceAdvance::HardRestartRequired(_)) {
                        return step;
                    }
                }
            }
        }
    }

    fn complete_pending_write(
        &mut self,
        result: Result<AsyncSentManagementFrame, AsyncManagementActorError>,
    ) -> SupervisorAsyncServiceAdvance<P::Error> {
        let pending = self.pending_write.take().expect("pending write");
        let receipt = match result {
            Ok(receipt) => receipt,
            Err(error) => {
                return self.close_after_write_failure(error, pending.failure_key);
            }
        };
        match pending.completion {
            PendingWriteCompletion::Authority(step) => {
                SupervisorAsyncServiceAdvance::AuthorityUpdated(step)
            }
            PendingWriteCompletion::Shutdown => {
                let _committed_stream_seq = receipt.stream_seq();
                SupervisorAsyncServiceAdvance::ShutdownArmed
            }
            PendingWriteCompletion::Termination(step) => {
                let _committed_stream_seq = receipt.stream_seq();
                SupervisorAsyncServiceAdvance::TerminationScheduled(step)
            }
            PendingWriteCompletion::Fact(emission) => {
                let normalized = ManagementEnvelopeReceipt::from(&receipt);
                if let Err(error) = self
                    .lifecycle
                    .owner_mut()
                    .track_prepared_fact(&normalized, *emission)
                {
                    return self.fail_driver(error, pending.failure_key);
                }
                SupervisorAsyncServiceAdvance::ManagementAcknowledged
            }
            PendingWriteCompletion::Launch(emission) => {
                let normalized = ManagementEnvelopeReceipt::from(&receipt);
                match self
                    .lifecycle
                    .owner_mut()
                    .track_prepared_launch(&normalized, *emission)
                {
                    Ok(step) => SupervisorAsyncServiceAdvance::LaunchResolved(step),
                    Err(error) => self.fail_driver(error, pending.failure_key),
                }
            }
        }
    }
}

enum WriteWake {
    Lifecycle(OnlineLifecycleAdvance),
    Written(Result<AsyncSentManagementFrame, AsyncManagementActorError>),
}
