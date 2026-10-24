use super::ActiveEngineError;
use agent_engine::{
    ports::{AuthorityCheckpoint, AuthorityPort, ClockPort, EventSinkPort, ProviderToolCall},
    turn::CapabilityBatch,
};
use agent_tools::capability::{
    CapabilityExecutionOutcome, CapabilityFailure, CapabilityReadBatchPort, SealedExecutionGrant,
};

#[allow(clippy::too_many_arguments)]
pub(super) async fn execute<
    G: CapabilityReadBatchPort,
    A: AuthorityPort,
    E: EventSinkPort,
    C: ClockPort,
>(
    batch: &CapabilityBatch,
    calls: &[ProviderToolCall],
    grants: &[SealedExecutionGrant],
    digest: [u8; 32],
    deadline: i64,
    gateway: &mut G,
    authority: &mut A,
    events: &mut E,
    clock: &mut C,
) -> Result<Vec<CapabilityExecutionOutcome>, ActiveEngineError> {
    if calls.len() != grants.len() || !(2..=4).contains(&calls.len()) {
        return Err(ActiveEngineError::CapabilityExecutionFailed);
    }
    let mut started = Vec::with_capacity(calls.len());
    for (call, grant) in calls.iter().zip(grants) {
        started.push(Some(
            batch
                .start(call, digest, deadline, grant, authority, events, clock)
                .await
                .map_err(|_| ActiveEngineError::CapabilityExecutionFailed)?,
        ));
    }
    let members: Vec<_> = started
        .iter()
        .flatten()
        .map(|token| (token.invocation().clone(), token.grant().clone()))
        .collect();
    let mut failure = if authority
        .verify(AuthorityCheckpoint::CapabilityEffect)
        .await
        .is_err()
    {
        Some(CapabilityExecutionOutcome::Cancelled(CapabilityFailure {
            reason_code: "authority_revoked_before_effect".into(),
            duration_ms: 0,
        }))
    } else if gateway.start_read_batch(&members).await.is_err() {
        Some(unknown())
    } else {
        None
    };
    let mut outcomes: Vec<Option<CapabilityExecutionOutcome>> =
        (0..calls.len()).map(|_| None).collect();
    for _ in 0..calls.len() {
        let next = if let Some(outcome) = &failure {
            started
                .iter()
                .position(Option::is_some)
                .map(|index| (index, outcome.clone()))
        } else if let Ok((id, outcome)) = gateway.next_read_result().await {
            let index = started
                .iter()
                .position(|token| {
                    token
                        .as_ref()
                        .is_some_and(|t| t.invocation().operation_id == id)
                })
                .ok_or(ActiveEngineError::CapabilityExecutionFailed)?;
            Some((index, outcome))
        } else {
            failure = Some(unknown());
            started
                .iter()
                .position(Option::is_some)
                .map(|index| (index, unknown()))
        };
        let (index, outcome) = next.ok_or(ActiveEngineError::CapabilityExecutionFailed)?;
        let token = started[index]
            .take()
            .ok_or(ActiveEngineError::CapabilityExecutionFailed)?;
        // Release the Data client between completions. This durable ACK and
        // publication happen while the slower members continue on the Host.
        outcomes[index] = Some(
            batch
                .settle::<A::Error, E, C::Error>(token, outcome, events)
                .await
                .map_err(|_| ActiveEngineError::CapabilityExecutionFailed)?,
        );
    }
    outcomes
        .into_iter()
        .map(|value| value.ok_or(ActiveEngineError::CapabilityExecutionFailed))
        .collect()
}

fn unknown() -> CapabilityExecutionOutcome {
    CapabilityExecutionOutcome::OutcomeUnknown(CapabilityFailure {
        reason_code: "executor_result_ambiguous".into(),
        duration_ms: 0,
    })
}
