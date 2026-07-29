use agent_protocol::generated::v1 as wire;
use zeroize::Zeroize;

pub(super) fn zeroize_identity(identity: &mut wire::AttemptIdentity) {
    identity.session_id.zeroize();
    identity.command_id.zeroize();
    identity.agent_run_id.zeroize();
    identity.attempt_id.zeroize();
    identity.executor_owner_id.zeroize();
    identity.correlation_id.zeroize();
    identity.root_agent_run_id.zeroize();
    if let Some(value) = &mut identity.owner_agent_run_id {
        value.zeroize();
    }
    if let Some(value) = &mut identity.parent_agent_run_id {
        value.zeroize();
    }
}
