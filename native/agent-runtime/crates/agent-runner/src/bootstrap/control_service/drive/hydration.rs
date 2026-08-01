use agent_platform::ipc::{EndpointCancellation, endpoint_cancellation};
use agent_platform::windows::ipc::VerifiedWindowsEndpointStream;
use tokio::time::{Instant, sleep_until};

use super::super::RunnerControlServiceError;
use super::super::data::PendingRunnerDataHydration;
use super::super::hydration::RunnerHydrationRequest;
use super::super::hydration::transport::pump::CompletedHydrationPump;

/// Receives the stop-and-wait hydration transaction under local cancellation
/// and the immutable attempt deadline.
///
/// The accepted `PrepareAttempt` remains the control receiver's one pending
/// transaction until `AttemptPrepared` commits, so the same stream cannot
/// admit another control frame during this interval. Supervisor containment
/// and endpoint closure remain the asynchronous abort authorities.
pub(super) async fn receive_with_terminal_guards(
    cancellation: &mut EndpointCancellation,
    data: PendingRunnerDataHydration,
    request: RunnerHydrationRequest,
    deadline: Instant,
) -> Result<CompletedHydrationPump<VerifiedWindowsEndpointStream>, RunnerControlServiceError> {
    let (data_cancellation_authority, mut data_cancellation) = endpoint_cancellation();
    let mut receive = Box::pin(data.receive(request, &mut data_cancellation));
    tokio::select! {
        biased;
        () = cancellation.cancelled() => {
            data_cancellation_authority.cancel();
            Err(RunnerControlServiceError::Cancelled)
        }
        () = sleep_until(deadline) => {
            data_cancellation_authority.cancel();
            Err(RunnerControlServiceError::DeadlineElapsed)
        }
        result = &mut receive => result.map_err(RunnerControlServiceError::hydration),
    }
}
