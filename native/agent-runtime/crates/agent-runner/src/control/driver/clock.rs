use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::control::authority::EffectClock;

/// Production clock anchored once to wall time and advanced monotonically.
#[derive(Debug, Clone)]
pub(in crate::control) struct SystemControlClock {
    anchor_unix_ms: i64,
    anchor: Instant,
}

impl SystemControlClock {
    pub(in crate::control) fn new() -> Self {
        let anchor_unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .and_then(|duration| i64::try_from(duration.as_millis()).ok())
            .unwrap_or_default();
        Self {
            anchor_unix_ms,
            anchor: Instant::now(),
        }
    }
}

impl EffectClock for SystemControlClock {
    fn now_unix_ms(&self) -> i64 {
        i64::try_from(self.anchor.elapsed().as_millis())
            .ok()
            .and_then(|elapsed| self.anchor_unix_ms.checked_add(elapsed))
            .unwrap_or(i64::MAX)
    }
}

impl Default for SystemControlClock {
    fn default() -> Self {
        Self::new()
    }
}
