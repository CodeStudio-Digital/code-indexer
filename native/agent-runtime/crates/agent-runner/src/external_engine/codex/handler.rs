use agent_engine::ports::ProviderEvent;
use serde_json::{Map, Value, json};

use super::CodexAppServerGateway;
use super::error::CodexGatewayError;
use super::protocol;

const BYPASS_ITEM_TYPES: &[&str] = &[
    "commandExecution",
    "fileChange",
    "mcpToolCall",
    "collabToolCall",
    "webSearch",
];

impl CodexAppServerGateway {
    pub(super) async fn server_request(
        &mut self,
        method: &str,
        request_id: Value,
        params: Option<&Value>,
    ) -> Result<Option<ProviderEvent>, CodexGatewayError> {
        let params =
            params
                .and_then(Value::as_object)
                .ok_or(CodexGatewayError::InvalidProtocol(
                    "request params are invalid",
                ))?;
        self.validate_correlation(params)?;
        if method == "item/tool/call" {
            if self.pending_tool.is_some() {
                self.process_mut()?
                    .reject(request_id, -32_601, "Concurrent tool request")
                    .await?;
                return Ok(Some(self.provider_failure("codex_concurrent_tool_request")));
            }
            let operation =
                self.operation_id
                    .as_ref()
                    .ok_or(CodexGatewayError::InvalidProtocol(
                        "provider operation is missing",
                    ))?;
            let parsed =
                protocol::parse_tool_call(request_id.clone(), params, operation, &self.tools);
            let Ok((call, pending)) = parsed else {
                self.process_mut()?
                    .reject(
                        request_id,
                        -32_601,
                        "Tool request is outside attempt authority",
                    )
                    .await?;
                return Ok(Some(self.provider_failure("codex_tool_request_rejected")));
            };
            self.pending_tool = Some(pending);
            return Ok(Some(ProviderEvent::ToolCall(call)));
        }
        let result = match method {
            "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                json!({ "decision": "decline" })
            }
            "item/permissions/requestApproval" => {
                json!({ "scope": "turn", "permissions": {} })
            }
            "mcpServer/elicitation/request" => json!({ "action": "decline", "content": null }),
            _ => {
                self.process_mut()?
                    .reject(request_id, -32_601, "Unsupported server request")
                    .await?;
                return Ok(Some(self.provider_failure("codex_server_request_rejected")));
            }
        };
        self.process_mut()?.respond(request_id, result).await?;
        Ok(None)
    }

    pub(super) async fn notification(
        &mut self,
        method: &str,
        params: Option<&Value>,
    ) -> Result<Option<ProviderEvent>, CodexGatewayError> {
        let params = params.and_then(Value::as_object);
        if let Some(params) = params {
            self.validate_optional_correlation(params)?;
        }
        match method {
            "item/agentMessage/delta" => Ok(optional_delta(params).map(ProviderEvent::TextDelta)),
            value if value.starts_with("item/reasoning/") && value.ends_with("Delta") => {
                Ok(optional_delta(params).map(ProviderEvent::ThinkingDelta))
            }
            "item/started" => {
                let item_type = params
                    .and_then(|value| value.get("item"))
                    .and_then(Value::as_object)
                    .and_then(|item| item.get("type"))
                    .and_then(Value::as_str);
                if item_type.is_some_and(|value| BYPASS_ITEM_TYPES.contains(&value)) {
                    return Ok(Some(self.provider_failure("codex_builtin_bypass_observed")));
                }
                Ok(None)
            }
            "turn/completed" => self.complete_turn(params).await.map(Some),
            _ => Ok(None),
        }
    }

    async fn complete_turn(
        &mut self,
        params: Option<&Map<String, Value>>,
    ) -> Result<ProviderEvent, CodexGatewayError> {
        let turn = params
            .and_then(|value| value.get("turn"))
            .and_then(Value::as_object)
            .ok_or(CodexGatewayError::InvalidProtocol(
                "terminal turn is missing",
            ))?;
        self.bind_turn(text(turn, "id")?)?;
        let status = text(turn, "status")?;
        let thread_id = self
            .thread_id
            .clone()
            .ok_or(CodexGatewayError::InvalidProtocol("thread is not bound"))?;
        self.process_mut()?
            .request("thread/delete", json!({ "threadId": thread_id }), || {})
            .await?;
        self.terminal = true;
        match status {
            "completed" => Ok(ProviderEvent::Completed {
                response_id: Some(format!(
                    "codex-turn:{}",
                    self.turn_id.as_deref().unwrap_or("unknown")
                )),
                response_message_count: None,
            }),
            "interrupted" => Ok(ProviderEvent::Interrupted {
                reason_code: "codex_turn_interrupted".into(),
            }),
            "failed" => Ok(ProviderEvent::Failed {
                reason_code: "codex_turn_failed".into(),
            }),
            _ => Err(CodexGatewayError::InvalidProtocol(
                "terminal status is invalid",
            )),
        }
    }

    fn validate_correlation(
        &mut self,
        params: &Map<String, Value>,
    ) -> Result<(), CodexGatewayError> {
        self.bind_thread(text(params, "threadId")?)?;
        self.bind_turn(text(params, "turnId")?)
    }

    fn validate_optional_correlation(
        &mut self,
        params: &Map<String, Value>,
    ) -> Result<(), CodexGatewayError> {
        if let Some(value) = params.get("threadId").and_then(Value::as_str) {
            self.bind_thread(value)?;
        }
        if let Some(value) = params.get("turnId").and_then(Value::as_str) {
            self.bind_turn(value)?;
        }
        Ok(())
    }

    fn bind_thread(&mut self, value: &str) -> Result<(), CodexGatewayError> {
        bind(&mut self.thread_id, value)
    }

    fn bind_turn(&mut self, value: &str) -> Result<(), CodexGatewayError> {
        bind(&mut self.turn_id, value)
    }

    fn provider_failure(&mut self, reason_code: &str) -> ProviderEvent {
        self.terminal = true;
        ProviderEvent::Failed {
            reason_code: reason_code.to_owned(),
        }
    }
}

fn optional_delta(params: Option<&Map<String, Value>>) -> Option<String> {
    params
        .and_then(|value| value.get("delta").or_else(|| value.get("text")))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn text<'a>(value: &'a Map<String, Value>, name: &str) -> Result<&'a str, CodexGatewayError> {
    value
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(CodexGatewayError::InvalidProtocol(
            "required text field is missing",
        ))
}

fn bind(target: &mut Option<String>, value: &str) -> Result<(), CodexGatewayError> {
    if value.is_empty() || target.as_ref().is_some_and(|current| current != value) {
        return Err(CodexGatewayError::InvalidProtocol("correlation mismatch"));
    }
    if target.is_none() {
        *target = Some(value.to_owned());
    }
    Ok(())
}
