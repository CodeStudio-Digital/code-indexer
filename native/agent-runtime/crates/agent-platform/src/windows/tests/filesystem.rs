use std::path::Path;

use super::super::filesystem::read_file_within_root;

#[test]
fn bounded_read_uses_a_final_handle_and_never_accepts_traversal() {
    let root = std::env::temp_dir().join(format!(
        "codestudio-native-read-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos(),
    ));
    std::fs::create_dir_all(&root).expect("temp root");
    std::fs::write(root.join("sample.txt"), b"abcdef").expect("fixture");
    let read = read_file_within_root(&root, Path::new("sample.txt"), 1, 3).expect("bounded read");
    assert_eq!(read.content, b"bcd");
    assert_eq!(read.bytes_read, 4);
    assert!(read.truncated);
    assert!(!read.eof);
    assert!(read_file_within_root(&root, Path::new("../sample.txt"), 0, 3).is_err());
    std::fs::remove_dir_all(root).expect("temp cleanup");
}
