use super::launch::worker::{RemoteLaunchCleanup, RemoteLaunchCleanupError};
use super::provision::{ProtectedLaunchCleanupOwner, ProtectedLaunchCleanupPort};
use crate::process_table::OwnershipKey;

pub(super) enum ManagedLaunchCleanup<C> {
    Local(C),
    Remote(RemoteLaunchCleanup),
}

#[derive(Debug)]
pub(super) enum ManagedLaunchCleanupError<E> {
    Local(std::marker::PhantomData<E>),
    Remote,
}

impl<C> ProtectedLaunchCleanupPort for ManagedLaunchCleanup<C>
where
    C: ProtectedLaunchCleanupPort,
{
    type Error = ManagedLaunchCleanupError<C::Error>;

    fn try_cleanup(
        &mut self,
    ) -> Result<super::provision::ProtectedLaunchCleanupProof, Self::Error> {
        match self {
            Self::Local(cleanup) => cleanup.try_cleanup().map_err(|error| {
                drop(error);
                ManagedLaunchCleanupError::Local(std::marker::PhantomData)
            }),
            Self::Remote(cleanup) => {
                cleanup
                    .try_cleanup()
                    .map_err(|error: RemoteLaunchCleanupError| {
                        let _ = error;
                        ManagedLaunchCleanupError::Remote
                    })
            }
        }
    }
}

impl<C> std::fmt::Debug for ManagedLaunchCleanup<C> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Local(_) => formatter.write_str("ManagedLaunchCleanup::Local([REDACTED])"),
            Self::Remote(_) => formatter.write_str("ManagedLaunchCleanup::Remote([REDACTED])"),
        }
    }
}

pub(super) enum CompletionCleanupAttempt {
    Absent,
    Completed,
    Retry,
    Stalled,
}

pub(super) const MAX_COMPLETION_CLEANUP_FAILURES: u16 = 100;

struct RetainedCleanup<C> {
    key: OwnershipKey,
    owner: ProtectedLaunchCleanupOwner<C>,
    failures: u16,
}

/// Bounded by physical ownership: each entry is tied to a spawned attempt.
pub(super) struct CompletionCleanupRegistry<C> {
    maximum_entries: usize,
    entries: Vec<RetainedCleanup<C>>,
}

impl<C> CompletionCleanupRegistry<C> {
    pub(super) const fn new(maximum_entries: usize) -> Self {
        Self {
            maximum_entries,
            entries: Vec::new(),
        }
    }

    pub(super) fn retain(&mut self, key: OwnershipKey, owner: ProtectedLaunchCleanupOwner<C>) {
        assert!(
            !self.owns(&key),
            "linear pending handoff cannot create duplicate cleanup ownership"
        );
        assert!(
            self.entries.len() < self.maximum_entries,
            "cleanup ownership cannot exceed physical ownership capacity"
        );
        self.entries.push(RetainedCleanup {
            key,
            owner,
            failures: 0,
        });
    }

    pub(super) fn owns(&self, key: &OwnershipKey) -> bool {
        self.entries.iter().any(|entry| &entry.key == key)
    }

    #[cfg(test)]
    pub(super) const fn len(&self) -> usize {
        self.entries.len()
    }
}

impl<C> CompletionCleanupRegistry<C>
where
    C: ProtectedLaunchCleanupPort,
{
    pub(super) fn cleanup_one(&mut self, key: &OwnershipKey) -> CompletionCleanupAttempt {
        let Some(index) = self.entries.iter().position(|entry| &entry.key == key) else {
            return CompletionCleanupAttempt::Absent;
        };
        if self.entries[index].owner.cleanup().is_err() {
            let failures = self.entries[index].failures.saturating_add(1);
            self.entries[index].failures = failures;
            return if failures >= MAX_COMPLETION_CLEANUP_FAILURES {
                CompletionCleanupAttempt::Stalled
            } else {
                CompletionCleanupAttempt::Retry
            };
        }
        self.entries.remove(index);
        CompletionCleanupAttempt::Completed
    }
}

impl<C> std::fmt::Debug for CompletionCleanupRegistry<C> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CompletionCleanupRegistry")
            .field("maximum_entries", &self.maximum_entries)
            .field("retained_entries", &self.entries.len())
            .finish_non_exhaustive()
    }
}
