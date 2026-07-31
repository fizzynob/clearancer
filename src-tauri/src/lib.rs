mod google;
mod smtc;
mod storage;

use std::fs;

/// Loads the saved tracker data as a raw JSON string.
/// Returns `None` if no save file exists yet (first run).
#[tauri::command]
fn load_data(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = storage::app_file_path(&app, "data.json")?;
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(&path).map(Some).map_err(|e| format!("could not read data file: {e}"))
}

/// Persists the tracker data (already-serialized JSON) to disk.
#[tauri::command]
fn save_data(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let path = storage::app_file_path(&app, "data.json")?;
    storage::atomic_write(&path, &json)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_data,
            save_data,
            google::google_status,
            google::google_disconnect,
            google::google_begin_auth,
            google::google_list_courses,
            google::google_sync_course,
            smtc::get_now_playing,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
