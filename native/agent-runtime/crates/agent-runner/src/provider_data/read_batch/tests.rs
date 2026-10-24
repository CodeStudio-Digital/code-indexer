use super::*;
use agent_protocol::testing::established_data_duplex;

fn fixture() -> (
    ProviderDataClient<tokio::io::DuplexStream>,
    wire::CapabilityReadBatchResult,
    wire::FrameHeader,
) {
    let identity = crate::provider_data::tests::identity();
    let (runner, _) = established_data_duplex(&identity).unwrap();
    let member = wire::CapabilityExecute {
        identity: Some(identity.clone()),
        runtime_instance_id: "runtime/read-batch".into(),
        operation_id: "capability/1".into(),
        tool_use_id: "tool/1".into(),
        grant_id: "grant/1".into(),
        effective_input_sha256: vec![1; 32],
        deadline_at_unix_ms: 1000,
    };
    let result = wire::CapabilityExecutionResult {
        identity: member.identity.clone(),
        runtime_instance_id: member.runtime_instance_id.clone(),
        operation_id: member.operation_id.clone(),
        tool_use_id: member.tool_use_id.clone(),
        grant_id: member.grant_id.clone(),
        outcome: Some(wire::capability_execution_result::Outcome::Failed(
            wire::CapabilityExecutionFailure {
                reason_code: "read_failed".into(),
                duration_ms: 1,
            },
        )),
    };
    let event = wire::CapabilityReadBatchResult {
        identity: Some(identity.clone()),
        runtime_instance_id: member.runtime_instance_id.clone(),
        batch_id: "batch/1".into(),
        result: Some(result),
    };
    let mut client = ProviderDataClient::new(runner, identity, member.runtime_instance_id.clone());
    client.read_batch = Some(ReadBatch {
        id: "batch/1".into(),
        members: vec![member],
        received: HashSet::new(),
        ready: VecDeque::new(),
        consumed: 0,
    });
    (client, event, wire::FrameHeader::default())
}

#[test]
fn rejects_foreign_duplicate_or_corrupt_read_completion() {
    for field in 0..8 {
        let (mut client, mut event, mut header) = fixture();
        match field {
            0 => event.batch_id = "foreign".into(),
            1 => event.runtime_instance_id = "foreign".into(),
            2 => event.identity.as_mut().unwrap().fencing_epoch += 1,
            3 => event.result.as_mut().unwrap().grant_id = "foreign".into(),
            4 => event.result.as_mut().unwrap().operation_id = "foreign".into(),
            5 => event.result.as_mut().unwrap().tool_use_id = "foreign".into(),
            6 => event.result.as_mut().unwrap().outcome = None,
            _ => header.reply_to_message_id = Some("unsolicited-only".into()),
        }
        assert!(client.buffer_read_result(event, &header).is_err());
        assert!(client.read_batch.unwrap().ready.is_empty());
    }
    let (mut client, event, header) = fixture();
    client.buffer_read_result(event.clone(), &header).unwrap();
    assert!(client.buffer_read_result(event, &header).is_err());
    assert_eq!(client.read_batch.unwrap().ready.len(), 1);
}

#[tokio::test]
async fn consumes_buffered_completion_once_and_releases_window() {
    let (mut client, event, header) = fixture();
    client.buffer_read_result(event, &header).unwrap();
    let timing = ProviderDataTiming {
        settlement_deadline_at_unix_ms: 2_000,
        hard_deadline: tokio::time::Instant::now() + std::time::Duration::from_secs(1),
        replay_write_timeout: std::time::Duration::from_millis(100),
    };
    assert_eq!(
        client
            .next_read_result(timing, &|| 20)
            .await
            .unwrap()
            .operation_id,
        "capability/1"
    );
    assert!(client.read_batch.is_none());
    assert!(client.next_read_result(timing, &|| 20).await.is_err());
}
