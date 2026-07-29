use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};

use agent_platform::budget::{BudgetError, ResourceBudget};
use agent_protocol::identity::{AttemptId, AttemptIdentity};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(
    clippy::struct_field_names,
    reason = "capacity fields mirror the max_* supervisor limit contract"
)]
pub struct SupervisorCapacity {
    pub max_active_attempts: u32,
    pub max_reserved_memory_bytes: u64,
    pub max_reserved_processes: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ReservedResources {
    memory_bytes: u64,
    processes: u32,
}

/// Non-cloneable proof that one admission reservation is currently owned.
#[derive(Debug, PartialEq, Eq)]
pub struct ReservationToken {
    attempt_id: AttemptId,
    fencing_epoch: u64,
    sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdmissionError {
    InvalidCapacity,
    InvalidBudget(BudgetError),
    DuplicateAttempt,
    AttemptsExhausted,
    MemoryExhausted,
    ProcessesExhausted,
    AccountingOverflow,
    StaleReservation,
}

impl Display for AdmissionError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(formatter, "supervisor admission failed: {self:?}")
    }
}

impl Error for AdmissionError {}

/// Bounded reservation ledger. Memory and process slots are reserved before
/// any platform spawn and returned only after physical reap.
#[derive(Debug)]
pub struct AdmissionLedger {
    capacity: SupervisorCapacity,
    reservations: BTreeMap<AttemptId, (u64, u64, ReservedResources)>,
    next_sequence: u64,
    reserved_memory_bytes: u64,
    reserved_processes: u32,
}

impl AdmissionLedger {
    /// Creates a ledger with explicit non-zero aggregate limits.
    ///
    /// # Errors
    ///
    /// Returns [`AdmissionError::InvalidCapacity`] for any zero capacity.
    pub const fn new(capacity: SupervisorCapacity) -> Result<Self, AdmissionError> {
        if capacity.max_active_attempts == 0
            || capacity.max_reserved_memory_bytes == 0
            || capacity.max_reserved_processes == 0
        {
            return Err(AdmissionError::InvalidCapacity);
        }
        Ok(Self {
            capacity,
            reservations: BTreeMap::new(),
            next_sequence: 1,
            reserved_memory_bytes: 0,
            reserved_processes: 0,
        })
    }

    /// Atomically reserves hard memory and process slots for an attempt.
    ///
    /// # Errors
    ///
    /// Rejects invalid budgets, duplicate attempts, exhausted aggregate limits
    /// and accounting overflow.
    pub fn reserve(
        &mut self,
        identity: &AttemptIdentity,
        budget: &ResourceBudget,
    ) -> Result<ReservationToken, AdmissionError> {
        budget.validate().map_err(AdmissionError::InvalidBudget)?;
        if self.reservations.contains_key(&identity.attempt_id) {
            return Err(AdmissionError::DuplicateAttempt);
        }
        if self.reservations.len() >= self.capacity.max_active_attempts as usize {
            return Err(AdmissionError::AttemptsExhausted);
        }

        let memory = self
            .reserved_memory_bytes
            .checked_add(budget.hard_memory_bytes)
            .ok_or(AdmissionError::AccountingOverflow)?;
        if memory > self.capacity.max_reserved_memory_bytes {
            return Err(AdmissionError::MemoryExhausted);
        }
        let processes = self
            .reserved_processes
            .checked_add(budget.max_processes)
            .ok_or(AdmissionError::AccountingOverflow)?;
        if processes > self.capacity.max_reserved_processes {
            return Err(AdmissionError::ProcessesExhausted);
        }

        let sequence = self.next_sequence;
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or(AdmissionError::AccountingOverflow)?;
        self.reservations.insert(
            identity.attempt_id.clone(),
            (
                identity.fencing_epoch,
                sequence,
                ReservedResources {
                    memory_bytes: budget.hard_memory_bytes,
                    processes: budget.max_processes,
                },
            ),
        );
        self.reserved_memory_bytes = memory;
        self.reserved_processes = processes;
        Ok(ReservationToken {
            attempt_id: identity.attempt_id.clone(),
            fencing_epoch: identity.fencing_epoch,
            sequence,
        })
    }

    /// Releases resources only for the exact currently-owned reservation.
    ///
    /// # Errors
    ///
    /// Returns [`AdmissionError::StaleReservation`] without changing totals if
    /// attempt, fence, or sequence no longer owns the reservation.
    pub fn release(&mut self, token: ReservationToken) -> Result<(), AdmissionError> {
        let ReservationToken {
            attempt_id,
            fencing_epoch: token_fence,
            sequence: token_sequence,
        } = token;
        let Some((fencing_epoch, sequence, resources)) =
            self.reservations.get(&attempt_id).copied()
        else {
            return Err(AdmissionError::StaleReservation);
        };
        if fencing_epoch != token_fence || sequence != token_sequence {
            return Err(AdmissionError::StaleReservation);
        }

        self.reservations.remove(&attempt_id);
        self.reserved_memory_bytes -= resources.memory_bytes;
        self.reserved_processes -= resources.processes;
        Ok(())
    }

    #[must_use]
    pub(crate) fn owns(&self, token: &ReservationToken) -> bool {
        self.reservations
            .get(&token.attempt_id)
            .is_some_and(|(fence, sequence, _)| {
                *fence == token.fencing_epoch && *sequence == token.sequence
            })
    }

    #[must_use]
    pub const fn reserved_memory_bytes(&self) -> u64 {
        self.reserved_memory_bytes
    }

    #[must_use]
    pub const fn reserved_processes(&self) -> u32 {
        self.reserved_processes
    }

    #[must_use]
    pub fn active_attempts(&self) -> usize {
        self.reservations.len()
    }
}

impl ReservationToken {
    pub(crate) fn opaque_id(&self) -> String {
        format!(
            "reservation:{:016x}:{:016x}",
            self.fencing_epoch, self.sequence
        )
    }
}

#[cfg(test)]
mod tests;
