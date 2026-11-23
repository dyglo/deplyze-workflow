use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSourceLink {
    pub title: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMessage {
    pub id: String,
    pub role: String, // "user" | "assistant"
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub has_chart: bool,
    #[serde(default)]
    pub image_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<AiSourceLink>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConversation {
    pub id: String,
    pub title: String,
    pub symbol: String,
    pub full_symbol: String,
    pub messages: Vec<AiMessage>,
    pub created_at: String,
    pub updated_at: String,
}

fn ai_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    let dir = base.join("ai");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create ai dir: {e}"))?;
    Ok(dir)
}

#[tauri::command]
pub fn ai_chats_load(app: AppHandle) -> Result<Vec<AiConversation>, String> {
    let path = ai_dir(&app)?.join("chats.json");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read AI chats: {e}"))?;
    if content.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str::<Vec<AiConversation>>(&content)
        .map_err(|e| format!("Failed to parse AI chats: {e}"))
}

#[tauri::command]
pub fn ai_chats_save(app: AppHandle, chats: Vec<AiConversation>) -> Result<(), String> {
    let dir = ai_dir(&app)?;
    let target = dir.join("chats.json");
    let tmp = dir.join("chats.json.tmp");
    let json = serde_json::to_string_pretty(&chats)
        .map_err(|e| format!("Failed to serialize AI chats: {e}"))?;
    fs::write(&tmp, json).map_err(|e| format!("Failed to write temp AI chats: {e}"))?;
    if target.exists() {
        let _ = fs::remove_file(&target);
    }
    fs::rename(&tmp, &target).map_err(|e| format!("Failed to commit AI chats: {e}"))?;
    Ok(())
}
