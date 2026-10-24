use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use std::collections::HashMap;

#[napi(object)]
pub struct NativeDuplexOptions {
    pub executable: String,
    pub arguments: Vec<String>,
    pub cwd: String,
    pub environment: HashMap<String, String>,
    pub timeout_ms: u32,
    pub stream_stderr: Option<bool>,
    pub tty: Option<bool>,
    pub columns: Option<u16>,
    pub rows: Option<u16>,
}
#[napi(object)]
pub struct NativeDuplexOutput {
    pub bytes: Buffer,
    pub stderr: bool,
}
impl std::fmt::Debug for NativeDuplexOutput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativeDuplexOutput")
            .field("stderr", &self.stderr)
            .finish_non_exhaustive()
    }
}
impl std::fmt::Debug for NativeDuplexOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativeDuplexOptions")
            .finish_non_exhaustive()
    }
}
#[napi(object)]
pub struct NativeDuplexResult {
    pub process_id: u32,
    pub exit_code: u32,
    pub cancelled: bool,
    pub timed_out: bool,
    pub reaped: bool,
    pub stderr_head: Buffer,
    pub stderr_tail: Buffer,
    pub stderr_total_bytes: f64,
}
impl std::fmt::Debug for NativeDuplexResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativeDuplexResult")
            .field("reaped", &self.reaped)
            .finish_non_exhaustive()
    }
}
