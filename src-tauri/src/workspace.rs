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

#[cfg(target_os = "windows")]
const APP_AUMID: &str = "com.deplyze.workflow";

#[cfg(target_os = "windows")]
const APP_DISPLAY_NAME: &str = "DeplyzeWorkflow";

#[cfg(target_os = "windows")]
static APP_ICON_PNG: &[u8] = include_bytes!("../icons/128x128.png");

#[cfg(target_os = "windows")]
static AUMID_READY: OnceLock<bool> = OnceLock::new();

#[cfg(target_os = "windows")]
fn to_wide_null(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn write_reg_sz(
    hkey: windows::Win32::System::Registry::HKEY,
    name: &str,
    value: &str,
) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{RegSetValueExW, REG_SZ};

    let name_w = to_wide_null(name);
    let val_w = to_wide_null(value);
    let byte_slice =
        unsafe { std::slice::from_raw_parts(val_w.as_ptr() as *const u8, val_w.len() * 2) };
    let status = unsafe {
        RegSetValueExW(
            hkey,
            PCWSTR(name_w.as_ptr()),
            0,
            REG_SZ,
            Some(byte_slice),
        )
    };
    if status.0 != 0 {
        return Err(format!("RegSetValueExW({name}) failed: {}", status.0));
    }
    Ok(())
}

/// Ensures Windows recognizes `com.deplyze.workflow` with display name "DeplyzeWorkflow" and
/// our app icon so native Windows toasts display "DeplyzeWorkflow" instead of "Windows PowerShell".
#[cfg(target_os = "windows")]
pub fn ensure_windows_aumid(app: &AppHandle) -> bool {
    *AUMID_READY.get_or_init(|| {
        use windows::core::PCWSTR;
        use windows::Win32::System::Registry::{
            RegCloseKey, RegCreateKeyExW, HKEY, HKEY_CURRENT_USER, KEY_WRITE,
            REG_OPTION_NON_VOLATILE,
        };
        use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;

        let aumid_w = to_wide_null(APP_AUMID);
        let _ = unsafe { SetCurrentProcessExplicitAppUserModelID(PCWSTR(aumid_w.as_ptr())) };

        let icon_path = app.path().app_data_dir().ok().and_then(|dir| {
            let _ = fs::create_dir_all(&dir);
            let p = dir.join("deplyze-toast-icon.png");
            if !p.exists() {
                let _ = fs::write(&p, APP_ICON_PNG);
            }
            if p.exists() {
                Some(p.to_string_lossy().into_owned())
            } else {
                None
            }
        });

        let subkey = format!("SOFTWARE\\Classes\\AppUserModelId\\{APP_AUMID}");
        let subkey_w = to_wide_null(&subkey);
        let mut hkey = HKEY::default();
        let status = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(subkey_w.as_ptr()),
                0,
                PCWSTR::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_WRITE,
                None,
                &mut hkey,
                None,
            )
        };
        if status.0 != 0 {
            return false;
        }

        let ok_name = write_reg_sz(hkey, "DisplayName", APP_DISPLAY_NAME).is_ok();
        let _ = write_reg_sz(hkey, "IconBackgroundColor", "FF000000");
        if let Some(ref icon) = icon_path {
            let _ = write_reg_sz(hkey, "IconUri", icon);
        }
        unsafe {
            let _ = RegCloseKey(hkey);
        }
        ok_name
    })
}

#[cfg(not(target_os = "windows"))]
pub fn ensure_windows_aumid(_app: &AppHandle) -> bool {
    false
}

#[tauri::command]
pub async fn notify_desktop(app: AppHandle, title: String, body: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let use_custom_aumid = ensure_windows_aumid(&app);
        tauri::async_runtime::spawn_blocking(move || {
            use winrt_notification::{Duration, Toast};

            if use_custom_aumid {
                let res = Toast::new(APP_AUMID)
                    .title(&title)
                    .text1(&body)
                    .sound(None)
                    .duration(Duration::Short)
                    .show();
                if res.is_ok() {
                    return Ok(());
                }
            }

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
        let _ = (app, title, body);
        Ok(())
    }
}
