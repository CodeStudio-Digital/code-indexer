use super::{TurnEngine, TurnEngineError, TurnOutcome};
use crate::lifecycle::RunState;
use crate::ports::{
    AuthorityCheckpoint, AuthorityPort, ClockPort, EngineEvent, EventSinkPort, ProviderUsage,
    TerminalClassification, TerminalRecord,
};

impl TurnEngine {
    pub(super) async fn provider_deadline_exceeded<P, A, E, C>(
        &mut self,
        usage: Option<ProviderUsage>,
        events: &mut E,
    ) -> Result<TurnOutcome, TurnEngineError<P, A, E::Error, C>>
    where
        E: EventSinkPort,
    {
        self.terminal(
            events,
            TerminalClassification::Interrupted,
            "deadline_exceeded",
            usage,
        )
        .await
    }

    pub(super) async fn provider_failed<P, A, E, C>(
        &mut self,
        provider_reason: &str,
        usage: Option<ProviderUsage>,
        events: &mut E,
    ) -> Result<TurnOutcome, TurnEngineError<P, A, E::Error, C>>
    where
        E: EventSinkPort,
    {
        // Shared tree consumption can run out before this member reaches its
        // local turn ceiling. Preserve that control outcome instead of
        // reporting a vendor failure. Fencing is deliberately not resumable.
        if provider_reason == "provider_run_tree_budget_exhausted" {
            return self
                .terminal(
                    events,
                    TerminalClassification::Interrupted,
                    "max_turns",
                    usage,
                )
                .await;
        }
        let reason = if valid_text(provider_reason) {
            "provider_failed"
        } else {
            "invalid_provider_terminal"
        };
        self.terminal(events, TerminalClassification::Failed, reason, usage)
            .await
    }

    pub(super) async fn provider_interrupted<P, A, E, C>(
        &mut self,
        provider_reason: &str,
        usage: Option<ProviderUsage>,
        events: &mut E,
    ) -> Result<TurnOutcome, TurnEngineError<P, A, E::Error, C>>
    where
        E: EventSinkPort,
    {
        let reason = if provider_reason == "ipc_identity_budget" {
            "ipc_identity_budget"
        } else if valid_text(provider_reason) {
            "provider_interrupted"
        } else {
            "invalid_provider_terminal"
        };
        self.terminal(events, TerminalClassification::Interrupted, reason, usage)
            .await
    }

    pub(super) async fn complete<P, A, E, C>(
        &mut self,
        operation_id: &str,
        response_id: Option<String>,
        text: String,
        usage: Option<ProviderUsage>,
        authority: &mut A,
        events: &mut E,
    ) -> Result<TurnOutcome, TurnEngineError<P, A::Error, E::Error, C>>
    where
        A: AuthorityPort,
        E: EventSinkPort,
    {
        if response_id
            .as_deref()
            .is_some_and(|value| !valid_text(value))
        {
            return self
                .terminal(
                    events,
                    TerminalClassification::Failed,
                    "invalid_provider_terminal",
                    usage,
                )
                .await;
        }
        events
            .append(EngineEvent::ProviderCompleted {
                operation_id,
                response_id: response_id.as_deref(),
            })
            .await
            .map_err(TurnEngineError::EventSink)?;
        authority
            .verify(AuthorityCheckpoint::TerminalDecision)
            .await
            .map_err(TurnEngineError::Authority)?;
        self.commit_terminal(
            events,
            TerminalClassification::Completed,
            "completed",
            usage,
        )
        .await?;
        Ok(TurnOutcome::Completed {
            response_id,
            text,
            usage,
        })
    }

    pub(super) async fn expired<C, P, A, E>(
        &self,
        deadline_at_unix_ms: i64,
        clock: &mut C,
    ) -> Result<bool, TurnEngineError<P, A, E, C::Error>>
    where
        C: ClockPort,
    {
        let now = clock.now_unix_ms().await.map_err(TurnEngineError::Clock)?;
        Ok(now <= 0 || now >= deadline_at_unix_ms)
    }

    pub(super) async fn terminal<P, A, E, C>(
        &mut self,
        events: &mut E,
        classification: TerminalClassification,
        reason_code: &'static str,
        usage: Option<ProviderUsage>,
    ) -> Result<TurnOutcome, TurnEngineError<P, A, E::Error, C>>
    where
        E: EventSinkPort,
    {
        self.commit_terminal(events, classification, reason_code, usage)
            .await?;
        Ok(match classification {
            TerminalClassification::Completed => {
                unreachable!("completed carries provider output")
            }
            TerminalClassification::Failed => TurnOutcome::Failed { reason_code },
            TerminalClassification::Interrupted => TurnOutcome::Interrupted { reason_code },
        })
    }

    pub(super) async fn commit_terminal<P, A, E, C>(
        &mut self,
        events: &mut E,
        classification: TerminalClassification,
        reason_code: &'static str,
        usage: Option<ProviderUsage>,
    ) -> Result<(), TurnEngineError<P, A, E::Error, C>>
    where
        E: EventSinkPort,
    {
        self.advance(RunState::Terminalizing)?;
        events
            .commit_terminal(TerminalRecord {
                classification,
                reason_code,
                usage,
            })
            .await
            .map_err(TurnEngineError::EventSink)?;
        self.advance(match classification {
            TerminalClassification::Completed => RunState::Completed,
            TerminalClassification::Failed => RunState::Failed,
            TerminalClassification::Interrupted => RunState::Interrupted,
        })
    }

    pub(super) fn advance<P, A, E, C>(
        &mut self,
        state: RunState,
    ) -> Result<(), TurnEngineError<P, A, E, C>> {
        self.lifecycle
            .transition(state)
            .map_err(TurnEngineError::Transition)
    }
}

pub(super) fn valid_text(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 1_024 && !value.contains('\0')
}
