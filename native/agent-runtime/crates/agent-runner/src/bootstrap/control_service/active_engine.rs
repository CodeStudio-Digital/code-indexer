use std::future::{Future, ready};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use agent_engine::limits::EngineLimits;
use agent_engine::operation::OperationId;
use agent_engine::ports::ClockPort;
use agent_engine::turn::{TurnEngine, TurnInput};
use agent_platform::windows::ipc::VerifiedWindowsEndpointStream;
use agent_protocol::frame::AsyncEstablishedAttemptChannel;
use agent_protocol::generated::v1 as wire;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::control::RunnerExecutionSeed;
use crate::engine_authority::EngineAuthority;
use crate::external_engine::CodexAppServerProcessConfig;
use crate::provider_data::ProviderDataTiming;
use crate::provider_gateway::ProviderDataGateway;

mod capability_loop;
mod codex;
mod error;

use capability_loop::CapabilityLoop;
use error::ActiveEngineError;

const MAX_DATA_IO_TIMEOUT_MS: u64 = 30_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ActiveEngineExit {
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug)]
pub(super) struct ActiveEngineTask {
    join: JoinHandle<ActiveEngineExit>,
    started: Option<oneshot::Receiver<()>>,
}

impl ActiveEngineTask {
    pub(super) fn spawn(resources: ActiveEngineResources) -> Self {
        let (started, started_wait) = oneshot::channel();
        Self {
            join: tokio::spawn(async move {
                Box::pin(run(resources, started))
                    .await
                    .map_or(ActiveEngineExit::Failed, |()| ActiveEngineExit::Completed)
            }),
            started: Some(started_wait),
        }
    }

    pub(super) async fn wait_started(&mut self) -> bool {
        match self.started.take() {
            Some(started) => started.await.is_ok(),
            None => false,
        }
    }

    pub(super) fn is_finished(&self) -> bool {
        self.join.is_finished()
    }

    pub(super) async fn cancel_and_join(self) -> ActiveEngineExit {
        if !self.join.is_finished() {
            self.join.abort();
        }
        match self.join.await {
            Ok(exit) => exit,
            Err(error) if error.is_cancelled() => ActiveEngineExit::Cancelled,
            Err(_) => ActiveEngineExit::Failed,
        }
    }
}

pub(super) struct ActiveEngineResources {
    pub data: AsyncEstablishedAttemptChannel<VerifiedWindowsEndpointStream>,
    pub execution_seed: RunnerExecutionSeed,
    pub authority: EngineAuthority,
    pub initial_provider_context: Vec<u8>,
    pub runtime_instance_id: String,
    pub codex_app_server: Option<CodexAppServerProcessConfig>,
}

async fn run(
    mut resources: ActiveEngineResources,
    started: oneshot::Sender<()>,
) -> Result<(), ActiveEngineError> {
    if let Some(config) = resources.codex_app_server.take() {
        return codex::run(resources, config, started).await;
    }
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
    let hard_deadline = super::physical_deadline(spec.deadline_at_unix_ms)
        .map_err(|_| ActiveEngineError::InvalidLimits)?;
    let timing = ProviderDataTiming {
        hard_deadline,
        replay_write_timeout: Duration::from_millis(budget.max_wall_ms.min(MAX_DATA_IO_TIMEOUT_MS)),
    };
    let max_context_bytes =
        usize::try_from(budget.max_ipc_bytes).map_err(|_| ActiveEngineError::InvalidLimits)?;
    let capability_set_sha256: [u8; 32] = spec
        .capability_set_snapshot
        .as_ref()
        .ok_or(ActiveEngineError::Missing("capability_set_snapshot"))?
        .content_sha256
        .as_slice()
        .try_into()
        .map_err(|_| ActiveEngineError::CapabilityAuthority)?;
    let mut provider = ProviderDataGateway::new(
        resources.data,
        identity.clone(),
        resources.runtime_instance_id,
        binding,
        timing,
        now_unix_ms,
        max_context_bytes,
    )
    .map_err(|_| ActiveEngineError::ProviderAuthority)?;
    provider.signal_first_start_with(started);
    let mut capabilities = provider
        .capability_gateway(&capability_set_sha256, max_context_bytes)
        .map_err(|_| ActiveEngineError::CapabilityAuthority)?;
    let mut events = provider
        .event_sink(spec.deadline_at_unix_ms, 1)
        .map_err(|_| ActiveEngineError::ProviderAuthority)?;
    let operation_id = OperationId::new(format!("provider-turn:{}", identity.attempt_id))
        .map_err(|_| ActiveEngineError::InvalidOperation)?;
    let mut engine = TurnEngine::new(limits);
    let mut authority = resources.authority;
    let mut clock = SystemClock;
    let mut provider_context: Arc<[u8]> = resources.initial_provider_context.into();
    let run_tree_budget = spec
        .run_tree_budget
        .as_ref()
        .ok_or(ActiveEngineError::Missing("run_tree_budget"))?;
    let max_turns = run_tree_budget.max_turns.unwrap_or(u64::MAX);
    let max_tool_calls = run_tree_budget.max_tool_calls.unwrap_or(u64::MAX);
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
        maximum_turns: max_turns,
        maximum_tool_calls: max_tool_calls,
        attempt_id: identity.attempt_id.as_str(),
    }
    .drive(outcome)
    .await?;
    // A completed provider turn is not the physical end of the attempt. Keep
    // the authenticated Data owner alive until Control cleanup aborts and
    // joins this task; otherwise the Host observes a false failure EOF.
    let retained_data_plane = (provider, events, capabilities, engine, provider_context);
    std::future::pending::<()>().await;
    drop(retained_data_plane);
    Ok(())
}

fn engine_limits(
    spec: &wire::ResolvedAttemptSpec,
    budget: wire::ResourceBudget,
) -> Result<EngineLimits, ActiveEngineError> {
    let tree = spec
        .run_tree_budget
        .as_ref()
        .ok_or(ActiveEngineError::Missing("run_tree_budget"))?;
    let context =
        usize::try_from(budget.max_ipc_bytes).map_err(|_| ActiveEngineError::InvalidLimits)?;
    let transcript = usize::try_from(budget.max_hot_transcript_bytes)
        .map_err(|_| ActiveEngineError::InvalidLimits)?;
    let event_bytes = usize::try_from(
        budget
            .max_artifact_bytes
            .min(budget.max_hot_transcript_bytes),
    )
    .map_err(|_| ActiveEngineError::InvalidLimits)?;
    EngineLimits::new(
        context,
        usize::try_from(budget.max_ipc_frames).map_err(|_| ActiveEngineError::InvalidLimits)?,
        event_bytes,
        transcript,
        tree.max_output_tokens.unwrap_or(u64::MAX),
        tree.max_cost_micros.unwrap_or(u64::MAX),
    )
    .map_err(|_| ActiveEngineError::InvalidLimits)
}

struct SystemClock;

impl ClockPort for SystemClock {
    type Error = std::convert::Infallible;

    fn now_unix_ms(&mut self) -> impl Future<Output = Result<i64, Self::Error>> + Send {
        ready(Ok(now_unix_ms()))
    }
}

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or(i64::MAX)
}
