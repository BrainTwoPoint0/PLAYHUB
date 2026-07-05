// Default title/description for the venue-management schedule form.
// Pure helpers so the prefill copy is unit-testable in one place.

/** "Nazwa" → "Nazwa Match" */
export function buildDefaultTitle(venueName: string): string {
  return `${venueName.trim()} Match`
}

/**
 * ("Nazwa", "2026-07-05T19:00") → "Match at Nazwa — Sun 5 Jul 2026, 7:00 PM"
 *
 * `startTime` is the datetime-local string from the form, interpreted in the
 * browser's local timezone. Returns '' when empty/invalid so callers can
 * skip the prefill.
 */
export function buildDefaultDescription(
  venueName: string,
  startTime: string
): string {
  if (!startTime) return ''
  const date = new Date(startTime)
  if (Number.isNaN(date.getTime())) return ''

  const datePart = date.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
  const timePart = date
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    .toUpperCase()

  // en-GB renders "Sun, 5 Jul 2026" in some runtimes — normalise the comma
  const cleanDate = datePart.replace(',', '')

  return `Match at ${venueName.trim()} — ${cleanDate}, ${timePart}`
}
