use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

static SAVE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static TMP_SEQ: AtomicU64 = AtomicU64::new(1);

fn save_lock() -> &'static Mutex<()> {
    SAVE_LOCK.get_or_init(|| Mutex::new(()))
}

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
pub async fn workspace_load_json(app: AppHandle, key: String) -> Result<Option<String>, String> {
    validate_key(&key)?;
    let dir = workspace_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = save_lock().lock().unwrap_or_else(|e| e.into_inner());
        let path = dir.join(format!("{key}.json"));
        if !path.exists() {
            return Ok(None);
        }
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read workspace/{key}: {e}"))?;
        if content.trim().is_empty() {
            return Ok(None);
        }
        Ok(Some(content))
    })
    .await
    .map_err(|e| format!("Workspace load task failed: {e}"))?
}

#[tauri::command]
pub async fn workspace_save_json(
    app: AppHandle,
    key: String,
    content: String,
) -> Result<(), String> {
    validate_key(&key)?;
    let dir = workspace_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = save_lock().lock().unwrap_or_else(|e| e.into_inner());
        let target = dir.join(format!("{key}.json"));
        let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let tmp = dir.join(format!("{key}.{seq}.tmp"));

        fs::write(&tmp, &content)
            .map_err(|e| format!("Failed to write temp workspace/{key}: {e}"))?;

        if let Err(rename_err) = fs::rename(&tmp, &target) {
            if target.exists() {
                let _ = fs::remove_file(&target);
                if let Err(retry_err) = fs::rename(&tmp, &target) {
                    let _ = fs::remove_file(&tmp);
                    return Err(format!(
                        "Failed to commit workspace/{key}: {retry_err} (initial: {rename_err})"
                    ));
                }
            } else {
                let _ = fs::remove_file(&tmp);
                return Err(format!("Failed to commit workspace/{key}: {rename_err}"));
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Workspace save task failed: {e}"))?
}

#[tauri::command]
pub async fn notify_desktop(title: String, body: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            use winrt_notification::{Duration, Toast};
            Toast::new(Toast::POWERSHELL_APP_ID)
                .title(&title)
                .text1(&body)
                .sound(None)
                .duration(Duration::Short)
                .show()
                .map_err(|e| format!("Windows toast failed: {e}"))
        })
        .await
        .map_err(|e| format!("Windows toast task failed: {e}"))?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (title, body);
        Ok(())
    }
}
