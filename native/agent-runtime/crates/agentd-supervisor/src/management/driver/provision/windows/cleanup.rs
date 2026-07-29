use agent_platform::windows::bootstrap::WindowsBootstrapCleanup;

use super::super::ProtectedLaunchCleanupProof;
use super::WindowsProtectedLaunchError;

/// Reaper-owned set of kernel operations from one failed bootstrap.
#[derive(Debug)]
pub struct WindowsProtectedLaunchCleanup {
    pending: Vec<WindowsBootstrapCleanup>,
}

impl WindowsProtectedLaunchCleanup {
    pub(super) const fn new(pending: Vec<WindowsBootstrapCleanup>) -> Self {
        Self { pending }
    }

    pub(super) fn try_cleanup(
        &mut self,
    ) -> Result<ProtectedLaunchCleanupProof, WindowsProtectedLaunchError> {
        let pending = std::mem::take(&mut self.pending);
        let mut retained = Vec::with_capacity(pending.len());
        for cleanup in pending {
            if let Err(failure) = cleanup.try_reap() {
                retained.push(failure.owner);
            }
        }
        self.pending = retained;
        if self.pending.is_empty() {
            Ok(ProtectedLaunchCleanupProof::completed())
        } else {
            Err(WindowsProtectedLaunchError::CleanupPending)
        }
    }
}
