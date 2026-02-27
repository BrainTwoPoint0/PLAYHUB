// Shared KWD exchange rates with in-memory cache
// Single API call returns all currency rates from KWD base

let cachedRates: { rates: Record<string, number>; fetchedAt: number } | null =
  null
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

const FALLBACK_RATES: Record<string, number> = {
  EUR: 2.75,
  GBP: 2.35,
}

async function getRates(): Promise<Record<string, number>> {
  if (cachedRates && Date.now() - cachedRates.fetchedAt < CACHE_TTL_MS) {
    return cachedRates.rates
  }

  try {
    const res = await fetch('https://open.er-api.com/v6/latest/KWD', {
      signal: AbortSignal.timeout(5000),
    })
    const data = await res.json()

    if (data.result !== 'success' || !data.rates) {
      return cachedRates?.rates ?? FALLBACK_RATES
    }

    cachedRates = { rates: data.rates, fetchedAt: Date.now() }
    return cachedRates.rates
  } catch {
    return cachedRates?.rates ?? FALLBACK_RATES
  }
}

/** 1 KWD = X GBP */
export async function getKwdToGbpRate(): Promise<number> {
  const rates = await getRates()
  return rates.GBP ?? FALLBACK_RATES.GBP
}

/** 1 KWD = X EUR */
export async function getKwdToEurRate(): Promise<number> {
  const rates = await getRates()
  return rates.EUR ?? FALLBACK_RATES.EUR
}
