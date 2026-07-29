use crate::generated::v1 as wire;
use crate::version::ProtocolVersion;

use crate::management_channel::ManagementChannelError;

pub(super) fn validate_protocol_range(
    hello: &wire::SupervisorHello,
    selected: ProtocolVersion,
) -> Result<(), ManagementChannelError> {
    let range = hello
        .supported_protocols
        .as_ref()
        .ok_or(ManagementChannelError::MissingSelectedProtocol)?;
    let minimum = range
        .minimum
        .as_ref()
        .copied()
        .ok_or(ManagementChannelError::MissingSelectedProtocol)
        .and_then(parse_version)?;
    let maximum = range
        .maximum
        .as_ref()
        .copied()
        .ok_or(ManagementChannelError::MissingSelectedProtocol)
        .and_then(parse_version)?;
    if minimum > maximum || selected < minimum || selected > maximum {
        return Err(ManagementChannelError::InvalidSelectedProtocol);
    }
    Ok(())
}

pub(super) fn provenance_matches(
    expected: &wire::ExpectedRuntimeProvenance,
    actual: &wire::RuntimeProvenance,
) -> bool {
    expected.build_id == actual.build_id
        && expected.source_commit == actual.source_commit
        && expected.binary_sha256 == actual.binary_sha256
        && expected.operating_system == actual.operating_system
        && expected.architecture == actual.architecture
}

pub(super) fn validate_required_containment(
    level: i32,
) -> Result<wire::ContainmentLevel, ManagementChannelError> {
    match wire::ContainmentLevel::try_from(level) {
        Ok(
            level @ (wire::ContainmentLevel::HardAggregate
            | wire::ContainmentLevel::HardProcess
            | wire::ContainmentLevel::Monitored),
        ) => Ok(level),
        _ => Err(ManagementChannelError::InvalidContainment),
    }
}

pub(super) const fn validate_containment(
    required: wire::ContainmentLevel,
    actual: wire::ContainmentCapabilities,
) -> Result<(), ManagementChannelError> {
    let sufficient = match required {
        wire::ContainmentLevel::HardAggregate | wire::ContainmentLevel::HardProcess => {
            actual.process_tree
                && actual.memory_limit
                && actual.cpu_limit
                && actual.process_count_limit
        }
        wire::ContainmentLevel::Monitored => true,
        _ => false,
    };
    if !sufficient {
        return Err(ManagementChannelError::InsufficientContainment);
    }
    Ok(())
}

pub(super) fn parse_version(
    value: wire::ProtocolVersion,
) -> Result<ProtocolVersion, ManagementChannelError> {
    let major =
        u16::try_from(value.major).map_err(|_| ManagementChannelError::InvalidSelectedProtocol)?;
    let minor =
        u16::try_from(value.minor).map_err(|_| ManagementChannelError::InvalidSelectedProtocol)?;
    let protocol = ProtocolVersion::new(major, minor);
    if protocol.major == 0 {
        return Err(ManagementChannelError::InvalidSelectedProtocol);
    }
    Ok(protocol)
}
