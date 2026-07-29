use std::fmt::{self, Debug, Formatter};
use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::windows::named_pipe::{NamedPipeClient, NamedPipeServer};

use crate::ipc::{ProtectedEndpointAddress, VerifiedLocalPeer};

/// Server stream that cannot exist before OS peer verification succeeds.
pub struct VerifiedWindowsEndpointStream {
    inner: NamedPipeServer,
    address: ProtectedEndpointAddress,
    peer: VerifiedLocalPeer,
}

impl VerifiedWindowsEndpointStream {
    pub(super) const fn new(
        inner: NamedPipeServer,
        address: ProtectedEndpointAddress,
        peer: VerifiedLocalPeer,
    ) -> Self {
        Self {
            inner,
            address,
            peer,
        }
    }

    #[must_use]
    pub const fn peer(&self) -> VerifiedLocalPeer {
        self.peer
    }
}

impl Debug for VerifiedWindowsEndpointStream {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VerifiedWindowsEndpointStream")
            .field("address", &self.address)
            .field("peer", &self.peer)
            .finish_non_exhaustive()
    }
}

impl AsyncRead for VerifiedWindowsEndpointStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(context, buffer)
    }
}

impl AsyncWrite for VerifiedWindowsEndpointStream {
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

/// Client half retains the validated address without exposing raw handles.
pub struct WindowsEndpointClient {
    inner: NamedPipeClient,
    address: ProtectedEndpointAddress,
    peer: VerifiedLocalPeer,
}

impl WindowsEndpointClient {
    pub(super) const fn new(
        inner: NamedPipeClient,
        address: ProtectedEndpointAddress,
        peer: VerifiedLocalPeer,
    ) -> Self {
        Self {
            inner,
            address,
            peer,
        }
    }

    #[must_use]
    pub const fn peer(&self) -> VerifiedLocalPeer {
        self.peer
    }
}

impl Debug for WindowsEndpointClient {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WindowsEndpointClient")
            .field("address", &self.address)
            .field("peer", &self.peer)
            .finish_non_exhaustive()
    }
}

impl AsyncRead for WindowsEndpointClient {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(context, buffer)
    }
}

impl AsyncWrite for WindowsEndpointClient {
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
