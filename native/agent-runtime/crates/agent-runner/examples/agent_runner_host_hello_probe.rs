//! Test-only physical Host peer for the Windows production-runner E2E.

use std::process::ExitCode;

#[cfg(windows)]
fn main() -> ExitCode {
    windows::run().map_or_else(
        |error| {
            eprintln!("host Hello probe failed: {error}");
            ExitCode::from(1)
        },
        |()| ExitCode::SUCCESS,
    )
}

#[cfg(not(windows))]
fn main() -> ExitCode {
    ExitCode::from(78)
}

#[cfg(windows)]
mod windows {
    use std::error::Error;
    use std::io;
    use std::time::{SystemTime, UNIX_EPOCH};

    use agent_platform::ipc::ExpectedLocalPeer;
    use agent_platform::windows::ipc::{WindowsEndpointClient, WindowsProtectedEndpoint};
    use agent_protocol::frame::{
        BootstrapReceiveOutcome, BootstrapReceiver, CONTROL_FRAME_MAX_BYTES, FrameDirection,
        encode_attempt_frame,
    };
    use agent_protocol::framing::DelimitedFrameCodec;
    use agent_protocol::generated::v1 as wire;
    use agent_protocol::identity::ConnectionId;
    use agent_protocol::version::ProtocolVersion;
    use agent_protocol::wire_identity::identity_from_wire;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::time::{Duration, sleep};

    const INPUT_MAX_BYTES: u32 = 1024 * 1024;
    const NEGOTIATED_CONTROL_MAX_BYTES: u64 = 64 * 1024;

    pub fn run() -> Result<(), Box<dyn Error>> {
        let codec = DelimitedFrameCodec::new(INPUT_MAX_BYTES)?;
        let mut input = io::stdin().lock();
        let launch = codec
            .read::<wire::LaunchAttemptProcess>(&mut input)?
            .ok_or("missing launch plan")?;
        let spawned = codec
            .read::<wire::AttemptProcessSpawned>(&mut input)?
            .ok_or("missing spawned fact")?;
        drop(input);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .enable_time()
            .build()?;
        runtime.block_on(hello(launch, spawned))
    }

    async fn hello(
        launch: wire::LaunchAttemptProcess,
        spawned: wire::AttemptProcessSpawned,
    ) -> Result<(), Box<dyn Error>> {
        let identity_wire = launch.identity.as_ref().ok_or("missing launch identity")?;
        if spawned.identity.as_ref() != Some(identity_wire) {
            return Err("spawned identity differs from launch".into());
        }
        let provenance = spawned
            .runner_provenance
            .as_ref()
            .ok_or("missing spawned provenance")?;
        let control = launch
            .protected_endpoints
            .iter()
            .find(|endpoint| endpoint.kind == wire::AttemptEndpointKind::Control as i32)
            .ok_or("missing control endpoint")?;
        let expected_runner = ExpectedLocalPeer::new(provenance.pid)?;
        let mut stream = None;
        let mut last_connect_error = None;
        for _ in 0..100 {
            match WindowsProtectedEndpoint::connect_expected_address(
                &control.address,
                expected_runner,
            ) {
                Ok(connected) => {
                    stream = Some(connected);
                    break;
                }
                Err(error) => last_connect_error = Some(error),
            }
            sleep(Duration::from_millis(10)).await;
        }
        let mut stream = stream.ok_or_else(|| {
            last_connect_error.expect("at least one physical connect attempt failed")
        })?;
        let encoded = read_delimited(&mut stream, CONTROL_FRAME_MAX_BYTES).await?;
        let identity = identity_from_wire(identity_wire)?;
        let connection = ConnectionId::new(control.connection_id.clone())?;
        let mut receiver = BootstrapReceiver::new(
            identity,
            connection,
            FrameDirection::RunnerToHost,
            CONTROL_FRAME_MAX_BYTES,
        )?;
        let outcome = receiver.receive(&encoded, unix_ms)?;
        let BootstrapReceiveOutcome::AgentHello(agent) = outcome else {
            return Err("runner did not send AgentHello".into());
        };
        let observed = agent.hello();
        if observed.launch_nonce != launch.launch_nonce
            || observed.provenance.as_ref() != Some(provenance)
            || observed.contract_version != "1.0.0"
            || observed.contract_schema_version != 1
        {
            return Err("AgentHello differs from protected launch authority".into());
        }
        let host_hello = wire::HostHello {
            selected_protocol: Some(wire::ProtocolVersion { major: 1, minor: 1 }),
            connection_id: control.connection_id.clone(),
            contract_version: "1.0.0".into(),
            contract_schema_version: 1,
            heartbeat_interval_ms: 1_000,
            heartbeat_timeout_ms: 3_000,
            frame_limits: Some(wire::FrameLimits {
                max_frame_bytes: NEGOTIATED_CONTROL_MAX_BYTES,
                max_chunk_bytes: 16 * 1024,
                max_in_flight_frames: 4,
                max_in_flight_bytes: NEGOTIATED_CONTROL_MAX_BYTES,
                read_timeout_ms: 1_000,
                write_timeout_ms: 1_000,
                transport_crc32c: false,
            }),
            connection_session_token: control.connection_token.clone(),
            allowed_feature_bits: 0,
            required_feature_bits: 0,
        };
        let frame = encode_attempt_frame(
            header(identity_wire, control, launch.hard_deadline_at_unix_ms),
            wire::TransportChannel::Control,
            &wire::FramePayload {
                body: Some(wire::frame_payload::Body::HostHello(host_hello)),
            },
            CONTROL_FRAME_MAX_BYTES,
        )?;
        write_delimited(&mut stream, &frame).await?;
        Ok(())
    }

