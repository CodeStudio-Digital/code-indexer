use agent_protocol::generated::v1 as wire;
use agent_session_store::SessionStoreError;

pub(super) fn invalid(reason_code: &'static str) -> wire::SessionStoreResponse {
    failure(
        wire::SessionStoreFailureCode::InvalidRequest,
        reason_code,
        false,
    )
}

pub(super) fn from_store(error: &SessionStoreError) -> wire::SessionStoreResponse {
    let (code, reason_code, retryable) = match error {
        SessionStoreError::StaleAuthority | SessionStoreError::AuthorityGap => (
            wire::SessionStoreFailureCode::StaleAuthority,
            "stale_storage_authority",
            false,
        ),
        SessionStoreError::WriterAlreadyActive => (
            wire::SessionStoreFailureCode::WriterActive,
            "session_writer_active",
            true,
        ),
        SessionStoreError::StorageLockBusy => (
            wire::SessionStoreFailureCode::LockBusy,
            "storage_root_lock_busy",
            true,
        ),
        SessionStoreError::DivergentReplay => (
            wire::SessionStoreFailureCode::DivergentReplay,
            "divergent_operation_replay",
            false,
        ),
        SessionStoreError::RecordLimitExceeded
        | SessionStoreError::PayloadLimitExceeded
        | SessionStoreError::AuthorityLimitExceeded => (
            wire::SessionStoreFailureCode::LimitExceeded,
            "session_store_limit_exceeded",
            false,
        ),
        SessionStoreError::CorruptAuthority
        | SessionStoreError::DivergentManifest
        | SessionStoreError::CorruptJournal
        | SessionStoreError::MissingPayload
        | SessionStoreError::DivergentPayload => (
            wire::SessionStoreFailureCode::CorruptBundle,
            "session_bundle_corrupt",
            false,
        ),
        SessionStoreError::InvalidRoot | SessionStoreError::UnsafePath => (
            wire::SessionStoreFailureCode::UnsafeStorage,
            "unsafe_session_storage",
            false,
        ),
        SessionStoreError::ConcurrentMutation | SessionStoreError::Poisoned => (
            wire::SessionStoreFailureCode::ConcurrentMutation,
            "concurrent_session_mutation",
            false,
        ),
        SessionStoreError::Io { .. } => (
            wire::SessionStoreFailureCode::Internal,
            "session_store_io",
            true,
        ),
        SessionStoreError::SessionArchived => (
            wire::SessionStoreFailureCode::InvalidRequest,
            "session_archived",
            false,
        ),
        _ => (
            wire::SessionStoreFailureCode::InvalidRequest,
            "invalid_session_store_request",
            false,
        ),
    };
    failure(code, reason_code, retryable)
}

fn failure(
    code: wire::SessionStoreFailureCode,
    reason_code: &'static str,
    retryable: bool,
) -> wire::SessionStoreResponse {
    wire::SessionStoreResponse {
        body: Some(wire::session_store_response::Body::Failure(
            wire::SessionStoreFailure {
                code: code.into(),
                reason_code: reason_code.to_owned(),
                redacted_detail: None,
                retryable,
            },
        )),
    }
}
