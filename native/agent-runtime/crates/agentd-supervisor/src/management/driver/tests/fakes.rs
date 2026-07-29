use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_platform::budget::ResourceBudget;
use agent_platform::containment::{
    ChildHandleAllowlist, ContainedLaunch, ContainmentCapabilities, ContainmentLevel,
    ContainmentPort, ContainmentReport, LimitKind, PhysicalReapEvidence, ProcessId, ReapFailure,
    ResourceGroupId, SpawnFailure, SpawnedGroup,
};

mod blocking_launch;
mod clock;
mod containment_clock;
mod provision;

pub(super) use blocking_launch::{BlockingContainment, BlockingLaunchGate};
pub(super) use clock::{EffectClockAdvance, ManualLifecycleClock};
pub(super) use provision::FakeProvisioner;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum FakeError {
    Spawn,
    Terminate,
    ReapTimeout,
    Provision,
    Handle,
}

impl Display for FakeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl Error for FakeError {}

#[derive(Debug)]
pub(super) struct FakeGroup {
    id: u64,
    drops: Arc<AtomicUsize>,
    process_id: ProcessId,
}

impl Drop for FakeGroup {
    fn drop(&mut self) {
        self.drops.fetch_add(1, Ordering::SeqCst);
    }
}

#[derive(Debug, Default)]
pub(super) struct ContainmentState {
    pub spawn_calls: AtomicUsize,
    pub terminate_calls: AtomicUsize,
    pub reap_calls: AtomicUsize,
    pub reaped_group_ids: Mutex<Vec<u64>>,
    pub terminated_group_ids: Mutex<Vec<u64>>,
    pub group_drops: Arc<AtomicUsize>,
    pub last_launch: Mutex<Option<ContainedLaunch>>,
    pub child_handle_counts: Mutex<Vec<usize>>,
    spawn_clock_advance: Mutex<Option<EffectClockAdvance>>,
    termination_clock_advance: Mutex<Option<EffectClockAdvance>>,
    reap_clock_advance: Mutex<Option<EffectClockAdvance>>,
}

#[derive(Debug)]
pub(super) struct FakeContainment {
    state: Arc<ContainmentState>,
    groups: Mutex<Vec<FakeGroup>>,
    report: ContainmentReport,
    fail_termination: bool,
    spawn_delay: Duration,
}

impl FakeContainment {
    pub(super) fn healthy() -> (Self, Arc<ContainmentState>) {
        Self::healthy_with_groups(1)
    }

    pub(super) fn healthy_with_groups(count: usize) -> (Self, Arc<ContainmentState>) {
        let state = Arc::new(ContainmentState::default());
        let groups = (0..count)
            .map(|index| {
                let offset = u32::try_from(index).expect("test group count fits u32");
                FakeGroup {
                    id: 7 + u64::from(offset),
                    drops: Arc::clone(&state.group_drops),
                    process_id: ProcessId(41 + offset),
                }
            })
            .rev()
            .collect();
        (
            Self {
                state: Arc::clone(&state),
                groups: Mutex::new(groups),
                report: ContainmentReport {
                    level: ContainmentLevel::HardAggregate,
                    enforced_limits: vec![
                        LimitKind::Memory,
                        LimitKind::CpuTime,
                        LimitKind::WallTime,
                        LimitKind::Processes,
                    ],
                    unsupported_limits: vec![
                        LimitKind::Threads,
                        LimitKind::OpenHandles,
                        LimitKind::ScratchBytes,
                    ],
                    capabilities: ContainmentCapabilities {
                        process_tree: true,
                        memory_limit: true,
                        cpu_limit: true,
                        process_count_limit: true,
                        ..ContainmentCapabilities::default()
                    },
                },
                fail_termination: false,
                spawn_delay: Duration::ZERO,
            },
            state,
        )
    }

    pub(super) fn failing_termination() -> (Self, Arc<ContainmentState>) {
        let (mut containment, state) = Self::healthy();
        containment.fail_termination = true;
        (containment, state)
    }

    pub(super) fn delayed_spawn(delay: Duration) -> (Self, Arc<ContainmentState>) {
        let (mut containment, state) = Self::healthy();
        containment.spawn_delay = delay;
        (containment, state)
    }

    pub(super) fn insufficient_containment() -> (Self, Arc<ContainmentState>) {
        let (mut containment, state) = Self::healthy();
        containment.report.level = ContainmentLevel::Monitored;
        (containment, state)
    }
}

impl ContainmentPort for FakeContainment {
    type Group = FakeGroup;
    type Error = FakeError;

    fn spawn_runner_contained_with_handles(
        &self,
        _resource_group_id: ResourceGroupId,
        _budget: &ResourceBudget,
        launch: &ContainedLaunch,
        child_handles: ChildHandleAllowlist,
    ) -> Result<SpawnedGroup<Self::Group>, SpawnFailure<Self::Group, Self::Error>> {
        self.state.spawn_calls.fetch_add(1, Ordering::SeqCst);
        *self.state.last_launch.lock().expect("last launch") = Some(launch.clone());
        self.state
            .child_handle_counts
            .lock()
            .expect("child handle counts")
            .push(child_handles.len());
        std::thread::sleep(self.spawn_delay);
        let group = self
            .groups
            .lock()
            .expect("groups")
            .pop()
            .ok_or(SpawnFailure::Clean(FakeError::Spawn))?;
        let process_id = group.process_id;
        let clock_advance = self
            .state
            .spawn_clock_advance
            .lock()
            .expect("spawn clock hook")
            .take();
        if let Some(advance) = clock_advance {
            advance.fire();
        }
        Ok(SpawnedGroup {
            group,
            process_id,
            report: self.report.clone(),
        })
    }

    fn spawn_descendant_contained(
        &self,
        _group: &Self::Group,
        _launch: &ContainedLaunch,
    ) -> Result<ProcessId, Self::Error> {
        unreachable!("driver never spawns descendants")
    }

    fn terminate_group(&self, group: &Self::Group, _exit_code: u32) -> Result<(), Self::Error> {
        self.state.terminate_calls.fetch_add(1, Ordering::SeqCst);
        self.state
            .terminated_group_ids
            .lock()
            .expect("terminated group IDs")
            .push(group.id);
        let clock_advance = self
            .state
            .termination_clock_advance
            .lock()
            .expect("termination clock hook")
            .take();
        if let Some(advance) = clock_advance {
            advance.fire();
        }
        if self.fail_termination {
            Err(FakeError::Terminate)
        } else {
            Ok(())
        }
    }

    fn reap_group(
        &self,
        group: Self::Group,
        _timeout: Duration,
    ) -> Result<PhysicalReapEvidence, ReapFailure<Self::Group, Self::Error>> {
        self.state.reap_calls.fetch_add(1, Ordering::SeqCst);
        let clock_advance = self
            .state
            .reap_clock_advance
            .lock()
            .expect("reap clock hook")
            .take();
        if let Some(advance) = clock_advance {
            advance.fire();
        }
        self.state
            .reaped_group_ids
            .lock()
            .expect("reaped group IDs")
            .push(group.id);
        Err(ReapFailure {
            group,
            error: FakeError::ReapTimeout,
        })
    }
}
