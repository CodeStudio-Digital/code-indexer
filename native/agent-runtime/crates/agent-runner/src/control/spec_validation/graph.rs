use agent_protocol::generated::v1 as wire;

use super::SpecValidationError;

pub(super) fn validate_trigger(
    value: i32,
    ordinal: u32,
) -> Result<wire::AttemptTrigger, SpecValidationError> {
    let trigger = wire::AttemptTrigger::try_from(value)
        .map_err(|_| SpecValidationError::UnknownTrigger(value))?;
    if trigger == wire::AttemptTrigger::Unspecified {
        return Err(SpecValidationError::UnspecifiedTrigger);
    }

    let coherent = match trigger {
        wire::AttemptTrigger::Initial | wire::AttemptTrigger::SessionContinuation => ordinal == 1,
        wire::AttemptTrigger::Resume
        | wire::AttemptTrigger::ProviderFallback
        | wire::AttemptTrigger::WorkerRecovery => ordinal > 1,
        wire::AttemptTrigger::Unspecified => false,
    };
    if !coherent {
        return Err(SpecValidationError::TriggerOrdinalMismatch);
    }
    Ok(trigger)
}

pub(super) fn validate_run_graph(
    identity: &wire::AttemptIdentity,
    spawn_depth: u32,
) -> Result<(), SpecValidationError> {
    let is_root = identity.agent_run_id == identity.root_agent_run_id;
    match (
        is_root,
        spawn_depth,
        identity.owner_agent_run_id.as_deref(),
        identity.parent_agent_run_id.as_deref(),
    ) {
        (true, 0, None, None) => Ok(()),
        (true, _, _, _) => Err(SpecValidationError::InvalidRunGraph(
            "root run must have depth zero and no owner or parent",
        )),
        (false, 0, _, _) => Err(SpecValidationError::InvalidRunGraph(
            "child run must have positive spawn depth",
        )),
        (false, _, None, _) | (false, _, _, None) => Err(SpecValidationError::InvalidRunGraph(
            "child run must have owner and parent",
        )),
        (false, _, Some(owner), Some(parent))
            if owner == identity.agent_run_id || parent == identity.agent_run_id =>
        {
            Err(SpecValidationError::InvalidRunGraph(
                "child owner and parent cannot refer to the child itself",
            ))
        }
        (false, _, Some(_), Some(_)) => Ok(()),
    }
}
