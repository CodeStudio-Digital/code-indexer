use std::error::Error;
use std::fmt::{self, Display, Formatter};

use agent_protocol::wire_identity::WireIdentityError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpecValidationError {
    UnsupportedSchemaVersion(u32),
    ZeroSpecVersion,
    ZeroOrdinal,
    MissingIdentity,
    InvalidIdentity(WireIdentityError),
    InvalidLaunchIdentity(WireIdentityError),
    IdentityMismatch,
    UnknownTrigger(i32),
    UnspecifiedTrigger,
    TriggerOrdinalMismatch,
    UnknownWaitMode(i32),
    UnspecifiedWaitMode,
    InvalidText {
        field: &'static str,
        reason: &'static str,
    },
    MissingTask,
    MissingTaskBody,
    InlineTaskTooLarge {
        length: usize,
        maximum: usize,
    },
    TooManyAttachments {
        count: usize,
        maximum: usize,
    },
    MissingProviderBinding,
    TooManyDowngradeReasons {
        count: usize,
        maximum: usize,
    },
    DuplicateDowngradeReason {
        index: usize,
    },
    MissingDowngradeReason,
    MissingRunTreeBudget,
    InvalidRunTreeBudget(&'static str),
    RunTreeDepthExceeded {
        spawn_depth: u32,
        maximum: u32,
    },
    RunTreeWallBelowAttempt,
    InvalidRunGraph(&'static str),
    ZeroWorkspaceLeaseFence,
    MissingRequiredSnapshot(&'static str),
    InvalidSnapshot {
        field: &'static str,
        reason: &'static str,
    },
    DuplicateSnapshotRef {
        field: &'static str,
    },
    MissingResourceBudget,
    InvalidResourceBudget(&'static str),
    InvalidLaunchBudget(Box<Self>),
    LaunchBudgetMismatch,
    InvalidArtifact {
        index: usize,
        reason: &'static str,
    },
    DuplicateArtifactId {
        index: usize,
    },
    ArtifactOwnerMismatch {
        index: usize,
    },
    ArtifactBudgetExceeded,
    InvalidLaunchDeadline(i64),
    InvalidObservedTime(i64),
    InvalidDeadline(i64),
    DeadlineExceedsLaunch {
        requested: i64,
        launch: i64,
    },
    DeadlineExpired {
        deadline: i64,
        observed: i64,
    },
}

impl Display for SpecValidationError {
    #[allow(clippy::too_many_lines)]
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedSchemaVersion(version) => {
                write!(formatter, "resolved spec schema {version} is unsupported")
            }
            Self::ZeroSpecVersion => formatter.write_str("spec version must be positive"),
            Self::ZeroOrdinal => formatter.write_str("attempt ordinal must be positive"),
            Self::MissingIdentity => formatter.write_str("resolved spec identity is missing"),
            Self::InvalidIdentity(error) => write!(formatter, "invalid spec identity: {error}"),
            Self::InvalidLaunchIdentity(error) => {
                write!(formatter, "invalid launch identity: {error}")
            }
            Self::IdentityMismatch => {
                formatter.write_str("resolved spec identity differs from launch authority")
            }
            Self::UnknownTrigger(value) => write!(formatter, "unknown attempt trigger {value}"),
            Self::UnspecifiedTrigger => formatter.write_str("attempt trigger is unspecified"),
            Self::TriggerOrdinalMismatch => {
                formatter.write_str("attempt trigger and ordinal are inconsistent")
            }
            Self::UnknownWaitMode(value) => write!(formatter, "unknown wait mode {value}"),
            Self::UnspecifiedWaitMode => formatter.write_str("wait mode is unspecified"),
            Self::InvalidText { field, reason } => {
                write!(formatter, "invalid {field}: {reason}")
            }
            Self::MissingTask => formatter.write_str("task is missing"),
            Self::MissingTaskBody => formatter.write_str("task body is missing"),
            Self::InlineTaskTooLarge { length, maximum } => {
                write!(
                    formatter,
                    "inline task is {length} bytes; maximum is {maximum}"
                )
            }
            Self::TooManyAttachments { count, maximum } => {
                write!(
                    formatter,
                    "task has {count} attachments; maximum is {maximum}"
                )
            }
            Self::MissingProviderBinding => formatter.write_str("provider binding is missing"),
            Self::TooManyDowngradeReasons { count, maximum } => {
                write!(
                    formatter,
                    "spec has {count} resolution reasons; maximum is {maximum}"
                )
            }
            Self::DuplicateDowngradeReason { index } => {
                write!(
                    formatter,
                    "resolution reason {index} duplicates code and dimension"
                )
            }
            Self::MissingDowngradeReason => formatter.write_str(
                "requested and effective provider bindings differ without a resolution reason",
            ),
            Self::MissingRunTreeBudget => formatter.write_str("run-tree budget is missing"),
            Self::InvalidRunTreeBudget(reason) => {
                write!(formatter, "invalid run-tree budget: {reason}")
            }
            Self::RunTreeDepthExceeded {
                spawn_depth,
                maximum,
            } => write!(
                formatter,
                "spawn depth {spawn_depth} exceeds run-tree maximum {maximum}"
            ),
            Self::RunTreeWallBelowAttempt => {
                formatter.write_str("attempt wall budget exceeds the run-tree wall budget")
            }
            Self::InvalidRunGraph(reason) => write!(formatter, "invalid run graph: {reason}"),
            Self::ZeroWorkspaceLeaseFence => {
                formatter.write_str("workspace lease fence must be positive")
            }
            Self::MissingRequiredSnapshot(field) => {
                write!(formatter, "required snapshot {field} is missing")
            }
            Self::InvalidSnapshot { field, reason } => {
                write!(formatter, "invalid snapshot {field}: {reason}")
            }
            Self::DuplicateSnapshotRef { field } => {
                write!(formatter, "snapshot {field} repeats an existing ref")
            }
            Self::MissingResourceBudget => formatter.write_str("resource budget is missing"),
            Self::InvalidResourceBudget(reason) => {
                write!(formatter, "invalid resource budget: {reason}")
            }
            Self::InvalidLaunchBudget(error) => {
                write!(formatter, "invalid launch resource budget: {error}")
            }
            Self::LaunchBudgetMismatch => {
                formatter.write_str("spec resource budget differs from launch authority")
            }
            Self::InvalidArtifact { index, reason } => {
                write!(formatter, "invalid input artifact {index}: {reason}")
            }
            Self::DuplicateArtifactId { index } => {
                write!(formatter, "input artifact {index} repeats an artifact ID")
            }
            Self::ArtifactOwnerMismatch { index } => {
                write!(
                    formatter,
                    "input artifact {index} belongs to another session"
                )
            }
            Self::ArtifactBudgetExceeded => {
                formatter.write_str("input artifacts exceed the resource budget")
            }
            Self::InvalidLaunchDeadline(value) => {
                write!(formatter, "launch hard deadline {value} is invalid")
            }
            Self::InvalidObservedTime(value) => {
                write!(formatter, "observed time {value} is invalid")
            }
            Self::InvalidDeadline(value) => write!(formatter, "spec deadline {value} is invalid"),
            Self::DeadlineExceedsLaunch { requested, launch } => write!(
                formatter,
                "spec deadline {requested} exceeds launch deadline {launch}"
            ),
            Self::DeadlineExpired { deadline, observed } => write!(
                formatter,
                "spec deadline {deadline} expired at observed time {observed}"
            ),
        }
    }
}

impl Error for SpecValidationError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::InvalidIdentity(error) | Self::InvalidLaunchIdentity(error) => Some(error),
            Self::InvalidLaunchBudget(error) => Some(error),
            _ => None,
        }
    }
}
