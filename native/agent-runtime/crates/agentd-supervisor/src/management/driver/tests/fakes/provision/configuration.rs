use std::sync::atomic::{AtomicI64, AtomicUsize};
use std::sync::{Arc, Mutex};

use super::cleanup::FakeCompletionCleanupState;
use super::{FakeProvisioner, SealMutation};
use crate::management::driver::tests::fakes::{EffectClockAdvance, ManualLifecycleClock};

impl FakeProvisioner {
    pub(in crate::management::driver::tests) fn successful() -> Self {
        Self::new(true, true, SealMutation::None)
    }

    pub(in crate::management::driver::tests) fn failing() -> Self {
        Self::new(false, true, SealMutation::None)
    }

    pub(in crate::management::driver::tests) fn failing_completion() -> Self {
        Self::new(true, false, SealMutation::None)
    }

    pub(in crate::management::driver::tests) fn failing_completion_with_cleanup_failures(
        failures: usize,
    ) -> Self {
        let provisioner = Self::failing_completion();
        provisioner.cleanup_state.fail_next(failures);
        provisioner
    }

    pub(in crate::management::driver::tests) fn cleanup_state(
        &self,
    ) -> Arc<FakeCompletionCleanupState> {
        Arc::clone(&self.cleanup_state)
    }

    pub(in crate::management::driver::tests) fn advance_clock_on_next_completion(
        &self,
        clock: ManualLifecycleClock,
        observed_at_unix_ms: i64,
    ) {
        *self
            .completion_clock_advance
            .lock()
            .expect("completion clock hook") =
            Some(EffectClockAdvance::new(clock, observed_at_unix_ms));
    }

    pub(in crate::management::driver::tests) fn mismatched_receipt() -> Self {
        Self::new(true, true, SealMutation::EndpointAddress)
    }

    pub(in crate::management::driver::tests) fn mismatched_peer_receipt() -> Self {
        Self::new(true, true, SealMutation::PeerAuthority)
    }

    pub(in crate::management::driver::tests) fn mismatched_lease_receipt() -> Self {
        Self::new(true, true, SealMutation::AuthorityLease)
    }

    fn new(prepare_succeeds: bool, complete_succeeds: bool, seal_mutation: SealMutation) -> Self {
        Self {
            prepare_succeeds,
            complete_succeeds,
            seal_mutation,
            calls: Arc::new(AtomicUsize::new(0)),
            complete_calls: Arc::new(AtomicUsize::new(0)),
            observed_secret_bytes: Arc::new(AtomicUsize::new(0)),
            observed_process_id: Arc::new(AtomicUsize::new(0)),
            observed_authority_lease_expires_at_unix_ms: Arc::new(AtomicI64::new(0)),
            observed_handoff: Arc::new(Mutex::new(None)),
            completion_clock_advance: Mutex::new(None),
            cleanup_state: Arc::new(FakeCompletionCleanupState::default()),
        }
    }
}
