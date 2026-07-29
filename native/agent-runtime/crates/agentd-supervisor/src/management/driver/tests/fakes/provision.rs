use std::fs::File;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

use agent_platform::containment::ChildHandleAllowlist;
use agent_protocol::generated::v1 as wire;

use crate::management::driver::provision::{
    PendingProtectedLaunch, PreparedProtectedLaunch, ProtectedLaunchCleanupOwner,
    ProtectedLaunchCompletion, ProtectedLaunchPeerAuthority, ProtectedLaunchPhysicalFacts,
    ProtectedLaunchProvisionPort, ProtectedLaunchRequest,
};

use super::{EffectClockAdvance, FakeError};

mod cleanup;
mod configuration;
mod handoff;

use cleanup::{FakeCompletionCleanup, FakeCompletionCleanupState};
use handoff::build_handoff;

#[derive(Debug)]
pub(in crate::management::driver::tests) struct FakePending {
    completion_started: bool,
}

#[derive(Debug, Clone, Copy)]
enum SealMutation {
    None,
    EndpointAddress,
    PeerAuthority,
    AuthorityLease,
}

#[derive(Debug)]
pub(in crate::management::driver::tests) struct FakeProvisioner {
    prepare_succeeds: bool,
    complete_succeeds: bool,
    seal_mutation: SealMutation,
    pub calls: Arc<AtomicUsize>,
    pub complete_calls: Arc<AtomicUsize>,
    pub observed_secret_bytes: Arc<AtomicUsize>,
    pub observed_process_id: Arc<AtomicUsize>,
    pub observed_authority_lease_expires_at_unix_ms: Arc<AtomicI64>,
    pub observed_handoff: Arc<Mutex<Option<wire::RunnerLaunchHandoff>>>,
    completion_clock_advance: Mutex<Option<EffectClockAdvance>>,
    cleanup_state: Arc<FakeCompletionCleanupState>,
}

impl ProtectedLaunchProvisionPort for FakeProvisioner {
    type Pending = FakePending;
    type Cleanup = FakeCompletionCleanup;
    type Error = FakeError;

    fn prepare(
        &self,
        request: &ProtectedLaunchRequest<'_>,
    ) -> Result<PreparedProtectedLaunch<Self::Pending>, Self::Error> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let secret_bytes = request.launch_nonce().len()
            + request
                .endpoints()
                .iter()
                .map(|endpoint| endpoint.connection_token.len())
                .sum::<usize>();
        self.observed_secret_bytes
            .store(secret_bytes, Ordering::SeqCst);
        if !self.prepare_succeeds {
            return Err(FakeError::Provision);
        }
        let handles = child_handles()?;
        match self.seal_mutation {
            SealMutation::None => {}
            SealMutation::EndpointAddress => {
                let mut launch = wire::LaunchAttemptProcess {
                    launch_nonce: request.launch_nonce().to_vec(),
                    protected_endpoints: request.endpoints().to_vec(),
                    ..wire::LaunchAttemptProcess::default()
                };
                launch
                    .protected_endpoints
                    .first_mut()
                    .ok_or(FakeError::Provision)?
                    .address
                    .push_str("-mismatch");
                let altered = request.with_endpoints_for_test(&launch.protected_endpoints);
                return Ok(PreparedProtectedLaunch::new(
                    &altered,
                    handles,
                    pending_provider(),
                ));
            }
            SealMutation::PeerAuthority => {
                let alternate = alternate_peer_authority(request.peer_authority())?;
                let altered = request.with_peer_authority_for_test(&alternate);
                return Ok(PreparedProtectedLaunch::new(
                    &altered,
                    handles,
                    pending_provider(),
                ));
            }
            SealMutation::AuthorityLease => {
                let altered = request.with_authority_lease_for_test(
                    request
                        .authority_lease_expires_at_unix_ms()
                        .saturating_sub(1),
                );
                return Ok(PreparedProtectedLaunch::new(
                    &altered,
                    handles,
                    pending_provider(),
                ));
            }
        }
        Ok(PreparedProtectedLaunch::new(
            request,
            handles,
            pending_provider(),
        ))
    }

    fn complete_after_spawn(
        &self,
        mut pending: PendingProtectedLaunch<Self::Pending>,
        physical: &ProtectedLaunchPhysicalFacts,
    ) -> ProtectedLaunchCompletion<Self::Cleanup, Self::Error> {
        self.complete_calls.fetch_add(1, Ordering::SeqCst);
        let clock_advance = self
            .completion_clock_advance
            .lock()
            .expect("completion clock hook")
            .take();
        if let Some(advance) = clock_advance {
            advance.fire();
        }
        self.observed_process_id
            .store(physical.process_id() as usize, Ordering::SeqCst);
        self.observed_authority_lease_expires_at_unix_ms.store(
            pending.handoff_facts().authority_lease_expires_at_unix_ms(),
            Ordering::SeqCst,
        );
        if pending.provider().completion_started {
            return self.cleanup_required();
        }
        pending.provider_mut().completion_started = true;
        if !pending.provider().completion_started {
            return self.cleanup_required();
        }
        *self.observed_handoff.lock().expect("observed handoff") =
            Some(build_handoff(pending.handoff_facts(), physical));
        if !self.complete_succeeds {
            return self.cleanup_required();
        }
        ProtectedLaunchCompletion::completed(pending.mint_receipt_for_test(physical))
    }
}

impl FakeProvisioner {
    fn cleanup_required(&self) -> ProtectedLaunchCompletion<FakeCompletionCleanup, FakeError> {
        ProtectedLaunchCompletion::cleanup_required(
            FakeError::Provision,
            ProtectedLaunchCleanupOwner::new(FakeCompletionCleanup::new(Arc::clone(
                &self.cleanup_state,
            ))),
        )
    }
}

const fn pending_provider() -> FakePending {
    FakePending {
        completion_started: false,
    }
}

fn alternate_peer_authority(
    current: &ProtectedLaunchPeerAuthority,
) -> Result<ProtectedLaunchPeerAuthority, FakeError> {
    let current_host = current.expected_host_peer();
    let current_supervisor = current.expected_supervisor_peer();
    let alternate_host_process_id = (1..=u32::MAX)
        .find(|candidate| {
            *candidate != current_host.process_id && *candidate != current_supervisor.process_id
        })
        .ok_or(FakeError::Provision)?;
    ProtectedLaunchPeerAuthority::new_for_test(
        alternate_host_process_id,
        current_supervisor.process_id,
        current_host.unix_user_id,
        current_supervisor.unix_user_id,
    )
    .map_err(|_| FakeError::Provision)
}

fn child_handles() -> Result<ChildHandleAllowlist, FakeError> {
    let executable = std::env::current_exe().map_err(|_| FakeError::Handle)?;
    let owner = File::open(executable).map_err(|_| FakeError::Handle)?;
    let mut handles = ChildHandleAllowlist::new();
    #[cfg(windows)]
    handles
        .prepare_windows(&owner)
        .map_err(|_| FakeError::Handle)?;
    #[cfg(unix)]
    handles
        .prepare_unix(&owner)
        .map_err(|_| FakeError::Handle)?;
    Ok(handles)
}
