#[cfg(windows)]
mod supported;
#[cfg(not(windows))]
mod unsupported;

#[cfg(windows)]
pub use supported::{ChannelKind, NativeChannelSet, NativeSupervisorSet};
#[cfg(not(windows))]
pub use unsupported::{ChannelKind, NativeChannelSet, NativeSupervisorSet};
