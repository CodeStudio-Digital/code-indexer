use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use tokio::time::Instant;

use super::{ActiveRunnerExitReason, CancelOutcome};

const TERMINATION_ACK_DRAIN: Duration = Duration::from_millis(50);

pub type SettlementHook<R> = for<'a> fn(&'a mut R) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>>;

/// Retains the verified Control owner while a flushed response is received and
/// already-started Data work settles within the original cancellation deadline.
pub(super) async fn drain_terminal_response<R: Send>(
    resources: &mut R,
    reason: &ActiveRunnerExitReason,
    hard_deadline: Instant,
    owner_now_unix_ms: impl FnOnce() -> i64 + Send,
    settlement: Option<SettlementHook<R>>,
) {
    // V1 has no ACK-of-ACK. Keep the verified Control owner alive briefly after
    // the physically flushed terminal response so the Host framing loop can
    // commit it before Windows reports peer EOF.
    if matches!(
        reason,
        ActiveRunnerExitReason::RemoteCancelled(_) | ActiveRunnerExitReason::Fenced(_)
    ) {
        tokio::time::sleep(TERMINATION_ACK_DRAIN).await;
    }
    if let (Some(settle), ActiveRunnerExitReason::RemoteCancelled(outcome)) = (settlement, reason) {
        let (CancelOutcome::Accepted(cancelled) | CancelOutcome::AlreadyAccepted(cancelled)) =
            outcome;
        let remaining = cancelled
            .grace_deadline_at_unix_ms()
            .saturating_sub(owner_now_unix_ms());
        if remaining > 0 {
            let deadline = (Instant::now() + Duration::from_millis(remaining.cast_unsigned()))
                .min(hard_deadline);
            let _ = tokio::time::timeout_at(deadline, settle(resources)).await;
        }
    }
}
