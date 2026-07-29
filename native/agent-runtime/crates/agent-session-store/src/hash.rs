use sha2::{Digest, Sha256};
use std::io::{self, Read};

pub type ContentHash = [u8; 32];

pub fn sha256(bytes: &[u8]) -> ContentHash {
    Sha256::digest(bytes).into()
}

pub fn sha256_reader(reader: &mut impl Read, expected_bytes: u64) -> io::Result<ContentHash> {
    let mut hasher = Sha256::new();
    let mut remaining = expected_bytes;
    let mut buffer = [0_u8; 16 * 1024];
    while remaining > 0 {
        let capacity = usize::try_from(remaining.min(buffer.len() as u64))
            .expect("buffer-sized remainder fits usize");
        let read = reader.read(&mut buffer[..capacity])?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "payload ended before declared length",
            ));
        }
        hasher.update(&buffer[..read]);
        remaining -= u64::try_from(read).expect("read length fits u64");
    }
    let mut trailing = [0_u8; 1];
    if reader.read(&mut trailing)? != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "payload exceeds declared length",
        ));
    }
    Ok(hasher.finalize().into())
}

pub fn encode_hex(value: &ContentHash) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(64);
    for byte in value {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    encoded
}

pub fn decode_hex(value: &str) -> Option<ContentHash> {
    if value.len() != 64 {
        return None;
    }
    let mut decoded = [0_u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        decoded[index] = (nibble(pair[0])? << 4) | nibble(pair[1])?;
    }
    Some(decoded)
}

const fn nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{decode_hex, encode_hex, sha256};

    #[test]
    fn lowercase_hex_round_trips() {
        let hash = sha256(b"session");
        assert_eq!(decode_hex(&encode_hex(&hash)), Some(hash));
        assert!(decode_hex(&encode_hex(&hash).to_uppercase()).is_none());
    }
}
