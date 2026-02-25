// Club slug → Veo ClubHouse slug mapping
// Mirrors src/lib/academy/config.ts but standalone (no Next.js dependency)

export const CLUB_VEO_SLUGS: Record<string, string> = {
  cfa: 'playback-15fdc44b',
  sefa: 'soccer-elite-fa-0b0814d2',
}

// Recordings from these teams should stay public (matched by team name on recording)
// Key: Veo club slug, Value: array of team names to skip
export const PUBLIC_RECORDING_TEAMS: Record<string, string[]> = {
  'soccer-elite-fa-0b0814d2': ['Soccer Elite FA U19'],
}
