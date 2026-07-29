use std::io::{self, Cursor, Write};
use std::sync::{Arc, Mutex};

use prost::Message;

use super::support;
use crate::framing::DelimitedFrameCodec;
use crate::runner_bootstrap::{
    RUNNER_ENDPOINTS_READY_MAX_BYTES, RUNNER_LAUNCH_HANDOFF_MAX_BYTES,
    RunnerBootstrapTransportError, RunnerPhysicalBootstrapReceiver,
    SupervisorPhysicalBootstrapSender, prepare_runner_launch_handoff,
};

mod owned;

#[derive(Debug, Clone, Default)]
struct SharedWriter(Arc<Mutex<Vec<u8>>>);

impl SharedWriter {
    fn bytes(&self) -> Vec<u8> {
        self.0.lock().expect("writer").clone()
    }
}

impl Write for SharedWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().expect("writer").extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn directional_transport_round_trips_one_handoff_and_one_ready() {
    let handoff = support::windows_handoff();
    let prepared = prepare_runner_launch_handoff(handoff.clone()).expect("handoff");
    let supervisor_output = SharedWriter::default();
    let pending = SupervisorPhysicalBootstrapSender::new(
        Cursor::new(framed_ready(&handoff)),
        supervisor_output.clone(),
    )
    .send(prepared)
    .expect("send handoff");
    pending.receive().expect("matched ready");

    let runner_output = SharedWriter::default();
    let received = RunnerPhysicalBootstrapReceiver::new(
        Cursor::new(supervisor_output.bytes()),
        runner_output.clone(),
    )
    .receive()
    .expect("receive handoff");
    let (validated, response) = received.into_parts();
    let ready = expected_ready(&handoff, validated.original_frame_sha256());
    response.send(&ready).expect("send ready");

    assert_eq!(runner_output.bytes(), framed_ready(&handoff));
}

#[test]
fn runner_rejects_missing_and_trailing_handoff_frames() {
    let missing =
        RunnerPhysicalBootstrapReceiver::new(Cursor::new(Vec::new()), Vec::<u8>::new()).receive();
    assert!(matches!(
        missing,
        Err(RunnerBootstrapTransportError::UnexpectedEof(
            "RunnerLaunchHandoff"
        ))
    ));

    let handoff = support::windows_handoff();
    let mut frames = framed(&handoff, RUNNER_LAUNCH_HANDOFF_MAX_BYTES);
    frames.extend(framed(&handoff, RUNNER_LAUNCH_HANDOFF_MAX_BYTES));
    let trailing =
        RunnerPhysicalBootstrapReceiver::new(Cursor::new(frames), Vec::<u8>::new()).receive();
    assert!(matches!(
        trailing,
        Err(RunnerBootstrapTransportError::TrailingFrame(
            "RunnerLaunchHandoff"
        ))
    ));
}

#[test]
fn supervisor_applies_the_smaller_ready_cap_before_decode() {
    let handoff = support::windows_handoff();
    let prepared = prepare_runner_launch_handoff(handoff).expect("handoff");
    let mut oversized = Vec::new();
    DelimitedFrameCodec::new(u32::try_from(RUNNER_LAUNCH_HANDOFF_MAX_BYTES).expect("handoff cap"))
        .expect("larger codec")
        .write_raw(
            &mut oversized,
            &vec![1; RUNNER_ENDPOINTS_READY_MAX_BYTES + 1],
        )
        .expect("oversized ready fixture");
    let pending = SupervisorPhysicalBootstrapSender::new(Cursor::new(oversized), Vec::<u8>::new())
        .send(prepared)
        .expect("handoff send");

    assert!(matches!(
        pending.receive(),
        Err(RunnerBootstrapTransportError::Framing(_))
    ));
}

fn framed_ready(handoff: &crate::generated::v1::RunnerLaunchHandoff) -> Vec<u8> {
    let encoded_handoff = handoff.encode_to_vec();
    let digest = crate::runner_bootstrap::runner_launch_handoff_sha256(&encoded_handoff);
    framed(
        &expected_ready(handoff, &digest),
        RUNNER_ENDPOINTS_READY_MAX_BYTES,
    )
}

fn expected_ready(
    handoff: &crate::generated::v1::RunnerLaunchHandoff,
    digest: &[u8; 32],
) -> crate::generated::v1::RunnerEndpointsReady {
    crate::generated::v1::RunnerEndpointsReady {
        schema_version: 1,
        identity: handoff.identity.clone(),
        runtime_instance_id: handoff.runtime_instance_id.clone(),
        runner_process_id: handoff.runner_process_id,
        acknowledged_handoff_sha256: digest.to_vec(),
        endpoints: handoff
            .endpoints
            .iter()
            .map(|endpoint| crate::generated::v1::RunnerReadyEndpoint {
                kind: endpoint.kind,
                endpoint_id: endpoint.endpoint_id.clone(),
                address: endpoint.address.clone(),
                connection_id: endpoint.connection_id.clone(),
            })
            .collect(),
    }
}

fn framed(message: &impl Message, maximum: usize) -> Vec<u8> {
    let mut output = Vec::new();
    DelimitedFrameCodec::new(u32::try_from(maximum).expect("cap"))
        .expect("codec")
        .write(&mut output, message)
        .expect("frame");
    output
}
