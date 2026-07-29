use super::{SemanticHashError, semantic_sha256};

const PREIMAGE_HEX: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../../packages/agent-runtime-contracts/fixtures/v1/semantic-hash-preimage.hex"
));
const EXPECTED_HASH: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../../packages/agent-runtime-contracts/fixtures/v1/semantic-hash.sha256"
));

fn decode_hex(source: &str) -> Vec<u8> {
    source
        .trim()
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let pair = std::str::from_utf8(pair).expect("fixture must be ASCII");
            u8::from_str_radix(pair, 16).expect("fixture must contain hex")
        })
        .collect()
}

#[test]
fn rust_matches_the_shared_semantic_hash_fixture() {
    let canonical = r#"{"a":1,"b":"α"}"#.as_bytes();
    let actual = semantic_sha256("codestudio.agent.fixture.v1", 7, canonical)
        .expect("valid semantic coordinates");
    let expected = decode_hex(EXPECTED_HASH);

    assert_eq!(actual.as_slice(), expected);

    let preimage = decode_hex(PREIMAGE_HEX);
    assert!(preimage.ends_with(canonical));
}

#[test]
fn rejects_ambiguous_semantic_coordinates() {
    assert_eq!(
        semantic_sha256("", 1, b"payload"),
        Err(SemanticHashError::EmptySchemaId)
    );
    assert_eq!(
        semantic_sha256("schema", 0, b"payload"),
        Err(SemanticHashError::ZeroSchemaVersion)
    );
}
