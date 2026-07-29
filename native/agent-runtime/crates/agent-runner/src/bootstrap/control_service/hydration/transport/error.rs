use std::error::Error;
use std::fmt::{self, Display, Formatter};

use super::super::RunnerHydrationError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::bootstrap::control_service) enum HydrationTransportError {
    InvalidTransferId,
    ManifestCoverage,
    ManifestMetadata,
    ManifestByteBudget,
    ManifestFrameBudget,
    InvalidChunkLimit,
    TransferMismatch,
    ManifestDigestMismatch,
    ChunkOrder,
    EmptyChunk,
    ChunkLimit,
    ChunkHash,
    ItemBoundary,
    Allocation,
    IncompleteTransfer,
    Poisoned,
    Verification(RunnerHydrationError),
}

impl Display for HydrationTransportError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(formatter, "runner hydration transport failed: {self:?}")
    }
}

impl Error for HydrationTransportError {}

impl From<RunnerHydrationError> for HydrationTransportError {
    fn from(value: RunnerHydrationError) -> Self {
        Self::Verification(value)
    }
}
