//! One blocking-pool dispatch for the existing empty provider-home fast path.

use std::io;
use std::path::Path;

use napi_derive::napi;

fn try_remove_empty_home_with(
    home: &Path,
    mut remove: impl FnMut(&Path) -> io::Result<()>,
) -> bool {
    // Probe the root first. Starting with workspace would follow a stable
    // replacement root symlink into an unrelated directory.
    match remove(home) {
        Ok(()) => return true,
        Err(error) if error.kind() == io::ErrorKind::DirectoryNotEmpty => {}
        Err(_) => return false,
    }
    // These pathname operations intentionally retain the original Node fast
    // path's semantics; they are not an atomic path-replacement defense.
    remove(&home.join("workspace")).is_ok() && remove(home).is_ok()
}

#[napi(js_name = "_try_remove_empty_provider_home")]
pub async fn try_remove_empty_provider_home(home: String) -> napi::Result<bool> {
    Ok(tokio::task::spawn_blocking(move || {
        try_remove_empty_home_with(Path::new(&home), |path| std::fs::remove_dir(path))
    })
    .await
    .unwrap_or(false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn remove(home: &Path) -> bool {
        try_remove_empty_home_with(home, |path| fs::remove_dir(path))
    }

    #[test]
    fn removes_default_shape_or_empty_root_and_defers_missing_root() {
        let outer = tempfile::tempdir().unwrap();
        let home = outer.path().join("home");
        fs::create_dir_all(home.join("workspace")).unwrap();
        assert!(remove(&home));
        assert!(!home.exists());
        assert!(!remove(&home));
        fs::create_dir(&home).unwrap();
        assert!(remove(&home));
        assert!(!home.exists());
    }

    #[test]
    fn partial_removal_defers_nonempty_root_and_workspace_to_node() {
        let outer = tempfile::tempdir().unwrap();
        let home = outer.path().join("home");
        fs::create_dir_all(home.join("workspace")).unwrap();
        fs::write(home.join("extra"), "keep for Node fallback").unwrap();
        assert!(!remove(&home));
        assert!(!home.join("workspace").exists());
        assert_eq!(
            fs::read(home.join("extra")).unwrap(),
            b"keep for Node fallback"
        );
        fs::create_dir(home.join("workspace")).unwrap();
        fs::write(home.join("workspace/data"), "keep for Node fallback").unwrap();
        assert!(!remove(&home));
        assert_eq!(
            fs::read(home.join("workspace/data")).unwrap(),
            b"keep for Node fallback"
        );
    }

    #[test]
    fn removal_error_preserves_home_for_node_fallback() {
        let outer = tempfile::tempdir().unwrap();
        let home = outer.path().join("home");
        fs::create_dir_all(home.join("workspace")).unwrap();
        assert!(!try_remove_empty_home_with(&home, |_| {
            Err(io::Error::from(io::ErrorKind::PermissionDenied))
        }));
        assert!(home.join("workspace").is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn removes_mode_0300_home_without_directory_listing() {
        use std::os::unix::fs::PermissionsExt;
        let outer = tempfile::tempdir().unwrap();
        let home = outer.path().join("home");
        fs::create_dir_all(home.join("workspace")).unwrap();
        fs::set_permissions(&home, fs::Permissions::from_mode(0o300)).unwrap();
        let removed = remove(&home);
        if home.exists() {
            fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
        }
        assert!(removed);
        assert!(!home.exists());
    }

    #[test]
    fn replacement_after_root_probe_is_left_for_node_fallback() {
        let outer = tempfile::tempdir().unwrap();
        let home = outer.path().join("home");
        let moved = outer.path().join("moved");
        fs::create_dir_all(home.join("workspace")).unwrap();
        let mut first = true;
        assert!(!try_remove_empty_home_with(&home, |path| {
            let result = fs::remove_dir(path);
            if first {
                first = false;
                fs::rename(&home, &moved)?;
                fs::create_dir(&home)?;
            }
            result
        }));
        assert!(home.is_dir());
        assert!(moved.join("workspace").is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn root_symlink_is_deferred_without_visiting_its_target() {
        let outer = tempfile::tempdir().unwrap();
        let target = outer.path().join("target");
        fs::create_dir_all(target.join("workspace")).unwrap();
        let home = outer.path().join("home");
        std::os::unix::fs::symlink(&target, &home).unwrap();
        assert!(!remove(&home));
        assert!(target.join("workspace").is_dir());
        assert!(
            fs::symlink_metadata(&home)
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[cfg(unix)]
    #[test]
    fn workspace_symlink_and_replacement_before_first_syscall_are_deferred() {
        let outer = tempfile::tempdir().unwrap();
        let target = outer.path().join("target");
        fs::create_dir_all(target.join("workspace")).unwrap();
        let home = outer.path().join("home");
        fs::create_dir(&home).unwrap();
        std::os::unix::fs::symlink(&target, home.join("workspace")).unwrap();
        assert!(!remove(&home));
        assert!(target.join("workspace").is_dir());
        fs::remove_file(home.join("workspace")).unwrap();
        fs::create_dir(home.join("workspace")).unwrap();
        let moved = outer.path().join("moved");
        let mut first = true;
        assert!(!try_remove_empty_home_with(&home, |path| {
            if first {
                first = false;
                fs::rename(&home, &moved)?;
                std::os::unix::fs::symlink(&target, &home)?;
            }
            fs::remove_dir(path)
        }));
        assert!(target.join("workspace").is_dir());
        assert!(moved.join("workspace").is_dir());
    }
}
