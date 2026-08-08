use agent_protocol::generated::v1 as wire;
use agent_tools::capability::ExecutionClass;

use super::CodexGatewayError;

pub(super) fn execution_class(value: i32) -> Result<ExecutionClass, CodexGatewayError> {
    match wire::CapabilityExecutionClass::try_from(value).ok() {
        Some(wire::CapabilityExecutionClass::NativeRead) => Ok(ExecutionClass::NativeRead),
        Some(wire::CapabilityExecutionClass::NativeMutation) => Ok(ExecutionClass::NativeMutation),
        Some(wire::CapabilityExecutionClass::NativeProcess) => Ok(ExecutionClass::NativeProcess),
        Some(wire::CapabilityExecutionClass::HostCapability) => Ok(ExecutionClass::HostCapability),
        Some(wire::CapabilityExecutionClass::ControlInteractive) => {
            Ok(ExecutionClass::ControlInteractive)
        }
        Some(wire::CapabilityExecutionClass::NestedCode) => Ok(ExecutionClass::NestedCode),
        Some(wire::CapabilityExecutionClass::RemoteEnvironment) => {
            Ok(ExecutionClass::RemoteEnvironment)
        }
        _ => Err(CodexGatewayError::InvalidContext(
            "execution class is invalid",
        )),
    }
}
