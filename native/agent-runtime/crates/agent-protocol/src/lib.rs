//! Stable protocol-domain primitives shared by the Rust processes.
//!
//! Protobuf-generated wire types live in [`generated::v1`]. The handwritten
//! modules validate inputs and adapt wire values; they are not a competing wire
//! authority.

pub mod activation_authority;
pub mod bootstrap_limits;
pub mod frame;
pub mod framing;
pub mod generated;
pub mod handshake;
pub mod identity;
pub mod management_channel;
pub mod management_frame;
mod management_secrets;
pub mod pulse_channel;
pub mod runner_bootstrap;
pub mod semantic_hash;
pub mod supervisor_bootstrap;
#[cfg(feature = "testing")]
pub mod testing;
pub mod version;
pub mod wire_identity;
