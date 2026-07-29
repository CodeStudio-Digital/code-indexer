use crate::generated::v1 as wire;
use zeroize::Zeroize;

pub(super) struct ScrubbedWireFrame(pub(super) wire::Frame);

impl Drop for ScrubbedWireFrame {
    fn drop(&mut self) {
        self.0.encoded_payload.zeroize();
    }
}

pub(in crate::frame) struct ScrubbedFrameBody(Option<wire::frame_payload::Body>);

impl ScrubbedFrameBody {
    pub(in crate::frame) const fn new(body: wire::frame_payload::Body) -> Self {
        Self(Some(body))
    }

    pub(in crate::frame) const fn as_ref(&self) -> &wire::frame_payload::Body {
        self.0.as_ref().expect("frame body is owned")
    }

    pub(in crate::frame) const fn take(&mut self) -> wire::frame_payload::Body {
        self.0.take().expect("frame body is owned")
    }
}

impl Drop for ScrubbedFrameBody {
    fn drop(&mut self) {
        if let Some(body) = self.0.as_mut() {
            scrub_body_secrets(body);
        }
    }
}

#[derive(Default)]
pub(super) struct ScrubbedFramePayload(pub(super) wire::FramePayload);

impl Drop for ScrubbedFramePayload {
    fn drop(&mut self) {
        if let Some(body) = self.0.body.as_mut() {
            scrub_body_secrets(body);
        }
    }
}

pub(in crate::frame) fn scrub_body_secrets(body: &mut wire::frame_payload::Body) {
    match body {
        wire::frame_payload::Body::AgentHello(hello) => {
            crate::runner_bootstrap::scrub_agent_hello(hello);
        }
        wire::frame_payload::Body::HostHello(hello) => {
            crate::runner_bootstrap::scrub_host_hello(hello);
        }
        wire::frame_payload::Body::BindAttemptChannel(binding) => {
            binding.connection_session_token.as_mut_slice().zeroize();
            binding.connection_session_token.clear();
        }
        wire::frame_payload::Body::HydrationChunk(chunk) => {
            chunk.encoded_chunk.as_mut_slice().zeroize();
            chunk.encoded_chunk.clear();
        }
        _ => {}
    }
}
