use crate::ipc::{
    EndpointBufferCapacity, EndpointName, ExpectedLocalPeer, ProtectedEndpointAddress,
    ProtectedEndpointError,
};

use super::{WindowsEndpointClient, WindowsProtectedEndpoint};

const PIPE_PREFIX: &str = r"\\.\pipe\codestudio-agent-v1-";
const INVALID_EXPECTED_ADDRESS: &str = "Windows pipe address is not canonical";

pub(super) fn canonical(name: &EndpointName) -> String {
    format!("{PIPE_PREFIX}{}", name.as_str())
}

impl WindowsProtectedEndpoint {
    /// Creates one protected listener only when the supplied address is the
    /// exact canonical address derived from a valid [`EndpointName`].
    ///
    /// # Errors
    ///
    /// Rejects alternate prefixes, case aliases, traversal, invalid suffixes,
    /// collisions, or any operating-system bind failure.
    pub fn bind_expected_address(
        expected_address: &str,
        capacity: EndpointBufferCapacity,
    ) -> Result<Self, ProtectedEndpointError> {
        let name = expected_name(expected_address)?;
        let endpoint = Self::bind(&name, capacity)?;
        if endpoint.address().as_str() != expected_address {
            return Err(invalid_expected_address());
        }
        Ok(endpoint)
    }

    /// Opens one protected listener only when the supplied address is exact
    /// and the operating system attributes its server to the expected PID.
    ///
    /// # Errors
    ///
    /// Rejects non-canonical addresses before opening them, then propagates
    /// connection and peer-verification failures without retry.
    pub fn connect_expected_address(
        expected_address: &str,
        expected_peer: ExpectedLocalPeer,
    ) -> Result<WindowsEndpointClient, ProtectedEndpointError> {
        let name = expected_name(expected_address)?;
        let canonical = canonical(&name);
        if canonical != expected_address {
            return Err(invalid_expected_address());
        }
        Self::connect(
            &ProtectedEndpointAddress::from_bound(canonical),
            expected_peer,
        )
    }
}

fn expected_name(expected_address: &str) -> Result<EndpointName, ProtectedEndpointError> {
    let suffix = expected_address
        .strip_prefix(PIPE_PREFIX)
        .ok_or_else(invalid_expected_address)?;
    let name = EndpointName::new(suffix.to_owned()).map_err(|_| invalid_expected_address())?;
    if canonical(&name) != expected_address {
        return Err(invalid_expected_address());
    }
    Ok(name)
}

const fn invalid_expected_address() -> ProtectedEndpointError {
    ProtectedEndpointError::InvalidAddress(INVALID_EXPECTED_ADDRESS)
}
