use napi_derive::napi;

pub const NATIVE_HOST_BRIDGE_API_VERSION: u32 = 2;
pub const MINIMUM_NODE_API_VERSION: u32 = 8;

#[derive(Debug)]
#[napi(object)]
pub struct NativeHostResourceBounds {
    pub version: u32,
    pub supervisor_memory_bytes: u32,
    pub supervisor_processes: u32,
    pub command_memory_bytes: u32,
    pub command_processes: u32,
    pub duplex_memory_bytes: u32,
    pub duplex_processes: u32,
}

#[derive(Debug)]
#[napi(object)]
pub struct NativeHostBridgeAbi {
    pub addon_api_version: u32,
    pub contract_schema_version: u32,
    pub contract_version: String,
    pub minimum_node_api_version: u32,
    pub target_triple: String,
    pub duplex_output_version: u32,
    pub pseudoconsole_version: u32,
    pub resource_bounds: NativeHostResourceBounds,
}

#[napi]
#[must_use]
pub fn native_host_bridge_abi() -> NativeHostBridgeAbi {
    NativeHostBridgeAbi {
        addon_api_version: NATIVE_HOST_BRIDGE_API_VERSION,
        contract_schema_version: 1,
        contract_version: "1.0.0".to_owned(),
        minimum_node_api_version: MINIMUM_NODE_API_VERSION,
        target_triple: env!("AGENT_HOST_BRIDGE_TARGET").to_owned(),
        duplex_output_version: 1,
        pseudoconsole_version: 1,
        resource_bounds: NativeHostResourceBounds {
            version: 1,
            supervisor_memory_bytes: agent_host_bridge::resource_bounds::SUPERVISOR_MEMORY_BYTES,
            supervisor_processes: agent_host_bridge::resource_bounds::SUPERVISOR_PROCESSES,
            command_memory_bytes: agent_host_bridge::resource_bounds::COMMAND_MEMORY_BYTES,
            command_processes: agent_host_bridge::resource_bounds::COMMAND_PROCESSES,
            duplex_memory_bytes: agent_host_bridge::resource_bounds::DUPLEX_MEMORY_BYTES,
            duplex_processes: agent_host_bridge::resource_bounds::DUPLEX_PROCESSES,
        },
    }
}
