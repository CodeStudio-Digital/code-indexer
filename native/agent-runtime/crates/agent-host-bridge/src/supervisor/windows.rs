mod package;

use std::ffi::OsString;
use std::time::Duration;

use agent_platform::budget::ResourceBudget;
use agent_platform::containment::{
    ChildHandleAllowlist, ContainedLaunch, ContainmentPort, ResourceGroupId, SpawnFailure,
};
use agent_platform::ipc::{
    EndpointBufferCapacity, ExpectedLocalPeer, ProtectedEndpointFailure, endpoint_cancellation,
};
use agent_platform::windows::bootstrap::{WindowsBootstrapParent, prepare_windows_bootstrap};
use agent_platform::windows::ipc::WindowsProtectedEndpoint;
use agent_platform::windows::{WindowsContainment, WindowsJobGroup};
use agent_protocol::generated::v1 as wire;
use agent_protocol::management_frame::MANAGEMENT_FRAME_MAX_BYTES;
use agent_protocol::supervisor_bootstrap::SupervisorPhysicalBootstrapSender;
use tokio::task::JoinHandle;
use tokio::time::{Instant, timeout_at};
use zeroize::Zeroize;

use super::error::HostSupervisorBridgeError;
use super::owner::{
    AuthenticatedHostSupervisorChannel, HostSupervisorBinding, SupervisorProcessOwner,
};
use super::request::HostSupervisorLaunchPlan;

const FAILURE_SETTLE_TIMEOUT: Duration = Duration::from_secs(5);

pub(super) async fn open(
    mut plan: HostSupervisorLaunchPlan,
) -> Result<AuthenticatedHostSupervisorChannel, HostSupervisorBridgeError> {
    package::verify(&plan)?;
    let maximum_frame_bytes = u32::try_from(MANAGEMENT_FRAME_MAX_BYTES)
        .map_err(|source| HostSupervisorBridgeError::Endpoint(source.to_string()))?;
    let capacity = EndpointBufferCapacity::new(maximum_frame_bytes)
        .map_err(|source| HostSupervisorBridgeError::Endpoint(source.to_string()))?;
    let endpoint = WindowsProtectedEndpoint::bind(&plan.endpoint_name, capacity)
        .map_err(|source| HostSupervisorBridgeError::Endpoint(source.to_string()))?;
    let endpoint_address = endpoint.address().as_str().to_owned();
    let prepared = prepare_windows_bootstrap()
        .map_err(|source| HostSupervisorBridgeError::Bootstrap(source.to_string()))?;
    let (bootstrap, child_stdio) = prepared.into_parts();
    let mut handles = ChildHandleAllowlist::new();
    handles
        .install_windows_bootstrap(child_stdio)
        .map_err(|source| HostSupervisorBridgeError::Launch(source.to_string()))?;
    let spawned = spawn(&plan, handles)?;
    let process_id = spawned.process_id.0;
    let containment = containment_to_wire(spawned.report.capabilities);
    let process = SupervisorProcessOwner::new(spawned.group);

    if let Err(error) = package::verify(&plan) {
        cleanup_failed_process(process).await?;
        return Err(error);
    }

    let handoff = plan.mint_handoff(process_id, &endpoint_address, containment);
    let connection_id = plan.connection_id.as_str().to_owned();
    let deadline = Instant::now() + plan.startup_timeout;
    let mut bootstrap_task = spawn_bootstrap(
        bootstrap,
        handoff,
        process_id,
        connection_id.clone(),
        endpoint_address,
    );
    let expected = ExpectedLocalPeer::new(process_id)
        .map_err(|source| HostSupervisorBridgeError::Endpoint(source.to_string()))?;
    let (cancel, mut cancellation) = endpoint_cancellation();
    let stream = match endpoint.accept(expected, deadline, &mut cancellation).await {
        Ok(stream) => stream,
        Err(failure) => {
            cancel.cancel();
            let reason = failure.error().to_string();
            let _ = process.request_termination();
            settle_bootstrap_after_failure(&mut bootstrap_task).await;
            reap_endpoint_failure(failure).await;
            cleanup_failed_process(process).await?;
            return Err(HostSupervisorBridgeError::Endpoint(reason));
        }
    };
    drop(cancel);

    match timeout_at(deadline, &mut bootstrap_task).await {
        Ok(Ok(Ok(()))) => Ok(AuthenticatedHostSupervisorChannel::from_parts(
            HostSupervisorBinding::new(connection_id, maximum_frame_bytes, process_id),
            stream,
            process,
        )),
        outcome => {
            let reason = bootstrap_failure_reason(outcome);
            drop(stream);
            let _ = process.request_termination();
            settle_bootstrap_after_failure(&mut bootstrap_task).await;
            cleanup_failed_process(process).await?;
            Err(HostSupervisorBridgeError::Bootstrap(reason))
        }
    }
}

