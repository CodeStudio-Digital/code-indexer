use std::fmt::{self, Debug, Formatter};

use crate::platform::NativeEndpointClient;

#[cfg(windows)]
pub type HostVerifiedStream = agent_platform::windows::ipc::WindowsEndpointClient;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostEndpointKind {
    Control,
    Data,
}

pub struct HostEndpointBinding {
    pub(crate) endpoint_id: String,
    pub(crate) connection_id: String,
    pub(crate) maximum_frame_bytes: u32,
    pub(crate) peer_pid: u32,
}

impl HostEndpointBinding {
    #[must_use]
    pub fn endpoint_id(&self) -> &str {
        &self.endpoint_id
    }

    #[must_use]
    pub fn connection_id(&self) -> &str {
        &self.connection_id
    }

    #[must_use]
    pub const fn maximum_frame_bytes(&self) -> u32 {
        self.maximum_frame_bytes
    }

    #[must_use]
    pub const fn peer_pid(&self) -> u32 {
        self.peer_pid
    }
}

impl Debug for HostEndpointBinding {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HostEndpointBinding")
            .field("endpoint_id", &"[REDACTED]")
            .field("connection_id", &"[REDACTED]")
            .field("maximum_frame_bytes", &self.maximum_frame_bytes)
            .field("peer_pid", &self.peer_pid)
            .finish()
    }
}

macro_rules! host_channel {
    ($name:ident) => {
        pub struct $name {
            #[cfg_attr(
                not(windows),
                allow(dead_code, reason = "non-Windows bridge remains fail-closed")
            )]
            pub(crate) stream: NativeEndpointClient,
            pub(crate) binding: HostEndpointBinding,
        }

        impl $name {
            #[must_use]
            pub const fn binding(&self) -> &HostEndpointBinding {
                &self.binding
            }

            #[cfg(windows)]
            #[must_use]
            pub fn into_verified_stream(self) -> HostVerifiedStream {
                self.stream
            }
        }

        impl Debug for $name {
            fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
                formatter
                    .debug_struct(stringify!($name))
                    .field("binding", &self.binding)
                    .finish_non_exhaustive()
            }
        }
    };
}

host_channel!(HostControlChannel);
host_channel!(HostDataChannel);

pub struct EndpointPlan {
    pub endpoint_id: String,
    #[cfg_attr(
        not(windows),
        allow(
            dead_code,
            reason = "the address is validated on every target but consumed only by a supported platform connector"
        )
    )]
    pub address: String,
    pub connection_id: String,
    pub maximum_frame_bytes: u32,
}

impl Debug for EndpointPlan {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EndpointPlan")
            .field("endpoint_id", &"[REDACTED]")
            .field("address", &"[REDACTED]")
            .field("connection_id", &"[REDACTED]")
            .field("maximum_frame_bytes", &self.maximum_frame_bytes)
            .finish()
    }
}