    fn header(
        identity: &wire::AttemptIdentity,
        control: &wire::ProtectedAttemptEndpoint,
        deadline_at_unix_ms: i64,
    ) -> wire::FrameHeader {
        wire::FrameHeader {
            protocol_version: ProtocolVersion::new(1, 1).to_wire(),
            connection_id: control.connection_id.clone(),
            message_id: "physical-host-hello".into(),
            session_id: identity.session_id.clone(),
            command_id: identity.command_id.clone(),
            agent_run_id: identity.agent_run_id.clone(),
            attempt_id: identity.attempt_id.clone(),
            executor_owner_id: identity.executor_owner_id.clone(),
            fencing_epoch: identity.fencing_epoch,
            correlation_id: identity.correlation_id.clone(),
            stream_seq: 1,
            sent_at_unix_ms: unix_ms(),
            deadline_at_unix_ms: Some(deadline_at_unix_ms),
            root_agent_run_id: identity.root_agent_run_id.clone(),
            owner_agent_run_id: identity.owner_agent_run_id.clone(),
            parent_agent_run_id: identity.parent_agent_run_id.clone(),
            ..wire::FrameHeader::default()
        }
    }

    async fn read_delimited(
        stream: &mut WindowsEndpointClient,
        maximum: usize,
    ) -> Result<Vec<u8>, Box<dyn Error>> {
        let length = read_length(stream).await?;
        if length == 0 || length > maximum {
            return Err("AgentHello frame length exceeds control cap".into());
        }
        let mut frame = vec![0; length];
        stream.read_exact(&mut frame).await?;
        Ok(frame)
    }

    async fn read_length(stream: &mut WindowsEndpointClient) -> Result<usize, Box<dyn Error>> {
        let mut value = 0_u32;
        for index in 0..5 {
            let byte = stream.read_u8().await?;
            value |= u32::from(byte & 0x7f) << (index * 7);
            if byte & 0x80 == 0 {
                return usize::try_from(value).map_err(Into::into);
            }
        }
        Err("AgentHello frame length overflow".into())
    }

    async fn write_delimited(
        stream: &mut WindowsEndpointClient,
        frame: &[u8],
    ) -> Result<(), Box<dyn Error>> {
        let length = u32::try_from(frame.len())?;
        let mut value = length;
        let mut prefix = [0_u8; 5];
        let mut count = 0;
        loop {
            let mut byte = u8::try_from(value & 0x7f)?;
            value >>= 7;
            if value != 0 {
                byte |= 0x80;
            }
            prefix[count] = byte;
            count += 1;
            if value == 0 {
                break;
            }
        }
        stream.write_all(&prefix[..count]).await?;
        stream.write_all(frame).await?;
        stream.flush().await?;
        Ok(())
    }

    fn unix_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .and_then(|elapsed| i64::try_from(elapsed.as_millis()).ok())
            .unwrap_or(1)
    }
}
