use std::fs::{self, DirBuilder};
use std::io;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};

use crate::ipc::{EndpointName, ProtectedEndpointError, ProtectedEndpointFailure};

const PRIVATE_DIRECTORY_MODE: u32 = 0o700;
const PRIVATE_SOCKET_MODE: u32 = 0o600;
/// Conservative common bound below Linux (108) and macOS (104) `sun_path`.
const MAX_SOCKET_PATH_BYTES_WITH_NUL: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

impl FileIdentity {
    fn from_metadata(metadata: &fs::Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
        }
    }
}

#[derive(Debug)]
pub(super) struct EndpointPathOwner {
    directory: PathBuf,
    socket: PathBuf,
    directory_identity: FileIdentity,
    socket_identity: Option<FileIdentity>,
    owner_user_id: u32,
    active: bool,
}

impl EndpointPathOwner {
    pub(super) fn create(root: &Path, name: &EndpointName) -> Result<Self, ProtectedEndpointError> {
        let root = validate_root(root)?;
        let directory = root.join(name.as_str());
        let socket = directory.join("endpoint.sock");
        validate_socket_path(&socket)?;
        let mut builder = DirBuilder::new();
        builder.mode(PRIVATE_DIRECTORY_MODE);
        builder
            .create(&directory)
            .map_err(|source| ProtectedEndpointError::io("create local IPC directory", source))?;
        let metadata = fs::symlink_metadata(&directory)
            .map_err(|source| ProtectedEndpointError::io("inspect local IPC directory", source))?;
        let mode = metadata.mode() & 0o777;
        if !metadata.file_type().is_dir() || mode != PRIVATE_DIRECTORY_MODE {
            let _ = fs::remove_dir(&directory);
            return Err(ProtectedEndpointError::PermissionNotProven {
                object: "local IPC directory",
                expected: PRIVATE_DIRECTORY_MODE,
                actual: mode,
            });
        }
        let owner = Self {
            directory,
            socket,
            directory_identity: FileIdentity::from_metadata(&metadata),
            socket_identity: None,
            owner_user_id: metadata.uid(),
            active: true,
        };
        let root_owner = fs::symlink_metadata(&root)
            .map_err(|source| ProtectedEndpointError::io("reinspect local IPC root", source))?
            .uid();
        if root_owner != owner.owner_user_id {
            return Err(ProtectedEndpointError::InvalidRoot(
                "root and endpoint directory owners differ",
            ));
        }
        Ok(owner)
    }

    pub(super) fn socket_path(&self) -> &Path {
        self.socket.as_path()
    }

    pub(super) const fn owner_user_id(&self) -> u32 {
        self.owner_user_id
    }

    pub(super) fn prove_bound_socket(&mut self) -> Result<(), ProtectedEndpointError> {
        let initial = fs::symlink_metadata(&self.socket)
            .map_err(|source| ProtectedEndpointError::io("inspect Unix socket", source))?;
        if !initial.file_type().is_socket() || initial.uid() != self.owner_user_id {
            return Err(ProtectedEndpointError::InvalidRoot(
                "bound socket identity does not match its endpoint directory",
            ));
        }
        let identity = FileIdentity::from_metadata(&initial);
        self.socket_identity = Some(identity);
        fs::set_permissions(
            &self.socket,
            fs::Permissions::from_mode(PRIVATE_SOCKET_MODE),
        )
        .map_err(|source| ProtectedEndpointError::io("chmod Unix socket", source))?;
        let metadata = fs::symlink_metadata(&self.socket)
            .map_err(|source| ProtectedEndpointError::io("inspect Unix socket", source))?;
        let mode = metadata.mode() & 0o777;
        if !metadata.file_type().is_socket()
            || FileIdentity::from_metadata(&metadata) != identity
            || mode != PRIVATE_SOCKET_MODE
        {
            return Err(ProtectedEndpointError::PermissionNotProven {
                object: "Unix socket",
                expected: PRIVATE_SOCKET_MODE,
                actual: mode,
            });
        }
        if metadata.uid() != self.owner_user_id {
            return Err(ProtectedEndpointError::InvalidRoot(
                "socket and endpoint directory owners differ",
            ));
        }
        Ok(())
    }

