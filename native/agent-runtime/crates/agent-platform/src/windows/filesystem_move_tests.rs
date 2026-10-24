use super::filesystem_move::rename_path_no_replace;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Barrier};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "native-move-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).expect("fixture");
        Self(path)
    }
    fn rename(&self, a: &str, b: &str) -> std::io::Result<()> {
        rename_path_no_replace(&self.0, Path::new(a), Path::new(b))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).expect("fixture cleanup");
    }
}

#[test]
fn files_and_nonempty_directories_move_without_overwrite() {
    let fixture = Fixture::new();
    std::fs::write(fixture.0.join("source.txt"), b"source").expect("source");
    std::fs::write(fixture.0.join("occupied.txt"), b"occupied").expect("destination");
    assert!(fixture.rename("source.txt", "occupied.txt").is_err());
    assert_eq!(
        std::fs::read(fixture.0.join("occupied.txt")).expect("preserved"),
        b"occupied"
    );
    std::fs::create_dir(fixture.0.join("folder")).expect("folder");
    fixture
        .rename("source.txt", "folder/moved.txt")
        .expect("file rename");
    fixture
        .rename("folder", "moved-folder")
        .expect("directory rename");
    assert_eq!(
        std::fs::read(fixture.0.join("moved-folder/moved.txt")).expect("moved"),
        b"source"
    );
    std::fs::create_dir(fixture.0.join("occupied-folder")).expect("occupied folder");
    assert!(fixture.rename("moved-folder", "occupied-folder").is_err());
    assert!(fixture.0.join("moved-folder/moved.txt").is_file());
}

#[test]
fn exactly_one_contender_claims_the_destination() {
    let fixture = Fixture::new();
    let barrier = Arc::new(Barrier::new(16));
    let mut threads = Vec::new();
    for number in 0..16 {
        let root = fixture.0.clone();
        let source = format!("source-{number}");
        std::fs::write(root.join(&source), source.as_bytes()).expect("contender");
        let barrier = Arc::clone(&barrier);
        threads.push(std::thread::spawn(move || {
            barrier.wait();
            rename_path_no_replace(&root, Path::new(&source), Path::new("winner")).is_ok()
        }));
    }
    let winners = threads
        .into_iter()
        .map(|thread| thread.join().expect("contender"))
        .filter(|won| *won)
        .count();
    assert_eq!(winners, 1);
    assert_eq!(std::fs::read_dir(&fixture.0).expect("entries").count(), 16);
}

#[test]
fn traversal_root_streams_and_win32_aliases_are_rejected() {
    let fixture = Fixture::new();
    std::fs::write(fixture.0.join("source"), b"source").expect("source");
    for invalid in [
        "",
        ".",
        "..",
        "../escape",
        "C:/escape",
        "source:stream",
        "NUL",
        "name.",
        "name ",
    ] {
        assert!(
            fixture.rename("source", invalid).is_err(),
            "accepted {invalid}"
        );
        assert!(
            fixture.rename(invalid, "destination").is_err(),
            "accepted source {invalid}"
        );
    }
    assert!(fixture.0.join("source").is_file());
}

#[test]
fn junction_parents_cannot_escape_the_root() {
    let fixture = Fixture::new();
    let outside = Fixture::new();
    // Windows directory junctions do not require symlink privilege.
    let status = std::process::Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(fixture.0.join("junction"))
        .arg(&outside.0)
        .output()
        .expect("junction command");
    assert!(status.status.success());
    std::fs::write(fixture.0.join("source"), b"source").expect("source");
    std::fs::write(outside.0.join("outside"), b"outside").expect("outside");
    assert!(fixture.rename("source", "junction/escaped").is_err());
    assert!(fixture.rename("junction/outside", "stolen").is_err());
    assert!(fixture.rename("junction", "moved-link").is_err());
    assert!(outside.0.join("outside").is_file());
    assert!(!outside.0.join("escaped").exists());
    std::fs::remove_dir(fixture.0.join("junction")).expect("unlink junction only");
}
