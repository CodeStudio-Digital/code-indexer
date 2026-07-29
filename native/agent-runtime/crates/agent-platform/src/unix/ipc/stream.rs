use std::fmt::{self, Debug, Formatter};
use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::UnixStream;

use crate::ipc::ProtectedEndpointAddress;

use super::peer::VerifiedUnixPeer;

pub struct VerifiedUnixEndpointStream {
    inner: UnixStream,
    address: ProtectedEndpointAddress,
    peer: VerifiedUnixPeer,
}

impl VerifiedUnixEndpointStream {
    pub(super) const fn new(
        inner: UnixStream,
        address: ProtectedEndpointAddress,
        peer: VerifiedUnixPeer,
    ) -> Self {
        Self {
            inner,
            address,
            peer,
        }
    }

    #[must_use]
    pub const fn peer(&self) -> VerifiedUnixPeer {
        self.peer
    }
}

impl Debug for VerifiedUnixEndpointStream {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VerifiedUnixEndpointStream")
            .field("address", &self.address)
            .field("peer", &self.peer)
            .finish_non_exhaustive()
    }
}

pub struct UnixEndpointClient {
    inner: UnixStream,
    address: ProtectedEndpointAddress,
    peer: VerifiedUnixPeer,
}

impl UnixEndpointClient {
    pub(super) const fn new(
        inner: UnixStream,
        address: ProtectedEndpointAddress,
        peer: VerifiedUnixPeer,
    ) -> Self {
        Self {
            inner,
            address,
            peer,
        }
    }

    #[must_use]
    pub const fn peer(&self) -> VerifiedUnixPeer {
        self.peer
    }
}

impl Debug for UnixEndpointClient {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UnixEndpointClient")
            .field("address", &self.address)
            .field("peer", &self.peer)
            .finish_non_exhaustive()
    }
}

macro_rules! delegate_io {
    ($type:ty) => {
        impl AsyncRead for $type {
            fn poll_read(
                mut self: Pin<&mut Self>,
                context: &mut Context<'_>,
                buffer: &mut ReadBuf<'_>,
            ) -> Poll<std::io::Result<()>> {
                Pin::new(&mut self.inner).poll_read(context, buffer)
            }
        }

        impl AsyncWrite for $type {
            fn poll_write(
                mut self: Pin<&mut Self>,
                context: &mut Context<'_>,
                buffer: &[u8],
            ) -> Poll<Result<usize, std::io::Error>> {
                Pin::new(&mut self.inner).poll_write(context, buffer)
            }

            fn poll_flush(
                mut self: Pin<&mut Self>,
                context: &mut Context<'_>,
            ) -> Poll<Result<(), std::io::Error>> {
                Pin::new(&mut self.inner).poll_flush(context)
            }

            fn poll_shutdown(
                mut self: Pin<&mut Self>,
                context: &mut Context<'_>,
            ) -> Poll<Result<(), std::io::Error>> {
                Pin::new(&mut self.inner).poll_shutdown(context)
            }
        }
    };
}

delegate_io!(VerifiedUnixEndpointStream);
delegate_io!(UnixEndpointClient);
