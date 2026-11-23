use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const BACKUP_DIR_NAME: &str = "DeplyzeWorkflow-Backup";
const MANIFEST_NAME: &str = "manifest.json";
const ALLOWED_ROOTS: &[&str] = &["notes", "ai", "workspace"];
const MAX_EXTRACT_BYTES: u64 = 512 * 1024 * 1024; // 512 MiB safety ceiling

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    pub app: String,
    pub format_version: u32,
    pub created_at: String,
    pub file_count: usize,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStats {
    pub notes_count: usize,
    pub screenshots_count: usize,
    pub playbook_count: usize,
    pub ai_chats_count: usize,
    pub alerts_count: usize,
    pub watchlist_count: usize,
    pub routines_count: usize,
    pub tasks_count: usize,
    pub total_files: usize,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub backup_dir: String,
    pub synced_at: String,
    pub copied_files: usize,
    pub skipped_files: usize,
    pub total_files: usize,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub restored_files: usize,
    pub total_bytes: u64,
    pub restored_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZipExportResult {
    pub path: String,
    pub file_count: usize,
    pub total_bytes: u64,
    pub created_at: String,
}

fn app_data_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create app data dir: {e}"))?;
    Ok(dir)
}

/// Formats current UTC time as ISO-8601 `YYYY-MM-DDTHH:MM:SSZ` without extra crates.
fn now_iso_utc() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (y, m, d, hh, mm, ss) = unix_secs_to_utc_ymd_hms(secs);
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

fn today_date_utc() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (y, m, d, _, _, _) = unix_secs_to_utc_ymd_hms(secs);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Howard Hinnant's civil-from-days algorithm (exact Gregorian calendar conversion).
fn unix_secs_to_utc_ymd_hms(secs: u64) -> (i64, u32, u32, u32, u32, u32) {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let hh = (rem / 3600) as u32;
    let mm = ((rem % 3600) / 60) as u32;
    let ss = (rem % 60) as u32;

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = y + if m <= 2 { 1 } else { 0 };
    (year, m, d, hh, mm, ss)
}

fn is_temp_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.ends_with(".tmp"))
        .unwrap_or(false)
}

fn collect_relative_files(root: &Path, sub: &str, out: &mut Vec<PathBuf>) -> Result<(), String> {
    let base = root.join(sub);
    if !base.exists() {
        return Ok(());
    }
    let mut stack = vec![base];
    while let Some(dir) = stack.pop() {
        let entries = fs::read_dir(&dir)
            .map_err(|e| format!("Failed to read directory {}: {e}", dir.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read dir entry: {e}"))?;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.is_file() && !is_temp_file(&path) {
                let rel = path
                    .strip_prefix(root)
                    .map_err(|e| format!("Failed to compute relative path: {e}"))?
                    .to_path_buf();
                out.push(rel);
            }
        }
    }
    Ok(())
}

fn collect_all_backup_files(app_root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    for root_name in ALLOWED_ROOTS {
        collect_relative_files(app_root, root_name, &mut files)?;
    }
    files.sort();
    Ok(files)
}

fn normalize_zip_rel_path(raw: &str) -> Result<PathBuf, String> {
    let cleaned = raw.replace('\\', "/");
    if cleaned.starts_with('/') || cleaned.contains(':') {
        return Err(format!("Unsafe archive entry path: {raw}"));
    }
    let p = Path::new(&cleaned);
    let mut normalized = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::Normal(seg) => normalized.push(seg),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!("Path traversal blocked in archive entry: {raw}"));
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err(format!("Empty archive entry path: {raw}"));
    }
    Ok(normalized)
}

fn is_allowed_backup_rel(rel: &Path) -> bool {
    if is_temp_file(rel) {
        return false;
    }
    let mut comps = rel.components();
    match comps.next() {
        Some(Component::Normal(first)) => {
            let first_str = first.to_string_lossy();
            ALLOWED_ROOTS.iter().any(|r| *r == first_str)
        }
        _ => false,
    }
}

fn file_sig(path: &Path) -> Option<(u64, u64)> {
    let meta = fs::metadata(path).ok()?;
    let size = meta.len();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Some((size, mtime))
}

