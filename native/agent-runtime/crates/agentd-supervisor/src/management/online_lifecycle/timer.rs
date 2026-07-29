use std::fmt::Debug;
use std::future::Future;
use std::time::Duration;

/// Injectable wait primitive. Deadline arithmetic remains with the owner clock.
pub trait SupervisorOnlineLifecycleTimer: Debug + Send {
    fn wait(&mut self, delay: Duration) -> impl Future<Output = ()> + Send;
}

#[derive(Debug, Default)]
pub struct TokioSupervisorLifecycleTimer;

impl SupervisorOnlineLifecycleTimer for TokioSupervisorLifecycleTimer {
    async fn wait(&mut self, delay: Duration) {
        tokio::time::sleep(delay).await;
    }
}
