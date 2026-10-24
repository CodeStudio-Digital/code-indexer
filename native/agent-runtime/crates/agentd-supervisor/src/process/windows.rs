use agent_platform::ipc::ExpectedLocalPeer;
use agent_platform::windows::WindowsContainment;
use agent_platform::windows::bootstrap::open_inherited_windows_bootstrap;
use agent_platform::windows::ipc::WindowsProtectedEndpoint;
use agent_protocol::management_channel::AsyncBootstrapManagementActor;
use agent_protocol::supervisor_bootstrap::SupervisorPhysicalBootstrapReceiver;
use zeroize::Zeroizing;

use crate::management::{
    ProtectedLaunchPeerAuthority, SupervisorAsyncService, SupervisorAsyncServiceOutcome,
    SupervisorLaunchReceipt, SupervisorLifecycleCore, SupervisorManagementTerminal,
    SystemSupervisorLifecycleClock, TokioSupervisorLifecycleTimer,
    WindowsProtectedLaunchProvisioner,
};

use super::SupervisorProcessError;
use super::config;

/// Consumes one inherited process handoff and owns the management/lifecycle
/// service until physical drain or a hard-restart invariant.
///
/// # Errors
///
/// Rejects unavailable inherited authority, invalid handoff or peer identity,
/// failed management negotiation, invalid physical configuration and any
/// terminal that cannot prove a clean drain.
#[allow(
    clippy::significant_drop_tightening,
    reason = "the established actor is moved directly into the permanent service owner"
)]
pub fn run_inherited_windows() -> Result<(), SupervisorProcessError> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()
        .map_err(SupervisorProcessError::Runtime)?;
    let bootstrap =
        open_inherited_windows_bootstrap().map_err(SupervisorProcessError::BootstrapOpen)?;
    let host_process_id = bootstrap.creator_process_id();
    let (reader, writer) = bootstrap.into_parts();
    let received = SupervisorPhysicalBootstrapReceiver::new(reader, writer)
        .receive(host_process_id, std::process::id())
        .map_err(SupervisorProcessError::Bootstrap)?;
    let (mut handoff, ready_transport) = received.into_parts();
    let lifecycle_outbox = open_outbox(
        handoff.lifecycle_outbox_directory(),
        handoff.connection_id().as_str(),
    )?;

    let trusted_runner =
        config::trusted_runner(&handoff).map_err(SupervisorProcessError::Configuration)?;
    let peer_authority =
        ProtectedLaunchPeerAuthority::from_authenticated_windows_host(host_process_id)
            .map_err(SupervisorProcessError::PeerAuthority)?;
    let launch_nonce = handoff.take_supervisor_launch_nonce();
    let mut actor_launch_nonce = Zeroizing::new(launch_nonce.clone());
    let launch_receipt = SupervisorLaunchReceipt::from_process_handoff(&handoff, launch_nonce)
        .map_err(|error| {
            SupervisorProcessError::Management(
                agent_protocol::management_channel::AsyncManagementActorError::Management(error),
            )
        })?;
    let management_token = handoff.take_management_session_token();
    let expected_host =
        ExpectedLocalPeer::new(host_process_id).map_err(SupervisorProcessError::Endpoint)?;
    let management = {
        let _guard = runtime.enter();
        WindowsProtectedEndpoint::connect_expected_address(
            handoff.management_endpoint_address(),
            expected_host,
        )
        .map_err(SupervisorProcessError::Endpoint)?
    };
    ready_transport
        .send(&handoff.ready())
        .map_err(SupervisorProcessError::Bootstrap)?;

    runtime.block_on(async move {
        let actor_launch_nonce = std::mem::take(actor_launch_nonce.as_mut());
        let bootstrap = AsyncBootstrapManagementActor::supervisor(
            management,
            handoff.connection_id().clone(),
            actor_launch_nonce,
            management_token,
        )
        .map_err(SupervisorProcessError::Management)?;
        let mut receipt = launch_receipt;
        let actor = bootstrap
            .establish_supervisor_with(move |policy| receipt.take_supervisor_hello(policy))
            .await
            .map_err(SupervisorProcessError::Management)?;
        let policy = actor.session_policy().clone();
        let pulse_timeout = std::time::Duration::from_millis(
            policy.limits().runner_pulse_timeout_ms,
        );
        let provisioner = WindowsProtectedLaunchProvisioner::new_with_pulse_timeout(
            std::time::Duration::from_secs(15),
            pulse_timeout,
        )
        .map_err(SupervisorProcessError::Provisioner)?;
        let core = SupervisorLifecycleCore::new(
            policy,
            WindowsContainment::new(),
            provisioner,
            trusted_runner,
            peer_authority,
        )
        .map_err(SupervisorProcessError::Driver)?;
        let core = if let Some(outbox) = lifecycle_outbox {
            core.with_lifecycle_outbox(outbox).map_err(SupervisorProcessError::Driver)?
        } else { core };
        let clock = SystemSupervisorLifecycleClock::new().map_err(SupervisorProcessError::Clock)?;
        let (_shutdown, service) =
            SupervisorAsyncService::new(actor, core, clock, TokioSupervisorLifecycleTimer);
        match service.run().await {
            SupervisorAsyncServiceOutcome::PhysicallyDrained {
                terminal:
                    SupervisorManagementTerminal::Shutdown
                    | SupervisorManagementTerminal::PeerClosed,
                ..
            } => Ok(()),
            SupervisorAsyncServiceOutcome::PhysicallyDrained { terminal, .. } => {
                Err(SupervisorProcessError::Terminal(terminal))
            }
            SupervisorAsyncServiceOutcome::HardRestartRequired { error, .. } => {
                Err(SupervisorProcessError::HardRestart(error))
            }
        }
    })
}

fn open_outbox(
    directory: &str,
    connection: &str,
) -> Result<Option<crate::lifecycle_outbox::DurableLifecycleOutbox>, SupervisorProcessError> {
    if directory.is_empty() {
        return Ok(None);
    }
    crate::lifecycle_outbox::DurableLifecycleOutbox::open(
        std::path::Path::new(directory),
        connection,
    )
    .map(Some)
    .map_err(SupervisorProcessError::LifecycleOutbox)
}
