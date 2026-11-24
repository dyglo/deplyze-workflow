<script lang="ts">
  import type { GaugeSummary } from './symbolInsightsApi';

  interface Props {
    theme: 'dark' | 'light';
    title: string;
    gauge: GaugeSummary;
    size?: 'hero' | 'compact';
  }

  let { theme, title, gauge, size = 'compact' }: Props = $props();

  // Map score [-1, +1] smoothly to needle rotation [-76deg, +76deg]
  const clampedScore = $derived(Math.max(-1, Math.min(1, gauge.score || 0)));
  const needleAngle = $derived(Number((clampedScore * 76).toFixed(2)));

  const ratingTone = $derived.by<'strong-sell' | 'sell' | 'neutral' | 'buy' | 'strong-buy'>(() => {
    if (gauge.rating === 'Strong sell') return 'strong-sell';
    if (gauge.rating === 'Sell') return 'sell';
    if (gauge.rating === 'Buy') return 'buy';
    if (gauge.rating === 'Strong buy') return 'strong-buy';
    return 'neutral';
  });

  // Semicircle arc geometry centered at (110, 108), radius 86, spanning -90deg (left) to +90deg (right)
  // 5 equal segments of 32deg with 4deg visual gaps between segments, matching TradingView's Technicals gauge
  function polar(cx: number, cy: number, r: number, degFromTop: number): [number, number] {
    const rad = ((degFromTop - 90) * Math.PI) / 180;
    return [
      Number((cx + r * Math.cos(rad)).toFixed(2)),
      Number((cy + r * Math.sin(rad)).toFixed(2))
    ];
  }

  function arcPath(startDeg: number, endDeg: number, r = 86): string {
    const [x1, y1] = polar(110, 108, r, startDeg);
    const [x2, y2] = polar(110, 108, r, endDeg);
    return `M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`;
  }

  const SEGMENTS = [
    { id: 'strong-sell', d: arcPath(-88, -56), color: '#a82330' },
    { id: 'sell', d: arcPath(-51, -20), color: '#f23645' },
    { id: 'neutral', d: arcPath(-15, 15), color: '#9598a1' },
    { id: 'buy', d: arcPath(20, 51), color: '#3b82f6' },
    { id: 'strong-buy', d: arcPath(56, 88), color: '#2962ff' }
  ];
</script>

<div class="gauge-card" class:hero={size === 'hero'} class:light={theme === 'light'}>
  <div class="gauge-dial-wrap">
    <svg class="gauge-svg" viewBox="0 0 220 124" aria-hidden="true">
      {#each SEGMENTS as seg (seg.id)}
        <path
          d={seg.d}
          fill="none"
          stroke={seg.color}
          stroke-width={size === 'hero' ? 8.5 : 8}
          stroke-linecap="round"
          opacity={ratingTone === seg.id ? 1 : 0.72}
        />
      {/each}

      <!-- Smoothly animated tapered needle -->
      <g class="needle-group" style:transform="rotate({needleAngle}deg)">
        <path
          class="needle-shape"
          d="M 106.5 108 L 109.2 40 C 109.4 38.6 110.6 38.6 110.8 40 L 113.5 108 A 3.5 3.5 0 0 1 106.5 108 Z"
        />
        <circle class="needle-cap" cx="110" cy="108" r="5" />
      </g>
    </svg>
  </div>

  <div class="gauge-title">{title}</div>
  <div class="gauge-rating {ratingTone}">{gauge.rating}</div>

  <div class="gauge-counts">
    <div class="count-cell">
      <span class="count-lbl">Sell</span>
      <span class="count-val">{gauge.sell}</span>
    </div>
    <div class="count-cell">
      <span class="count-lbl">Neutral</span>
      <span class="count-val">{gauge.neutral}</span>
    </div>
    <div class="count-cell">
      <span class="count-lbl">Buy</span>
      <span class="count-val">{gauge.buy}</span>
    </div>
  </div>
</div>

<style>
  .gauge-card {
    --g-text: var(--dark-text-strong);
    --g-muted: var(--dark-text-secondary);
    --g-pill-bg: var(--dark-bg-surface);
    --g-pill-border: var(--dark-border-subtle);
    --g-needle: #e5e5e5;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    user-select: none;
  }

  .gauge-card.light {
    --g-text: #131722;
    --g-muted: #6a6d78;
    --g-pill-bg: #f4f5f7;
    --g-pill-border: #ebedf2;
    --g-needle: #131722;
  }

  .gauge-dial-wrap {
    width: 196px;
    height: 110px;
    display: grid;
    place-items: center;
  }

  .gauge-card.hero .gauge-dial-wrap {
    width: 268px;
    height: 148px;
  }

  .gauge-svg {
    width: 100%;
    height: 100%;
    overflow: visible;
  }

  .needle-group {
    transform-origin: 110px 108px;
    transition: transform 360ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .needle-shape,
  .needle-cap {
    fill: var(--g-needle);
  }

  .gauge-title {
    margin-top: 2px;
    font-size: 13px;
    font-weight: 600;
    color: var(--g-text);
  }

  .gauge-card.hero .gauge-title {
    font-size: 14px;
  }

  .gauge-rating {
    margin-top: 4px;
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.015em;
    color: var(--g-text);
  }

  .gauge-card.hero .gauge-rating {
    font-size: 22px;
  }

  .gauge-rating.strong-sell {
    color: #f23645;
  }

  .gauge-rating.sell {
    color: #f23645;
  }

  .gauge-rating.buy {
    color: #2962ff;
  }

  .gauge-rating.strong-buy {
    color: #2962ff;
  }

  .gauge-counts {
    margin-top: 12px;
    padding: 8px 14px;
    border-radius: 10px;
    background: var(--g-pill-bg);
    border: 1px solid var(--g-pill-border);
    display: grid;
    grid-template-columns: repeat(3, minmax(56px, 1fr));
    gap: 10px;
  }

  .gauge-card.hero .gauge-counts {
    margin-top: 14px;
    padding: 10px 18px;
    grid-template-columns: repeat(3, minmax(64px, 1fr));
  }

  .count-cell {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
  }

  .count-lbl {
    font-size: 11.5px;
    font-weight: 500;
    color: var(--g-muted);
  }

  .count-val {
    font-size: 14px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--g-text);
  }

  .gauge-card.hero .count-val {
    font-size: 15px;
  }
</style>
