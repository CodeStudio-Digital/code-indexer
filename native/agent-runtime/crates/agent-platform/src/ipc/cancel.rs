use tokio::sync::watch;

/// Revocable owner used by supervisor lifecycle code.
#[derive(Debug)]
pub struct EndpointCancellationHandle {
    sender: watch::Sender<bool>,
}

/// Single operation-side observer. It is intentionally not cloneable.
#[derive(Debug)]
pub struct EndpointCancellation {
    receiver: watch::Receiver<bool>,
}

#[must_use]
pub fn endpoint_cancellation() -> (EndpointCancellationHandle, EndpointCancellation) {
    let (sender, receiver) = watch::channel(false);
    (
        EndpointCancellationHandle { sender },
        EndpointCancellation { receiver },
    )
}

impl EndpointCancellationHandle {
    /// Revocation is idempotent. A dropped observer is already unable to use
    /// its endpoint, so send failure needs no separate state.
    pub fn cancel(&self) {
        let _ = self.sender.send(true);
    }
}

impl EndpointCancellation {
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        *self.receiver.borrow()
    }

    /// Waits until the lifecycle owner revokes this endpoint/session.
    pub async fn cancelled(&mut self) {
        while !*self.receiver.borrow_and_update() {
            if self.receiver.changed().await.is_err() {
                break;
            }
        }
    }
}
