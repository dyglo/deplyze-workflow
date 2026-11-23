use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

static IMAGE_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteAttachment {
    pub id: String,
    pub filename: String,
    pub mime_type: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub title: String,
    pub body: String,
    pub date: String,
    pub symbol: String,
    pub full_symbol: String,
    pub pinned: bool,
    pub attachments: Vec<NoteAttachment>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedImageResult {
    pub filename: String,
    pub path: String,
    pub mime_type: String,
}

fn notes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    let dir = base.join("notes");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create notes dir: {e}"))?;
    Ok(dir)
}

fn images_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = notes_dir(app)?.join("images");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create images dir: {e}"))?;
    Ok(dir)
}

fn normalize_ext(ext: &str) -> Result<(&'static str, &'static str), String> {
    match ext.trim().trim_start_matches('.').to_ascii_lowercase().as_str() {
        "png" => Ok(("png", "image/png")),
        "jpg" | "jpeg" => Ok(("jpg", "image/jpeg")),
        "webp" => Ok(("webp", "image/webp")),
        "gif" => Ok(("gif", "image/gif")),
        other => Err(format!("Unsupported image format: {other}")),
    }
}

fn sanitize_segment(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(24)
        .collect();
    if cleaned.is_empty() {
        "note".to_string()
    } else {
        cleaned
    }
}

fn build_filename(date: &str, note_id: &str, ext: &str) -> String {
    let date_seg = sanitize_segment(date);
    let note_seg = sanitize_segment(note_id);
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = IMAGE_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{date_seg}_{note_seg}_{millis}_{seq}.{ext}")
}

fn validate_flat_filename(filename: &str) -> Result<(), String> {
    if filename.is_empty()
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains("..")
    {
        return Err("Invalid image filename".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn notes_load(app: AppHandle) -> Result<Vec<Note>, String> {
    let index_path = notes_dir(&app)?.join("index.json");
    if !index_path.exists() {
        return Ok(Vec::new());
    }
    let content =
        fs::read_to_string(&index_path).map_err(|e| format!("Failed to read notes index: {e}"))?;
    if content.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str::<Vec<Note>>(&content)
        .map_err(|e| format!("Failed to parse notes index: {e}"))
}

#[tauri::command]
pub fn notes_save(app: AppHandle, notes: Vec<Note>) -> Result<(), String> {
    let dir = notes_dir(&app)?;
    let index_path = dir.join("index.json");
    let tmp_path = dir.join("index.json.tmp");

    let json = serde_json::to_string_pretty(&notes)
        .map_err(|e| format!("Failed to serialize notes: {e}"))?;

    fs::write(&tmp_path, json).map_err(|e| format!("Failed to write temp notes file: {e}"))?;
    fs::rename(&tmp_path, &index_path)
        .map_err(|e| format!("Failed to commit notes index atomically: {e}"))?;

    Ok(())
}

#[tauri::command]
pub fn notes_get_images_dir(app: AppHandle) -> Result<String, String> {
    let dir = images_dir(&app)?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn notes_save_image_bytes(
    app: AppHandle,
    bytes: Vec<u8>,
    ext: String,
    note_id: String,
    date: String,
) -> Result<SavedImageResult, String> {
    if bytes.is_empty() {
        return Err("Image payload is empty".to_string());
    }
    let (norm_ext, mime_type) = normalize_ext(&ext)?;
    let dir = images_dir(&app)?;
    let filename = build_filename(&date, &note_id, norm_ext);
    let dest = dir.join(&filename);
    let tmp = dir.join(format!("{filename}.tmp"));

    fs::write(&tmp, &bytes).map_err(|e| format!("Failed to write image file: {e}"))?;
    fs::rename(&tmp, &dest).map_err(|e| format!("Failed to finalize image file: {e}"))?;

    Ok(SavedImageResult {
        filename,
        path: dest.to_string_lossy().into_owned(),
        mime_type: mime_type.to_string(),
    })
}

#[tauri::command]
pub fn notes_copy_image_file(
    app: AppHandle,
    source_path: String,
    note_id: String,
    date: String,
) -> Result<SavedImageResult, String> {
    let src = Path::new(&source_path);
    if !src.is_file() {
        return Err("Dropped path is not a readable file".to_string());
    }
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .ok_or_else(|| "File has no image extension".to_string())?;
    let (norm_ext, mime_type) = normalize_ext(ext)?;

    let dir = images_dir(&app)?;
    let filename = build_filename(&date, &note_id, norm_ext);
    let dest = dir.join(&filename);
    let tmp = dir.join(format!("{filename}.tmp"));

    fs::copy(src, &tmp).map_err(|e| format!("Failed to copy image file: {e}"))?;
    fs::rename(&tmp, &dest).map_err(|e| format!("Failed to finalize copied image: {e}"))?;

    Ok(SavedImageResult {
        filename,
        path: dest.to_string_lossy().into_owned(),
        mime_type: mime_type.to_string(),
    })
}

#[tauri::command]
pub fn notes_delete_image(app: AppHandle, filename: String) -> Result<(), String> {
    validate_flat_filename(&filename)?;
    let target = images_dir(&app)?.join(&filename);
    match fs::remove_file(&target) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to delete image file: {e}")),
    }
}
