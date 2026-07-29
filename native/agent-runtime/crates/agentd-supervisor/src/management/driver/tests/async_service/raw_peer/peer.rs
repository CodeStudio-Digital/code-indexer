use agent_protocol::generated::v1 as wire;
use agent_protocol::identity::ConnectionId;
use agent_protocol::management_channel::{
    AsyncBootstrapManagementActor, AsyncEstablishedManagementActor,
};
use agent_protocol::management_frame::{encode_management_frame, validate_management_frame};
use tokio::io::DuplexStream;

use super::super::super::support::{
    CONNECTION, NONCE, TOKEN, host_hello_with_maximum_in_flight, launch_attempt,
};
use super::framing::{header, now_unix_ms, read_delimited, write_delimited};

pub(in crate::management::driver::tests::async_service) struct RawInbound {
    pub(in crate::management::driver::tests::async_service) message_id: String,
    pub(in crate::management::driver::tests::async_service) reply_to_message_id: Option<String>,
    pub(in crate::management::driver::tests::async_service) payload_digest: [u8; 32],
    pub(in crate::management::driver::tests::async_service) sent_at_unix_ms: i64,
    pub(in crate::management::driver::tests::async_service) body: wire::management_payload::Body,
    pub(in crate::management::driver::tests::async_service) encoded: Vec<u8>,
}

pub(in crate::management::driver::tests::async_service) struct RawSent {
    pub(super) encoded: Vec<u8>,
}

pub(in crate::management::driver::tests::async_service) struct RawHost {
    stream: DuplexStream,
    next_stream_seq: u64,
}

impl RawHost {
    pub(in crate::management::driver::tests::async_service) async fn send_launch(&mut self) {
        let _sent = self
            .send(
                wire::management_payload::Body::LaunchAttemptProcess(launch_attempt()),
                None,
                None,
            )
            .await;
    }

    pub(in crate::management::driver::tests::async_service) async fn send_launch_recorded(
        &mut self,
    ) -> RawSent {
        self.send(
            wire::management_payload::Body::LaunchAttemptProcess(launch_attempt()),
            None,
            None,
        )
        .await
    }

    pub(in crate::management::driver::tests::async_service) async fn send_shutdown(
        &mut self,
        command: wire::ShutdownSupervisor,
    ) {
        let _sent = self.send_shutdown_recorded(command).await;
    }

    pub(in crate::management::driver::tests::async_service) async fn send_shutdown_recorded(
        &mut self,
        command: wire::ShutdownSupervisor,
    ) -> RawSent {
        self.send(
            wire::management_payload::Body::ShutdownSupervisor(command),
            None,
            None,
        )
        .await
    }

    pub(in crate::management::driver::tests::async_service) async fn replay(
        &mut self,
        sent: &RawSent,
    ) {
        write_delimited(&mut self.stream, &sent.encoded).await;
    }

    pub(in crate::management::driver::tests::async_service) async fn acknowledge(
        &mut self,
        inbound: &RawInbound,
    ) {
        let timestamp = now_unix_ms().max(inbound.sent_at_unix_ms);
        let _sent = self
            .send(
                wire::management_payload::Body::ManagementAck(wire::ManagementAck {
                    acknowledged_message_id: inbound.message_id.clone(),
                    acknowledged_payload_sha256: inbound.payload_digest.to_vec(),
                    acknowledged_at_unix_ms: timestamp,
                }),
                Some(inbound.message_id.clone()),
                Some(timestamp),
            )
            .await;
    }

    pub(in crate::management::driver::tests::async_service) async fn receive(
        &mut self,
    ) -> RawInbound {
        let encoded = read_delimited(&mut self.stream).await;
        let mut validated = validate_management_frame(&encoded).expect("valid raw peer frame");
        let header = validated.frame.header.take().expect("frame header");
        let payload_digest = header
            .payload_sha256
            .as_slice()
            .try_into()
            .expect("payload digest");
        RawInbound {
            message_id: header.message_id,
            reply_to_message_id: header.reply_to_message_id,
            payload_digest,
            sent_at_unix_ms: header.sent_at_unix_ms,
            body: validated.payload.body.take().expect("frame body"),
            encoded,
        }
    }

    async fn send(
        &mut self,
        body: wire::management_payload::Body,
        reply_to_message_id: Option<String>,
        timestamp: Option<i64>,
    ) -> RawSent {
        let stream_seq = self.next_stream_seq;
        self.next_stream_seq += 1;
        let sent_at_unix_ms = timestamp.unwrap_or_else(now_unix_ms);
        let encoded = encode_management_frame(
            header(
                format!("raw-host:{stream_seq}"),
                stream_seq,
                sent_at_unix_ms,
                reply_to_message_id,
            ),
            &wire::ManagementPayload { body: Some(body) },
        )
        .expect("encode raw host frame");
        write_delimited(&mut self.stream, &encoded).await;
        RawSent { encoded }
    }
}

pub(in crate::management::driver::tests::async_service) async fn raw_pair(
    capacity: usize,
) -> (RawHost, AsyncEstablishedManagementActor) {
    let (host_stream, supervisor_stream) = tokio::io::duplex(capacity);
    let supervisor = AsyncBootstrapManagementActor::supervisor(
        supervisor_stream,
        ConnectionId::new(CONNECTION).expect("connection"),
        NONCE.to_vec(),
        TOKEN.to_vec(),
    )
    .expect("supervisor bootstrap");
    let supervisor_hello = super::super::fixtures::supervisor_hello();
    let raw = raw_handshake(host_stream);
    let established = supervisor.establish_supervisor(&supervisor_hello);
    let (raw, actor) = tokio::join!(raw, established);
    (raw, actor.expect("supervisor established"))
}

async fn raw_handshake(mut stream: DuplexStream) -> RawHost {
    let hello = wire::ManagementPayload {
        body: Some(wire::management_payload::Body::HostSupervisorHello(
            host_hello_with_maximum_in_flight(4),
        )),
    };
    let encoded = encode_management_frame(
        header("raw-host-bootstrap".into(), 1, now_unix_ms(), None),
        &hello,
    )
    .expect("encode host Hello");
    write_delimited(&mut stream, &encoded).await;
    let response = read_delimited(&mut stream).await;
    let validated = validate_management_frame(&response).expect("valid supervisor Hello");
    assert!(matches!(
        validated.payload.body,
        Some(wire::management_payload::Body::SupervisorHello(_))
    ));
    RawHost {
        stream,
        next_stream_seq: 2,
    }
}
