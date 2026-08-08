use std::collections::VecDeque;
use std::os::windows::process::CommandExt;
use std::process::Stdio;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use super::error::CodexGatewayError;
use crate::external_engine::CodexAppServerProcessConfig;

const MAX_LINE_BYTES: usize = 1024 * 1024;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DISABLED_FEATURES: &[&str] = &[
    "shell_tool",
    "browser_use",
    "browser_use_external",
    "computer_use",
    "in_app_browser",
    "apps",
    "plugins",
    "multi_agent",
    "image_generation",
    "hooks",
    "skill_search",
    "tool_suggest",
];

#[derive(Debug)]
pub(super) struct CodexProcess {
    child: Child,
    input: BufWriter<ChildStdin>,
    output: BufReader<ChildStdout>,
    queued: VecDeque<Value>,
    next_id: u64,
}

impl CodexProcess {
    pub(super) fn spawn(config: CodexAppServerProcessConfig) -> Result<Self, CodexGatewayError> {
        let mut command = Command::new(config.executable);
        command
            .arg("app-server")
            .arg("--stdio")
            .args(
                DISABLED_FEATURES
                    .iter()
                    .flat_map(|feature| ["--disable", *feature]),
            )
            .arg("-c")
            .arg("mcp_servers={}")
            .current_dir(config.working_directory)
            .env_clear()
            .envs(config.environment)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        command.as_std_mut().creation_flags(CREATE_NO_WINDOW);
        let mut child = command.spawn()?;
        let input = child
            .stdin
            .take()
            .ok_or(CodexGatewayError::Spawn("stdin was not piped"))?;
        let output = child
            .stdout
            .take()
            .ok_or(CodexGatewayError::Spawn("stdout was not piped"))?;
        Ok(Self {
            child,
            input: BufWriter::new(input),
            output: BufReader::new(output),
            queued: VecDeque::new(),
            next_id: 1,
        })
    }

    #[must_use]
    pub(super) fn process_id(&self) -> Option<u32> {
        self.child.id()
    }

    pub(super) async fn notify(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<(), CodexGatewayError> {
        self.send(&json!({ "method": method, "params": params }))
            .await
    }

    pub(super) async fn request(
        &mut self,
        method: &str,
        params: Value,
        after_write: impl FnOnce(),
    ) -> Result<Value, CodexGatewayError> {
        let id = self.next_id;
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or(CodexGatewayError::InvalidProtocol("request ID exhausted"))?;
        self.send(&json!({ "method": method, "id": id, "params": params }))
            .await?;
        after_write();
        loop {
            let message = self.read_wire().await?;
            if message.get("id").and_then(Value::as_u64) == Some(id)
                && message.get("method").is_none()
            {
                if let Some(error) = message.get("error") {
                    return Err(rpc_error(error));
                }
                return Ok(message.get("result").cloned().unwrap_or(Value::Null));
            }
            if message.get("id").is_some() && message.get("method").is_none() {
                return Err(CodexGatewayError::InvalidProtocol("foreign response ID"));
            }
            self.queued.push_back(message);
        }
    }

    pub(super) async fn respond(
        &mut self,
        id: Value,
        result: Value,
    ) -> Result<(), CodexGatewayError> {
        self.send(&json!({ "id": id, "result": result })).await
    }

    pub(super) async fn reject(
        &mut self,
        id: Value,
        code: i64,
        message: &str,
    ) -> Result<(), CodexGatewayError> {
        self.send(&json!({ "id": id, "error": { "code": code, "message": message } }))
            .await
    }

    pub(super) async fn next_message(&mut self) -> Result<Value, CodexGatewayError> {
        if let Some(message) = self.queued.pop_front() {
            return Ok(message);
        }
        self.read_wire().await
    }

    async fn send(&mut self, message: &Value) -> Result<(), CodexGatewayError> {
        let bytes = serde_json::to_vec(message)?;
        if bytes.is_empty() || bytes.len() > MAX_LINE_BYTES {
            return Err(CodexGatewayError::InvalidProtocol("outbound line limit"));
        }
        self.input.write_all(&bytes).await?;
        self.input.write_all(b"\n").await?;
        self.input.flush().await?;
        Ok(())
    }

    async fn read_wire(&mut self) -> Result<Value, CodexGatewayError> {
        let mut line = Vec::new();
        loop {
            let available = self.output.fill_buf().await?;
            if available.is_empty() {
                return Err(CodexGatewayError::InvalidProtocol("unexpected stdout EOF"));
            }
            let end = available
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(available.len(), |index| index + 1);
            if line.len().saturating_add(end) > MAX_LINE_BYTES {
                return Err(CodexGatewayError::InvalidProtocol("inbound line limit"));
            }
            line.extend_from_slice(&available[..end]);
            self.output.consume(end);
            if line.last() == Some(&b'\n') {
                break;
            }
        }
        while matches!(line.last(), Some(b'\n' | b'\r')) {
            line.pop();
        }
        if line.is_empty() {
            return Err(CodexGatewayError::InvalidProtocol("empty JSON line"));
        }
        serde_json::from_slice(&line).map_err(Into::into)
    }
}

fn rpc_error(value: &Value) -> CodexGatewayError {
    CodexGatewayError::Rpc {
        code: value.get("code").and_then(Value::as_i64).unwrap_or(-32_603),
        message: value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("JSON-RPC request failed")
            .to_owned(),
    }
}
