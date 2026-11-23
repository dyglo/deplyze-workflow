export interface RgbaColor {
  hex: string; // #RRGGBB
  opacity: number; // 0..100
}

export interface CandleSettings {
  colorBarsOnPrevClose: boolean;
  drawBody: boolean;
  bodyUp: RgbaColor;
  bodyDown: RgbaColor;
  drawBorder: boolean;
  borderUp: RgbaColor;
  borderDown: RgbaColor;
  drawWick: boolean;
  wickUp: RgbaColor;
  wickDown: RgbaColor;
}

export interface ChartSettings {
  verticalGrid: boolean;
  horizontalGrid: boolean;
  candles: CandleSettings;
}

export const CHART_SETTINGS_KEY = 'deplyzeworkflow-chart-settings';

const UP_DEFAULT: RgbaColor = { hex: '#089981', opacity: 100 };
const DOWN_DEFAULT: RgbaColor = { hex: '#F23645', opacity: 100 };

export function createDefaultChartSettings(): ChartSettings {
  return {
    verticalGrid: false,
    horizontalGrid: false,
    candles: {
      colorBarsOnPrevClose: false,
      drawBody: true,
      bodyUp: { ...UP_DEFAULT },
      bodyDown: { ...DOWN_DEFAULT },
      drawBorder: true,
      borderUp: { ...UP_DEFAULT },
      borderDown: { ...DOWN_DEFAULT },
      drawWick: true,
      wickUp: { ...UP_DEFAULT },
      wickDown: { ...DOWN_DEFAULT }
    }
  };
}

export function cloneChartSettings(s: ChartSettings): ChartSettings {
  return {
    verticalGrid: s.verticalGrid,
    horizontalGrid: s.horizontalGrid,
    candles: {
      colorBarsOnPrevClose: s.candles.colorBarsOnPrevClose,
      drawBody: s.candles.drawBody,
      bodyUp: { ...s.candles.bodyUp },
      bodyDown: { ...s.candles.bodyDown },
      drawBorder: s.candles.drawBorder,
      borderUp: { ...s.candles.borderUp },
      borderDown: { ...s.candles.borderDown },
      drawWick: s.candles.drawWick,
      wickUp: { ...s.candles.wickUp },
      wickDown: { ...s.candles.wickDown }
    }
  };
}

function sanitizeColor(raw: unknown, fallback: RgbaColor): RgbaColor {
  if (!raw || typeof raw !== 'object') return { ...fallback };
  const obj = raw as Partial<RgbaColor>;
  const hex =
    typeof obj.hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(obj.hex)
      ? obj.hex.toUpperCase()
      : fallback.hex;
  const opacity =
    typeof obj.opacity === 'number' && Number.isFinite(obj.opacity)
      ? Math.round(Math.min(100, Math.max(0, obj.opacity)))
      : fallback.opacity;
  return { hex, opacity };
}

export function toRgba(color: RgbaColor): string {
  const clean = color.hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  const a = Math.round(Math.min(100, Math.max(0, color.opacity))) / 100;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export function loadChartSettings(): ChartSettings {
  const defaults = createDefaultChartSettings();
  if (typeof localStorage === 'undefined') return defaults;

  try {
    const raw = localStorage.getItem(CHART_SETTINGS_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<ChartSettings>;
    const c = (parsed.candles ?? {}) as Partial<CandleSettings>;

    return {
      verticalGrid:
        typeof parsed.verticalGrid === 'boolean' ? parsed.verticalGrid : defaults.verticalGrid,
      horizontalGrid:
        typeof parsed.horizontalGrid === 'boolean'
          ? parsed.horizontalGrid
          : defaults.horizontalGrid,
      candles: {
        colorBarsOnPrevClose:
          typeof c.colorBarsOnPrevClose === 'boolean'
            ? c.colorBarsOnPrevClose
            : defaults.candles.colorBarsOnPrevClose,
        drawBody: typeof c.drawBody === 'boolean' ? c.drawBody : defaults.candles.drawBody,
        bodyUp: sanitizeColor(c.bodyUp, UP_DEFAULT),
        bodyDown: sanitizeColor(c.bodyDown, DOWN_DEFAULT),
        drawBorder: typeof c.drawBorder === 'boolean' ? c.drawBorder : defaults.candles.drawBorder,
        borderUp: sanitizeColor(c.borderUp, UP_DEFAULT),
        borderDown: sanitizeColor(c.borderDown, DOWN_DEFAULT),
        drawWick: typeof c.drawWick === 'boolean' ? c.drawWick : defaults.candles.drawWick,
        wickUp: sanitizeColor(c.wickUp, UP_DEFAULT),
        wickDown: sanitizeColor(c.wickDown, DOWN_DEFAULT)
      }
    };
  } catch {
    return defaults;
  }
}

export function saveChartSettings(settings: ChartSettings): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(CHART_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage quota / privacy errors
  }
}