fn read_json_value(path: &Path) -> Option<serde_json::Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn compute_stats_for_root(app_root: &Path) -> Result<WorkspaceStats, String> {
    let files = collect_all_backup_files(app_root)?;
    let mut total_bytes: u64 = 0;
    let mut screenshots_count: usize = 0;

    for rel in &files {
        let full = app_root.join(rel);
        if let Ok(meta) = fs::metadata(&full) {
            total_bytes += meta.len();
        }
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if rel_str.starts_with("notes/images/") {
            screenshots_count += 1;
        }
    }

    let notes_count = read_json_value(&app_root.join("notes").join("index.json"))
        .and_then(|v| v.as_array().cloned())
        .map(|arr| {
            arr.iter()
                .filter(|n| n.get("deletedAt").map(|d| d.is_null()).unwrap_or(true))
                .count()
        })
        .unwrap_or(0);

    let ai_chats_count = read_json_value(&app_root.join("ai").join("chats.json"))
        .and_then(|v| v.as_array().map(|a| a.len()))
        .unwrap_or(0);

    let ws = app_root.join("workspace");

    let playbook_count = read_json_value(&ws.join("playbook.json"))
        .and_then(|v| v.get("entries").and_then(|e| e.as_array()).map(|a| a.len()))
        .unwrap_or(0);

    let alerts_count = read_json_value(&ws.join("alerts.json"))
        .and_then(|v| v.get("alerts").and_then(|e| e.as_array()).map(|a| a.len()))
        .unwrap_or(0);

    let routines_count = read_json_value(&ws.join("routines.json"))
        .and_then(|v| v.get("items").and_then(|e| e.as_array()).map(|a| a.len()))
        .unwrap_or(0);

    let tasks_count = read_json_value(&ws.join("tasks.json"))
        .map(|v| {
            let rules = v.get("rules").and_then(|r| r.as_array()).map(|a| a.len()).unwrap_or(0);
            let todos = v.get("todos").and_then(|t| t.as_array()).map(|a| a.len()).unwrap_or(0);
            rules + todos
        })
        .unwrap_or(0);

    let watchlist_count = read_json_value(&ws.join("watchlist.json"))
        .and_then(|v| v.get("groups").and_then(|g| g.as_array()).cloned())
        .map(|groups| {
            let mut n = 0usize;
            for g in groups {
                if let Some(secs) = g.get("sections").and_then(|s| s.as_array()) {
                    for s in secs {
                        if let Some(items) = s.get("items").and_then(|i| i.as_array()) {
                            n += items.len();
                        }
                    }
                }
            }
            n
        })
        .unwrap_or(0);

    Ok(WorkspaceStats {
        notes_count,
        screenshots_count,
        playbook_count,
        ai_chats_count,
        alerts_count,
        watchlist_count,
        routines_count,
        tasks_count,
        total_files: files.len(),
        total_bytes,
    })
}

