#[cfg(windows)]
use agent_platform::ipc::{ExpectedLocalPeer, ProtectedEndpointError};

#[cfg(windows)]
use crate::endpoint::EndpointPlan;

#[cfg(windows)]
pub type NativeEndpointClient = agent_platform::windows::ipc::WindowsEndpointClient;

#[cfg(not(windows))]
#[derive(Debug)]
pub struct NativeEndpointClient;

#[cfg(windows)]
pub fn connect(
    plan: &EndpointPlan,
    runner_pid: u32,
) -> Result<NativeEndpointClient, ProtectedEndpointError> {
    let expected = ExpectedLocalPeer::new(runner_pid)?;
    agent_platform::windows::ipc::WindowsProtectedEndpoint::connect_expected_address(
        &plan.address,
        expected,
    )
}
