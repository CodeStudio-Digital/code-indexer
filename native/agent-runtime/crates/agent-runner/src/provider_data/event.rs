use agent_protocol::generated::v1 as wire;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderWireEvent {
    Text(wire::ProviderTextDelta),
    Thinking(wire::ProviderThinkingDelta),
    ToolCall(wire::ProviderToolCall),
    Usage(wire::ProviderUsageEvent),
    Terminal(wire::ProviderTerminal),
}

impl ProviderWireEvent {
    #[must_use]
    pub const fn is_terminal(&self) -> bool {
        matches!(self, Self::Terminal(_))
    }
}
