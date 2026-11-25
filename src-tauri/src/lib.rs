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

/// Injected into subframes so embedded TradingView chart widgets reserve exact vertical space
/// beneath the main symbol title row for Paper Ledger's Buy/Sell pills and report the exact
/// legend slot coordinates (top & left) back to the parent window.
const TV_LEGEND_OFFSET_SCRIPT: &str = r#"
(function () {
  try {
    var host = (window.location && window.location.hostname) || '';
    if (host.indexOf('tradingview.com') === -1 && host.indexOf('tradingview-widget.com') === -1) {
      return;
    }
    var offsetPx = 0;
    var rafId = 0;
    var lastTop = -1;
    var lastLeft = -1;

    function syncLegend() {
      rafId = 0;
      var seriesEl =
        document.querySelector('[data-qa-id="legend-series-item"]') ||
        document.querySelector('[data-name="legend-series-item"]');
      var sourcesWrap = document.querySelector('[data-qa-id="legend-sources-wrapper"]');

      var prev = document.querySelectorAll('[data-deplyze-paper-gap]');
      var target = sourcesWrap || seriesEl;

      for (var i = 0; i < prev.length; i++) {
        if (prev[i] !== target) {
          prev[i].style.marginTop = '';
          prev[i].style.marginBottom = '';
          prev[i].removeAttribute('data-deplyze-paper-gap');
        }
      }

      if (target) {
        if (offsetPx > 0) {
          var desired = offsetPx + 'px';
          if (target === sourcesWrap) {
            if (target.style.marginTop !== desired) target.style.marginTop = desired;
            target.style.marginBottom = '';
          } else {
            if (target.style.marginBottom !== desired) target.style.marginBottom = desired;
            target.style.marginTop = '';
          }
          target.setAttribute('data-deplyze-paper-gap', '1');
        } else {
          target.style.marginTop = '';
          target.style.marginBottom = '';
          target.removeAttribute('data-deplyze-paper-gap');
        }
      }

      if (seriesEl && window.parent && window.parent !== window) {
        var r = seriesEl.getBoundingClientRect();
        if (r.width > 20 && r.height > 10) {
          var nextTop = Math.round(r.bottom + 3);
          var nextLeft = Math.round(r.left);
          if (nextTop !== lastTop || nextLeft !== lastLeft) {
            lastTop = nextTop;
            lastLeft = nextLeft;
            window.parent.postMessage(
              { type: 'deplyze:legend-slot', top: nextTop, left: nextLeft },
              '*'
            );
          }
        }
      }
    }

    function scheduleSync() {
      if (!rafId) {
        rafId = window.requestAnimationFrame(syncLegend);
      }
    }

    window.addEventListener('message', function (e) {
      var d = e && e.data;
      if (typeof d === 'string') {
        try {
          d = JSON.parse(d);
        } catch (_) {
          return;
        }
      }
      if (!d || d.type !== 'deplyze:paper-dock') return;
      var next =
        typeof d.offsetPx === 'number' && isFinite(d.offsetPx)
          ? Math.max(0, Math.round(d.offsetPx))
          : 0;
      if (next !== offsetPx) {
        offsetPx = next;
      }
      // Force re-report of slot coordinates whenever dock state syncs
      lastTop = -1;
      scheduleSync();
    });

    window.addEventListener('resize', scheduleSync);

    function startObserver() {
      if (!document.documentElement) return;
      var mo = new MutationObserver(scheduleSync);
      mo.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style']
      });
      scheduleSync();
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startObserver, { once: true });
    } else {
      startObserver();
    }
  } catch (_) {}
})();
"#;

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
            if app.get_webview_window("main").is_none() {
                if let Some(win_cfg) = app.config().app.windows.first() {
                    let _ = tauri::WebviewWindowBuilder::from_config(app, win_cfg)?
                        .initialization_script_for_all_frames(TV_LEGEND_OFFSET_SCRIPT)
                        .build()?;
                }
            }
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
