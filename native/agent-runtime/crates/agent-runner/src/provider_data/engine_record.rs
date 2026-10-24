use super::ProviderDataError;
use agent_protocol::generated::v1 as wire;

pub(super) fn storage(record: &wire::EngineEventRecordV1) -> Result<(i32, i32), ProviderDataError> {
    use wire::SessionDurabilityClass as Durability;
    use wire::SessionRecordKind as Kind;
    use wire::engine_event_record_v1::Body;
    let result = match &record.body {
        Some(Body::Content(content)) => match wire::EngineContentKindV1::try_from(content.kind) {
            Ok(wire::EngineContentKindV1::Transcript) => {
                (Kind::Conversation, Durability::Coalesced)
            }
            Ok(wire::EngineContentKindV1::ToolInput) => (Kind::Input, Durability::Authoritative),
            Ok(wire::EngineContentKindV1::ToolResult) => {
                (Kind::ToolOutput, Durability::Authoritative)
            }
            _ => return Err(ProviderDataError::InvalidRequest("invalid content kind")),
        },
        Some(Body::ProviderDelta(_)) => (Kind::LifecycleEvent, Durability::Coalesced),
        Some(
            Body::CapabilityBoundary(_)
            | Body::CapabilityDispatchStarted(_)
            | Body::CapabilityTerminal(_)
            | Body::CapabilityRefused(_)
            | Body::Terminal(_),
        ) => (Kind::LifecycleEvent, Durability::Authoritative),
        _ => (Kind::LifecycleEvent, Durability::Durable),
    };
    Ok((result.0 as i32, result.1 as i32))
}
