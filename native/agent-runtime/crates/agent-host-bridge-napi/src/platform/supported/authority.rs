use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use napi::Result;
use tokio::sync::watch;

use crate::error;

pub(super) struct Activity<'a>(&'a AtomicBool);

impl<'a> Activity<'a> {
    pub(super) fn acquire(
        active: &'a AtomicBool,
        operation: &'static str,
        close: &CloseAuthority,
    ) -> Result<Self> {
        if active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            close.begin();
            return Err(error::concurrent(operation));
        }
        Ok(Self(active))
    }
}

impl Drop for Activity<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[derive(Clone)]
pub(super) struct CloseAuthority {
    closed: Arc<AtomicBool>,
    signal: watch::Sender<bool>,
}

impl CloseAuthority {
    pub(super) fn new() -> Self {
        let (signal, _) = watch::channel(false);
        Self {
            closed: Arc::new(AtomicBool::new(false)),
            signal,
        }
    }

    pub(super) fn begin(&self) {
        self.closed.store(true, Ordering::Release);
        self.signal.send_replace(true);
    }

    pub(super) fn ensure_open(&self) -> Result<()> {
        if self.is_closed() {
            return Err(error::closed());
        }
        Ok(())
    }

    pub(super) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    pub(super) fn subscribe(&self) -> watch::Receiver<bool> {
        self.signal.subscribe()
    }
}
