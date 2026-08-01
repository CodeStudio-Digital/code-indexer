use std::fmt::{self, Debug, Formatter};
use std::time::Duration;

use agent_platform::windows::ipc::VerifiedWindowsEndpointStream;
use agent_protocol::generated::v1 as wire;
use agent_protocol::pulse_channel::RunnerPulseSender;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior};

use super::super::RunnerControlServiceError;
use super::initial_resources;

#[derive(Debug, Clone)]
struct RunnerPulseState {
    phase: wire::RunnerPulsePhase,
    last_progress_seq: u64,
    resources: wire::ResourceSample,
}

/// Control handle for the runner-owned periodic pulse task.
pub(in crate::bootstrap::control_service) struct RunnerPulsePump {
    state: watch::Sender<RunnerPulseState>,
    task: JoinHandle<()>,
}

impl RunnerPulsePump {
    pub(in crate::bootstrap::control_service) fn start(
        mut sender: RunnerPulseSender<VerifiedWindowsEndpointStream>,
        interval: Duration,
    ) -> Result<Self, RunnerControlServiceError> {
        if interval.is_zero() {
            return Err(RunnerControlServiceError::Pulse(
                agent_protocol::pulse_channel::RunnerPulseError::InvalidTimeout,
            ));
        }
        let initial = RunnerPulseState {
            phase: wire::RunnerPulsePhase::Negotiating,
            last_progress_seq: 0,
            resources: initial_resources(),
        };
        let (state, mut updates) = watch::channel(initial);
        let task = tokio::spawn(async move {
            let mut ticker = tokio::time::interval_at(Instant::now() + interval, interval);
            ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
            loop {
                let current = tokio::select! {
                    biased;
                    changed = updates.changed() => {
                        if changed.is_err() {
                            return;
                        }
                        updates.borrow_and_update().clone()
                    }
                    _ = ticker.tick() => updates.borrow().clone(),
                };
                if sender
                    .send(
                        current.phase,
                        current.last_progress_seq,
                        current.resources,
                        interval,
                    )
                    .await
                    .is_err()
                {
                    return;
                }
            }
        });
        Ok(Self { state, task })
    }

    pub(in crate::bootstrap::control_service) fn transition(
        &self,
        phase: wire::RunnerPulsePhase,
        last_progress_seq: u64,
    ) -> Result<(), RunnerControlServiceError> {
        if self.task.is_finished() {
            return Err(RunnerControlServiceError::PulsePumpStopped);
        }
        self.state
            .send(RunnerPulseState {
                phase,
                last_progress_seq,
                resources: initial_resources(),
            })
            .map_err(|_| RunnerControlServiceError::PulsePumpStopped)
    }
}

impl Drop for RunnerPulsePump {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Debug for RunnerPulsePump {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RunnerPulsePump")
            .field("task_finished", &self.task.is_finished())
            .finish_non_exhaustive()
    }
}
