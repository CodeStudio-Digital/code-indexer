use agent_engine::ports::{
    AuthorityCheckpoint, AuthorityPort, ClockPort, EngineEvent, EventSinkPort, TerminalRecord,
};
use tokio::sync::Mutex;

pub(super) struct SharedPort<'a, T>(pub &'a Mutex<T>);

impl<A: AuthorityPort> AuthorityPort for SharedPort<'_, &mut A> {
    type Error = A::Error;
    async fn verify(&mut self, checkpoint: AuthorityCheckpoint) -> Result<(), Self::Error> {
        self.0.lock().await.verify(checkpoint).await
    }
}

impl<E: EventSinkPort> EventSinkPort for SharedPort<'_, &mut E> {
    type Error = E::Error;
    async fn append(&mut self, event: EngineEvent<'_>) -> Result<(), Self::Error> {
        self.0.lock().await.append(event).await
    }
    async fn commit_terminal(&mut self, terminal: TerminalRecord<'_>) -> Result<(), Self::Error> {
        self.0.lock().await.commit_terminal(terminal).await
    }
}

impl<C: ClockPort> ClockPort for SharedPort<'_, &mut C> {
    type Error = C::Error;
    async fn now_unix_ms(&mut self) -> Result<i64, Self::Error> {
        self.0.lock().await.now_unix_ms().await
    }
}
