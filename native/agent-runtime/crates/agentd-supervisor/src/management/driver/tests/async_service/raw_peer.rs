use std::sync::Arc;

use agent_protocol::generated::v1 as wire;
use agent_protocol::management_channel::{AsyncEstablishedManagementActor, AsyncManagementEvent};
use agent_protocol::management_frame::validate_management_frame;

use super::super::fakes::{ContainmentState, FakeContainment, FakeProvisioner};
use super::super::support::{
    TestWriter, decoded_bodies, decoded_frames, established, launch_attempt, launch_frame,
    peer_authority, trusted_runner,
};
use super::fixtures::{TestCore, service};
use crate::management::driver::SupervisorPhysicalDriver;
use crate::management::driver::fact_flow::FactFlow;
use crate::management::{
    ManagementEnvelopeReceipt, SupervisorAsyncService, SystemSupervisorLifecycleClock,
    TokioSupervisorLifecycleTimer,
};

mod clock_failure;
mod framing;
mod launch;
mod peer;
mod pending_launch;

use framing::now_unix_ms;
pub(super) use peer::{RawHost, RawInbound, raw_pair};

type TestService = SupervisorAsyncService<
    FakeContainment,
    FakeProvisioner,
    SystemSupervisorLifecycleClock,
    TokioSupervisorLifecycleTimer,
>;

pub(super) async fn fact_bound_service() -> (RawHost, RawInbound, Arc<ContainmentState>, TestService)
{
    fact_bound_service_with_capacity(256 * 1024).await
}

pub(super) async fn fact_bound_service_with_capacity(
    capacity: usize,
) -> (RawHost, RawInbound, Arc<ContainmentState>, TestService) {
    let (raw, accepted, containment, core, actor) = fact_bound_parts(capacity).await;
    let (_shutdown, service) = service(actor, core);
    (raw, accepted, containment, service)
}

pub(super) async fn fact_bound_parts(
    capacity: usize,
) -> (
    RawHost,
    RawInbound,
    Arc<ContainmentState>,
    TestCore,
    AsyncEstablishedManagementActor,
) {
    let (mut core, containment, mut accepted, action) = launched_core_action();
    let (mut raw, mut actor) = raw_pair(capacity).await;
    raw.send_launch().await;
    let event = actor
        .receive()
        .await
        .expect("actor open")
        .expect("valid raw launch");
    let AsyncManagementEvent::Pending(mut pending) = event else {
        panic!("raw launch must be pending");
    };
    let request_sent_at = pending.pending_mut().header().sent_at_unix_ms;
    let wire::management_payload::Body::LaunchAccepted(value) = &mut accepted else {
        panic!("fixture must produce LaunchAccepted");
    };
    value.accepted_at_unix_ms = now_unix_ms().max(request_sent_at);
    let queued = pending
        .respond(wire::ManagementPayload {
            body: Some(accepted),
        })
        .expect("queue LaunchAccepted");
    let (sent, accepted) = tokio::join!(queued.written(), raw.receive());
    let sent = sent.expect("write LaunchAccepted");
    assert_eq!(accepted.message_id, sent.message_id());
    assert!(
        core.fact_flow
            .track(&ManagementEnvelopeReceipt::from(&sent), action)
    );
    (raw, accepted, containment, core, actor)
}

fn launched_core_action() -> (
    TestCore,
    Arc<ContainmentState>,
    wire::management_payload::Body,
    crate::management::driver::fact_flow::PendingFactAction,
) {
    let writer = TestWriter::default();
    let launch = launch_attempt();
    let channel = established(
        vec![launch_frame(launch, "launch:fact-bound", 2)],
        writer.clone(),
    );
    let (containment, state) = FakeContainment::healthy();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        FakeProvisioner::successful(),
        trusted_runner(),
        peer_authority(),
    )
    .expect("physical driver");
    driver.process_next().expect("launch owner");
    let accepted = decoded_bodies(&writer).remove(1);
    let mut encoded = validate_management_frame(&decoded_frames(&writer)[1]).expect("accepted");
    let header = encoded.frame.header.take().expect("accepted header");
    let ack = wire::ManagementAck {
        acknowledged_message_id: header.message_id,
        acknowledged_payload_sha256: header.payload_sha256,
        acknowledged_at_unix_ms: now_unix_ms(),
    };
    let action = driver
        .core
        .fact_flow
        .take_ack(&ack)
        .expect("pending action");
    driver.core.fact_flow = FactFlow::new(4);
    (driver.core, state, accepted, action)
}
