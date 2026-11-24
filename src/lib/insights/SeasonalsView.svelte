<script lang="ts">
  import { untrack } from 'svelte';
  import type { SeasonalDayPoint, SeasonalYearSeries, SymbolSeasonalsPayload } from './symbolInsightsApi';

  type DisplayMode = 'chart' | 'table';
  type ValueMode = 'percent' | 'abs' | 'indexed';

  interface Props {
    theme: 'dark' | 'light';
    data: SymbolSeasonalsPayload | null;
    loading: boolean;
    error: string | null;
    onRetry: () => void;
  }

  let { theme, data, loading, error, onRetry }: Props = $props();

  let displayMode = $state<DisplayMode>('chart');
  let valueMode = $state<ValueMode>('percent');
  let showAverage = $state(false);
  let valueMenuOpen = $state(false);
  let startYear = $state(2021);
  let endYear = $state(2026);
  let lastBoundRangeKey = '';

  // Chart interactivity state
  let chartWrapEl: HTMLDivElement | undefined = $state();
  let svgEl: SVGSVGElement | undefined = $state();
  let chartWidth = $state(760);
  let chartHeight = $state(430);
  let hoverDoy = $state<number | null>(null);
  let hoverClientX = $state(0);
  let hoverClientY = $state(0);
  let emphasizedYear = $state<number | null>(null);
  let snapshotFeedback = $state(false);

  // Dual-thumb slider drag state
  let sliderTrackEl: HTMLDivElement | undefined = $state();
  let dragKind = $state<'start' | 'end' | 'window' | null>(null);
  let dragAnchorX = 0;
  let dragOrigStart = 0;
  let dragOrigEnd = 0;

  // Sync default 6-year window (matching TradingView default e.g. 2021..2026) when a new symbol loads
  $effect(() => {
    const key = data ? `${data.symbol}|${data.minYear}|${data.maxYear}` : '';
    if (!data || !key) return;
    untrack(() => {
      if (key === lastBoundRangeKey) return;
      lastBoundRangeKey = key;
      const maxY = data.maxYear;
      const minY = data.minYear;
      endYear = maxY;
      startYear = Math.max(minY, maxY - 5);
      hoverDoy = null;
      emphasizedYear = null;
    });
  });

  // ResizeObserver for crisp responsive SVG scaling
  $effect(() => {
    const el = chartWrapEl;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      if (rect.width > 120) chartWidth = Math.round(rect.width);
      if (rect.height > 180) chartHeight = Math.round(rect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  });

  const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTH_START_DOY = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
  const MONTH_NAMES_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // TradingView-inspired distinct seasonal palette (current year always highlighted in #2962ff)
  const YEAR_PALETTE = [
    '#22c55e', // green (e.g. 2025)
    '#f59e0b', // amber (e.g. 2024)
    '#06b6d4', // cyan (e.g. 2023)
    '#db2777', // magenta (e.g. 2022)
    '#eab308', // yellow (e.g. 2021)
    '#a855f7', // purple
    '#14b8a6', // teal
    '#f97316', // orange
    '#ec4899', // pink
    '#84cc16'  // lime
  ];

  function colorForYear(year: number, currentYr: number): string {
    if (year === currentYr) return '#2962ff';
    const offset = Math.max(0, currentYr - 1 - year);
    return YEAR_PALETTE[offset % YEAR_PALETTE.length];
  }

  function pointValue(pt: SeasonalDayPoint, mode: ValueMode): number {
    if (mode === 'abs') return pt.abs;
    if (mode === 'indexed') return pt.idx;
    return pt.pct;
  }

  function formatModeVal(val: number | null, mode: ValueMode): string {
    if (val == null || !Number.isFinite(val)) return '—';
    if (mode === 'percent') {
      const sign = val > 0 ? '' : '';
      return `${sign}${val.toFixed(2)}%`;
    }
    if (mode === 'indexed') {
      return val.toFixed(2);
    }
    const sign = val > 0 ? '+' : '';
    const digits = Math.abs(val) < 5 ? 4 : 2;
    return `${sign}${val.toFixed(digits)}`;
  }

  function formatDoyLabel(doy: number): string {
    const clamped = Math.max(0, Math.min(365, Math.round(doy)));
    let mIdx = 0;
    for (let i = 11; i >= 0; i--) {
      if (clamped >= MONTH_START_DOY[i]) {
        mIdx = i;
        break;
      }
    }
    const dayNum = clamped - MONTH_START_DOY[mIdx] + 1;
    return `${dayNum} ${MONTH_NAMES_SHORT[mIdx]}`;
  }

  const visibleYears = $derived.by<SeasonalYearSeries[]>(() => {
    if (!data) return [];
    return data.years.filter((y) => y.year >= startYear && y.year <= endYear);
  });

  // Lookup / interpolate value for a year at a given day-of-year (returns null past last known day of current year)
  function valueAtDoy(series: SeasonalYearSeries, doy: number, mode: ValueMode): number | null {
    const pts = series.points;
    if (pts.length === 0) return null;
    if (doy < pts[0].doy) return pointValue(pts[0], mode);
    if (doy > pts[pts.length - 1].doy) return null;
    // Binary search nearest point <= doy
    let lo = 0;
    let hi = pts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].doy === doy) return pointValue(pts[mid], mode);
      if (pts[mid].doy < doy) lo = mid + 1;
      else hi = mid - 1;
    }
    const left = pts[Math.max(0, hi)];
    const right = pts[Math.min(pts.length - 1, lo)];
    if (!right || left.doy === right.doy) return pointValue(left, mode);
    const t = (doy - left.doy) / (right.doy - left.doy);
    const lv = pointValue(left, mode);
    const rv = pointValue(right, mode);
    return lv + (rv - lv) * t;
  }

  // Dynamic Average seasonal curve across selected years (recomputed instantly when slider moves!)
  const averageCurve = $derived.by<{ doy: number; val: number }[]>(() => {
    if (!showAverage || visibleYears.length === 0) return [];
    const out: { doy: number; val: number }[] = [];
    for (let doy = 0; doy <= 365; doy += 2) {
      let sum = 0;
      let count = 0;
      for (const y of visibleYears) {
        const v = valueAtDoy(y, doy, valueMode);
        if (v != null) {
          sum += v;
          count += 1;
        }
      }
      if (count > 0) {
        out.push({ doy, val: sum / count });
      }
    }
    return out;
  });

  // Chart layout metrics
  const PAD_LEFT = 14;
  const PAD_TOP = 16;
  const PAD_RIGHT = 114;
  const PAD_BOTTOM = 28;

  const plotW = $derived(Math.max(180, chartWidth - PAD_LEFT - PAD_RIGHT));
  const plotH = $derived(Math.max(140, chartHeight - PAD_TOP - PAD_BOTTOM));

  const yDomain = $derived.by<{ min: number; max: number; ticks: number[] }>(() => {
    let minVal = Infinity;
    let maxVal = -Infinity;
    for (const y of visibleYears) {
      for (const pt of y.points) {
        const v = pointValue(pt, valueMode);
        if (v < minVal) minVal = v;
        if (v > maxVal) maxVal = v;
      }
    }
    if (showAverage) {
      for (const pt of averageCurve) {
        if (pt.val < minVal) minVal = pt.val;
        if (pt.val > maxVal) maxVal = pt.val;
      }
    }
    if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) {
      const base = valueMode === 'indexed' ? 100 : 0;
      minVal = base - 10;
      maxVal = base + 10;
    }
    const baseline = valueMode === 'indexed' ? 100 : 0;
    minVal = Math.min(minVal, baseline);
    maxVal = Math.max(maxVal, baseline);
    const span = Math.max(maxVal - minVal, 1);
    const pad = span * 0.08;
    const rawMin = minVal - pad;
    const rawMax = maxVal + pad;

    // Nice tick interval
    const rawStep = (rawMax - rawMin) / 7;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep || 1)));
    const norm = rawStep / mag;
    const niceMult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
    const step = niceMult * mag;
    const niceMin = Math.floor(rawMin / step) * step;
    const niceMax = Math.ceil(rawMax / step) * step;

    const ticks: number[] = [];
    for (let v = niceMin; v <= niceMax + step * 0.001; v += step) {
      ticks.push(Number(v.toFixed(6)));
      if (ticks.length > 16) break;
    }
    return { min: niceMin, max: niceMax, ticks };
  });

  function xForDoy(doy: number): number {
    return PAD_LEFT + (doy / 365) * plotW;
  }

  function yForVal(val: number): number {
    const span = yDomain.max - yDomain.min || 1;
    return PAD_TOP + (1 - (val - yDomain.min) / span) * plotH;
  }

  const seriesPaths = $derived.by(() => {
    const curYr = data?.currentYear ?? new Date().getUTCFullYear();
    return visibleYears.map((y) => {
      const color = colorForYear(y.year, curYr);
      const isCurrent = y.year === curYr;
      const pts = y.points;
      const d = pts
        .map((pt, idx) => {
          const x = xForDoy(pt.doy).toFixed(1);
          const py = yForVal(pointValue(pt, valueMode)).toFixed(1);
          return `${idx === 0 ? 'M' : 'L'}${x},${py}`;
        })
        .join(' ');
      const lastPt = pts[pts.length - 1];
      const endVal = lastPt ? pointValue(lastPt, valueMode) : 0;
      const rawEndY = yForVal(endVal);
      return {
        year: y.year,
        color,
        isCurrent,
        d,
        endVal,
        rawEndY,
        series: y
      };
    });
  });

  // Anti-collided right-side year badges (just like TradingView's colored pill labels)
  const rightBadges = $derived.by(() => {
    const sorted = [...seriesPaths]
      .sort((a, b) => a.rawEndY - b.rawEndY)
      .map((s) => ({
        year: s.year,
        color: s.color,
        isCurrent: s.isCurrent,
        val: s.endVal,
        y: Math.max(PAD_TOP + 10, Math.min(PAD_TOP + plotH - 10, s.rawEndY))
      }));

    const minGap = 21;
    // Push overlapping badges apart cleanly
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].y - sorted[i - 1].y < minGap) {
          const mid = (sorted[i].y + sorted[i - 1].y) / 2;
          sorted[i - 1].y = mid - minGap / 2;
          sorted[i].y = mid + minGap / 2;
        }
      }
      for (let i = 0; i < sorted.length; i++) {
        sorted[i].y = Math.max(PAD_TOP + 10, Math.min(PAD_TOP + plotH - 10, sorted[i].y));
      }
    }
    return sorted;
  });

  const averagePathD = $derived.by(() => {
    if (averageCurve.length < 2) return '';
    return averageCurve
      .map((pt, idx) => `${idx === 0 ? 'M' : 'L'}${xForDoy(pt.doy).toFixed(1)},${yForVal(pt.val).toFixed(1)}`)
      .join(' ');
  });

  // Crosshair hover rows matching Screenshot 8
  const crosshairInfo = $derived.by(() => {
    if (hoverDoy == null || visibleYears.length === 0) return null;
    const curYr = data?.currentYear ?? new Date().getUTCFullYear();
    const x = xForDoy(hoverDoy);
    const rows = visibleYears.map((y) => {
      const val = valueAtDoy(y, hoverDoy!, valueMode);
      return {
        year: y.year,
        color: colorForYear(y.year, curYr),
        isCurrent: y.year === curYr,
        val,
        yPx: val != null ? yForVal(val) : null
      };
    });
    let avgVal: number | null = null;
    if (showAverage) {
      let s = 0;
      let c = 0;
      for (const r of rows) {
        if (r.val != null) {
          s += r.val;
          c += 1;
        }
      }
      if (c > 0) avgVal = s / c;
    }
    return {
      doy: hoverDoy,
      dateLabel: formatDoyLabel(hoverDoy),
      x,
      rows,
      avgVal
    };
  });

  function onChartPointerMove(e: PointerEvent) {
    if (!svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    if (localX < PAD_LEFT || localX > PAD_LEFT + plotW) {
      hoverDoy = null;
      return;
    }
    const frac = Math.max(0, Math.min(1, (localX - PAD_LEFT) / plotW));
    hoverDoy = Math.round(frac * 365);
    hoverClientX = localX;
    hoverClientY = localY;
  }

  function onChartPointerLeave() {
    hoverDoy = null;
  }

  // Dual-thumb year range slider calculations & pointer handlers
  const sliderMinYear = $derived(data?.minYear ?? 2000);
  const sliderMaxYear = $derived(data?.maxYear ?? new Date().getUTCFullYear());
  const sliderSpan = $derived(Math.max(1, sliderMaxYear - sliderMinYear));
  const startPct = $derived(((startYear - sliderMinYear) / sliderSpan) * 100);
  const endPct = $derived(((endYear - sliderMinYear) / sliderSpan) * 100);

  const sliderTicks = $derived.by<number[]>(() => {
    const min = sliderMinYear;
    const max = sliderMaxYear;
    if (max <= min) return [min];
    const count = 4;
    const out: number[] = [];
    for (let i = 0; i <= count; i++) {
      const y = Math.round(min + ((max - min) * i) / count);
      if (!out.includes(y)) out.push(y);
    }
    return out;
  });

  function yearFromClientX(clientX: number): number {
    if (!sliderTrackEl) return startYear;
    const rect = sliderTrackEl.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    return Math.round(sliderMinYear + frac * sliderSpan);
  }

  function startSliderDrag(kind: 'start' | 'end' | 'window', e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragKind = kind;
    dragAnchorX = e.clientX;
    dragOrigStart = startYear;
    dragOrigEnd = endYear;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function moveSliderDrag(e: PointerEvent) {
    if (!dragKind || !sliderTrackEl) return;
    if (dragKind === 'start') {
      const yr = yearFromClientX(e.clientX);
      startYear = Math.max(sliderMinYear, Math.min(endYear - 1, yr));
    } else if (dragKind === 'end') {
      const yr = yearFromClientX(e.clientX);
      endYear = Math.min(sliderMaxYear, Math.max(startYear + 1, yr));
    } else if (dragKind === 'window') {
      const rect = sliderTrackEl.getBoundingClientRect();
      const deltaYears = Math.round(((e.clientX - dragAnchorX) / Math.max(1, rect.width)) * sliderSpan);
      const winSize = dragOrigEnd - dragOrigStart;
      let nextStart = dragOrigStart + deltaYears;
      let nextEnd = nextStart + winSize;
      if (nextStart < sliderMinYear) {
        nextStart = sliderMinYear;
        nextEnd = Math.min(sliderMaxYear, nextStart + winSize);
      }
      if (nextEnd > sliderMaxYear) {
        nextEnd = sliderMaxYear;
        nextStart = Math.max(sliderMinYear, nextEnd - winSize);
      }
      startYear = nextStart;
      endYear = nextEnd;
    }
  }

  function endSliderDrag(e: PointerEvent) {
    if (!dragKind) return;
    dragKind = null;
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) {
      el.releasePointerCapture(e.pointerId);
    }
  }

  function applyQuickRange(yearsBack: number | 'all') {
    endYear = sliderMaxYear;
    if (yearsBack === 'all') {
      startYear = sliderMinYear;
    } else {
      startYear = Math.max(sliderMinYear, sliderMaxYear - (yearsBack - 1));
    }
  }

  // Monthly heatmap table calculations
  const tableRows = $derived([...visibleYears].sort((a, b) => b.year - a.year));

  const monthlySummary = $derived.by(() => {
    const avg: (number | null)[] = [];
    const winRate: (number | null)[] = [];
    for (let m = 0; m < 12; m++) {
      let sum = 0;
      let wins = 0;
      let count = 0;
      for (const y of visibleYears) {
        const v = y.months[m];
        if (v != null && Number.isFinite(v)) {
          sum += v;
          if (v > 0) wins += 1;
          count += 1;
        }
      }
      avg.push(count > 0 ? sum / count : null);
      winRate.push(count > 0 ? (wins / count) * 100 : null);
    }
    const annualVals = visibleYears.map((y) => y.totalPct);
    const annualAvg =
      annualVals.length > 0 ? annualVals.reduce((a, b) => a + b, 0) / annualVals.length : null;
    const annualWin =
      annualVals.length > 0
        ? (annualVals.filter((v) => v > 0).length / annualVals.length) * 100
        : null;
    return { avg, winRate, annualAvg, annualWin };
  });

  function cellHeatBg(val: number | null): string {
    if (val == null || !Number.isFinite(val)) return 'transparent';
    const intensity = Math.min(0.32, Math.abs(val) / 28);
    if (val > 0) return `rgba(8, 153, 129, ${Math.max(0.06, intensity).toFixed(2)})`;
    if (val < 0) return `rgba(242, 54, 69, ${Math.max(0.06, intensity).toFixed(2)})`;
    return 'transparent';
  }

  // Snapshot chart export as PNG
  async function exportSnapshot() {
    if (!svgEl || !data) return;
    try {
      const clone = svgEl.cloneNode(true) as SVGSVGElement;
      const w = chartWidth;
      const h = chartHeight;
      clone.setAttribute('width', String(w));
      clone.setAttribute('height', String(h));
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bgRect.setAttribute('width', String(w));
      bgRect.setAttribute('height', String(h));
      bgRect.setAttribute('fill', theme === 'light' ? '#ffffff' : '#0b0b0b');
      clone.insertBefore(bgRect, clone.firstChild);

      const xml = new XMLSerializer().serializeToString(clone);
      const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = (err) => reject(err);
        img.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = w * 2;
      canvas.height = h * 2;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.scale(2, 2);
        ctx.drawImage(img, 0, 0, w, h);
        const pngUrl = canvas.toDataURL('image/png');
        const link = document.createElement('a');
        link.href = pngUrl;
        link.download = `${data.shortName}-seasonals-${startYear}-${endYear}.png`;
        link.click();
      }
      URL.revokeObjectURL(url);
      snapshotFeedback = true;
      setTimeout(() => {
        snapshotFeedback = false;
      }, 1800);
    } catch {
      // ignore export errors
    }
  }

  function onWindowPointerDown(e: PointerEvent) {
    const target = e.target as HTMLElement | null;
    if (valueMenuOpen && target && !target.closest('[data-sv-pop]')) {
      valueMenuOpen = false;
    }
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div class="seasonals-root" class:light={theme === 'light'}>
  <!-- Top Toolbar matching TradingView Seasonals (Screenshots 7 & 8) -->
  <div class="sv-toolbar">
    <div class="sv-left">
      <div class="seg-group" role="tablist" aria-label="Seasonals view mode">
        <button
          class="seg-btn"
          class:active={displayMode === 'chart'}
          type="button"
          role="tab"
          aria-selected={displayMode === 'chart'}
          title="Seasonals chart view"
          onclick={() => (displayMode = 'chart')}
        >
          <svg viewBox="0 0 18 18" aria-hidden="true">
            <path d="M2.5 13 6.5 8.5l3.5 3 5.5-6.5" />
          </svg>
        </button>
        <button
          class="seg-btn"
          class:active={displayMode === 'table'}
          type="button"
          role="tab"
          aria-selected={displayMode === 'table'}
          title="Monthly returns table view"
          onclick={() => (displayMode = 'table')}
        >
          <svg viewBox="0 0 18 18" aria-hidden="true">
            <rect x="2.75" y="3.25" width="12.5" height="11.5" rx="1.75" />
            <path d="M2.75 7.25h12.5M7.25 7.25v7.5" />
          </svg>
        </button>
      </div>

      <div class="quick-range">
        {#each [
          { label: '5Y', val: 5 as const },
          { label: '10Y', val: 10 as const },
          { label: 'All', val: 'all' as const }
        ] as preset (preset.label)}
          {@const isActive =
            preset.val === 'all'
              ? startYear === sliderMinYear && endYear === sliderMaxYear
              : endYear === sliderMaxYear && endYear - startYear + 1 === preset.val}
          <button
            class="qr-pill"
            class:active={isActive}
            type="button"
            onclick={() => applyQuickRange(preset.val)}
          >
            {preset.label}
          </button>
        {/each}
        <span class="range-caption">{startYear}–{endYear}</span>
      </div>
    </div>

    <div class="sv-right">
      <button
        class="sv-ctrl-btn"
        class:active={showAverage}
        type="button"
        title="Overlay average seasonal curve across selected years"
        onclick={() => (showAverage = !showAverage)}
      >
        <svg viewBox="0 0 18 18" aria-hidden="true">
          <path d="M2.5 12.5 6 8.5l3 2.5 3.5-5 3 2" stroke-dasharray="2.4 2" />
        </svg>
        <span>Average</span>
      </button>

      <div class="sv-pop-anchor" data-sv-pop="true">
        <button
          class="sv-ctrl-btn"
          type="button"
          onclick={() => (valueMenuOpen = !valueMenuOpen)}
        >
          <span>
            {valueMode === 'percent'
              ? 'Percent'
              : valueMode === 'abs'
                ? 'Price change'
                : 'Indexed (100)'}
          </span>
          <svg class="chev" class:open={valueMenuOpen} viewBox="0 0 12 12" aria-hidden="true">
            <path d="m3 4.5 3 3 3-3" />
          </svg>
        </button>

        {#if valueMenuOpen}
          <div class="sv-menu">
            {#each [
              { id: 'percent' as ValueMode, label: 'Percent', sub: '% from year start' },
              { id: 'abs' as ValueMode, label: 'Price change', sub: 'Absolute points' },
              { id: 'indexed' as ValueMode, label: 'Indexed (100)', sub: 'Base 100 scale' }
            ] as opt (opt.id)}
              <button
                class="sv-menu-item"
                class:active={valueMode === opt.id}
                type="button"
                onclick={() => {
                  valueMode = opt.id;
                  valueMenuOpen = false;
                }}
              >
                <span>{opt.label}</span>
                <span class="sv-menu-sub">{opt.sub}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>

      {#if displayMode === 'chart'}
        <button
          class="sv-ctrl-btn icon-only"
          class:active={snapshotFeedback}
          type="button"
          title={snapshotFeedback ? 'Saved PNG snapshot' : 'Save seasonal chart snapshot (PNG)'}
          aria-label="Save chart snapshot"
          onclick={() => void exportSnapshot()}
        >
          <svg viewBox="0 0 18 18" aria-hidden="true">
            <path d="M3.25 6.25h2l1.1-1.75h5.3l1.1 1.75h2A1.5 1.5 0 0 1 16.25 7.75v6A1.5 1.5 0 0 1 14.75 15.25H3.25a1.5 1.5 0 0 1-1.5-1.5v-6a1.5 1.5 0 0 1 1.5-1.5Z" />
            <circle cx="9" cy="10.5" r="2.5" />
          </svg>
        </button>
      {/if}
    </div>
  </div>

  <!-- Dual-Thumb Year Range Slider matching TradingView Screenshots 7 & 8 -->
  {#if data && data.years.length > 1}
    <div class="slider-section">
      <div class="slider-labels">
        {#each sliderTicks as yr (yr)}
          <span class:current={yr === sliderMaxYear}>{yr}</span>
        {/each}
      </div>

      <div bind:this={sliderTrackEl} class="slider-track-wrap">
        <div class="slider-track-bg"></div>
        <!-- Active selected range segment (draggable to slide window!) -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="slider-track-active"
          style:left="{startPct}%"
          style:width="{Math.max(2, endPct - startPct)}%"
          onpointerdown={(e) => startSliderDrag('window', e)}
          onpointermove={moveSliderDrag}
          onpointerup={endSliderDrag}
          onpointercancel={endSliderDrag}
          title="Drag to shift year window ({startYear}–{endYear})"
        >
          <span class="slider-grip-dots" aria-hidden="true">⋮⋮</span>
        </div>

        <button
          class="slider-thumb"
          type="button"
          style:left="{startPct}%"
          aria-label="Start year ({startYear})"
          title="Start year: {startYear}"
          onpointerdown={(e) => startSliderDrag('start', e)}
          onpointermove={moveSliderDrag}
          onpointerup={endSliderDrag}
          onpointercancel={endSliderDrag}
        ></button>

        <button
          class="slider-thumb"
          type="button"
          style:left="{endPct}%"
          aria-label="End year ({endYear})"
          title="End year: {endYear}"
          onpointerdown={(e) => startSliderDrag('end', e)}
          onpointermove={moveSliderDrag}
          onpointerup={endSliderDrag}
          onpointercancel={endSliderDrag}
        ></button>
      </div>
    </div>
  {/if}

  <!-- Body: Loading / Error / Chart / Table -->
  {#if loading && !data}
    <div class="sv-state">
      <div class="sv-spinner"></div>
      <span>Loading multi-year seasonal history…</span>
    </div>
  {:else if error && !data}
    <div class="sv-state">
      <p class="sv-err">{error}</p>
      <button class="sv-retry-btn" type="button" onclick={onRetry}>Retry</button>
    </div>
  {:else if !data || data.years.length === 0}
    <div class="sv-state">
      <span>Seasonal daily history is unavailable for this symbol.</span>
    </div>
  {:else if displayMode === 'chart'}
    <div bind:this={chartWrapEl} class="sv-chart-wrap">
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <svg
        bind:this={svgEl}
        class="sv-svg"
        viewBox="0 0 {chartWidth} {chartHeight}"
        onpointermove={onChartPointerMove}
        onpointerleave={onChartPointerLeave}
      >
        <!-- Horizontal Y-axis gridlines & labels -->
        {#each yDomain.ticks as tick (tick)}
          {@const y = yForVal(tick)}
          {@const isZero = Math.abs(tick - (valueMode === 'indexed' ? 100 : 0)) < 0.0001}
          <line
            x1={PAD_LEFT}
            x2={PAD_LEFT + plotW}
            y1={y}
            y2={y}
            class={isZero ? 'grid-zero' : 'grid-line'}
          />
          <text
            x={PAD_LEFT + plotW + 8}
            y={y + 4}
            class="axis-text y-label"
          >
            {formatModeVal(tick, valueMode)}
          </text>
        {/each}

        <!-- Vertical Month gridlines & labels (Jan..Dec) -->
        {#each MONTH_LABELS as mLabel, mIdx (mLabel)}
          {@const x = xForDoy(MONTH_START_DOY[mIdx])}
          <line
            x1={x}
            x2={x}
            y1={PAD_TOP}
            y2={PAD_TOP + plotH}
            class="grid-month"
          />
          <text
            x={x + plotW / 24}
            y={PAD_TOP + plotH + 18}
            text-anchor="middle"
            class="axis-text x-label"
          >
            {mLabel}
          </text>
        {/each}

        <!-- Historical Year Lines (non-current first, current year bolded on top) -->
        {#each seriesPaths as sp (sp.year)}
          {#if !sp.isCurrent}
            <path
              d={sp.d}
              fill="none"
              stroke={sp.color}
              stroke-width={emphasizedYear === sp.year ? 2.4 : 1.35}
              stroke-linejoin="round"
              stroke-linecap="round"
              opacity={emphasizedYear !== null && emphasizedYear !== sp.year ? 0.22 : 0.88}
            />
          {/if}
        {/each}

        <!-- Average Seasonal Curve (dashed high-contrast overlay when toggled) -->
        {#if showAverage && averagePathD}
          <path
            d={averagePathD}
            fill="none"
            class="avg-line"
            stroke-width="2.2"
            stroke-dasharray="5 4"
            stroke-linejoin="round"
          />
        {/if}

        <!-- Current Year Highlighted Bold Line (TradingView blue #2962ff) -->
        {#each seriesPaths as sp (sp.year)}
          {#if sp.isCurrent}
            <path
              d={sp.d}
              fill="none"
              stroke={sp.color}
              stroke-width={emphasizedYear === sp.year ? 3 : 2.35}
              stroke-linejoin="round"
              stroke-linecap="round"
              opacity={emphasizedYear !== null && emphasizedYear !== sp.year ? 0.35 : 1}
            />
          {/if}
        {/each}

        <!-- Crosshair Vertical Line + Dots -->
        {#if crosshairInfo}
          <line
            x1={crosshairInfo.x}
            x2={crosshairInfo.x}
            y1={PAD_TOP}
            y2={PAD_TOP + plotH}
            class="crosshair-line"
          />
          {#each crosshairInfo.rows as row (row.year)}
            {#if row.yPx !== null}
              <circle
                cx={crosshairInfo.x}
                cy={row.yPx}
                r={row.isCurrent ? 4.2 : 3.4}
                fill={row.color}
                stroke={theme === 'light' ? '#ffffff' : '#0b0b0b'}
                stroke-width="1.5"
              />
            {/if}
          {/each}
        {/if}

        <!-- Right-side Colored Year Badges (matching TradingView Screenshots 7 & 8) -->
        {#each rightBadges as badge (badge.year)}
          {@const bx = PAD_LEFT + plotW + 4}
          {@const by = badge.y - 10}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <g
            class="year-badge"
            onmouseenter={() => (emphasizedYear = badge.year)}
            onmouseleave={() => (emphasizedYear = null)}
          >
            <rect
              x={bx}
              y={by}
              width="104"
              height="20"
              rx="4"
              fill={badge.color}
              opacity={emphasizedYear !== null && emphasizedYear !== badge.year ? 0.38 : 1}
            />
            <text x={bx + 6} y={by + 13.5} class="badge-yr">{badge.year}</text>
            <text x={bx + 98} y={by + 13.5} text-anchor="end" class="badge-val">
              {formatModeVal(badge.val, valueMode)}
            </text>
          </g>
        {/each}
      </svg>

      <!-- Floating Dark Crosshair Tooltip (exact TradingView Screenshot 8 layout) -->
      {#if crosshairInfo}
        {@const tipOnLeft = hoverClientX > PAD_LEFT + plotW * 0.62}
        {@const tipLeft = tipOnLeft ? Math.max(12, crosshairInfo.x - 166) : Math.min(chartWidth - 176, crosshairInfo.x + 14)}
        {@const tipTop = Math.max(16, Math.min(chartHeight - 190, hoverClientY - 50))}
        <div
          class="sv-tooltip"
          style:left="{tipLeft}px"
          style:top="{tipTop}px"
        >
          {#each crosshairInfo.rows as row (row.year)}
            <div class="tip-row" class:current={row.isCurrent}>
              <span class="tip-dot" style:background={row.color}></span>
              <span class="tip-yr">{row.year}</span>
              <span class="tip-val">{formatModeVal(row.val, valueMode)}</span>
            </div>
          {/each}
          {#if showAverage && crosshairInfo.avgVal !== null}
            <div class="tip-row avg">
              <span class="tip-dot avg-dot"></span>
              <span class="tip-yr">Avg</span>
              <span class="tip-val">{formatModeVal(crosshairInfo.avgVal, valueMode)}</span>
            </div>
          {/if}
          <div class="tip-date">{crosshairInfo.dateLabel}</div>
        </div>
      {/if}
    </div>
  {:else}
    <!-- Monthly Seasonal Returns Heatmap Table -->
    <div class="sv-table-wrap">
      <table class="sv-table">
        <thead>
          <tr>
            <th class="sticky-col">Year</th>
            {#each MONTH_LABELS as m (m)}
              <th>{m}</th>
            {/each}
            <th class="annual-col">Annual</th>
          </tr>
        </thead>
        <tbody>
          {#each tableRows as row (row.year)}
            <tr class:is-cur={row.year === data.currentYear}>
              <td class="sticky-col yr-cell">
                <span
                  class="yr-swatch"
                  style:background={colorForYear(row.year, data.currentYear)}
                ></span>
                <span>{row.year}</span>
              </td>
              {#each row.months as mVal, mIdx (mIdx)}
                <td
                  class="num-td"
                  class:pos={mVal !== null && mVal > 0}
                  class:neg={mVal !== null && mVal < 0}
                  style:background={cellHeatBg(mVal)}
                >
                  {mVal != null ? `${mVal > 0 ? '+' : ''}${mVal.toFixed(1)}%` : '—'}
                </td>
              {/each}
              <td
                class="num-td annual-col"
                class:pos={row.totalPct > 0}
                class:neg={row.totalPct < 0}
                style:background={cellHeatBg(row.totalPct)}
              >
                {row.totalPct > 0 ? '+' : ''}{row.totalPct.toFixed(2)}%
              </td>
            </tr>
          {/each}
        </tbody>
        <tfoot>
          <tr class="summary-row">
            <td class="sticky-col">Average</td>
            {#each monthlySummary.avg as aVal, idx (idx)}
              <td class="num-td" class:pos={aVal !== null && aVal > 0} class:neg={aVal !== null && aVal < 0}>
                {aVal != null ? `${aVal > 0 ? '+' : ''}${aVal.toFixed(2)}%` : '—'}
              </td>
            {/each}
            <td
              class="num-td annual-col"
              class:pos={monthlySummary.annualAvg !== null && monthlySummary.annualAvg > 0}
              class:neg={monthlySummary.annualAvg !== null && monthlySummary.annualAvg < 0}
            >
              {monthlySummary.annualAvg != null
                ? `${monthlySummary.annualAvg > 0 ? '+' : ''}${monthlySummary.annualAvg.toFixed(2)}%`
                : '—'}
            </td>
          </tr>
          <tr class="summary-row win-row">
            <td class="sticky-col">Win %</td>
            {#each monthlySummary.winRate as wVal, idx (idx)}
              <td class="num-td">
                {wVal != null ? `${Math.round(wVal)}%` : '—'}
              </td>
            {/each}
            <td class="num-td annual-col">
              {monthlySummary.annualWin != null ? `${Math.round(monthlySummary.annualWin)}%` : '—'}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  {/if}
</div>

<style>
  .seasonals-root {
    --sv-bg: var(--dark-bg-base);
    --sv-surface: var(--dark-bg-surface);
    --sv-elevated: var(--dark-bg-elevated);
    --sv-hover: var(--dark-bg-hover);
    --sv-border: var(--dark-border-subtle);
    --sv-border-strong: var(--dark-border-strong);
    --sv-text: var(--dark-text-strong);
    --sv-secondary: var(--dark-text-secondary);
    --sv-muted: var(--dark-text-muted);
    --sv-grid: #1e1e1e;
    --sv-grid-zero: #3a3a3a;
    --sv-avg-stroke: #e5e5e5;
    --sv-thumb-bg: #141414;
    --sv-thumb-ring: #e5e5e5;

    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px 20px 16px;
    color: var(--sv-text);
  }

  .seasonals-root.light {
    --sv-bg: #ffffff;
    --sv-surface: #f4f5f7;
    --sv-elevated: #ffffff;
    --sv-hover: #f0f3fa;
    --sv-border: #e5e7eb;
    --sv-border-strong: #d1d4dc;
    --sv-text: #131722;
    --sv-secondary: #6a6d78;
    --sv-muted: #868993;
    --sv-grid: #f0f1f4;
    --sv-grid-zero: #c7cbd4;
    --sv-avg-stroke: #131722;
    --sv-thumb-bg: #ffffff;
    --sv-thumb-ring: #131722;
  }

  .sv-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
    flex: 0 0 auto;
  }

  .sv-left,
  .sv-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .seg-group {
    display: inline-flex;
    padding: 2px;
    border-radius: 8px;
    border: 1px solid var(--sv-border);
    background: var(--sv-surface);
  }

  .seg-btn {
    width: 30px;
    height: 26px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--sv-secondary);
    display: grid;
    place-items: center;
    cursor: pointer;
    transition: background-color 140ms ease, color 140ms ease;
  }

  .seg-btn.active {
    background: var(--sv-elevated);
    color: var(--sv-text);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.14);
  }

  .seg-btn svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .quick-range {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .qr-pill {
    height: 26px;
    padding: 0 8px;
    border: 1px solid var(--sv-border);
    border-radius: 6px;
    background: transparent;
    color: var(--sv-secondary);
    font: inherit;
    font-size: 11.5px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 130ms ease, color 130ms ease, border-color 130ms ease;
  }

  .qr-pill:hover {
    color: var(--sv-text);
    background: var(--sv-hover);
  }

  .qr-pill.active {
    color: var(--sv-text);
    background: var(--sv-surface);
    border-color: var(--sv-border-strong);
    font-weight: 600;
  }

  .range-caption {
    margin-left: 4px;
    font-size: 12px;
    font-weight: 500;
    color: var(--sv-secondary);
    font-variant-numeric: tabular-nums;
  }

  .sv-ctrl-btn {
    height: 30px;
    padding: 0 10px;
    border: 1px solid var(--sv-border);
    border-radius: 7px;
    background: var(--sv-bg);
    color: var(--sv-text);
    font: inherit;
    font-size: 12.5px;
    font-weight: 500;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    transition: background-color 130ms ease, border-color 130ms ease, color 130ms ease;
  }

  .sv-ctrl-btn.icon-only {
    width: 30px;
    padding: 0;
    justify-content: center;
  }

  .sv-ctrl-btn:hover {
    background: var(--sv-hover);
  }

  .sv-ctrl-btn.active {
    border-color: #2962ff;
    color: #2962ff;
    background: rgba(41, 98, 255, 0.1);
  }

  .sv-ctrl-btn svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .sv-ctrl-btn .chev {
    width: 12px;
    height: 12px;
    transition: transform 150ms ease;
  }

  .sv-ctrl-btn .chev.open {
    transform: rotate(180deg);
  }

  .sv-pop-anchor {
    position: relative;
  }

  .sv-menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 40;
    min-width: 190px;
    padding: 5px;
    border-radius: 10px;
    background: var(--sv-elevated);
    border: 1px solid var(--sv-border-strong);
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.28);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .sv-menu-item {
    width: 100%;
    padding: 7px 10px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--sv-text);
    font: inherit;
    font-size: 12.5px;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 1px;
    cursor: pointer;
  }

  .sv-menu-item:hover {
    background: var(--sv-hover);
  }

  .sv-menu-item.active {
    background: rgba(41, 98, 255, 0.12);
    color: #2962ff;
    font-weight: 600;
  }

  .sv-menu-sub {
    font-size: 11px;
    font-weight: 400;
    color: var(--sv-secondary);
  }

  /* Year Range Slider */
  .slider-section {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 0 4px 6px;
    user-select: none;
  }

  .slider-labels {
    display: flex;
    justify-content: space-between;
    font-size: 11.5px;
    color: var(--sv-muted);
    font-variant-numeric: tabular-nums;
  }

  .slider-labels .current {
    color: var(--sv-text);
    font-weight: 600;
  }

  .slider-track-wrap {
    position: relative;
    height: 22px;
    display: flex;
    align-items: center;
  }

  .slider-track-bg {
    width: 100%;
    height: 7px;
    border-radius: 999px;
    background: var(--sv-surface);
    border: 1px solid var(--sv-border);
  }

  .slider-track-active {
    position: absolute;
    height: 7px;
    border-radius: 999px;
    background: var(--sv-text);
    cursor: grab;
    display: grid;
    place-items: center;
  }

  .slider-track-active:active {
    cursor: grabbing;
  }

  .slider-grip-dots {
    position: absolute;
    top: 12px;
    font-size: 10px;
    line-height: 1;
    color: var(--sv-muted);
    pointer-events: none;
  }

  .slider-thumb {
    position: absolute;
    width: 16px;
    height: 16px;
    margin-left: -8px;
    padding: 0;
    border-radius: 50%;
    border: 2.5px solid var(--sv-thumb-ring);
    background: var(--sv-thumb-bg);
    cursor: ew-resize;
    z-index: 2;
    transition: transform 120ms ease;
  }

  .slider-thumb:hover {
    transform: scale(1.14);
  }

  /* Chart area */
  .sv-chart-wrap {
    position: relative;
    flex: 1;
    min-height: 300px;
    overflow: hidden;
  }

  .sv-svg {
    width: 100%;
    height: 100%;
    display: block;
    user-select: none;
    cursor: crosshair;
  }

  .grid-line {
    stroke: var(--sv-grid);
    stroke-width: 1;
  }

  .grid-zero {
    stroke: var(--sv-grid-zero);
    stroke-width: 1;
    stroke-dasharray: 4 4;
  }

  .grid-month {
    stroke: var(--sv-grid);
    stroke-width: 1;
    stroke-dasharray: 3 3;
  }

  .avg-line {
    stroke: var(--sv-avg-stroke);
    opacity: 0.85;
  }

  .crosshair-line {
    stroke: var(--sv-muted);
    stroke-width: 1;
    stroke-dasharray: 3 3;
  }

  .axis-text {
    fill: var(--sv-secondary);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .year-badge {
    cursor: pointer;
  }

  .badge-yr,
  .badge-val {
    fill: #ffffff;
    font-size: 11px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  /* Dark Floating Crosshair Tooltip (exact TradingView Screenshot 8) */
  .sv-tooltip {
    position: absolute;
    z-index: 15;
    width: 154px;
    padding: 9px 11px 7px;
    border-radius: 8px;
    background: #1f1f1f;
    color: #f0f0f0;
    box-shadow: 0 10px 26px rgba(0, 0, 0, 0.36);
    border: 1px solid rgba(255, 255, 255, 0.1);
    pointer-events: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .tip-row {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .tip-row.current {
    font-weight: 600;
  }

  .tip-row.avg {
    margin-top: 2px;
    padding-top: 4px;
    border-top: 1px solid rgba(255, 255, 255, 0.12);
  }

  .tip-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex: 0 0 7px;
  }

  .tip-dot.avg-dot {
    background: #ffffff;
  }

  .tip-yr {
    color: #d4d4d4;
  }

  .tip-val {
    margin-left: auto;
    font-weight: 600;
    color: #ffffff;
  }

  .tip-date {
    margin-top: 4px;
    padding-top: 4px;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    text-align: center;
    font-size: 11px;
    color: #a3a3a3;
  }

  /* Monthly Matrix Table */
  .sv-table-wrap {
    flex: 1;
    min-height: 0;
    overflow: auto;
    border: 1px solid var(--sv-border);
    border-radius: 10px;
  }

  .sv-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .sv-table th {
    position: sticky;
    top: 0;
    z-index: 2;
    padding: 9px 8px;
    background: var(--sv-surface);
    color: var(--sv-secondary);
    font-weight: 600;
    text-align: right;
    border-bottom: 1px solid var(--sv-border);
  }

  .sv-table th.sticky-col {
    text-align: left;
    left: 0;
    z-index: 3;
    padding-left: 12px;
  }

  .sv-table td {
    padding: 8px 8px;
    border-bottom: 1px solid var(--sv-border);
    text-align: right;
  }

  .sv-table td.sticky-col {
    position: sticky;
    left: 0;
    background: var(--sv-bg);
    text-align: left;
    padding-left: 12px;
    font-weight: 600;
    z-index: 1;
  }

  .yr-cell {
    display: flex;
    align-items: center;
    gap: 7px;
  }

  .yr-swatch {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: 0 0 8px;
  }

  .sv-table tr.is-cur td.sticky-col {
    color: #2962ff;
  }

  .num-td.pos {
    color: #089981;
    font-weight: 500;
  }

  .num-td.neg {
    color: #f23645;
    font-weight: 500;
  }

  .annual-col {
    border-left: 1px solid var(--sv-border);
    font-weight: 600;
  }

  .sv-table tfoot tr.summary-row td {
    background: var(--sv-surface);
    font-weight: 650;
    border-top: 1px solid var(--sv-border-strong);
  }

  .sv-table tfoot tr.win-row td {
    color: var(--sv-secondary);
    font-weight: 600;
    border-top: 1px solid var(--sv-border);
    border-bottom: 0;
  }

  /* Loading & error states */
  .sv-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: var(--sv-secondary);
    font-size: 13px;
  }

  .sv-spinner {
    width: 22px;
    height: 22px;
    border: 2px solid var(--sv-border-strong);
    border-top-color: #2962ff;
    border-radius: 50%;
    animation: sv-spin 0.8s linear infinite;
  }

  @keyframes sv-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .sv-err {
    margin: 0;
    color: #f23645;
  }

  .sv-retry-btn {
    height: 30px;
    padding: 0 14px;
    border: 1px solid var(--sv-border-strong);
    border-radius: 7px;
    background: var(--sv-surface);
    color: var(--sv-text);
    font: inherit;
    font-size: 12.5px;
    cursor: pointer;
  }
</style>
