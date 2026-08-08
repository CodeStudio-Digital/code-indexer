use std::sync::Arc;
use std::time::Duration;

use agent_engine::operation::OperationId;
use agent_engine::turn::{TurnEngine, TurnInput};
use tokio::sync::oneshot;

use super::capability_loop::CapabilityLoop;
use super::error::ActiveEngineError;
use super::{ActiveEngineResources, SystemClock, engine_limits, now_unix_ms};
use crate::external_engine::{CodexAppServerGateway, CodexAppServerProcessConfig};
use crate::provider_data::ProviderDataTiming;
use crate::provider_gateway::ProviderDataGateway;

const MAX_DATA_IO_TIMEOUT_MS: u64 = 30_000;

pub(super) async fn run(
    resources: ActiveEngineResources,
    config: CodexAppServerProcessConfig,
    started: oneshot::Sender<()>,
) -> Result<(), ActiveEngineError> {
    let spec = resources.execution_seed.as_wire();
    let identity = spec
        .identity
        .clone()
        .ok_or(ActiveEngineError::Missing("identity"))?;
    let binding = spec
        .provider_binding
        .clone()
        .ok_or(ActiveEngineError::Missing("provider_binding"))?;
    let budget = spec
        .resource_budget
        .ok_or(ActiveEngineError::Missing("resource_budget"))?;
    let limits = engine_limits(spec, budget)?;
    let hard_deadline = super::super::physical_deadline(spec.deadline_at_unix_ms)
        .map_err(|_| ActiveEngineError::InvalidLimits)?;
    let timing = ProviderDataTiming {
        hard_deadline,
        replay_write_timeout: Duration::from_millis(budget.max_wall_ms.min(MAX_DATA_IO_TIMEOUT_MS)),
    };
    let max_context_bytes =
        usize::try_from(budget.max_ipc_bytes).map_err(|_| ActiveEngineError::InvalidLimits)?;
    let capability_set_sha256 = capability_set_digest(spec)?;
    let data_owner = ProviderDataGateway::new(
        resources.data,
        identity.clone(),
        resources.runtime_instance_id,
        binding.clone(),
        timing,
        now_unix_ms,
        max_context_bytes,
    )
    .map_err(|_| ActiveEngineError::ProviderAuthority)?;
    let mut capabilities = data_owner
        .capability_gateway(&capability_set_sha256, max_context_bytes)
        .map_err(|_| ActiveEngineError::CapabilityAuthority)?;
    let mut events = data_owner
        .event_sink(spec.deadline_at_unix_ms, 1)
        .map_err(|_| ActiveEngineError::ProviderAuthority)?;
    let mut provider = CodexAppServerGateway::new(config, binding.effective_model, started)
        .map_err(|_| ActiveEngineError::ProviderAuthority)?;
    let operation_id = OperationId::new(format!("codex-turn:{}", identity.attempt_id))
        .map_err(|_| ActiveEngineError::InvalidOperation)?;
    let mut engine = TurnEngine::new(limits);
    let mut authority = resources.authority;
    let mut clock = SystemClock;
    let mut provider_context: Arc<[u8]> = resources.initial_provider_context.into();
    let run_tree_budget = spec
        .run_tree_budget
        .as_ref()
        .ok_or(ActiveEngineError::Missing("run_tree_budget"))?;
    let outcome = engine
        .run(
            TurnInput {
                operation_id,
                encoded_context: Arc::clone(&provider_context),
                deadline_at_unix_ms: spec.deadline_at_unix_ms,
            },
            &mut provider,
            &mut authority,
            &mut events,
            &mut clock,
        )
        .await
        .map_err(|_| ActiveEngineError::TurnFailed)?;
    CapabilityLoop {
        engine: &mut engine,
        provider: &mut provider,
        capabilities: &mut capabilities,
        events: &mut events,
        authority: &mut authority,
        clock: &mut clock,
        provider_context: &mut provider_context,
        capability_set_sha256,
        deadline_at_unix_ms: spec.deadline_at_unix_ms,
        maximum_context_bytes: max_context_bytes,
        maximum_turns: run_tree_budget.max_turns.unwrap_or(u64::MAX),
        maximum_tool_calls: run_tree_budget.max_tool_calls.unwrap_or(u64::MAX),
        attempt_id: identity.attempt_id.as_str(),
    }
    .drive(outcome)
    .await?;
    let retained = (
        provider,
        data_owner,
        capabilities,
        events,
        engine,
        provider_context,
    );
    std::future::pending::<()>().await;
    drop(retained);
    Ok(())
}

fn capability_set_digest(
    spec: &agent_protocol::generated::v1::ResolvedAttemptSpec,
) -> Result<[u8; 32], ActiveEngineError> {
    spec.capability_set_snapshot
        .as_ref()
        .ok_or(ActiveEngineError::Missing("capability_set_snapshot"))?
        .content_sha256
        .as_slice()
        .try_into()
        .map_err(|_| ActiveEngineError::CapabilityAuthority)
}
