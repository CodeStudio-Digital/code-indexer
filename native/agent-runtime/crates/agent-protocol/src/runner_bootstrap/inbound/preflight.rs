use prost::DecodeError;
use prost::bytes::Buf;
use prost::encoding::{DecodeContext, WireType, decode_key, decode_varint, skip_field};

const ENDPOINTS_TAG: u32 = 5;
const LAUNCH_NONCE_TAG: u32 = 6;
const CONNECTION_TOKEN_TAG: u32 = 5;

/// Rejects wire shapes that could make Prost discard an unguarded secret.
///
/// Prost replaces duplicate singular byte fields without scrubbing the
/// previous allocation. This allocation-free pass walks endpoint boundaries
/// and proves secret fields occur at most once before the secret-bearing
/// decode starts. Endpoint-local `Drop` remains the backstop for later
/// semantic failures such as invalid UTF-8.
pub(super) fn validate_secret_safe_wire(mut encoded: &[u8]) -> Result<(), DecodeError> {
    let mut launch_nonce_seen = false;
    while encoded.has_remaining() {
        let (tag, wire_type) = decode_key(&mut encoded)?;
        match tag {
            ENDPOINTS_TAG => {
                require_wire_type(wire_type, WireType::LengthDelimited, "endpoints")?;
                let endpoint = take_length_delimited(&mut encoded)?;
                validate_endpoint(endpoint)?;
            }
            LAUNCH_NONCE_TAG => {
                require_wire_type(wire_type, WireType::LengthDelimited, "launch_nonce")?;
                reject_duplicate(&mut launch_nonce_seen, "launch_nonce")?;
                skip_field(wire_type, tag, &mut encoded, DecodeContext::default())?;
            }
            _ => skip_field(wire_type, tag, &mut encoded, DecodeContext::default())?,
        }
    }
    Ok(())
}

fn validate_endpoint(mut encoded: &[u8]) -> Result<(), DecodeError> {
    let mut connection_token_seen = false;
    while encoded.has_remaining() {
        let (tag, wire_type) = decode_key(&mut encoded)?;
        match tag {
            1 | 6..=9 => {
                require_wire_type(wire_type, WireType::Varint, "endpoint scalar")?;
            }
            2..=4 => {
                require_wire_type(wire_type, WireType::LengthDelimited, "endpoint text")?;
            }
            CONNECTION_TOKEN_TAG => {
                require_wire_type(wire_type, WireType::LengthDelimited, "connection_token")?;
                reject_duplicate(&mut connection_token_seen, "connection_token")?;
            }
            _ => {}
        }
        skip_field(wire_type, tag, &mut encoded, DecodeContext::default())?;
    }
    Ok(())
}

fn take_length_delimited<'a>(encoded: &mut &'a [u8]) -> Result<&'a [u8], DecodeError> {
    let length = decode_varint(encoded)?;
    let length = usize::try_from(length)
        .map_err(|_| DecodeError::new("length-delimited field exceeds address space"))?;
    if length > encoded.len() {
        return Err(DecodeError::new("buffer underflow"));
    }
    let (value, remaining) = encoded.split_at(length);
    *encoded = remaining;
    Ok(value)
}

fn require_wire_type(
    actual: WireType,
    expected: WireType,
    field: &'static str,
) -> Result<(), DecodeError> {
    if actual == expected {
        Ok(())
    } else {
        Err(DecodeError::new(format!(
            "invalid wire type for protected field {field}"
        )))
    }
}

fn reject_duplicate(seen: &mut bool, field: &'static str) -> Result<(), DecodeError> {
    if *seen {
        Err(DecodeError::new(format!(
            "duplicate protected field {field}"
        )))
    } else {
        *seen = true;
        Ok(())
    }
}
