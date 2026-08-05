use std::fmt::{self, Debug, Formatter};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use agent_session_bridge::{
    AuthenticatedSessionStoreBridge, BridgeInstanceId, SessionRootId, SessionStoreBridgeBootstrap,
};
use napi::Result;
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

use crate::error;

struct SessionOwner {
    bridge: Mutex<Option<AuthenticatedSessionStoreBridge>>,
    closed: AtomicBool,
}

impl Debug for SessionOwner {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionOwner")
            .field("closed", &self.closed.load(Ordering::Acquire))
            .finish_non_exhaustive()
    }
}

#[napi]
pub struct NativeSessionStoreBridge {
    owner: Arc<SessionOwner>,
}

impl Debug for NativeSessionStoreBridge {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeSessionStoreBridge")
            .field("owner", &self.owner)
            .finish()
    }
}

#[napi]
impl NativeSessionStoreBridge {
    #[napi(getter)]
    #[must_use]
    pub fn is_closed(&self) -> bool {
        self.owner.closed.load(Ordering::Acquire)
    }

    /// Runs one authenticated, bounded session-store frame off the JS thread.
    /// Paths are unavailable after bootstrap; requests carry only root IDs and
    /// opaque writer handles.
    ///
    /// # Errors
    ///
    /// Returns a N-API error when the owner is closed, poisoned, the frame is
    /// invalid, or the blocking store operation cannot join.
    #[napi]
    pub async fn handle(&self, mut request: Buffer, now_unix_ms: i64) -> Result<Buffer> {
        let encoded = request.to_vec();
        request.fill(0);
        let owner = Arc::clone(&self.owner);
        tokio::task::spawn_blocking(move || {
            let mut guard = owner
                .bridge
                .lock()
                .map_err(|_| error::session_state("native session owner lock is poisoned"))?;
            let bridge = guard
                .as_mut()
                .ok_or_else(|| error::session_state("native session owner is closed"))?;
            let result = bridge.handle(&encoded, now_unix_ms);
            drop(guard);
            result.map(Buffer::from).map_err(error::session)
        })
        .await
        .map_err(|_| error::session_state("native session task did not join"))?
    }

    /// Closes the single native store owner idempotently.
    ///
    /// # Errors
    ///
    /// Returns a N-API error when the owner lock is poisoned or its blocking
    /// cleanup task cannot join.
    #[napi]
    pub async fn close(&self) -> Result<String> {
        if self.owner.closed.swap(true, Ordering::AcqRel) {
            return Ok("closed".to_owned());
        }
        let owner = Arc::clone(&self.owner);
        tokio::task::spawn_blocking(move || {
            owner
                .bridge
                .lock()
                .map_err(|_| error::session_state("native session owner lock is poisoned"))?
                .take();
            Ok::<(), napi::Error>(())
        })
        .await
        .map_err(|_| error::session_state("native session close task did not join"))??;
        Ok("closed".to_owned())
    }
}

/// Registers one application-owned storage root, then consumes the path into
/// Rust. No session bundle path is accepted by this ABI.
///
/// # Errors
///
/// Returns a N-API error for invalid root authority, invalid limits, duplicate
/// registration, or a filesystem root that cannot be opened safely.
#[napi]
#[allow(
    clippy::needless_pass_by_value,
    reason = "N-API owns JavaScript strings at the ABI boundary"
)]
pub fn open_native_session_store_bridge(
    instance_id: String,
    root_id: String,
    root_path: String,
    maximum_frame_bytes: u32,
) -> Result<NativeSessionStoreBridge> {
    let instance = BridgeInstanceId::parse(instance_id.as_str()).map_err(error::session)?;
    let root = SessionRootId::parse(root_id.as_str()).map_err(error::session)?;
    let mut bootstrap = SessionStoreBridgeBootstrap::new(
        instance,
        usize::try_from(maximum_frame_bytes)
            .map_err(|_| error::session_state("native session frame limit overflows"))?,
    )
    .map_err(error::session)?;
    bootstrap
        .register_root(root, PathBuf::from(root_path).as_path())
        .map_err(error::session)?;
    Ok(NativeSessionStoreBridge {
        owner: Arc::new(SessionOwner {
            bridge: Mutex::new(Some(bootstrap.bind())),
            closed: AtomicBool::new(false),
        }),
    })
}
