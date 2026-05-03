// Shared exchange-rate helpers with per-base in-memory cache.
// Each base currency hits open.er-api.com once per hour and is reused.

const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

type CachedRates = { rates: Record<string, number>; fetchedAt: number }
const cache = new Map<string, CachedRates>()

// Fallbacks used when the FX API is unreachable. AED is pegged to USD at ~3.67;
// EUR/USD spot ~1.17 puts EUR/AED ≈ 4.25.
const FALLBACK_RATES: Record<string, Record<string, number>> = {
  KWD: { EUR: 2.75, GBP: 2.35 },
  EUR: { AED: 4.25, KWD: 0.36, GBP: 0.85 },
}

// ±25% deviation from fallback is the upper bound on what we trust from the
// upstream API. A compromised or malformed response (e.g. EUR→AED returning
// 0.5) feeds straight into invoice math and either over- or under-charges
// venues by orders of magnitude. Reject anything outside this window.
const SANITY_DEVIATION = 0.25

function ratesPassSanity(base: string, rates: Record<string, number>): boolean {
  const expected = FALLBACK_RATES[base]
  if (!expected) return true // no expectations → trust upstream
  for (const [quote, fallback] of Object.entries(expected)) {
    const actual = rates[quote]
    if (typeof actual !== 'number' || !Number.isFinite(actual) || actual <= 0) {
      return false
    }
    const lower = fallback * (1 - SANITY_DEVIATION)
    const upper = fallback * (1 + SANITY_DEVIATION)
    if (actual < lower || actual > upper) {
      console.warn(
        `[fx] rejecting ${base}→${quote}=${actual} (outside ±${SANITY_DEVIATION * 100}% of fallback ${fallback})`
      )
      return false
    }
  }
  return true
}

async function getRates(base: string): Promise<Record<string, number>> {
  const cached = cache.get(base)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.rates
  }

  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${base}`, {
      signal: AbortSignal.timeout(5000),
    })
    const data = await res.json()

    if (data.result !== 'success' || !data.rates) {
      return cached?.rates ?? FALLBACK_RATES[base] ?? {}
    }

    if (!ratesPassSanity(base, data.rates)) {
      return cached?.rates ?? FALLBACK_RATES[base] ?? {}
    }

    cache.set(base, { rates: data.rates, fetchedAt: Date.now() })
    return data.rates
  } catch {
    return cached?.rates ?? FALLBACK_RATES[base] ?? {}
  }
}

/** 1 KWD = X GBP */
export async function getKwdToGbpRate(): Promise<number> {
  const rates = await getRates('KWD')
  return rates.GBP ?? FALLBACK_RATES.KWD.GBP
}

/** 1 KWD = X EUR */
export async function getKwdToEurRate(): Promise<number> {
  const rates = await getRates('KWD')
  return rates.EUR ?? FALLBACK_RATES.KWD.EUR
}

/** 1 EUR = X AED */
export async function getEurToAedRate(): Promise<number> {
  const rates = await getRates('EUR')
  return rates.AED ?? FALLBACK_RATES.EUR.AED
}