    fn cleanup(&mut self) -> Result<(), ProtectedEndpointError> {
        if !self.active {
            return Ok(());
        }
        if let Some(expected) = self.socket_identity {
            match fs::symlink_metadata(&self.socket) {
                Ok(metadata)
                    if metadata.file_type().is_socket()
                        && FileIdentity::from_metadata(&metadata) == expected =>
                {
                    fs::remove_file(&self.socket).map_err(|source| {
                        ProtectedEndpointError::io("unlink Unix socket", source)
                    })?;
                }
                Ok(_) => return Err(ProtectedEndpointError::CleanupIdentityMismatch),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(source) => {
                    return Err(ProtectedEndpointError::io(
                        "reinspect Unix socket for cleanup",
                        source,
                    ));
                }
            }
        }
        let directory = fs::symlink_metadata(&self.directory);
        match directory {
            Ok(metadata)
                if metadata.file_type().is_dir()
                    && FileIdentity::from_metadata(&metadata) == self.directory_identity =>
            {
                fs::remove_dir(&self.directory).map_err(|source| {
                    ProtectedEndpointError::io("remove local IPC directory", source)
                })?;
            }
            Ok(_) => return Err(ProtectedEndpointError::CleanupIdentityMismatch),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(source) => {
                return Err(ProtectedEndpointError::io(
                    "reinspect local IPC directory for cleanup",
                    source,
                ));
            }
        }
        self.active = false;
        Ok(())
    }
}

impl Drop for EndpointPathOwner {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

#[derive(Debug)]
pub struct UnixEndpointCleanup {
    owner: Box<EndpointPathOwner>,
}

impl UnixEndpointCleanup {
    pub(super) fn new(owner: EndpointPathOwner) -> Self {
        Self {
            owner: Box::new(owner),
        }
    }

    /// Retries conditional cleanup without ever deleting a replacement.
    ///
    /// # Errors
    ///
    /// Returns the same cleanup owner when identity or removal cannot be
    /// proven, so a registry/reaper can retry without losing authority.
    pub fn revoke(mut self) -> Result<(), ProtectedEndpointFailure<Self>> {
        match self.owner.cleanup() {
            Ok(()) => Ok(()),
            Err(error) => Err(ProtectedEndpointFailure::Owned { owner: self, error }),
        }
    }
}

fn validate_root(root: &Path) -> Result<PathBuf, ProtectedEndpointError> {
    if !root.is_absolute()
        || root
            .components()
            .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
    {
        return Err(ProtectedEndpointError::InvalidRoot(
            "root must be absolute and normalized",
        ));
    }
    let metadata = fs::symlink_metadata(root)
        .map_err(|source| ProtectedEndpointError::io("inspect local IPC root", source))?;
    let mode = metadata.mode() & 0o777;
    if !metadata.file_type().is_dir() || mode != PRIVATE_DIRECTORY_MODE {
        return Err(ProtectedEndpointError::PermissionNotProven {
            object: "local IPC root",
            expected: PRIVATE_DIRECTORY_MODE,
            actual: mode,
        });
    }
    let canonical = fs::canonicalize(root)
        .map_err(|source| ProtectedEndpointError::io("canonicalize local IPC root", source))?;
    if canonical != root {
        return Err(ProtectedEndpointError::InvalidRoot(
            "root must not traverse symbolic links",
        ));
    }
    Ok(canonical)
}

fn validate_socket_path(path: &Path) -> Result<(), ProtectedEndpointError> {
    let text = path.to_str().ok_or(ProtectedEndpointError::InvalidAddress(
        "non-UTF-8 Unix path",
    ))?;
    let units = text.len() + 1;
    if units > MAX_SOCKET_PATH_BYTES_WITH_NUL {
        return Err(ProtectedEndpointError::AddressTooLong {
            units,
            maximum: MAX_SOCKET_PATH_BYTES_WITH_NUL,
        });
    }
    Ok(())
}
