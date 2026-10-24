use agent_platform::containment::ContainmentPort;
use agent_protocol::management_channel::{
    AsyncAcknowledgedManagementInbound, AsyncManagementActorError, AsyncManagementEvent,
    AsyncPendingManagementInbound, ManagementPayloadKind,
};

use super::launch::{PendingLaunchPhase, PendingServiceLaunch};
use super::write::PendingWriteCompletion;
use super::{SupervisorAsyncService, SupervisorAsyncServiceAdvance};
use crate::management::driver::{AsyncLaunchStart, PendingPhysicalLaunchWorker};
use crate::management::{
    ProtectedLaunchProvisionPort, SupervisorDriverError, SupervisorLifecycleClock,
    SupervisorOnlineLifecycleTimer,
};

impl<P, V, C, T> SupervisorAsyncService<P, V, C, T>
where
    P: ContainmentPort + Send + Sync + 'static,
    P::Group: Send + 'static,
    V: ProtectedLaunchProvisionPort + Send + Sync + 'static,
    C: SupervisorLifecycleClock,
    T: SupervisorOnlineLifecycleTimer,
{
    pub(super) async fn dispatch(
        &mut self,
        event: AsyncManagementEvent,
    ) -> SupervisorAsyncServiceAdvance<P::Error> {
        match event {
            AsyncManagementEvent::Pending(pending) => self.dispatch_pending(pending).await,
            AsyncManagementEvent::Acknowledged(acknowledged) => {
                self.dispatch_acknowledgement(acknowledged).await
            }
            AsyncManagementEvent::Replay(_) => SupervisorAsyncServiceAdvance::Replay,
        }
    }

    async fn dispatch_pending(
        &mut self,
        mut pending: AsyncPendingManagementInbound,
    ) -> SupervisorAsyncServiceAdvance<P::Error> {
        let kind = pending.kind();
        let request_sent_at_unix_ms = pending.pending_mut().header().sent_at_unix_ms;
        let extracted = pending.pending_mut().take_validated_payload_and_digest();
        let (payload, digest) = match extracted {
            Ok(extracted) => extracted,
            Err(error) => {
                let actor_error = AsyncManagementActorError::Management(error);
                let _ = pending.reject();
                return self.fail_channel(actor_error);
            }
        };
        if matches!(kind, ManagementPayloadKind::LaunchAttemptProcess) {
            return Box::pin(self.dispatch_launch(
                pending,
                payload,
                digest,
                request_sent_at_unix_ms,
            ))
            .await;
        }
        if matches!(
            kind,
            ManagementPayloadKind::CancelAttemptProcess
                | ManagementPayloadKind::FenceAttemptProcess
                | ManagementPayloadKind::ReapAttemptProcess
        ) {
            return self.dispatch_termination(pending, &payload, digest).await;
        }
        if matches!(kind, ManagementPayloadKind::ShutdownSupervisor) {
            return self.dispatch_shutdown(pending, &payload, digest).await;
        }
        if matches!(kind, ManagementPayloadKind::UpdateAttemptAuthority) {
            return self
                .dispatch_authority_update(pending, &payload, digest)
                .await;
        }
        drop(payload);
        let rejected = pending.reject();
        if let Err(error) = rejected {
            return self.fail_channel(error);
        }
        self.fail_unsupported(
            kind.name(),
            SupervisorDriverError::UnsupportedInbound(kind.name()),
        )
    }

    async fn dispatch_launch(
        &mut self,
        pending: AsyncPendingManagementInbound,
        payload: agent_protocol::management_channel::ValidatedManagementPayload,
        digest: [u8; 32],
        request_sent_at_unix_ms: i64,
    ) -> SupervisorAsyncServiceAdvance<P::Error> {
        let received_at_unix_ms = self
            .lifecycle
            .owner_now_unix_ms()
            .max(request_sent_at_unix_ms);
        let started = {
            let (owner, clock) = self.lifecycle.owner_and_clock_mut();
            owner.start_async_launch(payload, digest, received_at_unix_ms, clock)
        };
        let started = match started {
            Ok(started) => started,
            Err(error) => {
                if let Err(actor_error) = pending.reject() {
                    return self.fail_channel(actor_error);
                }
                return self.fail_driver(error, None);
            }
        };
        let AsyncLaunchStart::Physical { mut state, worker } = started else {
            let AsyncLaunchStart::Immediate(emission) = started else {
                unreachable!("launch start variants are exhaustive");
            };
            return self.queue_launch_response(pending, emission).await;
        };
        let (containment, provisioner) = self.owner().physical_ports();
        let worker = match PendingPhysicalLaunchWorker::start(*worker, containment, provisioner) {
            Ok(worker) => worker,
            Err(error) => {
                drop(error);
                let rejected = {
                    let (owner, clock) = self.lifecycle.owner_and_clock_mut();
                    owner.reject_unstarted_async_launch(&mut state, clock)
                };
                return match rejected {
                    Ok(emission) => self.queue_launch_response(pending, emission).await,
                    Err(driver) => {
                        let _ = pending.reject();
                        self.fail_driver(driver, None)
                    }
                };
            }
        };
        debug_assert!(
            self.pending_launch.is_none(),
            "management protocol permits one pending inbound"
        );
        self.pending_launch = Some(PendingServiceLaunch {
            inbound: Some(pending),
            state,
            worker: Some(worker),
            phase: PendingLaunchPhase::Preparing,
            stop_result: None,
        });
        self.resume_pending_launch().await
    }

    pub(super) async fn queue_launch_response(
        &mut self,
        pending: AsyncPendingManagementInbound,
        mut emission: crate::management::driver::PreparedLaunchEmission,
    ) -> SupervisorAsyncServiceAdvance<P::Error> {
        let failure_key = emission.write_failure_key().cloned();
        let queued = match pending.respond(emission.take_payload()) {
            Ok(queued) => queued,
            Err(error) => return self.close_after_write_failure(error, failure_key),
        };
        self.retain_write(
            queued,
            PendingWriteCompletion::Launch(Box::new(emission)),
            failure_key,
        );
        self.resume_pending_write().await
    }

    async fn dispatch_termination(
        &mut self,
        pending: AsyncPendingManagementInbound,
        payload: &agent_protocol::management_channel::ValidatedManagementPayload,
        digest: [u8; 32],
    ) -> SupervisorAsyncServiceAdvance<P::Error> {
        let now_unix_ms = self.lifecycle.owner_now_unix_ms();
        let scheduled =
            match self
                .lifecycle
                .owner_mut()
                .schedule_termination(payload, digest, now_unix_ms)
            {
                Ok(scheduled) => scheduled,
                Err(failure) => {
                    let (error, immediate_key) = (*failure).into_parts();
                    let rejected = pending.reject();
                    if let Err(actor_error) = rejected {
                        return self.fail_channel(actor_error);
                    }
                    return self.fail_driver(error, immediate_key);
                }
            };
        let step = scheduled.step();
        let immediate_key = Some(scheduled.key().clone());
        let queued = match pending.acknowledge() {
            Ok(queued) => queued,
            Err(error) => return self.close_after_write_failure(error, immediate_key),
        };
        self.retain_write(
            queued,
            PendingWriteCompletion::Termination(step),
            immediate_key,
        );
        self.resume_pending_write().await
    }

    async fn dispatch_acknowledgement(
        &mut self,
        acknowledged: AsyncAcknowledgedManagementInbound,
    ) -> SupervisorAsyncServiceAdvance<P::Error> {
        let now_unix_ms = self.lifecycle.owner_now_unix_ms();
        let emission = self
            .lifecycle
            .owner_mut()
            .acknowledge_management_fact(acknowledged.acknowledgement(), now_unix_ms);
        let mut emission = match emission {
            Ok(Some(emission)) => emission,
            Ok(None) => return SupervisorAsyncServiceAdvance::ManagementAcknowledged,
            Err(error) => return self.fail_driver(error, None),
        };
        let failure_key = emission.failure_key().clone();
        let payload = emission.take_payload();
        let command_port = self.actor.command_port();
        let enqueue = command_port.enqueue(payload);
        drop(command_port);
        let queued = match enqueue {
            Ok(queued) => queued,
            Err(error) => {
                return self.close_after_write_failure(error, Some(failure_key));
            }
        };
        self.retain_write(
            queued,
            PendingWriteCompletion::Fact(Box::new(emission)),
            Some(failure_key),
        );
        self.resume_pending_write().await
    }
}
