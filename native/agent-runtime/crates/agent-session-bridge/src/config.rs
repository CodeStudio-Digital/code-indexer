use std::collections::HashMap;
use std::fmt::{self, Debug, Formatter};
use std::path::{Path, PathBuf};

use crate::{
    AuthenticatedSessionStoreBridge, RejectingSessionStoreExtensionPort, SessionStoreBridgeError,
    SessionStoreExtensionPort,
};

const MAX_OPAQUE_ID_BYTES: usize = 128;
const MIN_FRAME_BYTES: usize = 1024;

#[derive(Clone, PartialEq, Eq, Hash)]
pub struct BridgeInstanceId(String);

impl BridgeInstanceId {
    /// Parses a bounded opaque bridge instance identifier.
    ///
    /// # Errors
    ///
    /// Rejects empty, oversized, or control-character-containing identifiers.
    pub fn parse(value: &str) -> Result<Self, SessionStoreBridgeError> {
        validate_opaque_id(value)
            .then(|| Self(value.to_owned()))
            .ok_or(SessionStoreBridgeError::InvalidBridgeInstanceId)
    }

    pub(super) fn as_str(&self) -> &str {
        &self.0
    }
}

impl Debug for BridgeInstanceId {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str("BridgeInstanceId([REDACTED])")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SessionRootId(String);

impl SessionRootId {
    /// Parses a bounded non-path root identifier.
    ///
    /// # Errors
    ///
    /// Rejects identifiers outside the portable opaque-ID alphabet.
    pub fn parse(value: &str) -> Result<Self, SessionStoreBridgeError> {
        let valid = validate_opaque_id(value)
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte));
        valid
            .then(|| Self(value.to_owned()))
            .ok_or(SessionStoreBridgeError::InvalidRootId)
    }
}

pub struct SessionStoreBridgeBootstrap {
    instance_id: BridgeInstanceId,
    max_frame_bytes: usize,
    roots: HashMap<SessionRootId, PathBuf>,
    extensions: Box<dyn SessionStoreExtensionPort>,
}

impl SessionStoreBridgeBootstrap {
    /// Creates bootstrap state consumed exactly once by the native owner.
    ///
    /// # Errors
    ///
    /// Rejects frame limits too small to carry the fixed protocol envelope.
    pub fn new(
        instance_id: BridgeInstanceId,
        max_frame_bytes: usize,
    ) -> Result<Self, SessionStoreBridgeError> {
        if max_frame_bytes < MIN_FRAME_BYTES {
            return Err(SessionStoreBridgeError::InvalidFrameLimit);
        }
        Ok(Self {
            instance_id,
            max_frame_bytes,
            roots: HashMap::new(),
            extensions: Box::<RejectingSessionStoreExtensionPort>::default(),
        })
    }

    /// Adds one bootstrap-only root mapping. Paths never cross the wire.
    ///
    /// # Errors
    ///
    /// Rejects relative, missing, non-directory, or duplicate roots.
    pub fn register_root(
        &mut self,
        root_id: SessionRootId,
        root: &Path,
    ) -> Result<(), SessionStoreBridgeError> {
        if !root.is_absolute() || !root.is_dir() {
            return Err(SessionStoreBridgeError::InvalidRoot);
        }
        if self.roots.insert(root_id, root.to_path_buf()).is_some() {
            return Err(SessionStoreBridgeError::DuplicateRoot);
        }
        Ok(())
    }

    #[must_use]
    pub fn with_extensions(mut self, extensions: Box<dyn SessionStoreExtensionPort>) -> Self {
        self.extensions = extensions;
        self
    }

    #[must_use]
    pub fn bind(self) -> AuthenticatedSessionStoreBridge {
        AuthenticatedSessionStoreBridge::new(
            self.instance_id,
            self.max_frame_bytes,
            self.roots,
            self.extensions,
        )
    }
}

impl Debug for SessionStoreBridgeBootstrap {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionStoreBridgeBootstrap")
            .field("instance_id", &self.instance_id)
            .field("max_frame_bytes", &self.max_frame_bytes)
            .field("root_count", &self.roots.len())
            .field("extensions", &self.extensions)
            .finish()
    }
}

fn validate_opaque_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_OPAQUE_ID_BYTES
        && value.bytes().all(|byte| !byte.is_ascii_control())
}
