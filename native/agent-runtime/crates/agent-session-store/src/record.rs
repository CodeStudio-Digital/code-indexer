use crate::hash::{ContentHash, encode_hex, sha256};
use crate::{DurabilityClass, OperationId, SessionRecordKind, SessionStoreError, StorageAuthority};

mod parse;
use parse::ParsedFields;

pub const MAX_JOURNAL_LINE_BYTES: usize = 512;
const ZERO_HASH: ContentHash = [0; 32];

#[derive(Debug, Clone)]
pub struct JournalRecord {
    pub(super) sequence: u64,
    pub(super) kind: SessionRecordKind,
    pub(super) durability: DurabilityClass,
    pub(super) authority: StorageAuthority,
    pub(super) operation_id: OperationId,
    pub(super) previous_hash: ContentHash,
    pub(super) payload_hash: ContentHash,
    pub(super) payload_bytes: u64,
    pub(super) record_hash: ContentHash,
}

pub struct JournalRecordInput {
    pub(super) sequence: u64,
    pub(super) kind: SessionRecordKind,
    pub(super) durability: DurabilityClass,
    pub(super) authority: StorageAuthority,
    pub(super) operation_id: OperationId,
    pub(super) previous_hash: ContentHash,
    pub(super) payload_hash: ContentHash,
    pub(super) payload_bytes: u64,
}

impl JournalRecord {
    pub(super) const fn first_previous_hash() -> ContentHash {
        ZERO_HASH
    }

    pub(crate) fn new(input: JournalRecordInput) -> Self {
        let record_hash = calculate_hash(&input);
        Self {
            sequence: input.sequence,
            kind: input.kind,
            durability: input.durability,
            authority: input.authority,
            operation_id: input.operation_id,
            previous_hash: input.previous_hash,
            payload_hash: input.payload_hash,
            payload_bytes: input.payload_bytes,
            record_hash,
        }
    }

    pub(crate) fn encode(&self) -> Vec<u8> {
        format!(
            concat!(
                "{{\"v\":1,\"seq\":{},\"kind\":\"{}\",\"operationId\":\"{}\",",
                "\"durability\":\"{}\",\"generation\":\"{}\",\"leaseEpoch\":{},",
                "\"writerId\":\"{}\",\"previousSha256\":\"{}\",",
                "\"payloadSha256\":\"{}\",\"payloadBytes\":{},",
                "\"recordSha256\":\"{}\"}}\n"
            ),
            self.sequence,
            self.kind.name(),
            self.operation_id.as_str(),
            self.durability.name(),
            self.authority.generation().name(),
            self.authority.lease_epoch().get(),
            self.authority.writer_id().as_str(),
            encode_hex(&self.previous_hash),
            encode_hex(&self.payload_hash),
            self.payload_bytes,
            encode_hex(&self.record_hash)
        )
        .into_bytes()
    }

    pub(crate) fn parse(line: &[u8]) -> Result<Self, SessionStoreError> {
        if line.len() > MAX_JOURNAL_LINE_BYTES || !line.ends_with(b"\n") {
            return Err(SessionStoreError::CorruptJournal);
        }
        let fields = ParsedFields::parse(line)?;
        let record = Self {
            sequence: fields.sequence,
            kind: fields.kind,
            durability: fields.durability,
            authority: fields.authority,
            operation_id: fields.operation_id,
            previous_hash: fields.previous_hash,
            payload_hash: fields.payload_hash,
            payload_bytes: fields.payload_bytes,
            record_hash: fields.record_hash,
        };
        let expected = calculate_hash(&JournalRecordInput {
            sequence: record.sequence,
            kind: record.kind,
            durability: record.durability,
            authority: record.authority.clone(),
            operation_id: record.operation_id.clone(),
            previous_hash: record.previous_hash,
            payload_hash: record.payload_hash,
            payload_bytes: record.payload_bytes,
        });
        if record.record_hash != expected {
            return Err(SessionStoreError::CorruptJournal);
        }
        Ok(record)
    }
}

fn calculate_hash(input: &JournalRecordInput) -> ContentHash {
    let material = format!(
        concat!(
            "codestudio.session.record.v1\n{}\n{}\n{}\n{}\n{}\n",
            "{}\n{}\n{}\n{}\n{}\n"
        ),
        input.sequence,
        input.kind.name(),
        input.durability.name(),
        input.authority.generation().name(),
        input.authority.lease_epoch().get(),
        input.authority.writer_id().as_str(),
        input.operation_id.as_str(),
        encode_hex(&input.previous_hash),
        encode_hex(&input.payload_hash),
        input.payload_bytes
    );
    sha256(material.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::{JournalRecord, JournalRecordInput};
    use crate::hash::sha256;
    use crate::{
        DurabilityClass, LeaseEpoch, OperationId, SessionRecordKind, StorageAuthority, WriterId,
    };

    #[test]
    fn exact_record_round_trips_and_detects_tamper() {
        let record = JournalRecord::new(JournalRecordInput {
            sequence: 1,
            kind: SessionRecordKind::MetricRollup,
            durability: DurabilityClass::Coalesced,
            authority: StorageAuthority::rust_fs_v1(
                LeaseEpoch::new(1).expect("epoch"),
                WriterId::parse("20000000-0000-0000-0000-000000000001").expect("writer"),
            ),
            operation_id: OperationId::parse("12345678-1234-1234-1234-123456789abc")
                .expect("operation"),
            previous_hash: JournalRecord::first_previous_hash(),
            payload_hash: sha256(b"payload"),
            payload_bytes: 7,
        });
        let encoded = record.encode();
        assert_eq!(
            JournalRecord::parse(&encoded)
                .expect("valid record")
                .record_hash,
            record.record_hash
        );

        let mut tampered = encoded;
        let position = tampered
            .iter()
            .position(|byte| *byte == b'7')
            .expect("payload length digit");
        tampered[position] = b'8';
        assert!(JournalRecord::parse(&tampered).is_err());
    }
}
