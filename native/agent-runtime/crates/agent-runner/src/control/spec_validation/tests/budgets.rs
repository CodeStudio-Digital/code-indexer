use super::super::SpecValidationError;

use super::support::{resource_budget, valid_spec, validate, validate_with_spec_identity};

#[test]
fn resource_budget_is_required_complete_and_equal_to_launch() {
    let mut spec = valid_spec();
    spec.resource_budget = None;
    assert_eq!(
        validate(spec).unwrap_err(),
        SpecValidationError::MissingResourceBudget
    );

    let mut spec = valid_spec();
    spec.resource_budget.as_mut().expect("budget").max_threads = 0;
    assert_eq!(
        validate(spec).unwrap_err(),
        SpecValidationError::InvalidResourceBudget("max_threads")
    );

    let mut spec = valid_spec();
    spec.resource_budget
        .as_mut()
        .expect("budget")
        .hard_memory_bytes += 1;
    assert_eq!(
        validate(spec).unwrap_err(),
        SpecValidationError::LaunchBudgetMismatch
    );
}

#[test]
fn resource_budget_relationships_fail_closed() {
    let mut spec = valid_spec();
    let budget = spec.resource_budget.as_mut().expect("budget");
    budget.soft_memory_bytes = budget.hard_memory_bytes + 1;
    assert!(matches!(
        validate(spec),
        Err(SpecValidationError::InvalidResourceBudget(_))
    ));

    let mut spec = valid_spec();
    let budget = spec.resource_budget.as_mut().expect("budget");
    budget.max_artifact_bytes = budget.max_spool_bytes + 1;
    assert!(matches!(
        validate(spec),
        Err(SpecValidationError::InvalidResourceBudget(_))
    ));

    let mut spec = valid_spec();
    let budget = spec.resource_budget.as_mut().expect("budget");
    budget.cancel_grace_ms = budget.max_wall_ms + 1;
    assert!(matches!(
        validate(spec),
        Err(SpecValidationError::InvalidResourceBudget(_))
    ));
}

#[test]
fn run_tree_budget_is_explicit_positive_and_covers_depth() {
    let mut spec = valid_spec();
    spec.run_tree_budget = None;
    assert_eq!(
        validate(spec).unwrap_err(),
        SpecValidationError::MissingRunTreeBudget
    );

    let mut spec = valid_spec();
    spec.run_tree_budget.as_mut().expect("tree").max_turns = Some(0);
    assert_eq!(
        validate(spec).unwrap_err(),
        SpecValidationError::InvalidRunTreeBudget("max_turns")
    );

    let mut spec = valid_spec();
    spec.run_tree_budget.as_mut().expect("tree").max_agents = None;
    assert!(matches!(
        validate(spec),
        Err(SpecValidationError::InvalidRunTreeBudget(_))
    ));

    let mut spec = valid_spec();
    spec.spawn_depth = 5;
    let identity = spec.identity.as_mut().expect("identity");
    identity.agent_run_id = "66666666-6666-4666-8666-666666666666".to_owned();
    identity.owner_agent_run_id = Some("33333333-3333-4333-8333-333333333333".to_owned());
    identity.parent_agent_run_id = Some("33333333-3333-4333-8333-333333333333".to_owned());
    assert_eq!(
        validate_with_spec_identity(spec).unwrap_err(),
        SpecValidationError::RunTreeDepthExceeded {
            spawn_depth: 5,
            maximum: 4,
        }
    );
}

#[test]
fn run_tree_wall_and_cost_pair_are_coherent() {
    let mut spec = valid_spec();
    spec.run_tree_budget.as_mut().expect("tree").max_wall_ms =
        Some(resource_budget().max_wall_ms - 1);
    assert_eq!(
        validate(spec).unwrap_err(),
        SpecValidationError::RunTreeWallBelowAttempt
    );

    let mut spec = valid_spec();
    spec.run_tree_budget.as_mut().expect("tree").cost_currency = None;
    assert!(matches!(
        validate(spec),
        Err(SpecValidationError::InvalidRunTreeBudget(_))
    ));

    let mut spec = valid_spec();
    spec.run_tree_budget.as_mut().expect("tree").cost_currency = Some("usd".to_owned());
    assert!(matches!(
        validate(spec),
        Err(SpecValidationError::InvalidRunTreeBudget(_))
    ));
}
