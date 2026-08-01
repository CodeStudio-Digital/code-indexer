use std::fmt::{self, Debug, Formatter};
use std::time::Duration;

use super::provision::pulse::{
    ProtectedRunnerPulseMonitor, RunnerPulseMonitorState, RunnerPulseObservation,
};
use super::state::CleanupStateError;
use crate::process_table::OwnershipKey;

struct PulseEntry {
    monitor: ProtectedRunnerPulseMonitor,
    deadline_at_unix_ms: i64,
    last_counter: u64,
}

pub(super) struct PulseRegistry {
    maximum_entries: usize,
    entries: Vec<(OwnershipKey, PulseEntry)>,
}

impl PulseRegistry {
    pub(super) const fn new(maximum_entries: usize) -> Self {
        Self {
            maximum_entries,
            entries: Vec::new(),
        }
    }

    pub(super) fn insert(
        &mut self,
        key: OwnershipKey,
        monitor: ProtectedRunnerPulseMonitor,
        now_unix_ms: i64,
    ) -> Result<(), CleanupStateError> {
        if now_unix_ms <= 0
            || self.entries.len() >= self.maximum_entries
            || self.entries.iter().any(|(owned, _)| owned == &key)
        {
            return Err(CleanupStateError::InvalidTransition);
        }
        let mut entry = PulseEntry {
            deadline_at_unix_ms: monitor.hard_deadline_at_unix_ms(),
            monitor,
            last_counter: 0,
        };
        refresh(&mut entry, now_unix_ms)?;
        self.entries.push((key, entry));
        Ok(())
    }

    #[must_use]
    pub(super) fn next_deadline_unix_ms(&self) -> Option<i64> {
        self.entries
            .iter()
            .map(|(_, entry)| entry.deadline_at_unix_ms)
            .min()
    }

    pub(super) fn take_expired(
        &mut self,
        now_unix_ms: i64,
    ) -> Result<Vec<OwnershipKey>, CleanupStateError> {
        if now_unix_ms <= 0 {
            return Err(CleanupStateError::InvalidTime);
        }
        for (_, entry) in &mut self.entries {
            refresh(entry, now_unix_ms)?;
        }
        let expired = self
            .entries
            .iter()
            .filter(|(_, entry)| entry.deadline_at_unix_ms <= now_unix_ms)
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        self.entries.retain(|(key, _)| !expired.contains(key));
        Ok(expired)
    }

    pub(super) fn remove(&mut self, key: &OwnershipKey) {
        self.entries.retain(|(owned, _)| owned != key);
    }
}

fn refresh(entry: &mut PulseEntry, now_unix_ms: i64) -> Result<(), CleanupStateError> {
    match entry.monitor.latest() {
        RunnerPulseMonitorState::Failed => entry.deadline_at_unix_ms = now_unix_ms,
        RunnerPulseMonitorState::Live(observation) => {
            let counter = observation.monotonic_counter();
            if counter > entry.last_counter {
                entry.last_counter = counter;
                entry.deadline_at_unix_ms = observation_deadline(
                    &observation,
                    entry.monitor.timeout(),
                    entry.monitor.hard_deadline_at_unix_ms(),
                    now_unix_ms,
                )?;
            }
        }
    }
    Ok(())
}

fn observation_deadline(
    observation: &RunnerPulseObservation,
    timeout: Duration,
    hard_deadline_at_unix_ms: i64,
    now_unix_ms: i64,
) -> Result<i64, CleanupStateError> {
    let remaining = timeout.saturating_sub(observation.received_at().elapsed());
    let remaining_ms =
        i64::try_from(remaining.as_millis()).map_err(|_| CleanupStateError::DeadlineOverflow)?;
    now_unix_ms
        .checked_add(remaining_ms)
        .map(|deadline| deadline.min(hard_deadline_at_unix_ms))
        .ok_or(CleanupStateError::DeadlineOverflow)
}

impl Debug for PulseRegistry {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PulseRegistry")
            .field("maximum_entries", &self.maximum_entries)
            .field("active_monitors", &self.entries.len())
            .finish()
    }
}

#[cfg(test)]
mod tests;
