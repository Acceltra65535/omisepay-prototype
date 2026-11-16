export interface ExchangeRatesData {
  base: 'SGD';
  rates: {
    SGD: number;
    USD: number;
    CAD: number;
  };
  source: 'live' | 'fallback';
  updatedAt: string;
}

const FALLBACK_RATES = {
  SGD: 1,
  USD: 0.745,
  CAD: 1.035,
};

const LIVE_TTL_MS = 60 * 60 * 1000;      // 1 hour for live rates
const FALLBACK_TTL_MS = 5 * 60 * 1000;   // 5 minutes before retrying on failure

let cachedData: ExchangeRatesData | null = null;
let cacheExpiresAt = 0;

/**
 * Fetch live SGD -> USD / CAD exchange rates with in-memory TTL cache and safe fallback.
 */
export async function getExchangeRates(): Promise<ExchangeRatesData> {
  const now = Date.now();
  if (cachedData && now < cacheExpiresAt) {
    return cachedData;
  }

  try {
    const res = await fetch('https://open.er-api.com/v6/latest/SGD', {
      method: 'GET',
      signal: AbortSignal.timeout(2500),
    });

    if (res.ok) {
      const json = (await res.json()) as {
        result?: string;
        rates?: Record<string, unknown>;
      };
      const usdRate = typeof json?.rates?.USD === 'number' ? json.rates.USD : 0;
      const cadRate = typeof json?.rates?.CAD === 'number' ? json.rates.CAD : 0;

      if (usdRate > 0 && cadRate > 0) {
        cachedData = {
          base: 'SGD',
          rates: {
            SGD: 1,
            USD: Number(usdRate.toFixed(4)),
            CAD: Number(cadRate.toFixed(4)),
          },
          source: 'live',
          updatedAt: new Date().toISOString(),
        };
        cacheExpiresAt = now + LIVE_TTL_MS;
        return cachedData;
      }
    }
  } catch (err) {
    console.warn('FX live rate fetch fallback:', err instanceof Error ? err.message : err);
  }

  cachedData = {
    base: 'SGD',
    rates: { ...FALLBACK_RATES },
    source: 'fallback',
    updatedAt: new Date().toISOString(),
  };
  cacheExpiresAt = now + FALLBACK_TTL_MS;
  return cachedData;
}