pub fn sync_root_to_folder(app_root: &Path, target_dir: &Path) -> Result<SyncResult, String> {
    if !target_dir.exists() || !target_dir.is_dir() {
        return Err("Selected sync folder does not exist or is not a directory".to_string());
    }

    let canon_app = fs::canonicalize(app_root).unwrap_or_else(|_| app_root.to_path_buf());
    let canon_target = fs::canonicalize(target_dir).unwrap_or_else(|_| target_dir.to_path_buf());
    if canon_target.starts_with(&canon_app) {
        return Err("Cannot sync inside DeplyzeWorkflow's own app data folder".to_string());
    }

    let backup_root = target_dir.join(BACKUP_DIR_NAME);
    fs::create_dir_all(&backup_root)
        .map_err(|e| format!("Failed to create backup folder: {e}"))?;

    let src_files = collect_all_backup_files(app_root)?;
    let mut expected_set = HashSet::new();
    let mut copied_files = 0usize;
    let mut skipped_files = 0usize;
    let mut total_bytes = 0u64;

    for rel in &src_files {
        expected_set.insert(rel.clone());
        let src = app_root.join(rel);
        let dst = backup_root.join(rel);
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create folder {}: {e}", parent.display()))?;
        }

        let src_sig = file_sig(&src);
        let dst_sig = file_sig(&dst);
        if let Some((sz, _)) = src_sig {
            total_bytes += sz;
        }

        let unchanged = match (src_sig, dst_sig) {
            (Some((s_sz, s_mt)), Some((d_sz, d_mt))) => s_sz == d_sz && d_mt >= s_mt,
            _ => false,
        };

        if unchanged {
            skipped_files += 1;
        } else {
            fs::copy(&src, &dst)
                .map_err(|e| format!("Failed to copy {} to backup: {e}", rel.display()))?;
            copied_files += 1;
        }
    }

    // Remove stale mirrored files that were deleted locally
    let existing_backup_files = collect_all_backup_files(&backup_root)?;
    for rel in existing_backup_files {
        if !expected_set.contains(&rel) {
            let _ = fs::remove_file(backup_root.join(&rel));
        }
    }

    let synced_at = now_iso_utc();
    let manifest = BackupManifest {
        app: "DeplyzeWorkflow".to_string(),
        format_version: 1,
        created_at: synced_at.clone(),
        file_count: src_files.len(),
        total_bytes,
    };
    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("Failed to serialize manifest: {e}"))?;
    fs::write(backup_root.join(MANIFEST_NAME), manifest_json)
        .map_err(|e| format!("Failed to write backup manifest: {e}"))?;

    Ok(SyncResult {
        backup_dir: backup_root.to_string_lossy().into_owned(),
        synced_at,
        copied_files,
        skipped_files,
        total_files: src_files.len(),
        total_bytes,
    })
}

pub fn restore_root_from_folder(
    app_root: &Path,
    source_dir: &Path,
) -> Result<RestoreResult, String> {
    if !source_dir.exists() || !source_dir.is_dir() {
        return Err("Source folder does not exist".to_string());
    }

    let candidate_nested = source_dir.join(BACKUP_DIR_NAME);
    let backup_root = if candidate_nested.is_dir() {
        candidate_nested
    } else if source_dir.join(MANIFEST_NAME).is_file() {
        source_dir.to_path_buf()
    } else {
        return Err(format!(
            "No {BACKUP_DIR_NAME} folder found inside {}",
            source_dir.display()
        ));
    };

    let manifest_path = backup_root.join(MANIFEST_NAME);
    if manifest_path.is_file() {
        let raw = fs::read_to_string(&manifest_path)
            .map_err(|e| format!("Failed to read backup manifest: {e}"))?;
        let parsed: BackupManifest = serde_json::from_str(&raw)
            .map_err(|e| format!("Invalid DeplyzeWorkflow manifest.json: {e}"))?;
        if parsed.app != "DeplyzeWorkflow" {
            return Err("Folder backup is not a DeplyzeWorkflow backup".to_string());
        }
    }

    let files = collect_all_backup_files(&backup_root)?;
    if files.is_empty() {
        return Err("Backup folder contains no DeplyzeWorkflow data files".to_string());
    }

    let mut restored_files = 0usize;
    let mut total_bytes = 0u64;

    for rel in &files {
        if !is_allowed_backup_rel(rel) {
            continue;
        }
        let src = backup_root.join(rel);
        let dst = app_root.join(rel);
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to prepare target dir {}: {e}", parent.display()))?;
        }
        let bytes = fs::copy(&src, &dst)
            .map_err(|e| format!("Failed to restore {}: {e}", rel.display()))?;
        restored_files += 1;
        total_bytes += bytes;
    }

    Ok(RestoreResult {
        restored_files,
        total_bytes,
        restored_at: now_iso_utc(),
    })
}

