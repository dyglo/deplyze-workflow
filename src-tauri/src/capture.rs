use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRegion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub viewport_width: f64,
    pub viewport_height: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedChart {
    pub data_url: String,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
}

#[cfg(target_os = "windows")]
mod win {
    use super::{CaptureRegion, CapturedChart};
    use base64::Engine;
    use image::codecs::jpeg::JpegEncoder;
    use image::imageops::FilterType;
    use image::{DynamicImage, RgbaImage};
    use std::ffi::c_void;
    use std::io::Cursor;
    use tauri::WebviewWindow;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
        ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
    use windows::Win32::UI::WindowsAndMessaging::GetClientRect;

    // PW_CLIENTONLY (0x1) | PW_RENDERFULLCONTENT (0x2) captures GPU-composited WebView2 content
    const PW_CLIENT_FULL_CONTENT: u32 = 0x0000_0001 | 0x0000_0002;
    const MAX_OUTPUT_WIDTH: u32 = 1440;
    const JPEG_QUALITY: u8 = 86;

    pub fn capture_region(
        window: &WebviewWindow,
        region: CaptureRegion,
    ) -> Result<CapturedChart, String> {
        let raw_hwnd = window
            .hwnd()
            .map_err(|e| format!("Failed to obtain native window handle: {e}"))?;
        let hwnd = HWND(raw_hwnd.0 as *mut c_void);

        let (client_w, client_h, rgba_bytes) = unsafe {
            let mut rect = RECT::default();
            GetClientRect(hwnd, &mut rect)
                .map_err(|e| format!("GetClientRect failed: {e}"))?;
            let width = (rect.right - rect.left).max(1);
            let height = (rect.bottom - rect.top).max(1);

            let hdc_window = GetDC(hwnd);
            if hdc_window.is_invalid() {
                return Err("GetDC returned invalid device context".to_string());
            }

            let hdc_mem = CreateCompatibleDC(hdc_window);
            if hdc_mem.is_invalid() {
                ReleaseDC(hwnd, hdc_window);
                return Err("CreateCompatibleDC failed".to_string());
            }

            let hbitmap = CreateCompatibleBitmap(hdc_window, width, height);
            if hbitmap.is_invalid() {
                let _ = DeleteDC(hdc_mem);
                ReleaseDC(hwnd, hdc_window);
                return Err("CreateCompatibleBitmap failed".to_string());
            }

            let old_obj = SelectObject(hdc_mem, hbitmap);
            let ok = PrintWindow(hwnd, hdc_mem, PRINT_WINDOW_FLAGS(PW_CLIENT_FULL_CONTENT));
            if !ok.as_bool() {
                SelectObject(hdc_mem, old_obj);
                let _ = DeleteObject(hbitmap);
                let _ = DeleteDC(hdc_mem);
                ReleaseDC(hwnd, hdc_window);
                return Err("PrintWindow failed to render WebView2 surface".to_string());
            }

            let mut bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height, // top-down DIB
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };

            let mut buffer = vec![0u8; (width as usize) * (height as usize) * 4];
            let lines = GetDIBits(
                hdc_mem,
                hbitmap,
                0,
                height as u32,
                Some(buffer.as_mut_ptr() as *mut c_void),
                &mut bmi,
                DIB_RGB_COLORS,
            );

            SelectObject(hdc_mem, old_obj);
            let _ = DeleteObject(hbitmap);
            let _ = DeleteDC(hdc_mem);
            ReleaseDC(hwnd, hdc_window);

            if lines == 0 {
                return Err("GetDIBits failed to read captured bitmap".to_string());
            }

            // BGRA -> RGBA (force opaque alpha)
            for px in buffer.chunks_exact_mut(4) {
                px.swap(0, 2);
                px[3] = 255;
            }

            (width as u32, height as u32, buffer)
        };

        let full_img = RgbaImage::from_raw(client_w, client_h, rgba_bytes)
            .ok_or_else(|| "Failed to build RGBA image buffer".to_string())?;

        // Map CSS viewport coords cleanly into physical client pixels (zoom-safe)
        let scale_x = if region.viewport_width > 0.0 {
            (client_w as f64) / region.viewport_width
        } else {
            1.0
        };
        let scale_y = if region.viewport_height > 0.0 {
            (client_h as f64) / region.viewport_height
        } else {
            1.0
        };

        let crop_x = ((region.x * scale_x).round().max(0.0) as u32).min(client_w.saturating_sub(1));
        let crop_y = ((region.y * scale_y).round().max(0.0) as u32).min(client_h.saturating_sub(1));
        let crop_w = ((region.width * scale_x).round().max(1.0) as u32)
            .min(client_w.saturating_sub(crop_x));
        let crop_h = ((region.height * scale_y).round().max(1.0) as u32)
            .min(client_h.saturating_sub(crop_y));

        if crop_w < 16 || crop_h < 16 {
            return Err("Captured chart region is too small".to_string());
        }

        let mut dyn_img = DynamicImage::ImageRgba8(full_img).crop_imm(crop_x, crop_y, crop_w, crop_h);

        // Downscale oversized 4K captures cleanly while keeping candlesticks & price labels crisp
        if dyn_img.width() > MAX_OUTPUT_WIDTH {
            let target_h = ((dyn_img.height() as f64) * (MAX_OUTPUT_WIDTH as f64)
                / (dyn_img.width() as f64))
                .round()
                .max(1.0) as u32;
            dyn_img = dyn_img.resize_exact(MAX_OUTPUT_WIDTH, target_h, FilterType::Triangle);
        }

        let rgb = dyn_img.to_rgb8();
        let out_w = rgb.width();
        let out_h = rgb.height();

        let mut jpeg_bytes = Cursor::new(Vec::new());
        let mut encoder = JpegEncoder::new_with_quality(&mut jpeg_bytes, JPEG_QUALITY);
        encoder
            .encode_image(&DynamicImage::ImageRgb8(rgb))
            .map_err(|e| format!("Failed to encode chart JPEG: {e}"))?;

        let b64 = base64::engine::general_purpose::STANDARD.encode(jpeg_bytes.into_inner());
        Ok(CapturedChart {
            data_url: format!("data:image/jpeg;base64,{b64}"),
            mime_type: "image/jpeg".to_string(),
            width: out_w,
            height: out_h,
        })
    }
}

#[tauri::command]
pub fn capture_chart_region(
    window: WebviewWindow,
    region: CaptureRegion,
) -> Result<CapturedChart, String> {
    #[cfg(target_os = "windows")]
    {
        win::capture_region(&window, region)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, region);
        Err("Native chart capture is currently supported on Windows only".to_string())
    }
}
