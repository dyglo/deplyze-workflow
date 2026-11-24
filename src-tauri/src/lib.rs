use tauri::{LogicalPosition, LogicalSize, Manager};

mod ai;
mod capture;
mod cloud;
mod notes;
mod workspace;

const DEFAULT_WINDOW_WIDTH: f64 = 1200.0;
const DEFAULT_WINDOW_HEIGHT: f64 = 760.0;
const MIN_WINDOW_WIDTH: f64 = 900.0;
const MIN_WINDOW_HEIGHT: f64 = 600.0;
const MAX_WORK_AREA_RATIO: f64 = 0.86;

fn configure_startup_window(app: &tauri::App) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());

    if let Some(monitor) = monitor {
        let scale = monitor.scale_factor();
        let work_area = monitor.work_area();
        let wa_w = (work_area.size.width as f64) / scale;
        let wa_h = (work_area.size.height as f64) / scale;
        let wa_x = (work_area.position.x as f64) / scale;
        let wa_y = (work_area.position.y as f64) / scale;

        let target_w = (wa_w * MAX_WORK_AREA_RATIO)
            .round()
            .min(DEFAULT_WINDOW_WIDTH)
            .max(MIN_WINDOW_WIDTH.min(wa_w));
        let target_h = (wa_h * MAX_WORK_AREA_RATIO)
            .round()
            .min(DEFAULT_WINDOW_HEIGHT)
            .max(MIN_WINDOW_HEIGHT.min(wa_h));

        let pos_x = (wa_x + (wa_w - target_w) / 2.0).round();
        let pos_y = (wa_y + (wa_h - target_h) / 2.0).round();

        let _ = window.set_size(LogicalSize::new(target_w, target_h));
        let _ = window.set_position(LogicalPosition::new(pos_x, pos_y));
    } else {
        let _ = window.center();
    }

    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let _ = workspace::ensure_windows_aumid(app.handle());
            configure_startup_window(app);
            Ok(())
        })
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
            cloud::cloud_workspace_stats,
            cloud::cloud_pick_folder,
            cloud::cloud_sync_to_folder,
            cloud::cloud_restore_from_folder,
            cloud::cloud_export_zip,
            cloud::cloud_import_zip,
            cloud::cloud_save_text_export,
            cloud::cloud_read_image_base64,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
