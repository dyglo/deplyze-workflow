export interface PaperInstrumentSpec {
  tickSize: number;
  pipSize: number;
  decimals: number;
  pipetteDigits: number; // trailing fractional digit shown superscript (0 or 1)
  defaultSpreadPrice: number; // total bid-ask spread in price units
  spreadMultiplier: number; // converts price spread to TradingView-style display value
  lotUnits: number; // units per 1.00 standard lot (matches tasks/store.ts)
  minQty: number;
  qtyStep: number;
  isUsdBaseFx: boolean; // USDJPY, USDCAD, USDCHF — notional in USD = quantity directly
  unitLabel: string;
}

export function normalizeShortTicker(raw: string): string {
  const cleaned = raw.trim().toUpperCase();
  const idx = cleaned.indexOf(':');
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

export function normalizeSymbolKey(raw: string): string {
  return normalizeShortTicker(raw).replace(/[^A-Z0-9]/g, '');
}

export function getPaperInstrumentSpec(symbol: string): PaperInstrumentSpec {
  const s = normalizeSymbolKey(symbol);

  if (s.includes('XAU') || s.includes('GOLD')) {
    return {
      tickSize: 0.001,
      pipSize: 0.01,
      decimals: 3,
      pipetteDigits: 1,
      defaultSpreadPrice: 0.3,
      spreadMultiplier: 100, // 0.30 -> 30.0
      lotUnits: 100,
      minQty: 0.01,
      qtyStep: 1,
      isUsdBaseFx: false,
      unitLabel: 'oz'
    };
  }

  if (s.includes('XAG') || s.includes('SILVER')) {
    return {
      tickSize: 0.001,
      pipSize: 0.01,
      decimals: 3,
      pipetteDigits: 1,
      defaultSpreadPrice: 0.02,
      spreadMultiplier: 100,
      lotUnits: 5000,
      minQty: 1,
      qtyStep: 10,
      isUsdBaseFx: false,
      unitLabel: 'oz'
    };
  }

  if (s.includes('OIL') || s.includes('WTI') || s.includes('BRENT')) {
    return {
      tickSize: 0.01,
      pipSize: 0.01,
      decimals: 2,
      pipetteDigits: 0,
      defaultSpreadPrice: 0.03,
      spreadMultiplier: 100,
      lotUnits: 1000,
      minQty: 1,
      qtyStep: 10,
      isUsdBaseFx: false,
      unitLabel: 'bbl'
    };
  }

  if (s.includes('BTC')) {
    return {
      tickSize: 0.1,
      pipSize: 1,
      decimals: 2,
      pipetteDigits: 0,
      defaultSpreadPrice: 8,
      spreadMultiplier: 1,
      lotUnits: 1,
      minQty: 0.001,
      qtyStep: 0.01,
      isUsdBaseFx: false,
      unitLabel: 'BTC'
    };
  }

  if (s.includes('ETH')) {
    return {
      tickSize: 0.01,
      pipSize: 0.1,
      decimals: 2,
      pipetteDigits: 0,
      defaultSpreadPrice: 0.8,
      spreadMultiplier: 10,
      lotUnits: 1,
      minQty: 0.01,
      qtyStep: 0.1,
      isUsdBaseFx: false,
      unitLabel: 'ETH'
    };
  }

  if (
    s.includes('NAS') ||
    s.includes('NDX') ||
    s.includes('US30') ||
    s.includes('DJI') ||
    s.includes('SPX') ||
    s.includes('US500') ||
    s.includes('DXY')
  ) {
    return {
      tickSize: 0.01,
      pipSize: 0.1,
      decimals: 2,
      pipetteDigits: 0,
      defaultSpreadPrice: s.includes('DXY') ? 0.02 : 1.2,
      spreadMultiplier: 10,
      lotUnits: 1,
      minQty: 0.1,
      qtyStep: 1,
      isUsdBaseFx: false,
      unitLabel: 'contracts'
    };
  }

  // 6-character FX pair detection
  const isSixAlphaFx =
    s.length === 6 &&
    /^[A-Z]{6}$/.test(s) &&
    ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF'].includes(s.slice(0, 3)) &&
    ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF'].includes(s.slice(3, 6));

  if (isSixAlphaFx) {
    if (s.endsWith('JPY')) {
      return {
        tickSize: 0.001,
        pipSize: 0.01,
        decimals: 3,
        pipetteDigits: 1,
        defaultSpreadPrice: 0.012,
        spreadMultiplier: 100, // 1.2 pips
        lotUnits: 100000,
        minQty: 1,
        qtyStep: 1000,
        isUsdBaseFx: s.startsWith('USD'),
        unitLabel: 'units'
      };
    }
    return {
      tickSize: 0.00001,
      pipSize: 0.0001,
      decimals: 5,
      pipetteDigits: 1,
      defaultSpreadPrice: 0.00008,
      spreadMultiplier: 10000, // 0.8 pips
      lotUnits: 100000,
      minQty: 1,
      qtyStep: 1000,
      isUsdBaseFx: s.startsWith('USD'),
      unitLabel: 'units'
    };
  }

  // Default equities / CFDs
  return {
    tickSize: 0.01,
    pipSize: 0.01,
    decimals: 2,
    pipetteDigits: 0,
    defaultSpreadPrice: 0.02,
    spreadMultiplier: 100,
    lotUnits: 1,
    minQty: 1,
    qtyStep: 1,
    isUsdBaseFx: false,
    unitLabel: 'shares'
  };
}

export function roundToTick(price: number, symbol: string): number {
  const spec = getPaperInstrumentSpec(symbol);
  if (!Number.isFinite(price)) return 0;
  const rounded = Math.round(price / spec.tickSize) * spec.tickSize;
  return Number(rounded.toFixed(spec.decimals));
}

export function computeBidAsk(
  lastPrice: number,
  symbol: string,
  zeroSpread: boolean
): { bid: number; ask: number; spreadDisplay: string } {
  const spec = getPaperInstrumentSpec(symbol);
  if (!Number.isFinite(lastPrice) || lastPrice <= 0) {
    return { bid: 0, ask: 0, spreadDisplay: '0.0' };
  }
  if (zeroSpread) {
    const p = roundToTick(lastPrice, symbol);
    return { bid: p, ask: p, spreadDisplay: '0.0' };
  }
  const half = spec.defaultSpreadPrice / 2;
  const bid = roundToTick(Math.max(spec.tickSize, lastPrice - half), symbol);
  const ask = roundToTick(lastPrice + half, symbol);
  const spreadVal = (ask - bid) * spec.spreadMultiplier;
  return {
    bid,
    ask,
    spreadDisplay: spreadVal.toFixed(1)
  };
}

/**
 * USD notional value of `quantity` units at `price`.
 * Matches TradingView Paper Trading:
 * - XAUUSD 1 @ 3519.59 -> 3,519.59 USD
 * - EURUSD 1,000 @ 1.11435 -> 1,114.35 USD
 * - USDJPY 1,002 @ 155.00 -> 1,002.00 USD
 */
export function computeTradeValueUsd(symbol: string, quantity: number, price: number): number {
  if (!Number.isFinite(quantity) || !Number.isFinite(price) || quantity <= 0 || price <= 0) {
    return 0;
  }
  const spec = getPaperInstrumentSpec(symbol);
  if (spec.isUsdBaseFx) {
    return quantity;
  }
  return quantity * price;
}

/**
 * USD PnL for moving from `entryPrice` to `exitPrice` on `quantity` units.
 */
export function computePnlUsd(
  symbol: string,
  side: 'long' | 'short',
  quantity: number,
  entryPrice: number,
  exitPrice: number
): number {
  if (
    !Number.isFinite(quantity) ||
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(exitPrice) ||
    quantity <= 0 ||
    entryPrice <= 0 ||
    exitPrice <= 0
  ) {
    return 0;
  }
  const spec = getPaperInstrumentSpec(symbol);
  const dir = side === 'long' ? 1 : -1;
  const rawDiff = (exitPrice - entryPrice) * dir * quantity;
  if (spec.isUsdBaseFx) {
    return rawDiff / exitPrice;
  }
  return rawDiff;
}

/**
 * USD value of a single tick move for `quantity` units at `referencePrice`.
 */
export function computeTickValueUsd(symbol: string, quantity: number, referencePrice: number): number {
  const spec = getPaperInstrumentSpec(symbol);
  if (!Number.isFinite(quantity) || quantity <= 0) return spec.tickSize;
  if (spec.isUsdBaseFx && referencePrice > 0) {
    return (spec.tickSize * quantity) / referencePrice;
  }
  return spec.tickSize * quantity;
}

export function formatPaperPrice(price: number | null | undefined, symbol: string): string {
  if (typeof price !== 'number' || !Number.isFinite(price)) return '—';
  const spec = getPaperInstrumentSpec(symbol);
  return price.toLocaleString('en-US', {
    minimumFractionDigits: spec.decimals,
    maximumFractionDigits: spec.decimals
  });
}

export function formatSplitPrice(
  price: number | null | undefined,
  symbol: string
): { main: string; pipette: string } {
  if (typeof price !== 'number' || !Number.isFinite(price)) {
    return { main: '—', pipette: '' };
  }
  const spec = getPaperInstrumentSpec(symbol);
  const full = formatPaperPrice(price, symbol);
  if (spec.pipetteDigits > 0 && full.length > spec.pipetteDigits) {
    return {
      main: full.slice(0, -spec.pipetteDigits),
      pipette: full.slice(-spec.pipetteDigits)
    };
  }
  return { main: full, pipette: '' };
}

export function formatQty(qty: number): string {
  if (!Number.isFinite(qty)) return '0';
  if (Number.isInteger(qty)) return qty.toLocaleString('en-US');
  const abs = Math.abs(qty);
  const maxFrac = abs >= 10 ? 2 : abs >= 1 ? 3 : 4;
  return qty.toLocaleString('en-US', { maximumFractionDigits: maxFrac });
}

export function formatUsd(value: number, signed = false): string {
  if (!Number.isFinite(value)) return '0.00';
  const abs = Math.abs(value);
  const formatted = abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  if (value < -0.004) return `-${formatted}`;
  if (signed && value > 0.004) return `+${formatted}`;
  return formatted;
}
