use agent_tools::capability::{
    CapabilityExecutionOutcome, CapabilityExecutorPort, SealedExecutionGrant,
};

use super::{CapabilityExecutionError, TurnEngine, TurnEngineError};
use crate::lifecycle::{InvalidRunTransition, RunState};
use crate::ports::{AuthorityPort, ClockPort, EventSinkPort, ProviderToolCall};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

/// Issued only while the engine owns a capability boundary. Each member still
/// crosses its own authority, durable-start and durable-terminal barriers.
#[derive(Debug)]
pub struct CapabilityBatch {
    pub(super) state: Arc<BatchState>,
}

#[derive(Debug)]
pub(super) struct BatchState {
    calls: Vec<ProviderToolCall>,
    started: Vec<AtomicBool>,
    settled: AtomicUsize,
    issued: AtomicBool,
}

impl CapabilityBatch {
    pub(super) fn reserve(&self, call: &ProviderToolCall) -> bool {
        self.state
            .calls
            .iter()
            .position(|expected| expected == call)
            .is_some_and(|index| !self.state.started[index].swap(true, Ordering::AcqRel))
    }

    pub(super) fn mark_settled(&self) {
        self.state.settled.fetch_add(1, Ordering::Release);
    }
}

impl TurnEngine {
    pub(super) fn stage_capabilities(&mut self, calls: &[ProviderToolCall]) {
        self.capability_boundary = Some(Arc::new(BatchState {
            calls: calls.to_vec(),
            started: calls.iter().map(|_| AtomicBool::new(false)).collect(),
            settled: AtomicUsize::new(0),
            issued: AtomicBool::new(false),
        }));
    }

    /// Opens execution at the current capability boundary.
    ///
    /// # Errors
    /// Rejects callers outside capability dispatch.
    pub fn capability_batch(&self) -> Result<CapabilityBatch, InvalidRunTransition> {
        let Some(state) = self.capability_boundary.as_ref().filter(|state| {
            self.state() == RunState::CapabilityDispatch
                && !state.issued.swap(true, Ordering::AcqRel)
        }) else {
            return Err(InvalidRunTransition {
                from: self.state(),
                to: RunState::CapabilityDispatch,
            });
        };
        Ok(CapabilityBatch {
            state: Arc::clone(state),
        })
    }

    /// Advances only after every started member has settled durably.
    ///
    /// # Errors
    /// Rejects a changed lifecycle state.
    pub fn finish_capability_batch(
        &mut self,
        batch: CapabilityBatch,
    ) -> Result<(), InvalidRunTransition> {
        if self.state() != RunState::CapabilityDispatch
            || !self
                .capability_boundary
                .as_ref()
                .is_some_and(|state| Arc::ptr_eq(state, &batch.state))
            || batch.state.settled.load(Ordering::Acquire) != batch.state.calls.len()
        {
            return Err(InvalidRunTransition {
                from: self.state(),
                to: RunState::Composing,
            });
        }
        self.lifecycle.transition(RunState::Composing)?;
        drop(batch);
        self.capability_boundary = None;
        Ok(())
    }

    /// Stops a batch after all dispatched members have committed their outcome.
    /// Undispatched members are abandoned and can never authorize another turn.
    ///
    /// # Errors
    /// Rejects foreign batches, unsettled effects, and failed terminal commits.
    pub async fn interrupt_capability_batch<E: EventSinkPort>(
        &mut self,
        batch: CapabilityBatch,
        events: &mut E,
    ) -> Result<(), TurnEngineError<(), (), E::Error, ()>> {
        let started = batch
            .state
            .started
            .iter()
            .filter(|started| started.load(Ordering::Acquire))
            .count();
        if self.state() != RunState::CapabilityDispatch
            || !self
                .capability_boundary
                .as_ref()
                .is_some_and(|state| Arc::ptr_eq(state, &batch.state))
            || batch.state.settled.load(Ordering::Acquire) != started
        {
            return Err(TurnEngineError::Transition(InvalidRunTransition {
                from: self.state(),
                to: RunState::Terminalizing,
            }));
        }
        self.commit_terminal(
            events,
            crate::ports::TerminalClassification::Interrupted,
            "capability_execution_interrupted",
            None,
        )
        .await?;
        self.capability_boundary = None;
        Ok(())
    }

    /// Executes one capability using the same barriers as a batch member.
    ///
    /// # Errors
    /// Returns an authority, commit, deadline or lifecycle failure.
    #[allow(clippy::too_many_arguments)]
    pub async fn execute_capability<X, A, E, C>(
        &mut self,
        call: &ProviderToolCall,
        capability_set_sha256: [u8; 32],
        deadline_at_unix_ms: i64,
        grant: &SealedExecutionGrant,
        executor: &mut X,
        authority: &mut A,
        events: &mut E,
        clock: &mut C,
    ) -> Result<CapabilityExecutionOutcome, CapabilityExecutionError<A::Error, E::Error, C::Error>>
    where
        X: CapabilityExecutorPort,
        A: AuthorityPort,
        E: EventSinkPort,
        C: ClockPort,
    {
        let batch = self
            .capability_batch()
            .map_err(|_| CapabilityExecutionError::InvalidState)?;
        let outcome = batch
            .execute(
                call,
                capability_set_sha256,
                deadline_at_unix_ms,
                grant,
                executor,
                authority,
                events,
                clock,
            )
            .await?;
        self.finish_capability_batch(batch)
            .map_err(CapabilityExecutionError::Transition)?;
        Ok(outcome)
    }
}
