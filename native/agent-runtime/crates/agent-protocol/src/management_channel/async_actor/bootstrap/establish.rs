use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::Duration;

use super::{AsyncBootstrapManagementActor, BOOTSTRAP_TIMEOUT, BootstrapRole};
use crate::generated::v1 as wire;
use crate::management_channel::async_actor::{
    AsyncEstablishedManagementActor, AsyncManagementActorError,
};
use crate::management_channel::bootstrap::{validate_host_hello, validate_supervisor_hello};
use crate::management_channel::{
    ManagementChannelError, ManagementDirection, ManagementSessionPolicy,
};

impl<S: AsyncRead + AsyncWrite + Unpin + Send + 'static> AsyncBootstrapManagementActor<S> {
    /// # Errors
    ///
    /// Fails closed on any physical or semantic Hello violation.
    pub async fn establish_host(
        mut self,
        hello: &wire::HostSupervisorHello,
    ) -> Result<AsyncEstablishedManagementActor, AsyncManagementActorError> {
        if self.role != BootstrapRole::Host {
            return Err(ManagementChannelError::WrongBootstrapOrder.into());
        }
        let selection = validate_host_hello(hello, &self.expected_connection, self.expected_token)?;
        self.send_hello(
            selection.protocol,
            ManagementDirection::HostToSupervisor,
            wire::management_payload::Body::HostSupervisorHello(hello.clone()),
            Duration::from_millis(selection.policy.frame_limits().write_timeout_ms),
        )
        .await?;
        let message_id = self
            .receive_hello(
                ManagementDirection::SupervisorToHost,
                Some(&selection),
                Duration::from_millis(selection.policy.frame_limits().read_timeout_ms),
            )
            .await?;
        self.finish(selection, message_id)
    }

    /// # Errors
    ///
    /// Fails closed on any physical or semantic Hello violation.
    pub async fn establish_supervisor(
        self,
        hello: &wire::SupervisorHello,
    ) -> Result<AsyncEstablishedManagementActor, AsyncManagementActorError> {
        let hello = hello.clone();
        self.establish_supervisor_with(|_| Ok(hello)).await
    }

    /// Receives and validates the Host selection before minting the
    /// supervisor-owned Hello from the negotiated policy.
    ///
    /// # Errors
    ///
    /// Fails closed on any physical, semantic, or Hello-construction failure.
    pub async fn establish_supervisor_with<F>(
        mut self,
        make_hello: F,
    ) -> Result<AsyncEstablishedManagementActor, AsyncManagementActorError>
    where
        F: FnOnce(
            &ManagementSessionPolicy,
        ) -> Result<wire::SupervisorHello, ManagementChannelError>,
    {
        if self.role != BootstrapRole::Supervisor {
            return Err(ManagementChannelError::WrongBootstrapOrder.into());
        }
        let received = self
            .receive_bootstrap(
                ManagementDirection::HostToSupervisor,
                None,
                BOOTSTRAP_TIMEOUT,
            )
            .await?;
        let selection = received
            .selection
            .ok_or(ManagementChannelError::WrongBootstrapOrder)?;
        let hello = make_hello(&selection.policy)?;
        validate_supervisor_hello(&hello, &selection, self.expected_nonce)?;
        self.send_hello(
            selection.protocol,
            ManagementDirection::SupervisorToHost,
            wire::management_payload::Body::SupervisorHello(hello),
            Duration::from_millis(selection.policy.frame_limits().write_timeout_ms),
        )
        .await?;
        self.finish(selection, received.message_id)
    }
}
