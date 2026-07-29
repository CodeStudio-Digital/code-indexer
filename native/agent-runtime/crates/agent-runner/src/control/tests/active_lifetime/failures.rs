use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use agent_platform::ipc::endpoint_cancellation;
use agent_protocol::frame::AsyncEstablishedChannelError;
use agent_protocol::framing::AsyncFramingError;

use super::support::{ActiveTestClock, active_with_clock, active_with_raw_tail, assert_revoked};
use crate::control::AsyncControlDriverError;
use crate::control::active_lifetime::{ActiveRunnerExitReason, ActiveRunnerLifetimeAdvance};
use crate::control::authority::EffectClock;
use crate::control::tests::support::{ManualClock, activate_frame_with_deadline};
use crate::lifecycle::RunnerState;

#[tokio::test(start_paused = true)]
async fn partial_frame_timeout_revokes_and_preserves_cleanup_owner() {
    let clock = ManualClock::new(1_000);
    let (lifetime, _, gate, drops) = active_with_raw_tail([], clock, Some(1), &[0x80]).await;
    let token = gate.token().expect("effect token");
    let (_handle, mut cancellation) = endpoint_cancellation();

    let ActiveRunnerLifetimeAdvance::CleanupRequired(cleanup) =
        Box::pin(lifetime.advance(&mut cancellation)).await
    else {
        panic!("partial frame cannot continue");
    };

    assert!(matches!(
        cleanup.reason(),
        ActiveRunnerExitReason::ProtocolFailure(AsyncControlDriverError::Channel(
            AsyncEstablishedChannelError::Framing(AsyncFramingError::ReadDeadlineElapsed)
        ))
    ));
    assert_eq!(cleanup.final_state(), RunnerState::Exiting);
    assert_revoked(&gate, &token);
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    cleanup.close_local();
    assert_eq!(drops.load(Ordering::SeqCst), 1);
}

#[derive(Clone, Debug)]
struct PostIoExpiryClock {
    base: ManualClock,
    armed: Arc<AtomicBool>,
    reads: Arc<AtomicUsize>,
}

impl PostIoExpiryClock {
    fn new(now: i64) -> Self {
        Self {
            base: ManualClock::new(now),
            armed: Arc::new(AtomicBool::new(false)),
            reads: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn arm(&self) {
        self.reads.store(0, Ordering::SeqCst);
        self.armed.store(true, Ordering::SeqCst);
    }
}

impl EffectClock for PostIoExpiryClock {
    fn now_unix_ms(&self) -> i64 {
        if !self.armed.load(Ordering::SeqCst) {
            return self.base.now();
        }
        match self.reads.fetch_add(1, Ordering::SeqCst) {
            0 => 8_000,
            1 => 8_999,
            _ => 9_000,
        }
    }
}

impl ActiveTestClock for PostIoExpiryClock {
    fn set_now(&self, now: i64) {
        self.base.set(now);
    }
}

#[tokio::test]
async fn semantic_expiry_after_io_cannot_continue_active() {
    let duplicate = activate_frame_with_deadline("activate-active", 3, 9_000);
    let clock = PostIoExpiryClock::new(1_000);
    let (lifetime, _, gate, drops) = active_with_clock([duplicate], clock.clone(), None).await;
    let token = gate.token().expect("effect token");
    clock.arm();
    let (_handle, mut cancellation) = endpoint_cancellation();

    let ActiveRunnerLifetimeAdvance::CleanupRequired(cleanup) =
        Box::pin(lifetime.advance(&mut cancellation)).await
    else {
        panic!("semantic deadline cannot continue");
    };

    assert!(matches!(
        cleanup.reason(),
        ActiveRunnerExitReason::HardDeadlineElapsed
    ));
    assert_eq!(cleanup.final_state(), RunnerState::Exiting);
    assert_revoked(&gate, &token);
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    cleanup.close_local();
    assert_eq!(drops.load(Ordering::SeqCst), 1);
}
