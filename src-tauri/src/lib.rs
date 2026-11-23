mod ai;
mod capture;
mod notes;
mod workspace;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            notes::notes_load,
            notes::notes_save,
            notes::notes_get_images_dir,
            notes::notes_save_image_bytes,
            notes::notes_copy_image_file,
            notes::notes_delete_image,
            capture::capture_chart_region,
            ai::ai_chats_load,
            ai::ai_chats_save,
            workspace::workspace_load_json,
            workspace::workspace_save_json,
            workspace::notify_desktop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
