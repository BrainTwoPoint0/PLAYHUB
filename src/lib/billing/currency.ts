// Shared Stripe currency helpers.
//
// Stripe expects amounts in the currency's *minor unit* — the smallest
// indivisible unit per ISO 4217. Most currencies are 2-decimal (cents); a
// handful are 0-decimal (no fractional unit) or 3-decimal (mils/fils).
//
// Hardcoding `* 100` works for cents but silently 10×-undercharges KWD/BHD/JOD/
// OMR/TND and 100×-overcharges 0-decimal currencies like JPY. Always go through
// minorUnitFactor() before multiplying a UI-facing price.

export const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'JPY',
  'KMF',
  'KRW',
  'MGA',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
])

export const THREE_DECIMAL_CURRENCIES = new Set([
  'BHD',
  'JOD',
  'KWD',
  'OMR',
  'TND',
])

export function minorUnitFactor(currency: string): number {
  const c = currency.toUpperCase()
  if (ZERO_DECIMAL_CURRENCIES.has(c)) return 1
  if (THREE_DECIMAL_CURRENCIES.has(c)) return 1000
  return 100
}
