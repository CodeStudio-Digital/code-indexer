use agent_protocol::generated::v1 as wire;
use prost::Message;
use sha2::{Digest, Sha256};

use crate::{BridgeInstanceId, SessionStoreBridgeError};

const PROTOCOL_VERSION: u32 = 1;
const REQUEST_HASH_DOMAIN: &[u8] = b"codestudio.agent.session-store-request.v1\0";
const RESPONSE_HASH_DOMAIN: &[u8] = b"codestudio.agent.session-store-response.v1\0";
const MAX_REQUEST_ID_BYTES: usize = 128;

pub struct VerifiedRequest {
    pub request_id: String,
    pub sequence: u64,
    pub request: wire::SessionStoreRequest,
}

pub fn decode_request(
    encoded_frame: &[u8],
    instance_id: &BridgeInstanceId,
    expected_sequence: u64,
    now_unix_ms: i64,
    max_frame_bytes: usize,
) -> Result<VerifiedRequest, SessionStoreBridgeError> {
    if encoded_frame.len() > max_frame_bytes {
        return Err(SessionStoreBridgeError::FrameTooLarge);
    }
    let frame = wire::SessionStoreRequestFrame::decode(encoded_frame)
        .map_err(|_| SessionStoreBridgeError::Decode)?;
    let header = frame.header.ok_or(SessionStoreBridgeError::MissingHeader)?;
    validate_header(&header, instance_id, expected_sequence, now_unix_ms)?;
    if header.request_payload_sha256 != hash(REQUEST_HASH_DOMAIN, &frame.encoded_request) {
        return Err(SessionStoreBridgeError::PayloadHashMismatch);
    }
    let request = wire::SessionStoreRequest::decode(frame.encoded_request.as_slice())
        .map_err(|_| SessionStoreBridgeError::Decode)?;
    if request.body.is_none() {
        return Err(SessionStoreBridgeError::MissingRequest);
    }
    Ok(VerifiedRequest {
        request_id: header.request_id,
        sequence: header.stream_seq,
        request,
    })
}

pub fn encode_response(
    instance_id: &BridgeInstanceId,
    request_id: String,
    sequence: u64,
    completed_at_unix_ms: i64,
    response: &wire::SessionStoreResponse,
    max_frame_bytes: usize,
) -> Result<Vec<u8>, SessionStoreBridgeError> {
    let encoded_response = response.encode_to_vec();
    let frame = wire::SessionStoreResponseFrame {
        header: Some(wire::SessionStoreResponseHeader {
            protocol_version: PROTOCOL_VERSION,
            bridge_instance_id: instance_id.as_str().to_owned(),
            request_id,
            stream_seq: sequence,
            completed_at_unix_ms,
            response_payload_sha256: hash(RESPONSE_HASH_DOMAIN, &encoded_response).to_vec(),
        }),
        encoded_response,
    }
    .encode_to_vec();
    if frame.len() > max_frame_bytes {
        return Err(SessionStoreBridgeError::ResponseTooLarge);
    }
    Ok(frame)
}

fn validate_header(
    header: &wire::SessionStoreRequestHeader,
    instance_id: &BridgeInstanceId,
    expected_sequence: u64,
    now_unix_ms: i64,
) -> Result<(), SessionStoreBridgeError> {
    if header.protocol_version != PROTOCOL_VERSION {
        return Err(SessionStoreBridgeError::InvalidProtocolVersion);
    }
    if header.bridge_instance_id != instance_id.as_str() {
        return Err(SessionStoreBridgeError::BridgeInstanceMismatch);
    }
    if header.request_id.is_empty()
        || header.request_id.len() > MAX_REQUEST_ID_BYTES
        || header
            .request_id
            .bytes()
            .any(|byte| byte.is_ascii_control())
    {
        return Err(SessionStoreBridgeError::InvalidRequestId);
    }
    if header.stream_seq != expected_sequence {
        return Err(SessionStoreBridgeError::InvalidSequence);
    }
    if header.sent_at_unix_ms > header.deadline_at_unix_ms
        || now_unix_ms > header.deadline_at_unix_ms
    {
        return Err(SessionStoreBridgeError::InvalidDeadline);
    }
    Ok(())
}

fn hash(domain: &[u8], payload: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update(payload);
    hasher.finalize().into()
}
