use agent_platform::ipc::{EndpointCancellation, endpoint_cancellation};
use agent_platform::windows::ipc::VerifiedWindowsEndpointStream;
use tokio::time::{Instant, sleep_until};

use crate::control::{
    ActivationOutcome, AsyncRunnerControlDriver, ControlDriverEvent, PrepareOutcome,
};

use super::super::RunnerControlServiceError;
use super::super::data::PendingRunnerDataHydration;
use super::super::hydration::RunnerHydrationRequest;
use super::super::hydration::transport::pump::CompletedHydrationPump;

pub(super) async fn receive_while_control_responsive(
    driver: &mut AsyncRunnerControlDriver<VerifiedWindowsEndpointStream>,
    cancellation: &mut EndpointCancellation,
    data: PendingRunnerDataHydration,
    request: RunnerHydrationRequest,
    deadline: Instant,
) -> Result<CompletedHydrationPump<VerifiedWindowsEndpointStream>, RunnerControlServiceError> {
    let (data_cancellation_authority, mut data_cancellation) = endpoint_cancellation();
    let mut receive = Box::pin(data.receive(request, &mut data_cancellation));
    loop {
        let selected = tokio::select! {
            biased;
            () = cancellation.cancelled() => {
                data_cancellation_authority.cancel();
                return Err(RunnerControlServiceError::Cancelled);
            }
            () = sleep_until(deadline) => {
                data_cancellation_authority.cancel();
                return Err(RunnerControlServiceError::DeadlineElapsed);
            }
            result = &mut receive => {
                return result.map_err(RunnerControlServiceError::hydration);
            }
            result = driver.receive_next() => {
                result.map_err(RunnerControlServiceError::Driver)?
            }
        };
        match selected {
            ControlDriverEvent::Replayed(_)
            | ControlDriverEvent::Prepare(
                PrepareOutcome::AlreadyPrepared | PrepareOutcome::HydrationInProgress,
            ) => {}
            ControlDriverEvent::Cancel(_) | ControlDriverEvent::Fence(_) => {
                data_cancellation_authority.cancel();
                return Err(RunnerControlServiceError::UnexpectedPreActiveTermination);
            }
            ControlDriverEvent::Prepare(PrepareOutcome::HydrationRequired(_))
            | ControlDriverEvent::Activate(
                ActivationOutcome::Activated | ActivationOutcome::AlreadyActive,
            ) => {
                data_cancellation_authority.cancel();
                return Err(RunnerControlServiceError::HydrationAlreadyConsumed);
            }
        }
    }
}
