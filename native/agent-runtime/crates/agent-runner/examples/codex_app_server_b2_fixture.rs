//! Deterministic app-server peer for the physical Codex B2 negative matrix.
//!
//! This binary is a test example, never part of the packaged runtime. The
//! scenario is selected by the sealed working-directory basename so the
//! production launcher keeps its fixed argv and environment allowlist.

use std::error::Error;
use std::io::{self, BufRead, Write};

use serde_json::{Value, json};

const VERSION: &str = "b2-fixture-v1";
const THREAD_ID: &str = "fixture-thread";
const TURN_ID: &str = "fixture-turn";
const TOOL_REQUEST_ID: u64 = 701;
const UNKNOWN_TOOL_REQUEST_ID: u64 = 702;
const LARGE_DELTA_BYTES: usize = 900 * 1_024;
const LARGE_DELTA_COUNT: usize = 10;
const MAX_INPUT_LINE_BYTES: usize = 2 * 1_024 * 1_024;

fn main() -> Result<(), Box<dyn Error>> {
    validate_arguments()?;
    let scenario = std::env::current_dir()?
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("fixture working directory has no basename")?
        .to_owned();
    let mut input = io::BufReader::new(io::stdin());
    let mut output = io::BufWriter::new(io::stdout());
    let mut line = String::new();
    loop {
        line.clear();
        if input.read_line(&mut line)? == 0 {
            return Ok(());
        }
        if line.len() > MAX_INPUT_LINE_BYTES {
            return Err("fixture input line limit exceeded".into());
        }
        let message: Value = serde_json::from_str(line.trim_end())?;
        handle_message(&scenario, &message, &mut output)?;
    }
}

fn handle_message(
    scenario: &str,
    message: &Value,
    output: &mut impl Write,
) -> Result<(), Box<dyn Error>> {
    let method = message.get("method").and_then(Value::as_str);
    let id = message.get("id").cloned();
    match (method, id) {
        (Some("initialize"), Some(_)) if scenario.contains("hang-initialize") => {}
        (Some("initialize" | "thread/delete"), Some(id)) => {
            respond(output, &id, &json!({}))?;
        }
        (Some("thread/start"), Some(id)) => respond(
            output,
            &id,
            &json!({ "thread": { "id": THREAD_ID, "cliVersion": VERSION } }),
        )?,
        (Some("turn/start"), Some(id)) => {
            respond(output, &id, &json!({ "turn": { "id": TURN_ID } }))?;
            start_scenario(scenario, output)?;
        }
        (None, Some(id)) if id == json!(TOOL_REQUEST_ID) => {
            if scenario.contains("ack-lost-after-tool") {
                return Err("fixture dropped the transport after tool result delivery".into());
            }
            let succeeded = message
                .get("result")
                .and_then(|result| result.get("success"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let status = if scenario.contains("tool-output-limit") || succeeded {
                "completed"
            } else {
                "failed"
            };
            terminal(output, status)?;
        }
        (None, Some(id)) if id == json!(UNKNOWN_TOOL_REQUEST_ID) => {}
        _ => {}
    }
    Ok(())
}

fn start_scenario(scenario: &str, output: &mut impl Write) -> Result<(), Box<dyn Error>> {
    if scenario.contains("unknown-tool") {
        return request_tool(
            output,
            UNKNOWN_TOOL_REQUEST_ID,
            "outside_snapshot",
            &json!({ "path": "sample.txt" }),
        );
    }
    if scenario.contains("builtin-bypass") {
        return send(
            output,
            &json!({
                "method": "item/started",
                "params": correlation(&json!({ "item": { "type": "commandExecution" } })),
            }),
        );
    }
    if scenario.contains("correlation-mismatch") {
        return send(
            output,
            &json!({
                "method": "item/agentMessage/delta",
                "params": {
                    "threadId": "foreign-thread",
                    "turnId": TURN_ID,
                    "delta": "must be rejected",
                },
            }),
        );
    }
    if scenario.contains("large-provider-output") {
        let delta = "x".repeat(LARGE_DELTA_BYTES);
        for _ in 0..LARGE_DELTA_COUNT {
            send(
                output,
                &json!({
                    "method": "item/agentMessage/delta",
                    "params": correlation(&json!({ "delta": delta })),
                }),
            )?;
        }
        return Ok(());
    }
    if scenario.contains("mutating-ack-loss") {
        return request_tool(
            output,
            TOOL_REQUEST_ID,
            "mutation_probe",
            &json!({ "path": "mutation-probe.txt", "token": "b2-fixture-mutation-v1" }),
        );
    }
    if scenario.contains("tool-output-limit")
        || scenario.contains("ack-lost-after-tool")
        || scenario.contains("read-success")
    {
        return request_tool(
            output,
            TOOL_REQUEST_ID,
            "read_file",
            &json!({ "path": "sample.txt" }),
        );
    }
    if scenario.contains("hang-turn") {
        return Ok(());
    }
    terminal(output, "completed")
}

fn request_tool(
    output: &mut impl Write,
    id: u64,
    tool: &str,
    arguments: &Value,
) -> Result<(), Box<dyn Error>> {
    send(
        output,
        &json!({
            "id": id,
            "method": "item/tool/call",
            "params": correlation(&json!({
                "callId": format!("fixture-call-{id}"),
                "namespace": "codestudio",
                "tool": tool,
                "arguments": arguments,
            })),
        }),
    )
}

fn terminal(output: &mut impl Write, status: &str) -> Result<(), Box<dyn Error>> {
    send(
        output,
        &json!({
            "method": "turn/completed",
            "params": {
                "threadId": THREAD_ID,
                "turn": { "id": TURN_ID, "status": status },
            },
        }),
    )
}

fn correlation(extra: &Value) -> Value {
    let mut object = extra.as_object().cloned().unwrap_or_default();
    object.insert("threadId".into(), json!(THREAD_ID));
    object.insert("turnId".into(), json!(TURN_ID));
    Value::Object(object)
}

fn respond(output: &mut impl Write, id: &Value, result: &Value) -> Result<(), Box<dyn Error>> {
    send(output, &json!({ "id": id, "result": result }))
}

fn send(output: &mut impl Write, value: &Value) -> Result<(), Box<dyn Error>> {
    serde_json::to_writer(&mut *output, value)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}

fn validate_arguments() -> Result<(), Box<dyn Error>> {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    if arguments.first().map(String::as_str) != Some("app-server")
        || !arguments.iter().any(|argument| argument == "--stdio")
    {
        return Err("fixture requires the production app-server argv".into());
    }
    Ok(())
}
