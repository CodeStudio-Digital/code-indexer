use agent_platform::containment::ChildHandleAllowlist;
use agent_platform::windows::bootstrap::{WindowsCommandStreams, prepare_windows_command_streams};
use agent_platform::windows::pseudoconsole::{WindowsPseudoConsole, prepare_windows_pseudoconsole};
use std::io;

/// Failure before the IO workers start must close the reader before `ConPTY`.
#[derive(Debug)]
pub(super) struct DuplexTransport {
    pub streams: Option<WindowsCommandStreams>,
    pub console: Option<WindowsPseudoConsole>,
}
impl DuplexTransport {
    pub fn prepare(geometry: Option<(u16, u16)>) -> io::Result<(Self, ChildHandleAllowlist)> {
        let mut handles = ChildHandleAllowlist::new();
        let transport = if let Some((columns, rows)) = geometry {
            let (streams, console) = prepare_windows_pseudoconsole(columns, rows)?;
            let mut transport = Self {
                streams: Some(streams),
                console: Some(console),
            };
            handles
                .install_windows_pseudoconsole(
                    transport.console.as_mut().expect("owned console").child()?,
                )
                .map_err(io::Error::other)?;
            transport
        } else {
            let (streams, child) = prepare_windows_command_streams()?;
            let transport = Self {
                streams: Some(streams),
                console: None,
            };
            handles
                .install_windows_bootstrap(child)
                .map_err(io::Error::other)?;
            transport
        };
        Ok((transport, handles))
    }
}
impl Drop for DuplexTransport {
    fn drop(&mut self) {
        drop(self.streams.take());
        drop(self.console.take());
    }
}
