<script lang="ts">
  import { FLAG_SVGS, type CountryCode } from '../calendar/flags';
  import { symbolBadgeBg } from './store';

  interface Props {
    symbol: string;
    size?: number;
  }

  let { symbol, size = 18 }: Props = $props();

  const CCY_TO_FLAG: Record<string, CountryCode> = {
    USD: 'US',
    EUR: 'EU',
    GBP: 'GB',
    JPY: 'JP',
    AUD: 'AU',
    CAD: 'CA',
    CHF: 'CH',
    NZD: 'NZ',
    CNY: 'CN',
    CNH: 'CN',
    INR: 'IN',
    IDR: 'ID'
  };

  const upper = $derived.by(() => {
    const raw = (symbol || '').toUpperCase().trim();
    const idx = raw.indexOf(':');
    return idx >= 0 ? raw.slice(idx + 1) : raw;
  });

  const fxFlags = $derived.by((): [CountryCode, CountryCode] | null => {
    const clean = upper.replace(/[^A-Z]/g, '');
    if (clean.length !== 6) return null;
    const base = CCY_TO_FLAG[clean.slice(0, 3)];
    const quote = CCY_TO_FLAG[clean.slice(3, 6)];
    if (base && quote) return [base, quote];
    return null;
  });

  const specialKind = $derived.by(() => {
    if (upper.includes('XAU') || upper.includes('GOLD')) return 'gold';
    if (upper.includes('XAG') || upper.includes('SILVER')) return 'silver';
    if (upper.includes('OIL') || upper.includes('WTI') || upper.includes('BRENT')) return 'oil';
    if (upper === 'DXY') return 'dxy';
    if (upper.includes('NAS') || upper === 'NDX') return 'nas';
    if (upper === 'SPX' || upper === 'US500') return 'spx';
    if (upper === 'US30' || upper === 'DJI') return 'us30';
    if (upper.includes('BTC')) return 'btc';
    if (upper.includes('ETH')) return 'eth';
    return 'mono';
  });

  const bg = $derived(
    specialKind === 'silver'
      ? '#8a94a6'
      : specialKind === 'spx'
        ? '#e53935'
        : specialKind === 'us30'
          ? '#1e88e5'
          : symbolBadgeBg(upper)
  );
</script>

{#if fxFlags}
  <!-- Dual overlapping circular country flags matching TradingView Watchlist -->
  <span class="fx-pair" style:width="{size}px" style:height="{size}px" aria-hidden="true">
    <svg
      class="fx-flag quote"
      viewBox="0 0 16 16"
      style:width="{Math.round(size * 0.72)}px"
      style:height="{Math.round(size * 0.72)}px"
    >
      {@html FLAG_SVGS[fxFlags[1]]}
    </svg>
    <svg
      class="fx-flag base"
      viewBox="0 0 16 16"
      style:width="{Math.round(size * 0.72)}px"
      style:height="{Math.round(size * 0.72)}px"
    >
      {@html FLAG_SVGS[fxFlags[0]]}
    </svg>
  </span>
{:else}
  <span
    class="asset-emblem"
    style:width="{size}px"
    style:height="{size}px"
    style:background={bg}
    aria-hidden="true"
  >
    {#if specialKind === 'gold' || specialKind === 'silver'}
      <svg viewBox="0 0 16 16" style:width="{Math.round(size * 0.68)}px" style:height="{Math.round(size * 0.68)}px">
        <path
          d="M5.4 6.1h5.2l.8 2.1H4.6l.8-2.1ZM2.8 9.2h4.4l.65 2.1H2.15l.65-2.1Zm6 0h4.4l.65 2.1H8.15l.65-2.1Z"
          fill="#ffffff"
        />
      </svg>
    {:else if specialKind === 'oil'}
      <svg viewBox="0 0 16 16" style:width="{Math.round(size * 0.66)}px" style:height="{Math.round(size * 0.66)}px">
        <path
          d="M8 2.4C8 2.4 4.1 6.9 4.1 9.6a3.9 3.9 0 0 0 7.8 0C11.9 6.9 8 2.4 8 2.4Z"
          fill="#ffffff"
        />
      </svg>
    {:else if specialKind === 'dxy'}
      <span style:font-size="{Math.round(size * 0.6)}px">$</span>
    {:else if specialKind === 'btc'}
      <span style:font-size="{Math.round(size * 0.58)}px">₿</span>
    {:else if specialKind === 'eth'}
      <span style:font-size="{Math.round(size * 0.58)}px">Ξ</span>
    {:else if specialKind === 'nas'}
      <span class="tight" style:font-size="{Math.round(size * 0.42)}px">100</span>
    {:else if specialKind === 'spx'}
      <span class="tight" style:font-size="{Math.round(size * 0.42)}px">500</span>
    {:else if specialKind === 'us30'}
      <span class="tight" style:font-size="{Math.round(size * 0.48)}px">30</span>
    {:else}
      <span style:font-size="{Math.round(size * 0.44)}px">{upper.slice(0, 2)}</span>
    {/if}
  </span>
{/if}

<style>
  .fx-pair {
    position: relative;
    display: inline-block;
    flex: 0 0 auto;
  }

  .fx-flag {
    position: absolute;
    display: block;
    border-radius: 50%;
    overflow: hidden;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.14);
  }

  .fx-flag.quote {
    top: 0;
    right: 0;
    z-index: 1;
  }

  .fx-flag.base {
    bottom: 0;
    left: 0;
    z-index: 2;
  }

  .asset-emblem {
    flex: 0 0 auto;
    border-radius: 50%;
    display: inline-grid;
    place-items: center;
    color: #ffffff;
    font-weight: 700;
    line-height: 1;
    overflow: hidden;
  }

  .tight {
    letter-spacing: -0.04em;
  }
</style>
