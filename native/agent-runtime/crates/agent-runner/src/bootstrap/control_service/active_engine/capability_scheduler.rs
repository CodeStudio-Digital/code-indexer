use std::future::{Future, poll_fn};
use std::pin::Pin;
use std::task::Poll;

use agent_engine::ports::{AuthorityPort, ClockPort, EventSinkPort, ProviderToolCall};
use agent_engine::turn::CapabilityBatch;
use agent_tools::capability::{
    CapabilityExecutionOutcome, CapabilityReadBatchPort, ExecutionClass, SealedExecutionGrant,
};
use tokio::sync::Mutex;

use super::error::ActiveEngineError;
use crate::native_tools::NativeToolExecutor;

mod host_reads;
mod shared_ports;
use shared_ports::SharedPort;

pub(super) fn window_size(calls: &[ProviderToolCall]) -> usize {
    let class = calls.first().map(|call| call.execution_class);
    let safe = |call: &&ProviderToolCall| {
        call.parallel_safe
            && call.read_only
            && !call.mutates
            && matches!(
                call.execution_class,
                ExecutionClass::NativeRead | ExecutionClass::HostCapability
            )
            && Some(call.execution_class) == class
    };
    if calls.first().is_some_and(|call| safe(&call)) {
        calls.iter().take(4).take_while(safe).count()
    } else {
        1
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn execute_window<G, A, E, C>(
    batch: &CapabilityBatch,
    calls: &[ProviderToolCall],
    grants: &[SealedExecutionGrant],
    capability_set_sha256: [u8; 32],
    deadline: i64,
    gateway: &G,
    authority: &mut A,
    events: &mut E,
    clock: &mut C,
) -> Result<Vec<CapabilityExecutionOutcome>, ActiveEngineError>
where
    G: CapabilityReadBatchPort + Clone + Sync,
    A: AuthorityPort,
    E: EventSinkPort,
    C: ClockPort,
{
    if calls.len() > 1
        && calls.iter().all(|call| {
            call.execution_class == ExecutionClass::HostCapability
                && call.read_only
                && call.parallel_safe
                && !call.mutates
        })
    {
        return host_reads::execute(
            batch,
            calls,
            grants,
            capability_set_sha256,
            deadline,
            &mut gateway.clone(),
            authority,
            events,
            clock,
        )
        .await;
    }
    let authority = Mutex::new(authority);
    let events = Mutex::new(events);
    let clock = Mutex::new(clock);
    let futures: Vec<_> = calls
        .iter()
        .zip(grants)
        .map(|(call, grant)| {
            let mut gateway = gateway.clone();
            let (authority, events, clock) = (&authority, &events, &clock);
            async move {
                let mut authority = SharedPort(authority);
                let mut events = SharedPort(events);
                let mut clock = SharedPort(clock);
                let result = if call.execution_class == ExecutionClass::HostCapability {
                    batch
                        .execute(
                            call,
                            capability_set_sha256,
                            deadline,
                            grant,
                            &mut gateway,
                            &mut authority,
                            &mut events,
                            &mut clock,
                        )
                        .await
                } else {
                    batch
                        .execute(
                            call,
                            capability_set_sha256,
                            deadline,
                            grant,
                            &mut NativeToolExecutor,
                            &mut authority,
                            &mut events,
                            &mut clock,
                        )
                        .await
                };
                result.map_err(|_| ActiveEngineError::CapabilityExecutionFailed)
            }
        })
        .collect();
    collect_ordered(futures).await
}

// Poll every member, publish via its own durable sink as it completes, and
// drain all started work even if another member fails. Return model input in
// provider order; never resubmit a failed or ambiguous member.
async fn collect_ordered<T, F>(futures: Vec<F>) -> Result<Vec<T>, ActiveEngineError>
where
    F: Future<Output = Result<T, ActiveEngineError>>,
{
    let mut pending: Vec<Option<Pin<Box<F>>>> =
        futures.into_iter().map(|f| Some(Box::pin(f))).collect();
    let mut results: Vec<Option<T>> = (0..pending.len()).map(|_| None).collect();
    let mut failure = None;
    for _ in 0..pending.len() {
        let (index, result) = poll_fn(|cx| {
            for (index, future) in pending.iter_mut().enumerate() {
                if let Some(future) = future
                    && let Poll::Ready(value) = future.as_mut().poll(cx)
                {
                    return Poll::Ready((index, value));
                }
            }
            Poll::Pending
        })
        .await;
        pending[index] = None;
        match result {
            Ok(value) => results[index] = Some(value),
            Err(error) => {
                failure.get_or_insert(error);
            }
        }
    }
    if let Some(error) = failure {
        return Err(error);
    }
    results
        .into_iter()
        .map(|value| value.ok_or(ActiveEngineError::CapabilityExecutionFailed))
        .collect()
}

#[cfg(test)]
mod tests;
