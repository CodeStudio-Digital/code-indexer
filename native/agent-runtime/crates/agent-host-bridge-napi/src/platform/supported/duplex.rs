use std::sync::atomic::AtomicBool;

use agent_host_bridge::{
    HostControlChannel, HostDataChannel, HostEndpointBinding, HostVerifiedStream,
};
use napi::Result;
use tokio::io::{AsyncReadExt, AsyncWriteExt, ReadHalf, WriteHalf, split};
use tokio::sync::Mutex;
use zeroize::Zeroize;

use super::authority::{Activity, CloseAuthority};
use crate::error;

pub(super) struct NativeDuplex {
    binding: NativeBinding,
    reader: Mutex<Option<ReadHalf<HostVerifiedStream>>>,
    writer: Mutex<Option<WriteHalf<HostVerifiedStream>>>,
    reading: AtomicBool,
    writing: AtomicBool,
    close: CloseAuthority,
}

struct NativeBinding {
    endpoint_id: String,
    connection_id: String,
    maximum_frame_bytes: u32,
    peer_pid: u32,
}

impl NativeDuplex {
    pub(super) fn new_control(channel: HostControlChannel, close: CloseAuthority) -> Self {
        let binding = NativeBinding::from(channel.binding());
        Self::new(binding, channel.into_verified_stream(), close)
    }

    pub(super) fn new_data(channel: HostDataChannel, close: CloseAuthority) -> Self {
        let binding = NativeBinding::from(channel.binding());
        Self::new(binding, channel.into_verified_stream(), close)
    }

    fn new(binding: NativeBinding, stream: HostVerifiedStream, close: CloseAuthority) -> Self {
        let (reader, writer) = split(stream);
        Self {
            binding,
            reader: Mutex::new(Some(reader)),
            writer: Mutex::new(Some(writer)),
            reading: AtomicBool::new(false),
            writing: AtomicBool::new(false),
            close,
        }
    }

    pub(super) fn endpoint_id(&self) -> &str {
        &self.binding.endpoint_id
    }

    pub(super) fn connection_id(&self) -> &str {
        &self.binding.connection_id
    }

    pub(super) const fn maximum_frame_bytes(&self) -> u32 {
        self.binding.maximum_frame_bytes
    }

    pub(super) const fn peer_pid(&self) -> u32 {
        self.binding.peer_pid
    }

    pub(super) async fn read(&self, maximum: u32) -> Result<Option<Vec<u8>>> {
        let _activity = Activity::acquire(&self.reading, "read", &self.close)?;
        self.close.ensure_open()?;
        let mut cancellation = self.close.subscribe();
        let mut bytes = vec![0; maximum as usize];
        let outcome = {
            let mut owner = self.reader.lock().await;
            let reader = owner.as_mut().ok_or_else(error::closed)?;
            let outcome = tokio::select! {
                biased;
                changed = cancellation.changed() => {
                    let _ = changed;
                    None
                }
                read = reader.read(&mut bytes) => Some(read),
            };
            if matches!(outcome, Some(Ok(0)))
                || matches!(&outcome, Some(Err(source)) if clean_pipe_eof(source))
            {
                owner.take();
            }
            outcome
        };
        let length = match outcome {
            None => {
                bytes.zeroize();
                return Err(error::closed());
            }
            Some(Err(source)) if clean_pipe_eof(&source) => {
                bytes.zeroize();
                return Ok(None);
            }
            Some(Err(source)) => {
                bytes.zeroize();
                self.close.begin();
                return Err(error::io("read", &source));
            }
            Some(Ok(length)) => length,
        };
        if length == 0 {
            return Ok(None);
        }
        bytes.truncate(length);
        Ok(Some(bytes))
    }

    pub(super) async fn write(&self, bytes: &[u8]) -> Result<()> {
        let _activity = Activity::acquire(&self.writing, "write", &self.close)?;
        self.close.ensure_open()?;
        let mut cancellation = self.close.subscribe();
        {
            let mut owner = self.writer.lock().await;
            let writer = owner.as_mut().ok_or_else(error::closed)?;
            let result = tokio::select! {
                biased;
                changed = cancellation.changed() => {
                    let _ = changed;
                    Err(error::closed())
                }
                result = async {
                    writer.write_all(bytes).await?;
                    writer.flush().await
                } => {
                    result.map_err(|source| {
                        self.close.begin();
                        error::io("write", &source)
                    })
                }
            };
            drop(owner);
            result
        }
    }

    pub(super) async fn close(&self) {
        self.reader.lock().await.take();
        self.writer.lock().await.take();
    }
}

fn clean_pipe_eof(source: &std::io::Error) -> bool {
    source.kind() == std::io::ErrorKind::BrokenPipe
        || matches!(source.raw_os_error(), Some(109 | 232 | 233))
}

impl From<&HostEndpointBinding> for NativeBinding {
    fn from(value: &HostEndpointBinding) -> Self {
        Self {
            endpoint_id: value.endpoint_id().to_owned(),
            connection_id: value.connection_id().to_owned(),
            maximum_frame_bytes: value.maximum_frame_bytes(),
            peer_pid: value.peer_pid(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::clean_pipe_eof;

    #[test]
    fn only_named_pipe_disconnect_codes_are_clean_eof() {
        for code in [109, 232, 233] {
            assert!(clean_pipe_eof(&std::io::Error::from_raw_os_error(code)));
        }
        assert!(!clean_pipe_eof(&std::io::Error::from_raw_os_error(5)));
    }
}
