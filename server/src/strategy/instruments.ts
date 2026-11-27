export interface StrategyInstrumentSpec {
  tickSize: number;
  pipSize: number;
  decimals: number;
  defaultSpreadPrice: number;
  lotUnits: number;
  minQty: number;
  qtyStep: number;
  isUsdBaseFx: boolean;
}

export function normalizeShortTicker(raw: string): string {
  const cleaned = raw.trim().toUpperCase();
  const idx = cleaned.indexOf(':');
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

export function normalizeSymbolKey(raw: string): string {
  return normalizeShortTicker(raw).replace(/[^A-Z0-9]/g, '');
}

/**
 * Exact server mirror of `src/lib/paper/instruments.ts` so backtest P&L,
 * notional value, tick rounding, and risk-based position sizing match Paper Ledger 1:1.
 */
export function getStrategyInstrumentSpec(symbol: string): StrategyInstrumentSpec {
  const s = normalizeSymbolKey(symbol);

  if (s.includes('XAU') || s.includes('GOLD')) {
    return {
      tickSize: 0.001,
      pipSize: 0.01,
      decimals: 3,
      defaultSpreadPrice: 0.3,
      lotUnits: 100,
      minQty: 0.01,
      qtyStep: 0.01,
      isUsdBaseFx: false
    };
  }

  if (s.includes('XAG') || s.includes('SILVER')) {
    return {
      tickSize: 0.001,
      pipSize: 0.01,
      decimals: 3,
      defaultSpreadPrice: 0.02,
      lotUnits: 5000,
      minQty: 1,
      qtyStep: 1,
      isUsdBaseFx: false
    };
  }

  if (s.includes('OIL') || s.includes('WTI') || s.includes('BRENT')) {
    return {
      tickSize: 0.01,
      pipSize: 0.01,
      decimals: 2,
      defaultSpreadPrice: 0.03,
      lotUnits: 1000,
      minQty: 1,
      qtyStep: 1,
      isUsdBaseFx: false
    };
  }

  if (s.includes('NATGAS')) {
    return {
      tickSize: 0.001,
      pipSize: 0.01,
      decimals: 3,
      defaultSpreadPrice: 0.012,
      lotUnits: 1000,
      minQty: 1,
      qtyStep: 1,
      isUsdBaseFx: false
    };
  }

  if (s.includes('COPPER') || s.includes('XCU')) {
    return {
      tickSize: 0.0005,
      pipSize: 0.001,
      decimals: 4,
      defaultSpreadPrice: 0.004,
      lotUnits: 1000,
      minQty: 1,
      qtyStep: 1,
      isUsdBaseFx: false
    };
  }

  if (s.includes('BTC')) {
    return {
      tickSize: 0.1,
      pipSize: 1,
      decimals: 2,
      defaultSpreadPrice: 8,
      lotUnits: 1,
      minQty: 0.001,
      qtyStep: 0.001,
      isUsdBaseFx: false
    };
  }

  if (s.includes('ETH')) {
    return {
      tickSize: 0.01,
      pipSize: 0.1,
      decimals: 2,
      defaultSpreadPrice: 0.8,
      lotUnits: 1,
      minQty: 0.01,
      qtyStep: 0.01,
      isUsdBaseFx: false
    };
  }

  if (
    s.includes('NAS') ||
    s.includes('NDX') ||
    s.includes('US30') ||
    s.includes('DJI') ||
    s.includes('SPX') ||
    s.includes('US500') ||
    s.includes('GER40') ||
    s.includes('DEU40') ||
    s.includes('DAX') ||
    s.includes('UK100') ||
    s.includes('JP225') ||
    s.includes('DXY')
  ) {
    return {
      tickSize: 0.01,
      pipSize: 0.1,
      decimals: 2,
      defaultSpreadPrice: s.includes('DXY') ? 0.02 : 1.2,
      lotUnits: 1,
      minQty: 0.1,
      qtyStep: 0.1,
      isUsdBaseFx: false
    };
  }

  const isSixAlphaFx =
    s.length === 6 &&
    /^[A-Z]{6}$/.test(s) &&
    ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF', 'SEK'].includes(s.slice(0, 3)) &&
    ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF', 'SEK'].includes(s.slice(3, 6));

  if (isSixAlphaFx) {
    if (s.endsWith('JPY')) {
      return {
        tickSize: 0.001,
        pipSize: 0.01,
        decimals: 3,
        defaultSpreadPrice: 0.012,
        lotUnits: 100000,
        minQty: 100,
        qtyStep: 100,
        isUsdBaseFx: s.startsWith('USD')
      };
    }
    return {
      tickSize: 0.00001,
      pipSize: 0.0001,
      decimals: 5,
      defaultSpreadPrice: 0.00008,
      lotUnits: 100000,
      minQty: 100,
      qtyStep: 100,
      isUsdBaseFx: s.startsWith('USD')
    };
  }

  return {
    tickSize: 0.01,
    pipSize: 0.01,
    decimals: 2,
    defaultSpreadPrice: 0.02,
    lotUnits: 1,
    minQty: 0.1,
    qtyStep: 0.1,
    isUsdBaseFx: false
  };
}

export function roundToTick(price: number, symbol: string): number {
  const spec = getStrategyInstrumentSpec(symbol);
  if (!Number.isFinite(price)) return 0;
  return Number((Math.round(price / spec.tickSize) * spec.tickSize).toFixed(spec.decimals));
}

export function roundQtyToStep(qty: number, spec: StrategyInstrumentSpec): number {
  if (!Number.isFinite(qty) || qty <= 0) return spec.minQty;
  const stepped = Math.floor(qty / spec.qtyStep) * spec.qtyStep;
  const clamped = Math.max(spec.minQty, stepped);
  return Number(clamped.toFixed(4));
}

export function computeNotionalUsd(symbol: string, quantity: number, price: number): number {
  if (!Number.isFinite(quantity) || !Number.isFinite(price) || quantity <= 0 || price <= 0) {
    return 0;
  }
  const spec = getStrategyInstrumentSpec(symbol);
  if (spec.isUsdBaseFx) return quantity;
  return quantity * price;
}

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
  const spec = getStrategyInstrumentSpec(symbol);
  const dir = side === 'long' ? 1 : -1;
  const raw = (exitPrice - entryPrice) * dir * quantity;
  return spec.isUsdBaseFx ? raw / exitPrice : raw;
}

/**
 * Given target dollar risk and stop distance in price units, compute exact quantity
 * matching Paper Ledger's contract math.
 */
export function computeQtyForDollarRisk(
  symbol: string,
  entryPrice: number,
  stopPrice: number,
  riskUsd: number,
  maxNotionalUsd: number
): number {
  const spec = getStrategyInstrumentSpec(symbol);
  const dist = Math.abs(entryPrice - stopPrice);
  if (!Number.isFinite(dist) || dist <= spec.tickSize || riskUsd <= 0 || entryPrice <= 0) {
    return spec.minQty;
  }
  // For USD-base FX (e.g. USDJPY), PnL = (dist * qty) / stopPrice => qty = (riskUsd * stopPrice) / dist
  const rawQty = spec.isUsdBaseFx ? (riskUsd * stopPrice) / dist : riskUsd / dist;
  const maxQtyByLeverage = spec.isUsdBaseFx ? maxNotionalUsd : maxNotionalUsd / entryPrice;
  const capped = Math.min(rawQty, Math.max(spec.minQty, maxQtyByLeverage));
  return roundQtyToStep(capped, spec);
}
