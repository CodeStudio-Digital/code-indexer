use std::error::Error;
use std::fmt::{self, Debug, Display, Formatter};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use agent_platform::ipc::{EndpointCancellation, ExpectedLocalPeer, ProtectedEndpointFailure};
use agent_platform::windows::ipc::{
    VerifiedWindowsEndpointStream, WindowsEndpointCleanup, WindowsProtectedEndpoint,
};
use agent_protocol::frame::{
    DATA_FRAME_MAX_BYTES, DataBindDeadlines, DataChannelError, DataChannelLimits,
    RunnerDataBindAuthority,
};
use agent_protocol::generated::v1 as wire;
use agent_protocol::identity::{ConnectionId, RuntimeInstanceId};
use agent_protocol::runner_bootstrap::{RunnerBootstrapError, ShapeValidatedRunnerLaunchHandoff};
use agent_protocol::version::ProtocolVersion;
use agent_protocol::wire_identity::identity_from_wire;
use tokio::time::Instant;

use super::hydration::RunnerHydrationRequest;
use super::hydration::transport::pump::{
    CompletedHydrationPump, HydrationDataPumpError, RunnerHydrationPumpContext, receive_hydration,
};
use crate::control::{CONTROL_PROTOCOL_MAJOR, CONTROL_PROTOCOL_MINOR};

const PREFERRED_DATA_CHUNK_BYTES: u64 = 900 * 1_024;
const DATA_ENVELOPE_SAFETY_BYTES: u64 = 64 * 1_024;
const PREFERRED_DATA_IO_TIMEOUT_MS: u64 = 30_000;

pub(super) struct PendingRunnerDataHydration {
    endpoint: WindowsProtectedEndpoint,
    expected_host: ExpectedLocalPeer,
    authority: RunnerDataBindAuthority,
    limits: DataChannelLimits,
    pump_context: RunnerHydrationPumpContext,
}

#[derive(Debug)]
pub(super) enum RunnerDataHydrationError {
    Bootstrap(RunnerBootstrapError),
    InvalidHandoff(&'static str),
    Channel(DataChannelError),
    Accept(ProtectedEndpointFailure<WindowsEndpointCleanup>),
    Pump(HydrationDataPumpError),
}

impl Debug for PendingRunnerDataHydration {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PendingRunnerDataHydration")
            .field("endpoint", &self.endpoint)
            .field("expected_host", &self.expected_host)
            .field("authority", &self.authority)
            .field("limits", &self.limits)
            .field("pump_context", &self.pump_context)
            .finish()
    }
}

impl PendingRunnerDataHydration {
    pub(super) fn from_handoff(
        endpoint: WindowsProtectedEndpoint,
        handoff: &mut ShapeValidatedRunnerLaunchHandoff,
        expected_host: ExpectedLocalPeer,
        hard_deadline: Instant,
    ) -> Result<Self, RunnerDataHydrationError> {
        let metadata = handoff.metadata();
        let wire_identity = metadata
            .identity
            .clone()
            .ok_or(RunnerDataHydrationError::InvalidHandoff("identity"))?;
        let identity = identity_from_wire(&wire_identity)
            .map_err(|_| RunnerDataHydrationError::InvalidHandoff("identity"))?;
        let runtime_instance_id = RuntimeInstanceId::new(metadata.runtime_instance_id.clone())
            .map_err(|_| RunnerDataHydrationError::InvalidHandoff("runtime_instance_id"))?;
        let data_endpoint = metadata
            .endpoints
            .iter()
            .find(|candidate| candidate.kind == wire::AttemptEndpointKind::Data as i32)
            .cloned()
            .ok_or(RunnerDataHydrationError::InvalidHandoff("data_endpoint"))?;
        let connection = ConnectionId::new(data_endpoint.connection_id.clone())
            .map_err(|_| RunnerDataHydrationError::InvalidHandoff("data_connection_id"))?;
        let budget = metadata
            .reserved_resource_budget
            .ok_or(RunnerDataHydrationError::InvalidHandoff("resource_budget"))?;
        let semantic_deadline_at_unix_ms = metadata.hard_deadline_at_unix_ms;
        let runtime_instance_id_text = metadata.runtime_instance_id.clone();
        let handoff_digest = *handoff.original_frame_sha256();
        let verifier = handoff
            .take_endpoint_token_verifier(wire::AttemptEndpointKind::Data)
            .map_err(RunnerDataHydrationError::Bootstrap)?;
        let limits = data_limits(&data_endpoint, budget)?;
        let protocol = ProtocolVersion::new(
            u16::try_from(CONTROL_PROTOCOL_MAJOR).expect("protocol major fits u16"),
            u16::try_from(CONTROL_PROTOCOL_MINOR).expect("protocol minor fits u16"),
        );
        let authority = RunnerDataBindAuthority::new(
            identity,
            connection,
            protocol,
            runtime_instance_id,
            &handoff_digest,
            verifier,
            limits,
        )
        .map_err(RunnerDataHydrationError::Channel)?;
        Ok(Self {
            endpoint,
            expected_host,
            authority,
            limits,
            pump_context: RunnerHydrationPumpContext {
                wire_identity,
                runtime_instance_id: runtime_instance_id_text,
                hard_deadline,
                semantic_deadline_at_unix_ms,
            },
        })
    }

