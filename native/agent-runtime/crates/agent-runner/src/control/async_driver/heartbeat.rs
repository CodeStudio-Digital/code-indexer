use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use agent_protocol::generated::v1 as wire;
use tokio::io::{AsyncRead, AsyncWrite};

use super::operation::AsyncControlOperation;
use super::{AsyncControlDriverError, AsyncRunnerControlDriver};

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> AsyncRunnerControlDriver<S> {
    pub(crate) fn heartbeat_interval(&self) -> Result<Duration, AsyncControlDriverError> {
        self.session
            .heartbeat_interval_ms()
            .map(Duration::from_millis)
            .map_err(Into::into)
    }

    pub(crate) fn send_heartbeat(
        &mut self,
        last_progress_at_unix_ms: i64,
        last_event_seq: u64,
        resources: wire::ResourceSample,
    ) -> impl Future<Output = Result<i64, AsyncControlDriverError>> + '_ {
        let operation = if self.pending_prepare.is_some() {
            Err(AsyncControlDriverError::PrepareInFlight)
        } else {
            AsyncControlOperation::new(self)
        };
        async move {
            let mut operation = operation?;
            let result = {
                let (driver, channel) = operation.parts();
                driver
                    .send_heartbeat_inner(
                        channel,
                        last_progress_at_unix_ms,
                        last_event_seq,
                        resources,
                    )
                    .await
            };
            if result.is_ok() {
                operation.commit();
            }
            result
        }
    }

    async fn send_heartbeat_inner(
        &mut self,
        channel: &mut agent_protocol::frame::AsyncEstablishedAttemptChannel<S>,
        last_progress_at_unix_ms: i64,
        last_event_seq: u64,
        resources: wire::ResourceSample,
    ) -> Result<i64, AsyncControlDriverError> {
        let sent_at_unix_ms = self.now()?;
        if last_progress_at_unix_ms <= 0 || last_progress_at_unix_ms > sent_at_unix_ms {
            return self.close_with(AsyncControlDriverError::InvalidHeartbeatProgress {
                progress: last_progress_at_unix_ms,
                alive: sent_at_unix_ms,
            });
        }
        let semantic_deadline = self.session.effective_deadline_at_unix_ms();
        let physical_deadline = self.write_deadline(semantic_deadline, "heartbeat write")?;
        let payload = wire::FramePayload {
            body: Some(wire::frame_payload::Body::Heartbeat(wire::Heartbeat {
                identity: Some(self.session.launch.wire_identity().clone()),
                runtime_instance_id: self
                    .session
                    .launch
                    .runtime_instance_id()
                    .as_str()
                    .to_owned(),
                last_alive_at_unix_ms: sent_at_unix_ms,
                last_progress_at_unix_ms,
                last_event_seq,
                active_provider_operation_ids: Vec::new(),
                active_capability_operation_ids: Vec::new(),
                active_child_attempt_ids: Vec::new(),
                phase: wire::PhysicalAttemptPhase::Active as i32,
                resources: Some(resources),
            })),
        };
        let clock = Arc::clone(&self.clock);
        channel
            .send_new(&payload, semantic_deadline, physical_deadline, || {
                clock.now_unix_ms()
            })
            .await
            .map_err(AsyncControlDriverError::from)?;
        let completed_at = self.now()?;
        if completed_at < sent_at_unix_ms {
            return self.close_with(AsyncControlDriverError::ClockRegressed {
                operation: "heartbeat write",
                started_at: sent_at_unix_ms,
                completed_at,
            });
        }
        if completed_at >= semantic_deadline {
            return self.close_with(AsyncControlDriverError::DeadlineElapsed {
                operation: "heartbeat write",
                deadline: semantic_deadline,
                observed: completed_at,
            });
        }
        Ok(sent_at_unix_ms)
    }
}
