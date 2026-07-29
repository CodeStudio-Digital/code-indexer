use std::fmt::{self, Debug, Formatter};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use agent_platform::budget::ResourceBudget;
use agent_platform::containment::{
    ChildHandleAllowlist, ContainedLaunch, ContainmentPort, ProcessId, ReapFailure,
    ResourceGroupId, SpawnResult,
};
use tokio::sync::Notify;

use super::{ContainmentState, FakeContainment, FakeError, FakeGroup};

const ANTI_HANG_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone)]
pub(in crate::management::driver::tests) struct BlockingLaunchGate {
    inner: Arc<GateState>,
}

struct GateState {
    entries: AtomicUsize,
    entered: Notify,
    released: Mutex<bool>,
    release: Condvar,
    timed_out: AtomicBool,
}

impl BlockingLaunchGate {
    fn new() -> Self {
        Self {
            inner: Arc::new(GateState {
                entries: AtomicUsize::new(0),
                entered: Notify::new(),
                released: Mutex::new(false),
                release: Condvar::new(),
                timed_out: AtomicBool::new(false),
            }),
        }
    }

    pub(in crate::management::driver::tests) async fn wait_until_entered(&self) {
        while self.entries() == 0 {
            self.inner.entered.notified().await;
        }
    }

    pub(in crate::management::driver::tests) fn release(&self) {
        *self.inner.released.lock().expect("launch gate release") = true;
        self.inner.release.notify_all();
    }

    pub(in crate::management::driver::tests) fn entries(&self) -> usize {
        self.inner.entries.load(Ordering::Acquire)
    }

    pub(in crate::management::driver::tests) fn timed_out(&self) -> bool {
        self.inner.timed_out.load(Ordering::Acquire)
    }

    fn enter_and_wait(&self) {
        self.inner.entries.fetch_add(1, Ordering::AcqRel);
        self.inner.entered.notify_one();
        let timed_out = {
            let (released, timeout) = self
                .inner
                .release
                .wait_timeout_while(
                    self.inner.released.lock().expect("launch gate wait"),
                    ANTI_HANG_TIMEOUT,
                    |released| !*released,
                )
                .expect("launch gate wait");
            let timed_out = !*released && timeout.timed_out();
            drop(released);
            timed_out
        };
        if timed_out {
            self.inner.timed_out.store(true, Ordering::Release);
        }
    }
}

impl Debug for BlockingLaunchGate {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BlockingLaunchGate")
            .field("entries", &self.entries())
            .field("timed_out", &self.timed_out())
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
pub(in crate::management::driver::tests) struct BlockingContainment {
    inner: FakeContainment,
    gate: BlockingLaunchGate,
    block_on_spawn_call: usize,
    spawn_calls: AtomicUsize,
}

impl BlockingContainment {
    pub(in crate::management::driver::tests) fn healthy(
        group_count: usize,
        block_on_spawn_call: usize,
    ) -> (Self, Arc<ContainmentState>, BlockingLaunchGate) {
        assert!(block_on_spawn_call > 0, "blocked spawn is one-based");
        let (inner, state) = FakeContainment::healthy_with_groups(group_count);
        let gate = BlockingLaunchGate::new();
        (
            Self {
                inner,
                gate: gate.clone(),
                block_on_spawn_call,
                spawn_calls: AtomicUsize::new(0),
            },
            state,
            gate,
        )
    }
}

impl ContainmentPort for BlockingContainment {
    type Group = FakeGroup;
    type Error = FakeError;

    fn spawn_runner_contained_with_handles(
        &self,
        resource_group_id: ResourceGroupId,
        budget: &ResourceBudget,
        launch: &ContainedLaunch,
        child_handles: ChildHandleAllowlist,
    ) -> SpawnResult<Self::Group, Self::Error> {
        let call = self.spawn_calls.fetch_add(1, Ordering::AcqRel) + 1;
        if call == self.block_on_spawn_call {
            self.gate.enter_and_wait();
        }
        self.inner.spawn_runner_contained_with_handles(
            resource_group_id,
            budget,
            launch,
            child_handles,
        )
    }

    fn spawn_descendant_contained(
        &self,
        group: &Self::Group,
        launch: &ContainedLaunch,
    ) -> Result<ProcessId, Self::Error> {
        self.inner.spawn_descendant_contained(group, launch)
    }

    fn terminate_group(&self, group: &Self::Group, exit_code: u32) -> Result<(), Self::Error> {
        self.inner.terminate_group(group, exit_code)
    }

    fn reap_group(
        &self,
        group: Self::Group,
        timeout: Duration,
    ) -> Result<
        agent_platform::containment::PhysicalReapEvidence,
        ReapFailure<Self::Group, Self::Error>,
    > {
        self.inner.reap_group(group, timeout)
    }
}
