use crate::generated::v1 as wire;
use crate::version::ProtocolVersion;

use super::{AsyncBootstrapChannelError, BootstrapError};

pub(super) fn agent_hello_protocol(
    hello: &wire::AgentHello,
) -> Result<ProtocolVersion, AsyncBootstrapChannelError> {
    let maximum = hello
        .supported_protocols
        .as_ref()
        .and_then(|range| range.maximum.as_ref())
        .ok_or(BootstrapError::InvalidSelectedProtocol)?;
    let major =
        u16::try_from(maximum.major).map_err(|_| BootstrapError::InvalidSelectedProtocol)?;
    let minor =
        u16::try_from(maximum.minor).map_err(|_| BootstrapError::InvalidSelectedProtocol)?;
    let protocol = ProtocolVersion::new(major, minor);
    if protocol.major == 0 {
        return Err(BootstrapError::InvalidSelectedProtocol.into());
    }
    Ok(protocol)
}
