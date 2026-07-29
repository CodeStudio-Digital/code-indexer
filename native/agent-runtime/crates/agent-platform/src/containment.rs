use crate::budget::ResourceBudget;
use std::ffi::OsString;
use std::path::PathBuf;
use std::time::Duration;

mod child_handles;

pub use child_handles::{ChildHandleAllowlist, ChildHandleAllowlistError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainmentLevel {
    HardAggregate,
    HardProcess,
    Monitored,
    Unavailable,
}

/// Capabilities physically proven by the platform adapter for this spawn.
///
/// These values describe the effective resource group, not an inventory of
/// features the operating system might support in another configuration.
#[allow(clippy::struct_excessive_bools)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ContainmentCapabilities {
    pub process_tree: bool,
    pub memory_limit: bool,
    pub cpu_limit: bool,
    pub process_count_limit: bool,
    pub open_file_limit: bool,
    pub filesystem_quota: bool,
    pub network_policy: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LimitKind {
    Memory,
    CpuTime,
    WallTime,
    Processes,
    Threads,
    OpenHandles,
    ScratchBytes,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainmentReport {
    pub level: ContainmentLevel,
    pub enforced_limits: Vec<LimitKind>,
    pub unsupported_limits: Vec<LimitKind>,
    pub capabilities: ContainmentCapabilities,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ProcessId(pub u32);

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ResourceGroupId(pub String);

/// Non-secret process launch data. IPC handles are separate, linearly consumed
/// by the containment adapter and never travel in argv or env.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainedLaunch {
    pub executable: PathBuf,
    pub arguments: Vec<OsString>,
    pub working_directory: PathBuf,
    /// Complete child environment. An empty vector means an explicitly empty
    /// environment, never inheritance from the supervisor.
    pub environment: Vec<(OsString, OsString)>,
}

/// Result of a contained spawn. `group` is the unique physical owner and is
/// deliberately non-cloneable for platform implementations.
#[derive(Debug)]
pub struct SpawnedGroup<G> {
    pub group: G,
    pub process_id: ProcessId,
    pub report: ContainmentReport,
}

/// A launch failure with explicit physical ownership.
///
/// `Clean` proves that no process or group remains. `Owned` returns the unique
/// group to the supervisor, which must retain admission until physical reap.
#[derive(Debug)]
pub enum SpawnFailure<G, E> {
    Clean(E),
    Owned {
        spawned: Box<SpawnedGroup<G>>,
        error: E,
    },
}

pub type SpawnResult<G, E> = Result<SpawnedGroup<G>, SpawnFailure<G, E>>;

/// Opaque physical proof returned only after a platform group has no active
/// processes and all attempt-owned operating-system handles were closed.
#[derive(Debug, PartialEq, Eq)]
pub struct PhysicalReapEvidence {
    resource_group_id: ResourceGroupId,
    process_id: ProcessId,
    exit_code: u32,
    peak_job_memory_bytes: u64,
}

impl PhysicalReapEvidence {
    #[must_use]
    pub const fn resource_group_id(&self) -> &ResourceGroupId {
        &self.resource_group_id
    }

    #[must_use]
    pub const fn process_id(&self) -> ProcessId {
        self.process_id
    }

    #[must_use]
    pub const fn exit_code(&self) -> u32 {
        self.exit_code
    }

    #[must_use]
    pub const fn peak_job_memory_bytes(&self) -> u64 {
        self.peak_job_memory_bytes
    }

    #[cfg(windows)]
    pub(crate) const fn new(
        resource_group_id: ResourceGroupId,
        process_id: ProcessId,
        exit_code: u32,
        peak_job_memory_bytes: u64,
    ) -> Self {
        Self {
            resource_group_id,
            process_id,
            exit_code,
            peak_job_memory_bytes,
        }
    }
}

/// Reap failure that returns ownership to the caller. In particular, timeout
/// cannot accidentally close the last kill-on-close handle.
#[derive(Debug)]
pub struct ReapFailure<G, E> {
    pub group: G,
    pub error: E,
}

/// Narrow owner boundary for platform-specific resource groups.
pub trait ContainmentPort {
    type Group;
    type Error;

    /// Creates the attempt resource group and its runner as one contained
    /// operation. The child-handle owner is consumed exactly once. The child
    /// must not execute a user instruction before the platform proves
    /// membership in the returned group.
    ///
    /// # Errors
    ///
    /// Returns the platform adapter error when the group, limits, suspended
    /// launch or pre-execution assignment cannot be proven.
    fn spawn_runner_contained_with_handles(
        &self,
        resource_group_id: ResourceGroupId,
        budget: &ResourceBudget,
        launch: &ContainedLaunch,
        child_handles: ChildHandleAllowlist,
    ) -> SpawnResult<Self::Group, Self::Error>;

    /// Creates a runner with an explicitly empty inherited-handle set.
    ///
    /// # Errors
    ///
    /// Returns the same errors as [`Self::spawn_runner_contained_with_handles`].
    fn spawn_runner_contained(
        &self,
        resource_group_id: ResourceGroupId,
        budget: &ResourceBudget,
        launch: &ContainedLaunch,
    ) -> SpawnResult<Self::Group, Self::Error> {
        self.spawn_runner_contained_with_handles(
            resource_group_id,
            budget,
            launch,
            ChildHandleAllowlist::new(),
        )
    }

    /// Spawns a descendant in the existing group before its first instruction.
    ///
    /// # Errors
    ///
    /// Returns the platform error when pre-execution containment is not proven.
    fn spawn_descendant_contained(
        &self,
        group: &Self::Group,
        launch: &ContainedLaunch,
    ) -> Result<ProcessId, Self::Error>;

    /// Requests termination of every process owned by a resource group.
    /// Success confirms that the operating system accepted the request;
    /// [`Self::reap_group`] is the only proof that the tree became empty.
    ///
    /// # Errors
    ///
    /// Returns the platform adapter error when the termination request fails.
    fn terminate_group(&self, group: &Self::Group, exit_code: u32) -> Result<(), Self::Error>;

    /// Consumes a physically empty resource group and closes its owned handles.
    /// A failure returns the group so ownership can never disappear on timeout.
    ///
    /// # Errors
    ///
    /// Returns the still-owned group together with the platform error when the
    /// tree cannot be proved empty before `timeout`.
    fn reap_group(
        &self,
        group: Self::Group,
        timeout: Duration,
    ) -> Result<PhysicalReapEvidence, ReapFailure<Self::Group, Self::Error>>;
}
