use super::*;
use agent_engine::operation::OperationId;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

fn read_call() -> ProviderToolCall {
    ProviderToolCall {
        operation_id: OperationId::new("provider/1").unwrap(),
        tool_use_id: OperationId::new("tool/1").unwrap(),
        capability_name: "read_file".into(),
        capability_id: "native.read_file".into(),
        capability_version: "1".into(),
        execution_class: ExecutionClass::NativeRead,
        mutates: false,
        parallel_safe: true,
        read_only: true,
        encoded_arguments: b"{}".to_vec(),
        arguments_sha256: [1; 32],
        provider_response_id: None,
        provider_response_message_count: None,
    }
}

#[test]
fn safe_reads_are_bounded_and_every_other_class_is_a_barrier() {
    let read = read_call();
    assert_eq!(window_size(&vec![read.clone(); 7]), 4);
    let mut host_read = read.clone();
    host_read.execution_class = ExecutionClass::HostCapability;
    assert_eq!(window_size(&vec![host_read.clone(); 7]), 4);
    assert_eq!(window_size(&[host_read, read.clone()]), 1);
    for (class, mutates, parallel_safe, read_only) in [
        (ExecutionClass::NativeRead, true, true, true),
        (ExecutionClass::NativeRead, false, false, true),
        (ExecutionClass::HostCapability, false, true, false),
        (ExecutionClass::NativeProcess, false, true, true),
        (ExecutionClass::ControlInteractive, false, true, true),
        (ExecutionClass::NativeMutation, false, true, true),
    ] {
        let mut barrier = read.clone();
        barrier.execution_class = class;
        barrier.mutates = mutates;
        barrier.parallel_safe = parallel_safe;
        barrier.read_only = read_only;
        assert_eq!(
            window_size(&[read.clone(), read.clone(), barrier.clone(), read.clone()]),
            2
        );
        assert_eq!(window_size(&[barrier, read.clone()]), 1);
    }
}

#[tokio::test]
async fn overlaps_reads_and_preserves_model_order_after_out_of_order_completion() {
    let running = Arc::new(AtomicUsize::new(0));
    let maximum = Arc::new(AtomicUsize::new(0));
    let completed = Arc::new(Mutex::new(Vec::new()));
    let futures = [40, 5, 20, 10]
        .into_iter()
        .enumerate()
        .map(|(index, delay)| {
            let (running, maximum, completed) =
                (running.clone(), maximum.clone(), completed.clone());
            async move {
                let active = running.fetch_add(1, Ordering::SeqCst) + 1;
                maximum.fetch_max(active, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(delay)).await;
                completed.lock().await.push(index);
                running.fetch_sub(1, Ordering::SeqCst);
                Ok(index)
            }
        })
        .collect();
    assert_eq!(collect_ordered(futures).await.unwrap(), vec![0, 1, 2, 3]);
    assert_eq!(maximum.load(Ordering::SeqCst), 4);
    assert_eq!(completed.lock().await.first(), Some(&1));
}

#[tokio::test]
async fn drains_started_members_after_failure_without_resubmitting() {
    let finished = Arc::new(AtomicUsize::new(0));
    let futures = (0..4)
        .map(|index| {
            let finished = finished.clone();
            async move {
                tokio::time::sleep(Duration::from_millis(index * 3)).await;
                finished.fetch_add(1, Ordering::SeqCst);
                if index == 0 {
                    Err(ActiveEngineError::CapabilityExecutionFailed)
                } else {
                    Ok(index)
                }
            }
        })
        .collect();
    assert!(collect_ordered(futures).await.is_err());
    assert_eq!(finished.load(Ordering::SeqCst), 4);
}
