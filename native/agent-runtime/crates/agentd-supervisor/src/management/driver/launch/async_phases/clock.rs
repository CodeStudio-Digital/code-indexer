use agent_platform::containment::ContainmentPort;

use super::super::super::cleanup::{FlooredLifecycleClock, LifecycleClockSampler};
use super::super::super::provision::ProtectedLaunchProvisionPort;
use super::super::super::state::CleanupStateError;
use super::super::super::{SupervisorDriverError, SupervisorLifecycleCore};
use super::super::operation::PhysicalLaunchState;
use crate::management::SupervisorLifecycleClock;

impl<P, V> SupervisorLifecycleCore<P, V>
where
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    pub(super) fn sample_async_gate(
        &mut self,
        state: &mut PhysicalLaunchState,
        clock: &dyn SupervisorLifecycleClock,
    ) -> Result<i64, SupervisorDriverError<P::Error>> {
        let floored = FlooredLifecycleClock::new(clock, state.clock_floor_unix_ms);
        let mut sampler = LifecycleClockSampler::new_floored_with_raw(
            &floored,
            self.last_observed_at_unix_ms,
            Some(state.last_raw_unix_ms),
        );
        let sample_result = sampler.sample();
        self.last_observed_at_unix_ms = sampler.last();
        let observed = sample_result?;
        state.last_gate_unix_ms = observed;
        state.last_raw_unix_ms = sampler
            .last_raw()
            .ok_or(CleanupStateError::InvalidTransition)?;
        Ok(observed)
    }

    pub(super) fn sample_after_async_owned_effect(
        &mut self,
        state: &mut PhysicalLaunchState,
        clock: &dyn SupervisorLifecycleClock,
    ) -> Result<i64, SupervisorDriverError<P::Error>> {
        let floored = FlooredLifecycleClock::new(clock, state.clock_floor_unix_ms);
        let mut sampler = LifecycleClockSampler::new_floored_with_raw(
            &floored,
            self.last_observed_at_unix_ms,
            Some(state.last_raw_unix_ms),
        );
        let observed = self.sample_after_owned_launch_effect(
            &state.ownership_key(),
            &mut sampler,
            state.last_gate_unix_ms,
        );
        self.last_observed_at_unix_ms = sampler.last();
        if let Ok(observed) = observed {
            state.last_gate_unix_ms = observed;
            state.last_raw_unix_ms = sampler
                .last_raw()
                .ok_or(CleanupStateError::InvalidTransition)?;
        }
        observed
    }
}