fn spawn(
    plan: &HostSupervisorLaunchPlan,
    handles: ChildHandleAllowlist,
) -> Result<agent_platform::containment::SpawnedGroup<WindowsJobGroup>, HostSupervisorBridgeError> {
    let launch = ContainedLaunch {
        executable: plan.supervisor_executable.clone(),
        arguments: Vec::<OsString>::new(),
        working_directory: plan.package_directory.clone(),
        environment: Vec::new(),
    };
    WindowsContainment::new()
        .spawn_runner_contained_with_handles(
            ResourceGroupId(format!("supervisor-{}", plan.connection_id.as_str())),
            &supervisor_budget(),
            &launch,
            handles,
        )
        .map_err(|failure| match failure {
            SpawnFailure::Clean(source) => HostSupervisorBridgeError::Launch(source.to_string()),
            SpawnFailure::Owned { spawned, error } => {
                let owner = SupervisorProcessOwner::new(spawned.group);
                let _ = owner.request_termination();
                let _ = owner.close();
                HostSupervisorBridgeError::Launch(error.to_string())
            }
        })
}

fn spawn_bootstrap(
    bootstrap: WindowsBootstrapParent,
    handoff: wire::SupervisorProcessHandoff,
    process_id: u32,
    connection_id: String,
    endpoint_address: String,
) -> JoinHandle<Result<(), HostSupervisorBridgeError>> {
    tokio::task::spawn_blocking(move || {
        let (reader, writer) = bootstrap.into_parts();
        let mut handoff = handoff;
        let result = SupervisorPhysicalBootstrapSender::new(reader, writer)
            .send(&handoff)
            .and_then(|sent| sent.receive_ready(process_id, &connection_id, &endpoint_address))
            .map(|_| ())
            .map_err(|source| HostSupervisorBridgeError::Bootstrap(source.to_string()));
        handoff.management_session_token.zeroize();
        handoff.supervisor_launch_nonce.zeroize();
        result
    })
}

async fn settle_bootstrap_after_failure(
    bootstrap: &mut JoinHandle<Result<(), HostSupervisorBridgeError>>,
) {
    let _ = timeout_at(Instant::now() + FAILURE_SETTLE_TIMEOUT, bootstrap).await;
}

async fn cleanup_failed_process(
    process: SupervisorProcessOwner,
) -> Result<(), HostSupervisorBridgeError> {
    tokio::task::spawn_blocking(move || process.close())
        .await
        .map_err(|source| HostSupervisorBridgeError::Cleanup(source.to_string()))??;
    Ok(())
}

async fn reap_endpoint_failure(
    failure: ProtectedEndpointFailure<agent_platform::windows::ipc::WindowsEndpointCleanup>,
) {
    if let ProtectedEndpointFailure::Owned { owner, .. } = failure {
        let _ = owner.reap(Instant::now() + FAILURE_SETTLE_TIMEOUT).await;
    }
}

fn bootstrap_failure_reason(
    outcome: Result<
        Result<Result<(), HostSupervisorBridgeError>, tokio::task::JoinError>,
        tokio::time::error::Elapsed,
    >,
) -> String {
    match outcome {
        Err(_) => "startup deadline elapsed".into(),
        Ok(Err(source)) => source.to_string(),
        Ok(Ok(Err(source))) => source.to_string(),
        Ok(Ok(Ok(()))) => "unexpected bootstrap state".into(),
    }
}

const fn containment_to_wire(
    value: agent_platform::containment::ContainmentCapabilities,
) -> wire::ContainmentCapabilities {
    wire::ContainmentCapabilities {
        process_tree: value.process_tree,
        memory_limit: value.memory_limit,
        cpu_limit: value.cpu_limit,
        process_count_limit: value.process_count_limit,
        open_file_limit: value.open_file_limit,
        filesystem_quota: value.filesystem_quota,
        network_policy: value.network_policy,
    }
}

const fn supervisor_budget() -> ResourceBudget {
    ResourceBudget {
        soft_memory_bytes: 128 * 1024 * 1024,
        hard_memory_bytes: 512 * 1024 * 1024,
        cpu_time_ms: 24 * 60 * 60 * 1_000,
        max_wall_ms: 7 * 24 * 60 * 60 * 1_000,
        max_processes: 1_024,
        max_threads: 4_096,
        max_open_handles: 65_536,
        max_hot_transcript_bytes: 1,
        max_ipc_frames: 65_536,
        max_ipc_bytes: 64 * 1024 * 1024,
        max_spool_bytes: 1,
        max_artifact_bytes: 1,
        max_concurrent_tools: 1,
        max_blocking_tasks: 4_096,
        cancel_grace_ms: 5_000,
    }
}
