use std::fmt::{self, Debug, Formatter};
use std::sync::{Arc, Mutex};

use agent_platform::ipc::{
    EndpointCancellation, EndpointCancellationHandle, endpoint_cancellation,
};

use super::WindowsProtectedLaunchError;

struct CancellationSlot {
    next_registration: u64,
    active: Option<(u64, EndpointCancellationHandle)>,
}

/// Revocation authority for the single in-flight synchronous bootstrap.
#[derive(Clone)]
pub struct WindowsProtectedLaunchCancellation {
    slot: Arc<Mutex<CancellationSlot>>,
}

#[derive(Clone)]
pub(super) struct CancellationRegistry {
    slot: Arc<Mutex<CancellationSlot>>,
}

pub(super) struct WindowsBootstrapCancellationRegistration {
    registration: u64,
    slot: Arc<Mutex<CancellationSlot>>,
    observer: EndpointCancellation,
}

impl CancellationRegistry {
    pub(super) fn new() -> Self {
        Self {
            slot: Arc::new(Mutex::new(CancellationSlot {
                next_registration: 1,
                active: None,
            })),
        }
    }

    pub(super) fn handle(&self) -> WindowsProtectedLaunchCancellation {
        WindowsProtectedLaunchCancellation {
            slot: Arc::clone(&self.slot),
        }
    }

    pub(super) fn register(
        &self,
    ) -> Result<WindowsBootstrapCancellationRegistration, WindowsProtectedLaunchError> {
        let (handle, observer) = endpoint_cancellation();
        let mut slot = self
            .slot
            .lock()
            .map_err(|_| WindowsProtectedLaunchError::CancellationState)?;
        if slot.active.is_some() {
            return Err(WindowsProtectedLaunchError::CancellationBusy);
        }
        let registration = slot.next_registration;
        slot.next_registration = slot
            .next_registration
            .checked_add(1)
            .ok_or(WindowsProtectedLaunchError::CancellationState)?;
        slot.active = Some((registration, handle));
        drop(slot);
        Ok(WindowsBootstrapCancellationRegistration {
            registration,
            slot: Arc::clone(&self.slot),
            observer,
        })
    }
}

impl WindowsProtectedLaunchCancellation {
    /// Cancels the current bootstrap, if one is registered.
    ///
    /// # Errors
    ///
    /// Returns an error if the bounded cancellation registry was poisoned.
    pub fn cancel_current(&self) -> Result<bool, WindowsProtectedLaunchError> {
        let slot = self
            .slot
            .lock()
            .map_err(|_| WindowsProtectedLaunchError::CancellationState)?;
        let Some((_, handle)) = &slot.active else {
            return Ok(false);
        };
        handle.cancel();
        drop(slot);
        Ok(true)
    }
}

impl WindowsBootstrapCancellationRegistration {
    pub(super) const fn observer(&self) -> &EndpointCancellation {
        &self.observer
    }
}

impl Drop for WindowsBootstrapCancellationRegistration {
    fn drop(&mut self) {
        let mut slot = self
            .slot
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if slot
            .active
            .as_ref()
            .is_some_and(|(registration, _)| *registration == self.registration)
        {
            slot.active = None;
        }
    }
}

impl Debug for WindowsProtectedLaunchCancellation {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WindowsProtectedLaunchCancellation")
            .finish_non_exhaustive()
    }
}
