use std::error::Error;
use std::fmt::{self, Debug, Display, Formatter};
use std::io;

#[cfg(unix)]
use std::os::fd::{AsFd, AsRawFd, OwnedFd};
#[cfg(windows)]
use std::os::windows::io::{AsHandle, AsRawHandle};

#[cfg(windows)]
#[allow(unsafe_code)]
mod windows;

#[cfg(windows)]
use crate::windows::bootstrap::{
    RawBootstrapStdio, WINDOWS_BOOTSTRAP_HANDLE_COUNT, WindowsBootstrapChildStdio,
};
#[cfg(windows)]
use windows::PreparedChildHandle;

const MAX_CHILD_HANDLES: usize = 8;

#[derive(Debug)]
pub enum ChildHandleAllowlistError {
    CapacityExceeded,
    Duplicate,
    Preparation(io::Error),
}

impl Display for ChildHandleAllowlistError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::CapacityExceeded => formatter.write_str("child handle allowlist is full"),
            Self::Duplicate => formatter.write_str("child handle is already allowlisted"),
            Self::Preparation(source) => {
                write!(formatter, "child handle preparation failed: {source}")
            }
        }
    }
}

impl Error for ChildHandleAllowlistError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Preparation(source) => Some(source),
            Self::CapacityExceeded | Self::Duplicate => None,
        }
    }
}

/// Bounded, single-owner authority for handles explicitly inherited by one
/// child spawn.
///
/// Windows entries are dedicated inheritable duplicates. Unix entries are
/// dedicated close-on-exec duplicates for a future `posix_spawn` file-action
/// adapter. Raw values are intentionally unavailable outside `agent-platform`.
pub struct ChildHandleAllowlist {
    #[cfg(unix)]
    descriptors: Vec<PreparedChildDescriptor>,
    #[cfg(windows)]
    handles: Vec<PreparedChildHandle>,
    #[cfg(windows)]
    bootstrap_stdio: Option<WindowsBootstrapChildStdio>,
}

#[cfg(unix)]
struct PreparedChildDescriptor {
    source: i32,
    _owned: OwnedFd,
}

impl Debug for ChildHandleAllowlist {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ChildHandleAllowlist")
            .field("count", &self.len())
            .finish_non_exhaustive()
    }
}

impl Default for ChildHandleAllowlist {
    fn default() -> Self {
        Self::new()
    }
}

impl ChildHandleAllowlist {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            #[cfg(unix)]
            descriptors: Vec::new(),
            #[cfg(windows)]
            handles: Vec::new(),
            #[cfg(windows)]
            bootstrap_stdio: None,
        }
    }

    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.len() == 0
    }

    #[must_use]
    pub const fn len(&self) -> usize {
        #[cfg(unix)]
        {
            self.descriptors.len()
        }
        #[cfg(windows)]
        {
            self.handles.len()
                + if self.bootstrap_stdio.is_some() {
                    WINDOWS_BOOTSTRAP_HANDLE_COUNT
                } else {
                    0
                }
        }
    }

    /// Creates and owns one dedicated inheritable Windows duplicate.
    ///
    /// # Errors
    ///
    /// Rejects duplicates and more than eight inherited handles.
    #[cfg(windows)]
    pub fn prepare_windows<T>(&mut self, owner: &T) -> Result<(), ChildHandleAllowlistError>
    where
        T: AsHandle + ?Sized,
    {
        let source = owner.as_handle().as_raw_handle() as usize;
        if self
            .handles
            .iter()
            .any(|current| current.source() == source)
        {
            return Err(ChildHandleAllowlistError::Duplicate);
        }
        if self.len() == MAX_CHILD_HANDLES {
            return Err(ChildHandleAllowlistError::CapacityExceeded);
        }
        self.handles.push(
            PreparedChildHandle::duplicate(owner.as_handle())
                .map_err(ChildHandleAllowlistError::Preparation)?,
        );
        Ok(())
    }

    /// Installs bootstrap stdin/stdout/stderr as one indivisible Windows set.
    ///
    /// # Errors
    ///
    /// Rejects a second bootstrap set or a set that would exceed the bounded
    /// inherited-handle capacity. Failure drops the supplied linear owner.
    #[cfg(windows)]
    pub fn install_windows_bootstrap(
        &mut self,
        bootstrap_stdio: WindowsBootstrapChildStdio,
    ) -> Result<(), ChildHandleAllowlistError> {
        if self.bootstrap_stdio.is_some() {
            return Err(ChildHandleAllowlistError::Duplicate);
        }
        if self
            .len()
            .checked_add(WINDOWS_BOOTSTRAP_HANDLE_COUNT)
            .is_none_or(|count| count > MAX_CHILD_HANDLES)
        {
            return Err(ChildHandleAllowlistError::CapacityExceeded);
        }
        self.bootstrap_stdio = Some(bootstrap_stdio);
        Ok(())
    }

    /// Creates and owns one dedicated Unix descriptor duplicate.
    ///
    /// # Errors
    ///
    /// Rejects duplicates and more than eight inherited descriptors.
    #[cfg(unix)]
    pub fn prepare_unix<T>(&mut self, owner: &T) -> Result<(), ChildHandleAllowlistError>
    where
        T: AsFd + ?Sized,
    {
        let source = owner.as_fd().as_raw_fd();
        if self
            .descriptors
            .iter()
            .any(|current| current.source == source)
        {
            return Err(ChildHandleAllowlistError::Duplicate);
        }
        if self.descriptors.len() == MAX_CHILD_HANDLES {
            return Err(ChildHandleAllowlistError::CapacityExceeded);
        }
        let duplicate = owner
            .as_fd()
            .try_clone_to_owned()
            .map_err(ChildHandleAllowlistError::Preparation)?;
        self.descriptors.push(PreparedChildDescriptor {
            source,
            _owned: duplicate,
        });
        Ok(())
    }

    #[cfg(windows)]
    pub(crate) fn windows_raw_handles(
        &self,
    ) -> impl Iterator<Item = windows_sys::Win32::Foundation::HANDLE> + '_ {
        self.handles.iter().map(PreparedChildHandle::raw).chain(
            self.bootstrap_stdio
                .iter()
                .flat_map(WindowsBootstrapChildStdio::raw_handles),
        )
    }

    #[cfg(windows)]
    pub(crate) fn windows_bootstrap_stdio(&self) -> Option<RawBootstrapStdio> {
        self.bootstrap_stdio
            .as_ref()
            .map(WindowsBootstrapChildStdio::raw)
    }

    #[cfg(test)]
    #[cfg(windows)]
    pub(crate) fn windows_raw_values(&self) -> Vec<usize> {
        self.handles
            .iter()
            .map(PreparedChildHandle::raw_value)
            .collect()
    }
}
