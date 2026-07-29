use std::io::Read;

use agent_protocol::frame::CONTROL_FRAME_MAX_BYTES;
use agent_protocol::framing::DelimitedFrameCodec;
use agent_protocol::generated::v1 as wire;
use prost::Message;

/// Observed frames before the runner committed `AttemptPrepared`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PreparedProbeOutput {
    pub frames: usize,
    pub saw_agent_hello: bool,
}

/// Reads bounded control frames until the exact `AttemptPrepared` response.
///
/// # Errors
///
/// Rejects malformed, oversized, reordered, or prematurely closed output.
pub fn read_prepared_probe_output(reader: &mut impl Read) -> Result<PreparedProbeOutput, String> {
    let maximum =
        u32::try_from(CONTROL_FRAME_MAX_BYTES).map_err(|_| "control frame cap exceeds u32")?;
    let codec = DelimitedFrameCodec::new(maximum).map_err(|error| error.to_string())?;
    let mut frames = 0_usize;
    let mut saw_agent_hello = false;
    loop {
        let raw = codec
            .read_raw(reader)
            .map_err(|error| format!("cannot read runner output: {error}"))?
            .ok_or_else(|| "runner closed before AttemptPrepared".to_owned())?;
        frames += 1;
        let frame = wire::Frame::decode(raw.as_slice())
            .map_err(|error| format!("cannot decode runner frame: {error}"))?;
        let payload = wire::FramePayload::decode(frame.encoded_payload.as_slice())
            .map_err(|error| format!("cannot decode runner payload: {error}"))?;
        match payload.body {
            Some(wire::frame_payload::Body::AgentHello(_)) if frames == 1 => {
                saw_agent_hello = true;
            }
            Some(wire::frame_payload::Body::AttemptPrepared(_))
                if saw_agent_hello && frames == 2 =>
            {
                return Ok(PreparedProbeOutput {
                    frames,
                    saw_agent_hello,
                });
            }
            _ => return Err("runner emitted an unexpected pre-prepared frame".into()),
        }
    }
}
