use std::collections::BTreeMap;
use std::future::Future;

use agent_engine::operation::OperationId;
use agent_engine::ports::{ProviderEvent, ProviderGatewayPort, ProviderRequest};
use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::external_engine::CodexAppServerProcessConfig;

mod error;
mod handler;
mod process;
mod protocol;

use error::CodexGatewayError;
use process::CodexProcess;
use protocol::{PendingTool, ToolAuthority};

const CLIENT_VERSION: &str = "0.1.0";
#[derive(Debug)]
pub struct CodexAppServerGateway {
    config: Option<CodexAppServerProcessConfig>,
    process: Option<CodexProcess>,
    candidate_version: String,
    model: String,
    working_directory: String,
    tools: BTreeMap<String, ToolAuthority>,
    operation_id: Option<OperationId>,
    pending_tool: Option<PendingTool>,
    thread_id: Option<String>,
    turn_id: Option<String>,
    startup_signal: Option<oneshot::Sender<()>>,
    terminal: bool,
}

#[derive(Debug)]
pub struct CodexOperation {
    operation_id: OperationId,
}

impl CodexAppServerGateway {
    pub(crate) fn new(
        config: CodexAppServerProcessConfig,
        model: String,
        startup_signal: oneshot::Sender<()>,
    ) -> Result<Self, CodexGatewayError> {
        if model.is_empty() || model.contains('\0') {
            return Err(CodexGatewayError::InvalidContext("model is invalid"));
        }
        let working_directory = config.working_directory.to_string_lossy().into_owned();
        Ok(Self {
            candidate_version: config.candidate_version.clone(),
            config: Some(config),
            process: None,
            model,
            working_directory,
            tools: BTreeMap::new(),
            operation_id: None,
            pending_tool: None,
            thread_id: None,
            turn_id: None,
            startup_signal: Some(startup_signal),
            terminal: false,
        })
    }

    async fn start_inner(
        &mut self,
        request: ProviderRequest,
    ) -> Result<CodexOperation, CodexGatewayError> {
        if self.terminal {
            return Err(CodexGatewayError::InvalidProtocol(
                "turn is already terminal",
            ));
        }
        if let Some(pending) = self.pending_tool.take() {
            let result = protocol::tool_result(&request.encoded_context, &pending)?;
            self.process_mut()?
                .respond(pending.request_id, result)
                .await?;
            self.operation_id = Some(request.operation_id.clone());
            return Ok(CodexOperation {
                operation_id: request.operation_id,
            });
        }
        if self.process.is_some() || self.operation_id.is_some() {
            return Err(CodexGatewayError::InvalidProtocol(
                "concurrent provider start",
            ));
        }
        let context = protocol::decode_context(&request.encoded_context)?;
        let config = self
            .config
            .take()
            .ok_or(CodexGatewayError::Spawn("process config was consumed"))?;
        let mut process = CodexProcess::spawn(config)?;
        if process.process_id().is_none() {
            return Err(CodexGatewayError::Spawn("process ID is unavailable"));
        }
        let startup_signal = self.startup_signal.take();
        process
            .request(
                "initialize",
                json!({
                    "clientInfo": {
                        "name": "codestudio_native_codex_adapter",
                        "title": "CodeStudio supervised Codex adapter",
                        "version": CLIENT_VERSION,
                    },
                    "capabilities": { "experimentalApi": true },
                }),
                move || {
                    if let Some(signal) = startup_signal {
                        let _ = signal.send(());
                    }
                },
            )
            .await?;
        process.notify("initialized", json!({})).await?;
        let thread = process
            .request(
                "thread/start",
                protocol::thread_start_params(&context, &self.working_directory, &self.model),
                || {},
            )
            .await?;
        if nested_text(&thread, "thread", "cliVersion")? != self.candidate_version {
            return Err(CodexGatewayError::InvalidProtocol(
                "candidate version does not match the sealed snapshot",
            ));
        }
        let thread_id = nested_id(&thread, "thread")?;
        let turn = process
            .request(
                "turn/start",
                protocol::turn_start_params(
                    &context,
                    &thread_id,
                    &self.working_directory,
                    &self.model,
                ),
                || {},
            )
            .await?;
        self.turn_id = Some(nested_id(&turn, "turn")?);
        self.thread_id = Some(thread_id);
        self.tools = context.tools;
        self.operation_id = Some(request.operation_id.clone());
        self.process = Some(process);
        Ok(CodexOperation {
            operation_id: request.operation_id,
        })
    }

    #[allow(
        clippy::needless_pass_by_ref_mut,
        reason = "ProviderGatewayPort requires mutable operation ownership"
    )]
    async fn next_inner(
        &mut self,
        operation: &mut CodexOperation,
    ) -> Result<Option<ProviderEvent>, CodexGatewayError> {
        if self.operation_id.as_ref() != Some(&operation.operation_id) {
            return Err(CodexGatewayError::InvalidProtocol(
                "provider operation mismatch",
            ));
        }
        loop {
            let message = self.process_mut()?.next_message().await?;
            let object = message
                .as_object()
                .ok_or(CodexGatewayError::InvalidProtocol(
                    "message is not an object",
                ))?;
            let method = object.get("method").and_then(Value::as_str);
            let request_id = object.get("id").cloned();
            match (method, request_id) {
                (Some(method), Some(request_id)) => {
                    if let Some(event) = self
                        .server_request(method, request_id, object.get("params"))
                        .await?
                    {
                        return Ok(Some(event));
                    }
                }
                (Some(method), None) => {
                    if let Some(event) = self.notification(method, object.get("params")).await? {
                        return Ok(Some(event));
                    }
                }
                _ => return Err(CodexGatewayError::InvalidProtocol("unexpected response")),
            }
        }
    }

    fn process_mut(&mut self) -> Result<&mut CodexProcess, CodexGatewayError> {
        self.process
            .as_mut()
            .ok_or(CodexGatewayError::InvalidProtocol("process is not active"))
    }
}

impl ProviderGatewayPort for CodexAppServerGateway {
    type Operation = CodexOperation;
    type Error = CodexGatewayError;

    fn start(
        &mut self,
        request: ProviderRequest,
    ) -> impl Future<Output = Result<Self::Operation, Self::Error>> + Send {
        self.start_inner(request)
    }

    fn next(
        &mut self,
        operation: &mut Self::Operation,
    ) -> impl Future<Output = Result<Option<ProviderEvent>, Self::Error>> + Send {
        self.next_inner(operation)
    }
}

fn nested_id(value: &Value, name: &str) -> Result<String, CodexGatewayError> {
    nested_text(value, name, "id").map(ToOwned::to_owned)
}

fn nested_text<'a>(
    value: &'a Value,
    object: &str,
    field: &str,
) -> Result<&'a str, CodexGatewayError> {
    value
        .get(object)
        .and_then(Value::as_object)
        .and_then(|object| object.get(field))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(CodexGatewayError::InvalidProtocol(
            "nested response text is missing",
        ))
}
