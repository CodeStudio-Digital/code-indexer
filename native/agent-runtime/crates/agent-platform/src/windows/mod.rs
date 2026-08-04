//! Windows Job Object containment.
//!
//! The public surface is safe. Raw Win32 calls are isolated in `sys`, and the
//! owned group never exposes or clones the last kill-on-close Job handle.
//! Completion-port wakeups and a soft-memory notification are intentionally
//! deferred; bounded reap polling does not report either as enforced.
//! Restricted tokens/AppContainer are also deferred: this adapter provides
//! lifecycle/resource containment, not a security sandbox for hostile code.

pub mod bootstrap;
mod environment;
mod error;
pub mod ipc;
mod launch;
mod lifecycle;
mod limits;
mod resource;
#[allow(unsafe_code)]
mod sys;

use std::os::windows::io::OwnedHandle;
use std::time::Duration;

use crate::budget::ResourceBudget;
use crate::containment::{
    ChildHandleAllowlist, ContainedLaunch, ContainmentPort, PhysicalReapEvidence, ProcessId,
    ReapFailure, ResourceGroupId, SpawnFailure, SpawnResult, SpawnedGroup,
};

pub use error::WindowsContainmentError;
pub use resource::{CurrentProcessResourceSample, sample_current_process_resources};

use launch::PreparedLaunch;
use limits::JobLimits;

#[derive(Debug, Default)]
pub struct WindowsContainment;

impl WindowsContainment {
    #[must_use]
    pub const fn new() -> Self {
        Self
    }

    fn spawn_runner(
        resource_group_id: ResourceGroupId,
        budget: &ResourceBudget,
        launch: &ContainedLaunch,
        child_handles: ChildHandleAllowlist,
        fault: sys::SpawnFault,
    ) -> SpawnResult<WindowsJobGroup, WindowsContainmentError> {
        if let Err(error) = budget.validate() {
            return Err(SpawnFailure::Clean(error.into()));
        }
        let limits = JobLimits::from_budget(budget).map_err(SpawnFailure::Clean)?;
        let mut prepared = PreparedLaunch::new(launch).map_err(SpawnFailure::Clean)?;
        let job = sys::create_job().map_err(SpawnFailure::Clean)?;
        sys::configure_job(&job, &limits.extended, &limits.end_of_job)
            .map_err(SpawnFailure::Clean)?;
        sys::prove_limits(&job, &limits.extended, &limits.end_of_job)
            .map_err(SpawnFailure::Clean)?;
        let report = JobLimits::report();
        let spawn = sys::spawn_in_job(&job, &mut prepared, &child_handles, fault);
        drop(child_handles);
        match spawn {
            Ok(process) => {
                let process_id = ProcessId(process.process_id);
                Ok(SpawnedGroup {
                    group: WindowsJobGroup {
                        resource_group_id,
                        root_process: process.handle,
                        job,
                        process_id,
                    },
                    process_id,
                    report,
                })
            }
            Err(sys::ProcessSpawnFailure::Clean(error)) => Err(SpawnFailure::Clean(error)),
            Err(sys::ProcessSpawnFailure::Owned { process, error }) => {
                let process_id = ProcessId(process.process_id);
                let group = WindowsJobGroup {
                    resource_group_id,
                    root_process: process.handle,
                    job,
                    process_id,
                };
                match lifecycle::cleanup_failed_spawn(&group, fault) {
                    Ok(()) => {
                        drop(group);
                        Err(SpawnFailure::Clean(error))
                    }
                    Err(cleanup) => Err(SpawnFailure::Owned {
                        spawned: Box::new(SpawnedGroup {
                            group,
                            process_id,
                            report,
                        }),
                        error: WindowsContainmentError::StartupCleanupFailed {
                            original: Box::new(error),
                            cleanup: Box::new(cleanup),
                        },
                    }),
                }
            }
        }
    }

    #[cfg(test)]
    fn spawn_runner_with_fault(
        resource_group_id: ResourceGroupId,
        budget: &ResourceBudget,
        launch: &ContainedLaunch,
        fault: sys::SpawnFault,
    ) -> SpawnResult<WindowsJobGroup, WindowsContainmentError> {
        Self::spawn_runner(
            resource_group_id,
            budget,
            launch,
            ChildHandleAllowlist::new(),
            fault,
        )
    }
}

/// Unique ownership of one anonymous Job Object and its root process.
///
/// This type is deliberately not `Clone`. Dropping it closes the last Job
/// handle and activates `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
#[derive(Debug)]
pub struct WindowsJobGroup {
    resource_group_id: ResourceGroupId,
    root_process: OwnedHandle,
    job: OwnedHandle,
    process_id: ProcessId,
}

impl WindowsJobGroup {
    #[must_use]
    pub const fn resource_group_id(&self) -> &ResourceGroupId {
        &self.resource_group_id
    }

    #[must_use]
    pub const fn process_id(&self) -> ProcessId {
        self.process_id
    }
}

impl ContainmentPort for WindowsContainment {
    type Group = WindowsJobGroup;
    type Error = WindowsContainmentError;

    fn spawn_runner_contained_with_handles(
        &self,
        resource_group_id: ResourceGroupId,
        budget: &ResourceBudget,
        launch: &ContainedLaunch,
        child_handles: ChildHandleAllowlist,
    ) -> SpawnResult<Self::Group, Self::Error> {
        Self::spawn_runner(
            resource_group_id,
            budget,
            launch,
            child_handles,
            sys::SpawnFault::None,
        )
    }

    fn terminate_group(&self, group: &Self::Group, exit_code: u32) -> Result<(), Self::Error> {
        sys::terminate_job(&group.job, exit_code)
    }

    fn spawn_descendant_contained(
        &self,
        group: &Self::Group,
        launch: &ContainedLaunch,
    ) -> Result<ProcessId, Self::Error> {
        let mut prepared = PreparedLaunch::new(launch)?;
        match sys::spawn_in_job(
            &group.job,
            &mut prepared,
            &ChildHandleAllowlist::new(),
            sys::SpawnFault::None,
        ) {
            Ok(process) => {
                // Job membership keeps tracking the descendant after this
                // individual handle closes; the runner never receives the Job.
                Ok(ProcessId(process.process_id))
            }
            Err(sys::ProcessSpawnFailure::Clean(error)) => Err(error),
            Err(sys::ProcessSpawnFailure::Owned { process, error }) => {
                let cleanup = lifecycle::cleanup_failed_descendant(group);
                drop(process);
                match cleanup {
                    Ok(()) => Err(error),
                    Err(cleanup) => Err(WindowsContainmentError::StartupCleanupFailed {
                        original: Box::new(error),
                        cleanup: Box::new(cleanup),
                    }),
                }
            }
        }
    }

    fn reap_group(
        &self,
        group: Self::Group,
        timeout: Duration,
    ) -> Result<PhysicalReapEvidence, ReapFailure<Self::Group, Self::Error>> {
        match lifecycle::wait_until_empty(&group, timeout) {
            Ok((exit_code, peak_memory)) => {
                let process_id = group.process_id;
                let resource_group_id = group.resource_group_id.clone();
                drop(group);
                Ok(PhysicalReapEvidence::new(
                    resource_group_id,
                    process_id,
                    exit_code,
                    peak_memory,
                ))
            }
            Err(error) => Err(ReapFailure { group, error }),
        }
    }
}

#[cfg(test)]
mod tests;
