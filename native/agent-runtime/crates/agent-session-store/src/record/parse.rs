use crate::hash::{ContentHash, decode_hex};
use crate::{
    DurabilityClass, LeaseEpoch, OperationId, SessionRecordKind, SessionStoreError,
    StorageAuthority, StorageGeneration, WriterId,
};

pub(super) struct ParsedFields {
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

impl ParsedFields {
    pub(super) fn parse(line: &[u8]) -> Result<Self, SessionStoreError> {
        let text = std::str::from_utf8(&line[..line.len() - 1])
            .map_err(|_| SessionStoreError::CorruptJournal)?;
        let tail = text
            .strip_prefix("{\"v\":1,\"seq\":")
            .ok_or(SessionStoreError::CorruptJournal)?;
        let (sequence, tail) = take(tail, ",\"kind\":\"")?;
        let (kind, tail) = take(tail, "\",\"operationId\":\"")?;
        let (operation_id, tail) = take(tail, "\",\"durability\":\"")?;
        let (durability, tail) = take(tail, "\",\"generation\":\"")?;
        let (generation, tail) = take(tail, "\",\"leaseEpoch\":")?;
        let (lease_epoch, tail) = take(tail, ",\"writerId\":\"")?;
        let (writer_id, tail) = take(tail, "\",\"previousSha256\":\"")?;
        let (previous_hash, tail) = take(tail, "\",\"payloadSha256\":\"")?;
        let (payload_hash, tail) = take(tail, "\",\"payloadBytes\":")?;
        let (payload_bytes, tail) = take(tail, ",\"recordSha256\":\"")?;
        let record_hash = tail
            .strip_suffix("\"}")
            .ok_or(SessionStoreError::CorruptJournal)?;
        Ok(Self {
            sequence: parse_u64(sequence)?,
            kind: SessionRecordKind::parse(kind)?,
            durability: DurabilityClass::parse(durability)?,
            authority: StorageAuthority::from_parts(
                StorageGeneration::parse(generation)
                    .map_err(|_| SessionStoreError::CorruptJournal)?,
                LeaseEpoch::new(parse_u64(lease_epoch)?)
                    .map_err(|_| SessionStoreError::CorruptJournal)?,
                WriterId::parse(writer_id).map_err(|_| SessionStoreError::CorruptJournal)?,
            ),
            operation_id: OperationId::parse(operation_id)
                .map_err(|_| SessionStoreError::CorruptJournal)?,
            previous_hash: parse_hash(previous_hash)?,
            payload_hash: parse_hash(payload_hash)?,
            payload_bytes: parse_u64(payload_bytes)?,
            record_hash: parse_hash(record_hash)?,
        })
    }
}

fn take<'a>(value: &'a str, delimiter: &str) -> Result<(&'a str, &'a str), SessionStoreError> {
    value
        .split_once(delimiter)
        .ok_or(SessionStoreError::CorruptJournal)
}

fn parse_u64(value: &str) -> Result<u64, SessionStoreError> {
    value.parse().map_err(|_| SessionStoreError::CorruptJournal)
}

fn parse_hash(value: &str) -> Result<ContentHash, SessionStoreError> {
    decode_hex(value).ok_or(SessionStoreError::CorruptJournal)
}
