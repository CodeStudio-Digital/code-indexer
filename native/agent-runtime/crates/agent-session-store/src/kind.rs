use crate::SessionStoreError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SessionRecordKind {
    Conversation,
    LifecycleEvent,
    MetricRollup,
    ToolOutput,
    Checkpoint,
    Plan,
    Task,
    Input,
    Memory,
    Subagent,
    Archive,
}

impl SessionRecordKind {
    pub(crate) const fn name(self) -> &'static str {
        match self {
            Self::Conversation => "conversation",
            Self::LifecycleEvent => "lifecycle",
            Self::MetricRollup => "metric",
            Self::ToolOutput => "tool_output",
            Self::Checkpoint => "checkpoint",
            Self::Plan => "plan",
            Self::Task => "task",
            Self::Input => "input",
            Self::Memory => "memory",
            Self::Subagent => "subagent",
            Self::Archive => "archive",
        }
    }

    pub(crate) const fn directory(self) -> &'static str {
        match self {
            Self::Conversation | Self::LifecycleEvent | Self::Archive => "events",
            Self::MetricRollup => "metrics",
            Self::ToolOutput => "tool-outputs",
            Self::Checkpoint => "checkpoints",
            Self::Plan => "plans",
            Self::Task => "tasks",
            Self::Input => "inputs",
            Self::Memory => "memory",
            Self::Subagent => "subagents",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, SessionStoreError> {
        match value {
            "conversation" => Ok(Self::Conversation),
            "lifecycle" => Ok(Self::LifecycleEvent),
            "metric" => Ok(Self::MetricRollup),
            "tool_output" => Ok(Self::ToolOutput),
            "checkpoint" => Ok(Self::Checkpoint),
            "plan" => Ok(Self::Plan),
            "task" => Ok(Self::Task),
            "input" => Ok(Self::Input),
            "memory" => Ok(Self::Memory),
            "subagent" => Ok(Self::Subagent),
            "archive" => Ok(Self::Archive),
            _ => Err(SessionStoreError::CorruptJournal),
        }
    }
}