    pub(super) async fn receive(
        self,
        request: RunnerHydrationRequest,
        cancellation: &mut EndpointCancellation,
    ) -> Result<CompletedHydrationPump<VerifiedWindowsEndpointStream>, RunnerDataHydrationError>
    {
        let limits = *self.authority_limits();
        let stream = self
            .endpoint
            .accept(
                self.expected_host,
                self.pump_context.hard_deadline,
                cancellation,
            )
            .await
            .map_err(RunnerDataHydrationError::Accept)?;
        let pending = self
            .authority
            .attach(stream)
            .map_err(RunnerDataHydrationError::Channel)?;
        let bound = pending
            .bind(
                DataBindDeadlines {
                    read: operation_deadline(
                        self.pump_context.hard_deadline,
                        limits.read_timeout(),
                    ),
                    replay_hard: self.pump_context.hard_deadline,
                    replay_write_timeout: limits.write_timeout(),
                    write: operation_deadline(
                        self.pump_context.hard_deadline,
                        limits.write_timeout(),
                    ),
                    semantic_at_unix_ms: self.pump_context.semantic_deadline_at_unix_ms,
                },
                current_unix_ms,
            )
            .await
            .map_err(RunnerDataHydrationError::Channel)?;
        Box::pin(receive_hydration(
            request,
            bound,
            self.pump_context,
            current_unix_ms,
        ))
        .await
        .map_err(RunnerDataHydrationError::Pump)
    }

    const fn authority_limits(&self) -> &DataChannelLimits {
        &self.limits
    }
}

fn data_limits(
    endpoint: &wire::RunnerLaunchEndpoint,
    budget: wire::ResourceBudget,
) -> Result<DataChannelLimits, RunnerDataHydrationError> {
    let max_frame_bytes = endpoint
        .max_frame_bytes
        .min(DATA_FRAME_MAX_BYTES as u64)
        .min(budget.max_ipc_bytes);
    let max_chunk_bytes = max_frame_bytes
        .saturating_sub(DATA_ENVELOPE_SAFETY_BYTES)
        .min(PREFERRED_DATA_CHUNK_BYTES);
    let timeout = budget.max_wall_ms.min(PREFERRED_DATA_IO_TIMEOUT_MS);
    DataChannelLimits::new(wire::FrameLimits {
        max_frame_bytes,
        max_chunk_bytes,
        max_in_flight_frames: 1,
        max_in_flight_bytes: max_frame_bytes,
        read_timeout_ms: timeout,
        write_timeout_ms: timeout,
        transport_crc32c: false,
    })
    .map_err(RunnerDataHydrationError::Channel)
}

fn operation_deadline(hard: Instant, timeout: Duration) -> Instant {
    Instant::now()
        .checked_add(timeout)
        .map_or(hard, |deadline| deadline.min(hard))
}

fn current_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or(i64::MAX)
}

impl Display for RunnerDataHydrationError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Bootstrap(error) => Display::fmt(error, formatter),
            Self::InvalidHandoff(field) => {
                write!(
                    formatter,
                    "data hydration handoff field is invalid: {field}"
                )
            }
            Self::Channel(error) => Display::fmt(error, formatter),
            Self::Accept(error) => Display::fmt(error.error(), formatter),
            Self::Pump(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for RunnerDataHydrationError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Bootstrap(error) => Some(error),
            Self::Channel(error) => Some(error),
            Self::Accept(error) => Some(error.error()),
            Self::Pump(error) => Some(error),
            Self::InvalidHandoff(_) => None,
        }
    }
}