pub fn write_backup_zip(app_root: &Path, zip_path: &Path) -> Result<ZipExportResult, String> {
    let files = collect_all_backup_files(app_root)?;
    let mut total_bytes = 0u64;
    for rel in &files {
        if let Ok(meta) = fs::metadata(app_root.join(rel)) {
            total_bytes += meta.len();
        }
    }

    let created_at = now_iso_utc();
    let manifest = BackupManifest {
        app: "DeplyzeWorkflow".to_string(),
        format_version: 1,
        created_at: created_at.clone(),
        file_count: files.len(),
        total_bytes,
    };
    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("Failed to serialize backup manifest: {e}"))?;

    let file = File::create(zip_path)
        .map_err(|e| format!("Failed to create zip file {}: {e}", zip_path.display()))?;
    let mut zip = ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    zip.start_file(MANIFEST_NAME, opts)
        .map_err(|e| format!("Failed to write manifest entry: {e}"))?;
    zip.write_all(manifest_json.as_bytes())
        .map_err(|e| format!("Failed to write manifest bytes: {e}"))?;

    let mut buf = Vec::new();
    for rel in &files {
        let entry_name = rel.to_string_lossy().replace('\\', "/");
        let full = app_root.join(rel);
        buf.clear();
        File::open(&full)
            .and_then(|mut f| f.read_to_end(&mut buf))
            .map_err(|e| format!("Failed to read {} for zip: {e}", rel.display()))?;

        zip.start_file(&entry_name, opts)
            .map_err(|e| format!("Failed to start zip entry {entry_name}: {e}"))?;
        zip.write_all(&buf)
            .map_err(|e| format!("Failed to write zip entry {entry_name}: {e}"))?;
    }

    zip.finish()
        .map_err(|e| format!("Failed to finalize backup zip: {e}"))?;

    Ok(ZipExportResult {
        path: zip_path.to_string_lossy().into_owned(),
        file_count: files.len(),
        total_bytes,
        created_at,
    })
}

pub fn extract_backup_zip(app_root: &Path, zip_path: &Path) -> Result<RestoreResult, String> {
    let file = File::open(zip_path)
        .map_err(|e| format!("Failed to open zip file {}: {e}", zip_path.display()))?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("Invalid zip archive: {e}"))?;

    // Pass 1: Strict validation of every entry (zip-slip protection, manifest check, size ceiling)
    let mut has_valid_manifest = false;
    let mut allowed_indices: Vec<(usize, PathBuf)> = Vec::new();
    let mut declared_total: u64 = 0;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Failed to inspect zip entry #{i}: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let raw_name = entry.name().to_string();
        if entry.enclosed_name().is_none() {
            return Err(format!("Blocked unsafe archive path (zip-slip): {raw_name}"));
        }
        let rel = normalize_zip_rel_path(&raw_name)?;

        declared_total = declared_total.saturating_add(entry.size());
        if declared_total > MAX_EXTRACT_BYTES {
            return Err("Backup archive exceeds safety size limit".to_string());
        }

        if rel == Path::new(MANIFEST_NAME) {
            let mut raw = String::new();
            entry
                .read_to_string(&mut raw)
                .map_err(|e| format!("Failed to read archive manifest: {e}"))?;
            let parsed: BackupManifest = serde_json::from_str(&raw)
                .map_err(|e| format!("Invalid archive manifest.json: {e}"))?;
            if parsed.app != "DeplyzeWorkflow" {
                return Err("Selected zip is not a DeplyzeWorkflow backup".to_string());
            }
            has_valid_manifest = true;
            continue;
        }

        if is_allowed_backup_rel(&rel) {
            allowed_indices.push((i, rel));
        }
    }

    if !has_valid_manifest && allowed_indices.is_empty() {
        return Err("Selected zip does not look like a DeplyzeWorkflow backup".to_string());
    }
    if allowed_indices.is_empty() {
        return Err("Backup archive contains no restorable workspace files".to_string());
    }

    // Pass 2: Safe extraction of allowlisted files only
    let mut restored_files = 0usize;
    let mut total_bytes = 0u64;
    let mut buf = Vec::new();

    for (idx, rel) in allowed_indices {
        let mut entry = archive
            .by_index(idx)
            .map_err(|e| format!("Failed to read archive entry #{idx}: {e}"))?;
        buf.clear();
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("Failed to decompress {}: {e}", rel.display()))?;

        total_bytes = total_bytes.saturating_add(buf.len() as u64);
        if total_bytes > MAX_EXTRACT_BYTES {
            return Err("Extracted archive size exceeded safety limit".to_string());
        }

        let dest = app_root.join(&rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create dir {}: {e}", parent.display()))?;
        }
        fs::write(&dest, &buf)
            .map_err(|e| format!("Failed to write restored file {}: {e}", rel.display()))?;
        restored_files += 1;
    }

    Ok(RestoreResult {
        restored_files,
        total_bytes,
        restored_at: now_iso_utc(),
    })
}

