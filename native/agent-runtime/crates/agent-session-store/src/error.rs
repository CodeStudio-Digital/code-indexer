use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::io;

#[derive(Debug)]
pub enum SessionStoreError {
    InvalidSessionId,
    InvalidOperationId,
    InvalidWriterId,
    InvalidLeaseEpoch,
    InvalidLimits,
    InvalidTransfer,
    InvalidRoot,
    UnsafePath,
    WriterAlreadyActive,
    StorageLockBusy,
    StaleAuthority,
    AuthorityGap,
    AuthorityLimitExceeded,
    CorruptAuthority,
    DivergentManifest,
    TransferManifestMismatch,
    CorruptLegacyBundle,
    TransferLimitExceeded,
    RecordLimitExceeded,
    PayloadLimitExceeded,
    SequenceOverflow,
    DivergentReplay,
    ArchiveRequiresAuthoritativeDurability,
    SessionArchived,
    ConcurrentMutation,
    CorruptJournal,
    MissingPayload,
    DivergentPayload,
    Poisoned,
    Io {
        action: &'static str,
        source: io::Error,
    },
}

impl SessionStoreError {
    pub(crate) const fn io(action: &'static str, source: io::Error) -> Self {
        Self::Io { action, source }
    }
}

impl Display for SessionStoreError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { action, source } => write!(formatter, "{action}: {source}"),
            other => write!(formatter, "session store error: {other:?}"),
        }
    }
}

impl Error for SessionStoreError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}
