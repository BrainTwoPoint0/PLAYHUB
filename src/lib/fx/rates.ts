// Shared KWD → EUR exchange rate with in-memory cache

let cachedRate: { rate: number; fetchedAt: number } | null = null
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

export const FALLBACK_KWD_TO_EUR_RATE = 2.75

export async function getKwdToEurRate(): Promise<number> {
  if (cachedRate && Date.now() - cachedRate.fetchedAt < CACHE_TTL_MS) {
    return cachedRate.rate
  }

  try {
    const res = await fetch('https://open.er-api.com/v6/latest/KWD', {
      signal: AbortSignal.timeout(5000),
    })
    const data = await res.json()

    if (data.result !== 'success' || !data.rates?.EUR) {
      return cachedRate?.rate ?? FALLBACK_KWD_TO_EUR_RATE
    }

    cachedRate = { rate: data.rates.EUR, fetchedAt: Date.now() }
    return cachedRate.rate
  } catch {
    return cachedRate?.rate ?? FALLBACK_KWD_TO_EUR_RATE
  }
}