#[tauri::command]
pub async fn cloud_workspace_stats(app: AppHandle) -> Result<WorkspaceStats, String> {
    let root = app_data_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || compute_stats_for_root(&root))
        .await
        .map_err(|e| format!("Stats task failed: {e}"))?
}

#[tauri::command]
pub async fn cloud_pick_folder() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let picked = rfd::FileDialog::new()
            .set_title("Choose Auto-Sync Folder (OneDrive / Google Drive / Dropbox)")
            .pick_folder();
        Ok(picked.map(|p| p.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| format!("Folder picker task failed: {e}"))?
}

#[tauri::command]
pub async fn cloud_sync_to_folder(
    app: AppHandle,
    target_dir: String,
) -> Result<SyncResult, String> {
    let root = app_data_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || sync_root_to_folder(&root, Path::new(&target_dir)))
        .await
        .map_err(|e| format!("Sync task failed: {e}"))?
}

#[tauri::command]
pub async fn cloud_restore_from_folder(
    app: AppHandle,
    source_dir: String,
) -> Result<RestoreResult, String> {
    let root = app_data_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        restore_root_from_folder(&root, Path::new(&source_dir))
    })
    .await
    .map_err(|e| format!("Restore folder task failed: {e}"))?
}

#[tauri::command]
pub async fn cloud_export_zip(app: AppHandle) -> Result<Option<ZipExportResult>, String> {
    let root = app_data_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let default_name = format!("DeplyzeWorkflow-Backup-{}.zip", today_date_utc());
        let picked = rfd::FileDialog::new()
            .set_title("Export DeplyzeWorkflow Backup")
            .set_file_name(&default_name)
            .add_filter("DeplyzeWorkflow Backup", &["zip"])
            .save_file();
        let Some(dest) = picked else {
            return Ok(None);
        };
        write_backup_zip(&root, &dest).map(Some)
    })
    .await
    .map_err(|e| format!("Export zip task failed: {e}"))?
}

#[tauri::command]
pub async fn cloud_import_zip(app: AppHandle) -> Result<Option<RestoreResult>, String> {
    let root = app_data_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let picked = rfd::FileDialog::new()
            .set_title("Restore DeplyzeWorkflow Backup (.zip)")
            .add_filter("DeplyzeWorkflow Backup", &["zip"])
            .pick_file();
        let Some(src) = picked else {
            return Ok(None);
        };
        extract_backup_zip(&root, &src).map(Some)
    })
    .await
    .map_err(|e| format!("Import zip task failed: {e}"))?
}

