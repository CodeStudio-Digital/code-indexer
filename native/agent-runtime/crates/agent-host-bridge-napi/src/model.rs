use napi_derive::napi;

pub const NATIVE_HOST_BRIDGE_API_VERSION: u32 = 2;
pub const MINIMUM_NODE_API_VERSION: u32 = 8;

#[derive(Debug)]
#[napi(object)]
pub struct NativeHostBridgeAbi {
    pub addon_api_version: u32,
    pub contract_schema_version: u32,
    pub contract_version: String,
    pub minimum_node_api_version: u32,
    pub target_triple: String,
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
    }
}
