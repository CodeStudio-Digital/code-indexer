use std::error::Error;
use std::fmt::{self, Display, Formatter};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderContextError {
    MissingExecutionSeed,
    MissingValidatedField(&'static str),
    UnsupportedTrigger(i32),
    ResumeInputUnsupported,
    MissingMaterial(&'static str),
    SnapshotContract(&'static str),
    MalformedSnapshot(&'static str),
    NonCanonicalSnapshot(&'static str),
    AgentDefinitionMismatch,
    PresetMismatch,
    InvalidInferenceOptions,
    InvalidSystemPrompt,
    TooManyTools { count: usize, maximum: usize },
    InvalidTool { index: usize, reason: &'static str },
    DuplicateTool { index: usize },
    ToolSchemaHashMismatch { index: usize },
    MissingTaskArtifact,
    InvalidTaskArtifact(&'static str),
    TaskArtifactNotUtf8,
    MalformedTurnContext,
    NonCanonicalTurnContext,
    InvalidCapabilityResult(&'static str),
    ContextLimitUnsupported,
    ContextTooLarge { length: usize, maximum: usize },
}

impl Display for ProviderContextError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingExecutionSeed => {
                formatter.write_str("validated execution seed is missing")
            }
            Self::MissingValidatedField(field) => {
                write!(formatter, "validated execution field {field} is missing")
            }
            Self::UnsupportedTrigger(trigger) => {
                write!(
                    formatter,
                    "attempt trigger {trigger} is not executable by the initial composer"
                )
            }
            Self::ResumeInputUnsupported => {
                formatter.write_str("checkpoint or transcript input requires the resume composer")
            }
            Self::MissingMaterial(field) => {
                write!(formatter, "hydrated material {field} is missing")
            }
            Self::SnapshotContract(field) => {
                write!(formatter, "snapshot {field} has the wrong schema contract")
            }
            Self::MalformedSnapshot(field) => write!(formatter, "snapshot {field} is malformed"),
            Self::NonCanonicalSnapshot(field) => {
                write!(formatter, "snapshot {field} is not canonically encoded")
            }
            Self::AgentDefinitionMismatch => {
                formatter.write_str("agent definition snapshot does not match the resolved spec")
            }
            Self::PresetMismatch => {
                formatter.write_str("provider preset snapshot does not match the resolved binding")
            }
            Self::InvalidInferenceOptions => {
                formatter.write_str("provider preset inference options are incoherent")
            }
            Self::InvalidSystemPrompt => {
                formatter.write_str("agent definition system prompt is invalid")
            }
            Self::TooManyTools { count, maximum } => write!(
                formatter,
                "capability snapshot has {count} tools; maximum is {maximum}"
            ),
            Self::InvalidTool { index, reason } => {
                write!(formatter, "provider tool {index} is invalid: {reason}")
            }
            Self::DuplicateTool { index } => write!(
                formatter,
                "provider tool {index} duplicates a capability name"
            ),
            Self::ToolSchemaHashMismatch { index } => write!(
                formatter,
                "provider tool {index} schema digest does not match"
            ),
            Self::MissingTaskArtifact => formatter.write_str("hydrated task artifact is missing"),
            Self::InvalidTaskArtifact(reason) => {
                write!(formatter, "task artifact is invalid: {reason}")
            }
            Self::TaskArtifactNotUtf8 => formatter.write_str("task artifact is not UTF-8"),
            Self::MalformedTurnContext => formatter.write_str("provider turn context is malformed"),
            Self::NonCanonicalTurnContext => {
                formatter.write_str("provider turn context is not canonically encoded")
            }
            Self::InvalidCapabilityResult(reason) => {
                write!(
                    formatter,
                    "capability result cannot resume provider: {reason}"
                )
            }
            Self::ContextLimitUnsupported => {
                formatter.write_str("provider context byte limit is unsupported on this target")
            }
            Self::ContextTooLarge { length, maximum } => write!(
                formatter,
                "provider context has {length} bytes; maximum is {maximum}"
            ),
        }
    }
}

impl Error for ProviderContextError {}
