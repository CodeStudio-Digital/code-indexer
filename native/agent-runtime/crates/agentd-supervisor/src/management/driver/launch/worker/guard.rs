use std::thread::JoinHandle;

#[cold]
pub(super) fn fail_stop() -> ! {
    std::process::abort()
}

pub(super) fn reap_finished_or_fail_stop(thread: &mut Option<JoinHandle<()>>) {
    let Some(worker) = thread.as_ref() else {
        return;
    };
    if !worker.is_finished() {
        fail_stop();
    }
    let _ = thread
        .take()
        .expect("finished worker retains join ownership")
        .join();
}
