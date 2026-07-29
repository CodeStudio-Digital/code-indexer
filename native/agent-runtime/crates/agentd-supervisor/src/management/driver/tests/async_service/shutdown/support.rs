use std::time::{SystemTime, UNIX_EPOCH};

use agent_protocol::generated::v1 as wire;
use agent_protocol::management_channel::AsyncEstablishedManagementActor;

use super::super::fixtures::{TestService, assert_acknowledged};
use crate::management::{
    SupervisorAsyncServiceAdvance, SupervisorAsyncServiceOutcome, SupervisorManagementTerminal,
};

pub(super) fn shutdown_command(
    mode: wire::SupervisorShutdownMode,
    idempotency_key: &str,
    after_ms: i64,
) -> wire::ShutdownSupervisor {
    wire::ShutdownSupervisor {
        mode: mode as i32,
        shutdown_deadline_at_unix_ms: now_unix_ms() + after_ms,
        reason_code: "test.native-shutdown".into(),
        idempotency_key: idempotency_key.into(),
    }
}

pub(super) fn wire_payload(command: wire::ShutdownSupervisor) -> wire::ManagementPayload {
    wire::ManagementPayload {
        body: Some(wire::management_payload::Body::ShutdownSupervisor(command)),
    }
}

pub(super) async fn send_and_ack(
    host: &mut AsyncEstablishedManagementActor,
    service: &mut TestService,
    command: wire::ShutdownSupervisor,
) {
    host.command_port()
        .send(wire_payload(command))
        .await
        .expect("shutdown physically written");
    assert!(matches!(
        service.advance().await,
        SupervisorAsyncServiceAdvance::ShutdownArmed
    ));
    assert_acknowledged(host).await;
}

pub(super) async fn assert_clean_shutdown(service: TestService) {
    let outcome = service.run().await;
    let SupervisorAsyncServiceOutcome::PhysicallyDrained { owner, terminal } = outcome else {
        panic!("empty shutdown must return its owner");
    };
    assert_eq!(terminal, SupervisorManagementTerminal::Shutdown);
    assert_eq!(owner.owned_attempts(), 0);
}

fn now_unix_ms() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_millis(),
    )
    .expect("timestamp fits")
}
