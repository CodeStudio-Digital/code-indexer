use agent_protocol::frame::{PendingInbound, ReplayedFrame};

use crate::control::{ActivationOutcome, CancelOutcome, FenceOutcome, PrepareOutcome};

#[derive(Debug)]
pub enum ControlDriverEvent {
    Replayed(ReplayedFrame),
    Prepare(PrepareOutcome),
    Activate(ActivationOutcome),
    Cancel(CancelOutcome),
    Fence(FenceOutcome),
}

#[derive(Debug)]
pub(super) struct HeldPrepare {
    pub inbound: PendingInbound,
}
