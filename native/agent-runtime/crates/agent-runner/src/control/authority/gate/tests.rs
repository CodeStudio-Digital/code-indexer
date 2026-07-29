use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Barrier, mpsc};
use std::thread;

use agent_protocol::identity::{
    AgentRunId, AttemptId, AttemptIdentity, CommandId, ConnectionId, CorrelationId,
    ExecutorOwnerId, RuntimeInstanceId, SessionId,
};

use super::{EffectClock, EffectGate};
use crate::control::authority::{ActiveAuthority, AuthorityError};

const DEADLINE: i64 = 10_000;

#[derive(Debug)]
struct ManualClock {
    now: AtomicI64,
}

impl ManualClock {
    const fn new(now: i64) -> Self {
        Self {
            now: AtomicI64::new(now),
        }
    }

    fn set(&self, now: i64) {
        self.now.store(now, Ordering::SeqCst);
    }
}

impl EffectClock for ManualClock {
    fn now_unix_ms(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
}

#[test]
fn live_token_authorizes_exactly_one_synchronous_dispatch() {
    let (gate, _) = gate_at(100);
    let token = gate.token().expect("live token");
    let mut dispatched = false;

    let value = gate
        .with_effect_dispatch(&token, |permit| {
            dispatched = true;
            format!("{permit:?}")
        })
        .expect("authorized dispatch");

    assert!(dispatched);
    assert!(value.contains("EffectDispatchPermit"));
}

#[test]
fn token_from_another_authority_is_rejected() {
    let (gate, _) = gate_at(100);
    let clock = Arc::new(ManualClock::new(100));
    let foreign = EffectGate::new(&authority_with_nonce(b"other-activation-nonce"), clock);
    let token = foreign.token().expect("foreign token");

    assert_eq!(
        gate.with_effect_dispatch(&token, |_| ()),
        Err(AuthorityError::InvalidToken)
    );
}

#[test]
fn revoke_invalidates_previously_issued_token() {
    let (gate, _) = gate_at(100);
    let token = gate.token().expect("live token");
    gate.revoke();

    let mut dispatched = false;
    assert_eq!(
        gate.with_effect_dispatch(&token, |_| dispatched = true),
        Err(AuthorityError::Revoked)
    );
    assert!(!dispatched);
}

#[test]
fn identical_authority_facts_do_not_share_gate_tokens() {
    let clock = Arc::new(ManualClock::new(100));
    let authority = authority();
    let first = EffectGate::new(&authority, clock.clone());
    let second = EffectGate::new(&authority, clock);
    let token = first.token().expect("first gate token");

    let mut dispatched = false;
    assert_eq!(
        second.with_effect_dispatch(&token, |_| dispatched = true),
        Err(AuthorityError::InvalidToken)
    );
    assert!(!dispatched);
}

#[test]
fn owner_clock_expiry_blocks_dispatch_without_caller_time() {
    let (gate, clock) = gate_at(100);
    let token = gate.token().expect("live token");
    clock.set(DEADLINE);

    let mut dispatched = false;
    assert_eq!(
        gate.with_effect_dispatch(&token, |_| dispatched = true),
        Err(AuthorityError::Expired {
            deadline: DEADLINE,
            now: DEADLINE,
        })
    );
    assert!(!dispatched);
}

#[test]
fn clock_regression_revokes_the_gate_fail_closed() {
    let (gate, clock) = gate_at(100);
    let token = gate.token().expect("live token");
    clock.set(99);

    assert_eq!(
        gate.with_effect_dispatch(&token, |_| ()),
        Err(AuthorityError::ClockRegressed {
            previous: 100,
            observed: 99,
        })
    );
    clock.set(101);
    assert_eq!(
        gate.with_effect_dispatch(&token, |_| ()),
        Err(AuthorityError::Revoked)
    );
}

#[test]
fn revoke_cannot_cross_the_authorize_dispatch_boundary() {
    let (gate, _) = gate_at(100);
    let token = gate.token().expect("live token");
    let dispatch_gate = gate.clone();
    let revoke_gate = gate;
    let dispatch_entered = Arc::new(Barrier::new(2));
    let release_dispatch = Arc::new(Barrier::new(2));
    let (revoke_started_tx, revoke_started_rx) = mpsc::channel();
    let (revoke_done_tx, revoke_done_rx) = mpsc::channel();

    thread::scope(|scope| {
        let entered = dispatch_entered.clone();
        let release = release_dispatch.clone();
        let dispatch = scope.spawn(move || {
            dispatch_gate
                .with_effect_dispatch(&token, |_| {
                    entered.wait();
                    release.wait();
                })
                .expect("dispatch");
        });
        dispatch_entered.wait();

        let revoke = scope.spawn(move || {
            revoke_started_tx.send(()).expect("start signal");
            revoke_gate.revoke();
            revoke_done_tx.send(()).expect("done signal");
        });
        revoke_started_rx.recv().expect("revoker started");
        assert!(revoke_done_rx.try_recv().is_err());

        release_dispatch.wait();
        dispatch.join().expect("dispatch thread");
        revoke.join().expect("revoke thread");
    });
    revoke_done_rx.recv().expect("revocation completed");
}

fn gate_at(now: i64) -> (EffectGate, Arc<ManualClock>) {
    let clock = Arc::new(ManualClock::new(now));
    let authority = authority();
    (EffectGate::new(&authority, clock.clone()), clock)
}

fn authority() -> ActiveAuthority {
    authority_with_nonce(b"activation-nonce")
}

fn authority_with_nonce(nonce: &[u8]) -> ActiveAuthority {
    ActiveAuthority::new(
        AttemptIdentity {
            session_id: SessionId::new("11111111-1111-4111-8111-111111111111").expect("session"),
            command_id: CommandId::new("22222222-2222-4222-8222-222222222222").expect("command"),
            agent_run_id: AgentRunId::new("33333333-3333-4333-8333-333333333333").expect("run"),
            attempt_id: AttemptId::new("44444444-4444-4444-8444-444444444444").expect("attempt"),
            executor_owner_id: ExecutorOwnerId::new("owner-1").expect("owner"),
            fencing_epoch: 7,
            correlation_id: CorrelationId::new("55555555-5555-4555-8555-555555555555")
                .expect("correlation"),
            root_agent_run_id: AgentRunId::new("33333333-3333-4333-8333-333333333333")
                .expect("root"),
            owner_agent_run_id: None,
            parent_agent_run_id: None,
        },
        RuntimeInstanceId::new("runtime-1").expect("runtime"),
        ConnectionId::new("connection-1").expect("connection"),
        4,
        3,
        DEADLINE,
        [7; 32],
        nonce,
    )
}
