use std::convert::Infallible;
use std::time::Duration;

use agent_platform::containment::{ProcessId, ReapFailure};

use super::super::{
    ContainmentOperationError, Entry, ObservedExit, Owned, OwnershipError, OwnershipRegistry,
    Physical, Quarantined, ReapAfterCleanupError, ReapBackend, ReapedAttempt, Reaping,
    VerifiedReap,
};
use crate::admission::ReservationToken;

impl<G> OwnershipRegistry<G> {
    pub(super) fn finish_reap<B>(
        &mut self,
        backend: &B,
        owned: Owned<Reaping<G>>,
        timeout: Duration,
        observed_at_for_unobserved: Option<i64>,
    ) -> Result<ReapedAttempt, ContainmentOperationError<B::Error>>
    where
        B: ReapBackend<G>,
    {
        let observed_at = observed_at_for_unobserved.or_else(|| {
            owned
                .state
                .observed
                .as_ref()
                .map(|observed| observed.observed_at_unix_ms)
        });
        let Some(observed_at) = observed_at else {
            self.restore(Entry::Reaping(owned));
            return Err(ContainmentOperationError::Ownership(
                OwnershipError::MissingObservedExit,
            ));
        };
        match self.finish_reap_gated(backend, owned, timeout, || {
            Ok::<i64, Infallible>(observed_at)
        }) {
            Ok(reaped) => Ok(reaped),
            Err(ReapAfterCleanupError::Operation(error)) => Err(error),
            Err(ReapAfterCleanupError::PostReapGate(never)) => match never {},
        }
    }

    pub(super) fn finish_reap_gated<B, F, V>(
        &mut self,
        backend: &B,
        owned: Owned<Reaping<G>>,
        timeout: Duration,
        post_reap_gate: F,
    ) -> Result<ReapedAttempt, ReapAfterCleanupError<B::Error, V>>
    where
        B: ReapBackend<G>,
        F: FnOnce() -> Result<i64, V>,
    {
        let Owned {
            metadata,
            reservation,
            state,
        } = owned;
        let Reaping { physical, observed } = state;
        let Physical {
            group,
            process_id,
            report,
        } = physical;
        let reaped = backend.reap(group, timeout);
        let post_reap_at_unix_ms = post_reap_gate();
        let evidence = match reaped {
            Ok(evidence) => match post_reap_at_unix_ms {
                Ok(observed_at) => (evidence, observed_at),
                Err(error) => {
                    drop(reservation);
                    self.restore(Entry::Quarantined(Quarantined { metadata }));
                    return Err(ReapAfterCleanupError::PostReapGate(error));
                }
            },
            Err(ReapFailure { group, error }) => {
                self.restore(Entry::Reaping(Owned {
                    metadata,
                    reservation,
                    state: Reaping {
                        physical: Physical {
                            group,
                            process_id,
                            report,
                        },
                        observed,
                    },
                }));
                return match post_reap_at_unix_ms {
                    Ok(_) => Err(ReapAfterCleanupError::Operation(
                        ContainmentOperationError::Platform(error),
                    )),
                    Err(gate) => Err(ReapAfterCleanupError::PostReapGate(gate)),
                };
            }
        };
        let (evidence, post_reap_at_unix_ms) = evidence;
        if evidence.resource_group_id != metadata.resource_group_id
            || evidence.process_id != process_id
        {
            let error = OwnershipError::EvidenceAttributionMismatch {
                expected_resource_group_id: metadata.resource_group_id.clone(),
                evidence_resource_group_id: evidence.resource_group_id.clone(),
                expected_process_id: process_id,
                evidence_process_id: evidence.process_id,
            };
            drop(reservation);
            self.restore(Entry::Quarantined(Quarantined { metadata }));
            return Err(ReapAfterCleanupError::Operation(
                ContainmentOperationError::Ownership(error),
            ));
        }
        let observed = observed.unwrap_or(ObservedExit {
            exit_code: evidence.exit_code,
            observed_at_unix_ms: post_reap_at_unix_ms,
        });
        self.release_after_reap(
            metadata,
            reservation,
            process_id,
            report,
            observed,
            &evidence,
        )
        .map_err(|error| {
            ReapAfterCleanupError::Operation(ContainmentOperationError::Ownership(error))
        })
    }

    fn release_after_reap(
        &mut self,
        metadata: super::super::AttemptRuntimeMetadata,
        reservation: ReservationToken,
        process_id: ProcessId,
        report: agent_platform::containment::ContainmentReport,
        observed: ObservedExit,
        evidence: &VerifiedReap,
    ) -> Result<ReapedAttempt, OwnershipError> {
        if let Err(error) = self.admission.release(reservation) {
            self.restore(Entry::Quarantined(Quarantined { metadata }));
            return Err(OwnershipError::AdmissionInvariant(error));
        }
        Ok(ReapedAttempt::new(
            metadata,
            process_id,
            evidence.exit_code,
            evidence.peak_job_memory_bytes,
            report,
            observed,
        ))
    }
}
