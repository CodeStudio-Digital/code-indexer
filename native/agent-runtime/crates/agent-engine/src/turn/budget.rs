use super::{TurnEngine, TurnEngineError};
use crate::lifecycle::RunState;
use crate::ports::{AuthorityCheckpoint, AuthorityPort, EventSinkPort, TerminalClassification};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnBudgetLimit {
    Turns,
    ToolCalls,
}

impl TurnBudgetLimit {
    #[must_use]
    pub const fn reason_code(self) -> &'static str {
        match self {
            Self::Turns => "max_turns",
            Self::ToolCalls => "max_tool_calls",
        }
    }
}

impl TurnEngine {
    /// Pauses after a settled batch and its durable conversation checkpoint.
    ///
    /// # Errors
    /// Rejects an unsettled lifecycle, lost authority or failed terminal commit.
    pub async fn pause_at_budget_limit<A: AuthorityPort, E: EventSinkPort>(
        &mut self,
        limit: TurnBudgetLimit,
        authority: &mut A,
        events: &mut E,
    ) -> Result<(), TurnEngineError<(), A::Error, E::Error, ()>> {
        self.pause_at_settled_boundary(limit.reason_code(), authority, events)
            .await
    }

    /// Pauses after a confirmed workspace request and durable frontier.
    ///
    /// # Errors
    /// Rejects unsettled work, lost authority or a failed terminal commit.
    pub async fn pause_at_workspace_transition<A: AuthorityPort, E: EventSinkPort>(
        &mut self,
        authority: &mut A,
        events: &mut E,
    ) -> Result<(), TurnEngineError<(), A::Error, E::Error, ()>> {
        self.pause_at_settled_boundary("workspace_transition", authority, events)
            .await
    }

    async fn pause_at_settled_boundary<A: AuthorityPort, E: EventSinkPort>(
        &mut self,
        reason: &'static str,
        authority: &mut A,
        events: &mut E,
    ) -> Result<(), TurnEngineError<(), A::Error, E::Error, ()>> {
        if self.state() != RunState::Composing {
            return Err(TurnEngineError::Transition(
                crate::lifecycle::InvalidRunTransition {
                    from: self.state(),
                    to: RunState::Terminalizing,
                },
            ));
        }
        authority
            .verify(AuthorityCheckpoint::TerminalDecision)
            .await
            .map_err(TurnEngineError::Authority)?;
        self.commit_terminal(events, TerminalClassification::Interrupted, reason, None)
            .await
    }

    /// Pauses at the provider-turn limit after a durable settled checkpoint.
    ///
    /// # Errors
    /// Rejects unsettled state, lost authority or a failed terminal commit.
    pub async fn pause_at_turn_limit<A: AuthorityPort, E: EventSinkPort>(
        &mut self,
        authority: &mut A,
        events: &mut E,
    ) -> Result<(), TurnEngineError<(), A::Error, E::Error, ()>> {
        self.pause_at_budget_limit(TurnBudgetLimit::Turns, authority, events)
            .await
    }
}
