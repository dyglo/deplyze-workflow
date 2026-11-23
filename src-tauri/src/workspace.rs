use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn validate_key(key: &str) -> Result<(), String> {
    if key.is_empty()
        || key.len() > 48
        || !key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid workspace storage key".to_string());
    }
    Ok(())
}

fn workspace_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    let dir = base.join("workspace");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create workspace dir: {e}"))?;
    Ok(dir)
}

#[tauri::command]
pub fn workspace_load_json(app: AppHandle, key: String) -> Result<Option<String>, String> {
    validate_key(&key)?;
    let path = workspace_dir(&app)?.join(format!("{key}.json"));
    if !path.exists() {
        return Ok(None);
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read workspace/{key}: {e}"))?;
    if content.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(content))
}

#[tauri::command]
pub fn workspace_save_json(app: AppHandle, key: String, content: String) -> Result<(), String> {
    validate_key(&key)?;
    let dir = workspace_dir(&app)?;
    let target = dir.join(format!("{key}.json"));
    let tmp = dir.join(format!("{key}.json.tmp"));
    fs::write(&tmp, content).map_err(|e| format!("Failed to write temp workspace/{key}: {e}"))?;
    if target.exists() {
        let _ = fs::remove_file(&target);
    }
    fs::rename(&tmp, &target).map_err(|e| format!("Failed to commit workspace/{key}: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn notify_desktop(title: String, body: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use winrt_notification::{Duration, Sound, Toast};
        Toast::new(Toast::POWERSHELL_APP_ID)
            .title(&title)
            .text1(&body)
            .sound(Some(Sound::Default))
            .duration(Duration::Short)
            .show()
            .map_err(|e| format!("Windows toast failed: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (title, body);
        Ok(())
    }
}
