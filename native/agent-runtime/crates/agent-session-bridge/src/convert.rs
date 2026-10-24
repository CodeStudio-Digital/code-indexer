use agent_protocol::generated::v1 as wire;
use agent_session_store as store;

pub fn authority_from_wire(
    value: Option<wire::SessionStoreAuthority>,
) -> Result<store::StorageAuthority, store::SessionStoreError> {
    let value = value.ok_or(store::SessionStoreError::StaleAuthority)?;
    let generation = wire::StorageGeneration::try_from(value.storage_generation)
        .map_err(|_| store::SessionStoreError::StaleAuthority)?;
    if generation != wire::StorageGeneration::RustFsV1 {
        return Err(store::SessionStoreError::StaleAuthority);
    }
    Ok(store::StorageAuthority::rust_fs_v1(
        store::LeaseEpoch::new(value.lease_epoch)?,
        store::WriterId::parse(value.writer_id)?,
    ))
}

pub fn authority_to_wire(value: &store::StorageAuthority) -> wire::SessionStoreAuthority {
    wire::SessionStoreAuthority {
        storage_generation: wire::StorageGeneration::RustFsV1.into(),
        lease_epoch: value.lease_epoch().get(),
        writer_id: value.writer_id().as_str().to_owned(),
    }
}

pub fn limits_from_wire(
    value: Option<wire::SessionStoreLimits>,
) -> Result<store::SessionStoreLimits, store::SessionStoreError> {
    let value = value.ok_or(store::SessionStoreError::InvalidLimits)?;
    store::SessionStoreLimits::new(
        value.max_records,
        value.max_payload_bytes,
        value.max_authority_transitions,
    )
}

pub fn kind_from_wire(value: i32) -> Result<store::SessionRecordKind, store::SessionStoreError> {
    match wire::SessionRecordKind::try_from(value)
        .map_err(|_| store::SessionStoreError::CorruptJournal)?
    {
        wire::SessionRecordKind::Conversation => Ok(store::SessionRecordKind::Conversation),
        wire::SessionRecordKind::LifecycleEvent => Ok(store::SessionRecordKind::LifecycleEvent),
        wire::SessionRecordKind::MetricRollup => Ok(store::SessionRecordKind::MetricRollup),
        wire::SessionRecordKind::ToolOutput => Ok(store::SessionRecordKind::ToolOutput),
        wire::SessionRecordKind::Checkpoint => Ok(store::SessionRecordKind::Checkpoint),
        wire::SessionRecordKind::Plan => Ok(store::SessionRecordKind::Plan),
        wire::SessionRecordKind::Task => Ok(store::SessionRecordKind::Task),
        wire::SessionRecordKind::Input => Ok(store::SessionRecordKind::Input),
        wire::SessionRecordKind::Memory => Ok(store::SessionRecordKind::Memory),
        wire::SessionRecordKind::Subagent => Ok(store::SessionRecordKind::Subagent),
        wire::SessionRecordKind::Archive => Ok(store::SessionRecordKind::Archive),
        wire::SessionRecordKind::Attachment => Ok(store::SessionRecordKind::Attachment),
        wire::SessionRecordKind::Unspecified => Err(store::SessionStoreError::CorruptJournal),
    }
}

pub const fn kind_to_wire(value: store::SessionRecordKind) -> i32 {
    let value = match value {
        store::SessionRecordKind::Conversation => wire::SessionRecordKind::Conversation,
        store::SessionRecordKind::LifecycleEvent => wire::SessionRecordKind::LifecycleEvent,
        store::SessionRecordKind::MetricRollup => wire::SessionRecordKind::MetricRollup,
        store::SessionRecordKind::ToolOutput => wire::SessionRecordKind::ToolOutput,
        store::SessionRecordKind::Checkpoint => wire::SessionRecordKind::Checkpoint,
        store::SessionRecordKind::Plan => wire::SessionRecordKind::Plan,
        store::SessionRecordKind::Task => wire::SessionRecordKind::Task,
        store::SessionRecordKind::Input => wire::SessionRecordKind::Input,
        store::SessionRecordKind::Memory => wire::SessionRecordKind::Memory,
        store::SessionRecordKind::Subagent => wire::SessionRecordKind::Subagent,
        store::SessionRecordKind::Archive => wire::SessionRecordKind::Archive,
        store::SessionRecordKind::Attachment => wire::SessionRecordKind::Attachment,
    };
    value as i32
}

pub fn durability_from_wire(
    value: i32,
) -> Result<store::DurabilityClass, store::SessionStoreError> {
    match wire::SessionDurabilityClass::try_from(value)
        .map_err(|_| store::SessionStoreError::CorruptJournal)?
    {
        wire::SessionDurabilityClass::Authoritative => Ok(store::DurabilityClass::Authoritative),
        wire::SessionDurabilityClass::Durable => Ok(store::DurabilityClass::Durable),
        wire::SessionDurabilityClass::Coalesced => Ok(store::DurabilityClass::Coalesced),
        wire::SessionDurabilityClass::Unspecified => Err(store::SessionStoreError::CorruptJournal),
    }
}

pub const fn durability_to_wire(value: store::DurabilityClass) -> i32 {
    let value = match value {
        store::DurabilityClass::Authoritative => wire::SessionDurabilityClass::Authoritative,
        store::DurabilityClass::Durable => wire::SessionDurabilityClass::Durable,
        store::DurabilityClass::Coalesced => wire::SessionDurabilityClass::Coalesced,
    };
    value as i32
}

pub fn receipt_to_wire(outcome: &store::CommitOutcome) -> wire::CommitSessionRecordReceipt {
    commit_receipt_to_wire(
        outcome.receipt(),
        matches!(outcome, store::CommitOutcome::Replay(_)),
    )
}

pub fn commit_receipt_to_wire(
    receipt: &store::CommitReceipt,
    replay: bool,
) -> wire::CommitSessionRecordReceipt {
    wire::CommitSessionRecordReceipt {
        session_id: receipt.session_id().as_str().to_owned(),
        operation_id: receipt.operation_id().as_str().to_owned(),
        authority: Some(wire::SessionStoreAuthority {
            storage_generation: wire::StorageGeneration::RustFsV1.into(),
            lease_epoch: receipt.lease_epoch().get(),
            writer_id: receipt.writer_id().as_str().to_owned(),
        }),
        global_sequence: receipt.sequence(),
        kind: kind_to_wire(receipt.kind()),
        durability: durability_to_wire(receipt.durability()),
        previous_commit_sha256: receipt.previous_hash().to_vec(),
        payload_sha256: receipt.payload_hash().to_vec(),
        commit_sha256: receipt.record_hash().to_vec(),
        payload_bytes: receipt.payload_bytes(),
        replay,
    }
}

pub fn state_to_wire(value: &store::SessionStateSnapshot) -> wire::SessionState {
    wire::SessionState {
        session_id: value.session_id().as_str().to_owned(),
        authority: Some(authority_to_wire(value.authority())),
        committed_records: value.committed_records(),
        last_commit_sha256: value.last_commit_hash().to_vec(),
        archived: value.archived(),
    }
}
