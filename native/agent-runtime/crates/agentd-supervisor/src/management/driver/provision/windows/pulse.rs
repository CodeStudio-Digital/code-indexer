use std::time::{Duration, Instant as StdInstant, SystemTime, UNIX_EPOCH};

use agent_platform::ipc::ExpectedLocalPeer;
use agent_platform::windows::ipc::WindowsProtectedEndpoint;
use agent_protocol::generated::v1 as wire;
use agent_protocol::pulse_channel::{RunnerPulseIdentity, SupervisorPulseReceiver};
use tokio::runtime::Runtime;
use tokio::sync::watch;
use tokio::time::Instant;

use super::super::deadline::EffectiveBootstrapDeadline;
use super::super::pulse::{
    ProtectedRunnerPulseMonitor, ProtectedRunnerPulseReceipt, RunnerPulseMonitorState,
    RunnerPulseObservation,
};
use super::super::staged::{PendingProtectedLaunch, ProtectedLaunchPhysicalFacts};
use super::WindowsProtectedLaunchError;

const DEFAULT_STARTUP_TIMEOUT: Duration = Duration::from_secs(15);

pub(super) fn establish_initial_pulse<P>(
    pending: &mut PendingProtectedLaunch<P>,
    physical: &ProtectedLaunchPhysicalFacts,
    startup_deadline: EffectiveBootstrapDeadline,
    startup_timeout: Duration,
    pulse_timeout: Duration,
    runtime: &Runtime,
) -> Result<ProtectedRunnerPulseReceipt, WindowsProtectedLaunchError> {
    let hard_deadline_at_unix_ms = pending.handoff_facts().hard_deadline_at_unix_ms();
    let authority = pending
        .take_runner_pulse_authority()
        .ok_or(WindowsProtectedLaunchError::PulseAuthority)?
        .map_err(WindowsProtectedLaunchError::Pulse)?;
    let (identity, runtime_instance_id, address, key) = authority.into_parts();
    let expected_runner = ExpectedLocalPeer::new(physical.process_id())
        .map_err(WindowsProtectedLaunchError::PulseEndpoint)?;
    let hard_deadline = physical_deadline(hard_deadline_at_unix_ms)?;
    let (mut receiver, initial) = runtime.block_on(async move {
        let client = WindowsProtectedEndpoint::connect_expected_address(&address, expected_runner)
            .map_err(WindowsProtectedLaunchError::PulseEndpoint)?;
        let identity = RunnerPulseIdentity::from_attempt(&identity, runtime_instance_id)
            .map_err(WindowsProtectedLaunchError::Pulse)?;
        let mut receiver = SupervisorPulseReceiver::new(client, identity, key, hard_deadline)
            .map_err(WindowsProtectedLaunchError::Pulse)?;
        let initial_timeout = startup_timeout.min(
            startup_deadline
                .instant()
                .saturating_duration_since(StdInstant::now()),
        );
        let initial = receiver
            .receive(initial_timeout)
            .await
            .map_err(WindowsProtectedLaunchError::Pulse)?;
        Ok::<_, WindowsProtectedLaunchError>((receiver, initial))
    })?;
    if initial.phase() != wire::RunnerPulsePhase::Negotiating
        || initial.monotonic_counter() != 1
        || initial.last_progress_seq() != 0
    {
        return Err(WindowsProtectedLaunchError::PulsePhase);
    }
    let observation = RunnerPulseObservation::new(&initial, StdInstant::now());
    let (updates, monitor) = watch::channel(RunnerPulseMonitorState::Live(observation));
    runtime.spawn(async move {
        loop {
            let outcome = tokio::select! {
                biased;
                () = updates.closed() => return,
                result = receiver.receive(pulse_timeout) => result,
            };
            if let Ok(pulse) = outcome {
                let state = RunnerPulseMonitorState::Live(RunnerPulseObservation::new(
                    &pulse,
                    StdInstant::now(),
                ));
                if updates.send(state).is_err() {
                    return;
                }
            } else {
                let _ = updates.send(RunnerPulseMonitorState::Failed);
                return;
            }
        }
    });
    Ok(ProtectedRunnerPulseReceipt::new_windows(
        ProtectedRunnerPulseMonitor::new_windows(monitor, pulse_timeout, hard_deadline_at_unix_ms),
        initial,
    ))
}

fn physical_deadline(deadline_at_unix_ms: i64) -> Result<Instant, WindowsProtectedLaunchError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| WindowsProtectedLaunchError::Clock)?;
    let now = i64::try_from(now.as_millis()).map_err(|_| WindowsProtectedLaunchError::Clock)?;
    if now >= deadline_at_unix_ms {
        return Err(WindowsProtectedLaunchError::AuthorityExpired);
    }
    let remaining = u64::try_from(deadline_at_unix_ms - now)
        .map_err(|_| WindowsProtectedLaunchError::AuthorityExpired)?;
    Instant::now()
        .checked_add(Duration::from_millis(remaining))
        .ok_or(WindowsProtectedLaunchError::AuthorityExpired)
}

impl Drop for super::WindowsProtectedLaunchProvisioner {
    fn drop(&mut self) {
        if let Some(runtime) = self.pulse_runtime.take() {
            runtime.shutdown_background();
        }
    }
}

impl Default for super::WindowsProtectedLaunchProvisioner {
    fn default() -> Self {
        Self::new(DEFAULT_STARTUP_TIMEOUT).expect("default startup timeout is non-zero")
    }
}
