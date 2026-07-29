use agent_protocol::generated::v1 as wire;

use super::SpecValidationError;
use super::text::validate_text;

pub(super) fn validate_resource_budget(
    budget: &wire::ResourceBudget,
) -> Result<(), SpecValidationError> {
    for (field, value) in resource_budget_values(budget) {
        if value == 0 {
            return Err(SpecValidationError::InvalidResourceBudget(field));
        }
    }
    if budget.soft_memory_bytes > budget.hard_memory_bytes {
        return Err(SpecValidationError::InvalidResourceBudget(
            "soft_memory_bytes exceeds hard_memory_bytes",
        ));
    }
    if budget.max_artifact_bytes > budget.max_spool_bytes {
        return Err(SpecValidationError::InvalidResourceBudget(
            "max_artifact_bytes exceeds max_spool_bytes",
        ));
    }
    if budget.cancel_grace_ms > budget.max_wall_ms {
        return Err(SpecValidationError::InvalidResourceBudget(
            "cancel_grace_ms exceeds max_wall_ms",
        ));
    }
    Ok(())
}

pub(super) fn validate_run_tree_budget(
    budget: Option<&wire::AgentRunBudget>,
    attempt_budget: &wire::ResourceBudget,
    spawn_depth: u32,
) -> Result<(), SpecValidationError> {
    let budget = budget.ok_or(SpecValidationError::MissingRunTreeBudget)?;
    let numeric = [
        ("max_turns", budget.max_turns),
        ("max_wall_ms", budget.max_wall_ms),
        ("max_input_tokens", budget.max_input_tokens),
        ("max_output_tokens", budget.max_output_tokens),
        ("max_tool_calls", budget.max_tool_calls),
        ("max_agents", budget.max_agents.map(u64::from)),
        ("max_depth", budget.max_depth.map(u64::from)),
        ("max_cost_micros", budget.max_cost_micros),
    ];
    if numeric.iter().all(|(_, value)| value.is_none()) {
        return Err(SpecValidationError::InvalidRunTreeBudget(
            "at least one explicit limit is required",
        ));
    }
    if let Some((field, _)) = numeric
        .into_iter()
        .find(|(_, value)| matches!(value, Some(0)))
    {
        return Err(SpecValidationError::InvalidRunTreeBudget(field));
    }

    let max_agents = budget
        .max_agents
        .ok_or(SpecValidationError::InvalidRunTreeBudget(
            "max_agents is required in V1",
        ))?;
    let max_depth = budget
        .max_depth
        .ok_or(SpecValidationError::InvalidRunTreeBudget(
            "max_depth is required in V1",
        ))?;
    if max_agents == 0 || max_depth == 0 {
        return Err(SpecValidationError::InvalidRunTreeBudget(
            "agent and depth limits must be positive",
        ));
    }
    if spawn_depth > max_depth {
        return Err(SpecValidationError::RunTreeDepthExceeded {
            spawn_depth,
            maximum: max_depth,
        });
    }
    if budget
        .max_wall_ms
        .is_some_and(|maximum| attempt_budget.max_wall_ms > maximum)
    {
        return Err(SpecValidationError::RunTreeWallBelowAttempt);
    }
    validate_cost_pair(budget)
}

fn validate_cost_pair(budget: &wire::AgentRunBudget) -> Result<(), SpecValidationError> {
    match (budget.max_cost_micros, budget.cost_currency.as_deref()) {
        (None, None) => Ok(()),
        (Some(_), Some(currency)) => {
            validate_text("run_tree_budget.cost_currency", currency, 16)?;
            if !currency
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
            {
                return Err(SpecValidationError::InvalidRunTreeBudget(
                    "cost_currency must use uppercase ASCII letters or digits",
                ));
            }
            Ok(())
        }
        _ => Err(SpecValidationError::InvalidRunTreeBudget(
            "max_cost_micros and cost_currency must be specified together",
        )),
    }
}

fn resource_budget_values(budget: &wire::ResourceBudget) -> [(&'static str, u64); 15] {
    [
        ("soft_memory_bytes", budget.soft_memory_bytes),
        ("hard_memory_bytes", budget.hard_memory_bytes),
        ("cpu_time_ms", budget.cpu_time_ms),
        ("max_wall_ms", budget.max_wall_ms),
        ("max_processes", u64::from(budget.max_processes)),
        ("max_threads", u64::from(budget.max_threads)),
        ("max_open_handles", u64::from(budget.max_open_handles)),
        ("max_hot_transcript_bytes", budget.max_hot_transcript_bytes),
        ("max_ipc_frames", u64::from(budget.max_ipc_frames)),
        ("max_ipc_bytes", budget.max_ipc_bytes),
        ("max_spool_bytes", budget.max_spool_bytes),
        ("max_artifact_bytes", budget.max_artifact_bytes),
        (
            "max_concurrent_tools",
            u64::from(budget.max_concurrent_tools),
        ),
        ("max_blocking_tasks", u64::from(budget.max_blocking_tasks)),
        ("cancel_grace_ms", budget.cancel_grace_ms),
    ]
}
