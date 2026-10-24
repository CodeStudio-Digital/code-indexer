use super::{ChildHandleAllowlist, ChildHandleAllowlistError};
use crate::windows::pseudoconsole::WindowsPseudoConsoleChild;

impl ChildHandleAllowlist {
    /// Installs an opaque `ConPTY` authority instead of inherited standard handles.
    /// # Errors
    /// Mixing terminal and pipe bootstrap or installing two consoles is rejected.
    pub fn install_windows_pseudoconsole(
        &mut self,
        console: WindowsPseudoConsoleChild,
    ) -> Result<(), ChildHandleAllowlistError> {
        if !self.is_empty() || self.pseudoconsole.is_some() {
            return Err(ChildHandleAllowlistError::Duplicate);
        }
        self.pseudoconsole = Some(console);
        Ok(())
    }

    pub(crate) fn windows_pseudoconsole_raw(&self) -> Option<isize> {
        self.pseudoconsole
            .as_ref()
            .map(WindowsPseudoConsoleChild::raw)
    }
}
