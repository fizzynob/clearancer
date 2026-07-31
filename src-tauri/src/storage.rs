use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// Resolves `<app data dir>/<file_name>`, creating the app data dir if needed.
pub fn app_file_path(app: &tauri::AppHandle, file_name: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("could not create app data dir: {e}"))?;
    Ok(dir.join(file_name))
}

/// Writes to a temp file first and renames it into place so a crash
/// mid-write (e.g. power loss) can never leave a corrupted file behind.
pub fn atomic_write(path: &Path, contents: &str) -> Result<(), String> {
    let tmp_path = path.with_extension("json.tmp");

    let mut file =
        fs::File::create(&tmp_path).map_err(|e| format!("could not create temp file: {e}"))?;
    file.write_all(contents.as_bytes())
        .map_err(|e| format!("could not write temp file: {e}"))?;
    file.sync_all()
        .map_err(|e| format!("could not flush temp file: {e}"))?;

    fs::rename(&tmp_path, path).map_err(|e| format!("could not finalize save: {e}"))?;
    Ok(())
}
