use std::cell::{Cell, RefCell};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::rc::Rc;
use std::time::Duration;

use agent_platform::budget::ResourceBudget;
use agent_platform::containment::{
    ChildHandleAllowlist, ContainedLaunch, ContainmentPort, PhysicalReapEvidence, ProcessId,
    ReapFailure, ResourceGroupId, SpawnFailure, SpawnedGroup,
};

use super::super::{ReapBackend, VerifiedReap};
use super::fixtures::report;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum FakeError {
    Spawn,
    Termination,
    TimedOut,
}

impl Display for FakeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl Error for FakeError {}

#[derive(Debug)]
pub(super) struct FakeGroup {
    pub(super) id: u64,
    drops: Rc<Cell<u32>>,
}

impl Drop for FakeGroup {
    fn drop(&mut self) {
        self.drops.set(self.drops.get() + 1);
    }
}

#[derive(Debug)]
pub(super) struct FakeContainment {
    spawn_group: RefCell<Option<FakeGroup>>,
    pub(super) spawn_calls: Cell<u32>,
    pub(super) observed_child_handle_counts: RefCell<Vec<usize>>,
    pub(super) terminate_calls: Cell<u32>,
    pub(super) fail_terminate: Cell<bool>,
    fail_spawn_with_ownership: Cell<bool>,
    pub(super) reaped_group_ids: RefCell<Vec<u64>>,
}

impl FakeContainment {
    pub(super) fn with_group(drops: Rc<Cell<u32>>) -> Self {
        Self {
            spawn_group: RefCell::new(Some(FakeGroup { id: 7, drops })),
            spawn_calls: Cell::new(0),
            observed_child_handle_counts: RefCell::new(Vec::new()),
            terminate_calls: Cell::new(0),
            fail_terminate: Cell::new(false),
            fail_spawn_with_ownership: Cell::new(false),
            reaped_group_ids: RefCell::new(Vec::new()),
        }
    }

    pub(super) fn failing_spawn_with_group(drops: Rc<Cell<u32>>) -> Self {
        let containment = Self::with_group(drops);
        containment.fail_spawn_with_ownership.set(true);
        containment
    }

    pub(super) fn failing_spawn() -> Self {
        Self {
            spawn_group: RefCell::new(None),
            spawn_calls: Cell::new(0),
            observed_child_handle_counts: RefCell::new(Vec::new()),
            terminate_calls: Cell::new(0),
            fail_terminate: Cell::new(false),
            fail_spawn_with_ownership: Cell::new(false),
            reaped_group_ids: RefCell::new(Vec::new()),
        }
    }
}

impl ContainmentPort for FakeContainment {
    type Group = FakeGroup;
    type Error = FakeError;

    fn spawn_runner_contained_with_handles(
        &self,
        _resource_group_id: ResourceGroupId,
        _budget: &ResourceBudget,
        _launch: &ContainedLaunch,
        child_handles: ChildHandleAllowlist,
    ) -> Result<SpawnedGroup<Self::Group>, SpawnFailure<Self::Group, Self::Error>> {
        self.spawn_calls.set(self.spawn_calls.get() + 1);
        self.observed_child_handle_counts
            .borrow_mut()
            .push(child_handles.len());
        let group = self
            .spawn_group
            .borrow_mut()
            .take()
            .ok_or(SpawnFailure::Clean(FakeError::Spawn))?;
        let spawned = SpawnedGroup {
            group,
            process_id: ProcessId(41),
            report: report(),
        };
        if self.fail_spawn_with_ownership.get() {
            Err(SpawnFailure::Owned {
                spawned: Box::new(spawned),
                error: FakeError::Spawn,
            })
        } else {
            Ok(spawned)
        }
    }

    fn spawn_descendant_contained(
        &self,
        _group: &Self::Group,
        _launch: &ContainedLaunch,
    ) -> Result<ProcessId, Self::Error> {
        unreachable!("not used by ownership registry")
    }

    fn terminate_group(&self, _group: &Self::Group, _exit_code: u32) -> Result<(), Self::Error> {
        self.terminate_calls.set(self.terminate_calls.get() + 1);
        if self.fail_terminate.get() {
            Err(FakeError::Termination)
        } else {
            Ok(())
        }
    }

    fn reap_group(
        &self,
        group: Self::Group,
        _timeout: Duration,
    ) -> Result<PhysicalReapEvidence, ReapFailure<Self::Group, Self::Error>> {
        self.reaped_group_ids.borrow_mut().push(group.id);
        Err(ReapFailure {
            group,
            error: FakeError::TimedOut,
        })
    }
}

pub(super) struct SuccessfulReaper {
    pub(super) group_ids: RefCell<Vec<u64>>,
    pub(super) resource_group_id: ResourceGroupId,
    pub(super) process_id: ProcessId,
}

impl ReapBackend<FakeGroup> for SuccessfulReaper {
    type Error = FakeError;

    fn reap(
        &self,
        group: FakeGroup,
        _timeout: Duration,
    ) -> Result<VerifiedReap, ReapFailure<FakeGroup, Self::Error>> {
        self.group_ids.borrow_mut().push(group.id);
        Ok(VerifiedReap {
            resource_group_id: self.resource_group_id.clone(),
            process_id: self.process_id,
            exit_code: 23,
            peak_job_memory_bytes: 8_192,
        })
    }
}
