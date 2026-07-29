use std::io::{Read, Write};
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::control::{
    ControlDriverEvent, EffectivePreparedFacts, PrepareOutcome, RunnerBootstrapDriver,
};

use super::fixture::{agent_hello_draft, containment_report, launch_authority, resource_budget};

pub(super) fn run(
    reader: impl Read,
    writer: impl Write,
    deadline_at_unix_ms: i64,
) -> Result<(), String> {
    let (launch, nonce) = launch_authority(deadline_at_unix_ms)?;
    let bootstrap = RunnerBootstrapDriver::from_validated_launch(reader, writer, launch)
        .map_err(|error| format!("bootstrap construction failed: {error}"))?;
    let mut driver = bootstrap
        .establish_with_nonce(agent_hello_draft(), nonce)
        .map_err(|error| format!("bootstrap negotiation failed: {error}"))?;
    let event = driver
        .receive_next()
        .map_err(|error| format!("prepare receive failed: {error}"))?;
    let ControlDriverEvent::Prepare(PrepareOutcome::HydrationRequired(token)) = event else {
        return Err("probe did not receive fresh PrepareAttempt".into());
    };
    std::thread::sleep(Duration::from_millis(2));
    let ready_at_unix_ms = unix_ms()?.saturating_sub(1);
    let facts = EffectivePreparedFacts::from_verified_platform(
        token.expected_snapshots().to_vec(),
        token.expected_artifacts().to_vec(),
        resource_budget(),
        containment_report(),
        ready_at_unix_ms,
    );
    driver
        .finish_prepare(token, facts)
        .map_err(|error| format!("AttemptPrepared commit failed: {error}"))
}

fn unix_ms() -> Result<i64, String> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock is before Unix epoch")?;
    i64::try_from(elapsed.as_millis()).map_err(|_| "system clock exceeds i64".into())
}