#[tauri::command]
pub async fn cloud_save_text_export(
    default_filename: String,
    content: String,
    ext: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let clean_ext = ext.trim().trim_start_matches('.').to_ascii_lowercase();
        let (filter_label, ext_ref) = match clean_ext.as_str() {
            "html" | "htm" => ("HTML Report", "html"),
            _ => ("Markdown Document", "md"),
        };
        let picked = rfd::FileDialog::new()
            .set_title("Save Weekly Review Export")
            .set_file_name(&default_filename)
            .add_filter(filter_label, &[ext_ref])
            .save_file();
        let Some(dest) = picked else {
            return Ok(None);
        };
        fs::write(&dest, content.as_bytes())
            .map_err(|e| format!("Failed to write export file: {e}"))?;
        Ok(Some(dest.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| format!("Save text export task failed: {e}"))?
}

#[tauri::command]
pub async fn cloud_read_image_base64(
    app: AppHandle,
    filename: String,
) -> Result<Option<String>, String> {
    if filename.is_empty()
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains("..")
    {
        return Err("Invalid screenshot filename".to_string());
    }
    let root = app_data_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = root.join("notes").join("images").join(&filename);
        if !path.is_file() {
            return Ok(None);
        }
        let bytes =
            fs::read(&path).map_err(|e| format!("Failed to read screenshot {filename}: {e}"))?;
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("png")
            .to_ascii_lowercase();
        let mime = match ext.as_str() {
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "gif" => "image/gif",
            _ => "image/png",
        };
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        Ok(Some(format!("data:{mime};base64,{b64}")))
    })
    .await
    .map_err(|e| format!("Image encode task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQ: AtomicU64 = AtomicU64::new(1);

    fn temp_test_dir(tag: &str) -> PathBuf {
        let seq = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "deplyze_cloud_test_{}_{}_{}",
            tag,
            std::process::id(),
            seq
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn seed_sample_workspace(root: &Path) {
        fs::create_dir_all(root.join("notes").join("images")).unwrap();
        fs::create_dir_all(root.join("ai")).unwrap();
        fs::create_dir_all(root.join("workspace")).unwrap();

        fs::write(
            root.join("notes").join("index.json"),
            r#"[{"id":"n1","title":"Gold sweep","body":"Clean CHoCH","deletedAt":null}]"#,
        )
        .unwrap();
        fs::write(
            root.join("notes").join("images").join("shot1.png"),
            b"fake-png-bytes",
        )
        .unwrap();
        fs::write(root.join("ai").join("chats.json"), r#"[{"id":"c1"}]"#).unwrap();
        fs::write(
            root.join("workspace").join("playbook.json"),
            r#"{"entries":[{"id":"pb1"}],"customSetupTypes":[]}"#,
        )
        .unwrap();
        fs::write(
            root.join("workspace").join("alerts.json"),
            r#"{"alerts":[{"id":"a1"}],"log":[]}"#,
        )
        .unwrap();
    }

    #[test]
    fn test_stats_zip_roundtrip_and_sync() {
        let src = temp_test_dir("src");
        let sync_target = temp_test_dir("sync");
        let restored_zip = temp_test_dir("restored_zip");
        let restored_folder = temp_test_dir("restored_folder");
        let zip_file = temp_test_dir("zip_out").join("backup.zip");

        seed_sample_workspace(&src);

        let stats = compute_stats_for_root(&src).unwrap();
        assert_eq!(stats.notes_count, 1);
        assert_eq!(stats.screenshots_count, 1);
        assert_eq!(stats.playbook_count, 1);
        assert_eq!(stats.ai_chats_count, 1);
        assert_eq!(stats.alerts_count, 1);
        assert_eq!(stats.total_files, 5);

        // First folder sync copies all 5 files
        let sync1 = sync_root_to_folder(&src, &sync_target).unwrap();
        assert_eq!(sync1.copied_files, 5);
        assert_eq!(sync1.skipped_files, 0);

        // Second folder sync skips unchanged files
        let sync2 = sync_root_to_folder(&src, &sync_target).unwrap();
        assert_eq!(sync2.copied_files, 0);
        assert_eq!(sync2.skipped_files, 5);

        // Restore from folder
        let res_folder = restore_root_from_folder(&restored_folder, &sync_target).unwrap();
        assert_eq!(res_folder.restored_files, 5);
        assert!(restored_folder
            .join("notes")
            .join("images")
            .join("shot1.png")
            .exists());

        // Export & import zip
        let exp = write_backup_zip(&src, &zip_file).unwrap();
        assert_eq!(exp.file_count, 5);

        let imp = extract_backup_zip(&restored_zip, &zip_file).unwrap();
        assert_eq!(imp.restored_files, 5);
        assert_eq!(
            fs::read(restored_zip.join("notes").join("images").join("shot1.png")).unwrap(),
            b"fake-png-bytes"
        );

        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&sync_target);
        let _ = fs::remove_dir_all(&restored_zip);
        let _ = fs::remove_dir_all(&restored_folder);
        if let Some(p) = zip_file.parent() {
            let _ = fs::remove_dir_all(p);
        }
    }

    #[test]
    fn test_zip_slip_is_rejected() {
        let dir = temp_test_dir("zipslip");
        let bad_zip = dir.join("evil.zip");
        let dest = temp_test_dir("zipslip_dest");

        {
            let f = File::create(&bad_zip).unwrap();
            let mut z = ZipWriter::new(f);
            let opts = SimpleFileOptions::default();
            z.start_file("../escape.txt", opts).unwrap();
            z.write_all(b"pwned").unwrap();
            z.finish().unwrap();
        }

        let err = extract_backup_zip(&dest, &bad_zip).unwrap_err();
        assert!(
            err.to_lowercase().contains("unsafe") || err.to_lowercase().contains("traversal"),
            "unexpected error: {err}"
        );
        assert!(!dest.parent().unwrap().join("escape.txt").exists());

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&dest);
    }
}
