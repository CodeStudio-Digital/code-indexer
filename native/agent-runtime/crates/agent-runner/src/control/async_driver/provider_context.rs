use tokio::io::{AsyncRead, AsyncWrite};

use super::AsyncRunnerControlDriver;
use crate::provider_context::{
    ProviderContextError, ProviderContextMaterial, compose_initial_provider_context,
};

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> AsyncRunnerControlDriver<S> {
    pub(crate) fn compose_initial_provider_context(
        &self,
        material: &impl ProviderContextMaterial,
    ) -> Result<Vec<u8>, ProviderContextError> {
        let seed = self
            .session
            .execution_seed
            .as_ref()
            .ok_or(ProviderContextError::MissingExecutionSeed)?;
        compose_initial_provider_context(seed, material)
    }
}
