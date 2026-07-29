use crate::hash::{ContentHash, decode_hex, encode_hex, sha256};
use crate::{LeaseEpoch, SessionStoreError, StorageAuthority, StorageGeneration, WriterId};

#[derive(Debug)]
pub(super) struct AuthorityRecord {
    pub(super) transition: u64,
    pub(super) authority: StorageAuthority,
    pub(super) previous_hash: ContentHash,
    pub(super) record_hash: ContentHash,
}

impl AuthorityRecord {
    pub(super) fn new(
        transition: u64,
        authority: StorageAuthority,
        previous_hash: ContentHash,
    ) -> Self {
        let record_hash = authority_hash(transition, &authority, &previous_hash);
        Self {
            transition,
            authority,
            previous_hash,
            record_hash,
        }
    }

    pub(super) fn encode(&self) -> Vec<u8> {
        format!(
            concat!(
                "{{\"v\":1,\"transition\":{},\"generation\":\"{}\",",
                "\"leaseEpoch\":{},\"writerId\":\"{}\",",
                "\"previousSha256\":\"{}\",\"recordSha256\":\"{}\"}}\n"
            ),
            self.transition,
            self.authority.generation().name(),
            self.authority.lease_epoch().get(),
            self.authority.writer_id().as_str(),
            encode_hex(&self.previous_hash),
            encode_hex(&self.record_hash)
        )
        .into_bytes()
    }

    pub(super) fn parse(line: &[u8]) -> Result<Self, SessionStoreError> {
        let text = std::str::from_utf8(&line[..line.len() - 1])
            .map_err(|_| SessionStoreError::CorruptAuthority)?;
        let tail = text
            .strip_prefix("{\"v\":1,\"transition\":")
            .ok_or(SessionStoreError::CorruptAuthority)?;
        let (transition, tail) = take(tail, ",\"generation\":\"")?;
        let (generation, tail) = take(tail, "\",\"leaseEpoch\":")?;
        let (lease_epoch, tail) = take(tail, ",\"writerId\":\"")?;
        let (writer_id, tail) = take(tail, "\",\"previousSha256\":\"")?;
        let (previous_hash, tail) = take(tail, "\",\"recordSha256\":\"")?;
        let record_hash = tail
            .strip_suffix("\"}")
            .ok_or(SessionStoreError::CorruptAuthority)?;
        let authority = StorageAuthority::from_parts(
            StorageGeneration::parse(generation)?,
            LeaseEpoch::new(parse_u64(lease_epoch)?)
                .map_err(|_| SessionStoreError::CorruptAuthority)?,
            WriterId::parse(writer_id).map_err(|_| SessionStoreError::CorruptAuthority)?,
        );
        let record = Self {
            transition: parse_u64(transition)?,
            authority,
            previous_hash: parse_hash(previous_hash)?,
            record_hash: parse_hash(record_hash)?,
        };
        if record.record_hash
            != authority_hash(record.transition, &record.authority, &record.previous_hash)
        {
            return Err(SessionStoreError::CorruptAuthority);
        }
        Ok(record)
    }
}

fn authority_hash(
    transition: u64,
    authority: &StorageAuthority,
    previous_hash: &ContentHash,
) -> ContentHash {
    let material = format!(
        "codestudio.session.authority.v1\n{transition}\n{}\n{}\n{}\n{}\n",
        authority.generation().name(),
        authority.lease_epoch().get(),
        authority.writer_id().as_str(),
        encode_hex(previous_hash)
    );
    sha256(material.as_bytes())
}

fn take<'a>(value: &'a str, delimiter: &str) -> Result<(&'a str, &'a str), SessionStoreError> {
    value
        .split_once(delimiter)
        .ok_or(SessionStoreError::CorruptAuthority)
}

fn parse_u64(value: &str) -> Result<u64, SessionStoreError> {
    value
        .parse()
        .map_err(|_| SessionStoreError::CorruptAuthority)
}

fn parse_hash(value: &str) -> Result<ContentHash, SessionStoreError> {
    decode_hex(value).ok_or(SessionStoreError::CorruptAuthority)
}
