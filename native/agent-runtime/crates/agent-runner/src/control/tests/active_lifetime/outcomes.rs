use std::sync::atomic::Ordering;

use agent_platform::ipc::endpoint_cancellation;

use super::support::{active, assert_revoked};
use crate::control::active_lifetime::{ActiveRunnerExitReason, ActiveRunnerLifetimeAdvance};
use crate::control::tests::support::{
    ManualClock, activate_frame_with, activate_frame_with_deadline,
};
use crate::lifecycle::RunnerState;

#[tokio::test]
async fn eof_is_interruption_and_never_completion() {
    let clock = ManualClock::new(1_000);
    let (lifetime, control, gate, drops) = active([], clock, None).await;
    let token = gate.token().expect("effect token");
    control.close_reads();
    let (_handle, mut cancellation) = endpoint_cancellation();

    let ActiveRunnerLifetimeAdvance::CleanupRequired(cleanup) =
        lifetime.advance(&mut cancellation).await
    else {
        panic!("EOF cannot continue Active");
    };

    assert!(matches!(
        cleanup.reason(),
        ActiveRunnerExitReason::ControlEof
    ));
    assert_eq!(cleanup.final_state(), RunnerState::Exiting);
    assert_revoked(&gate, &token);
    cleanup.close_local();
    assert_eq!(drops.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn exact_replay_continues_but_conflict_revokes() {
    let duplicate = activate_frame_with_deadline("activate-active", 3, 9_000);
    let clock = ManualClock::new(1_000);
    let (lifetime, _, gate, drops) = active([duplicate], clock, None).await;
    let token = gate.token().expect("effect token");
    let (_handle, mut cancellation) = endpoint_cancellation();
    let ActiveRunnerLifetimeAdvance::Continue(lifetime) = lifetime.advance(&mut cancellation).await
    else {
        panic!("exact replay should continue");
    };
    gate.with_effect_dispatch(&token, |_| ())
        .expect("authority remains live");
    lifetime.revoke().close_local();
    assert_eq!(drops.load(Ordering::SeqCst), 1);

    let conflict = activate_frame_with("activate-conflict", 4, 9_000, |activate| {
        activate.idempotency_key = "different".to_owned();
    });
    let conflict_clock = ManualClock::new(1_000);
    let (lifetime, _, gate, drops) = active([conflict], conflict_clock, None).await;
    let token = gate.token().expect("effect token");
    let (_handle, mut cancellation) = endpoint_cancellation();
    let ActiveRunnerLifetimeAdvance::CleanupRequired(cleanup) =
        lifetime.advance(&mut cancellation).await
    else {
        panic!("conflict cannot continue");
    };
    assert!(matches!(
        cleanup.reason(),
        ActiveRunnerExitReason::ProtocolFailure(_)
    ));
    assert_revoked(&gate, &token);
    cleanup.close_local();
    assert_eq!(drops.load(Ordering::SeqCst), 1);
}
