use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use agent_protocol::generated::v1 as wire;
use prost::Message;

use super::super::asynchronous::{GateControl, GateStream, driver};
use super::super::support::{
    ManualClock, activate_frame_with_deadline, effective_facts, prepare_frame,
};
use crate::control::authority::{EffectClock, EffectGate, EffectToken};
use crate::control::{
    ActivationOutcome, AsyncRunnerControlDriver, AuthorityError, ControlDriverEvent, PrepareOutcome,
};

pub(super) trait TerminationTestClock: EffectClock + Clone + 'static {
    fn set_now(&self, now: i64);
}

impl TerminationTestClock for ManualClock {
    fn set_now(&self, now: i64) {
        self.set(now);
    }
}

pub(super) async fn active_driver<C>(
    tail: impl IntoIterator<Item = Vec<u8>>,
    clock: C,
) -> (
    AsyncRunnerControlDriver<GateStream>,
    GateControl,
    EffectGate,
)
where
    C: TerminationTestClock,
{
    let mut frames = vec![
        prepare_frame("prepare-termination", 2),
        activate_frame_with_deadline("activate-termination", 3, 9_000),
    ];
    frames.extend(tail);
    let (mut driver, control) = driver(frames, clock.clone()).await;
    let ControlDriverEvent::Prepare(PrepareOutcome::HydrationRequired(token)) =
        Box::pin(driver.receive_next()).await.expect("Prepare")
    else {
        panic!("expected Prepare");
    };
    clock.set_now(1_100);
    driver
        .finish_prepare(token, effective_facts(1_050))
        .await
        .expect("AttemptPrepared");
    clock.set_now(1_200);
    assert!(matches!(
        Box::pin(driver.receive_next()).await.expect("Activate"),
        ControlDriverEvent::Activate(ActivationOutcome::Activated)
    ));
    let gate = driver.effect_gate_for_test().expect("active effect gate");
    (driver, control, gate)
}

pub(super) fn decoded_output(control: &GateControl) -> Vec<wire::Frame> {
    super::super::support::decode_written_frames(&control.written()).expect("outbound frames")
}

pub(super) fn decoded_ack(frame: &wire::Frame) -> wire::Ack {
    let payload =
        wire::FramePayload::decode(frame.encoded_payload.as_slice()).expect("Ack payload");
    let Some(wire::frame_payload::Body::Ack(ack)) = payload.body else {
        panic!("expected Ack payload");
    };
    ack
}

pub(super) fn frame_payload_digest(encoded_frame: &[u8]) -> Vec<u8> {
    wire::Frame::decode(encoded_frame)
        .expect("fixture frame")
        .header
        .expect("fixture header")
        .payload_sha256
}

pub(super) fn assert_revoked(gate: &EffectGate, token: &EffectToken) {
    assert!(matches!(
        gate.with_effect_dispatch(token, |_| ()),
        Err(AuthorityError::Revoked)
    ));
}

#[derive(Clone, Debug)]
pub(super) struct ScriptClock {
    base: ManualClock,
    armed: Arc<AtomicBool>,
    reads: Arc<AtomicUsize>,
    script: Arc<[i64]>,
}

impl ScriptClock {
    pub(super) fn new(script: impl Into<Arc<[i64]>>) -> Self {
        Self {
            base: ManualClock::new(1_000),
            armed: Arc::new(AtomicBool::new(false)),
            reads: Arc::new(AtomicUsize::new(0)),
            script: script.into(),
        }
    }

    pub(super) fn arm(&self) {
        self.reads.store(0, Ordering::SeqCst);
        self.armed.store(true, Ordering::SeqCst);
    }
}

impl EffectClock for ScriptClock {
    fn now_unix_ms(&self) -> i64 {
        if !self.armed.load(Ordering::SeqCst) {
            return self.base.now();
        }
        let index = self.reads.fetch_add(1, Ordering::SeqCst);
        self.script
            .get(index)
            .copied()
            .or_else(|| self.script.last().copied())
            .expect("non-empty clock script")
    }
}

impl TerminationTestClock for ScriptClock {
    fn set_now(&self, now: i64) {
        self.base.set(now);
    }
}
