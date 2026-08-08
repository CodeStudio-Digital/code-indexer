use super::super::sample_current_process_resources;

#[test]
fn current_sample_reports_real_monotonic_counters_and_job_membership() {
    let first = sample_current_process_resources().expect("current process resources");
    let second = sample_current_process_resources().expect("second resource sample");

    assert!(first.resident_memory_bytes > 0);
    assert!(first.peak_resident_memory_bytes >= first.resident_memory_bytes);
    assert!(second.cpu_time_ms >= first.cpu_time_ms);
    assert!(first.open_handle_count > 0);
    assert!(first.process_count >= 1);
}
