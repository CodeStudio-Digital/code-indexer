//! Production composition root for the permanent supervisor process.

mod config;
mod error;
#[cfg(windows)]
mod windows;

pub use error::SupervisorProcessError;
#[cfg(windows)]
pub use windows::run_inherited_windows;
