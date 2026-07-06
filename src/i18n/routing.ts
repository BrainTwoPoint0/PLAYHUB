import { defineRouting } from 'next-intl/routing'

export const routing = defineRouting({
  locales: ['en', 'ar', 'es'],
  defaultLocale: 'en',
  // English URLs stay unprefixed (/venue); other locales get a prefix (/ar/venue)
  localePrefix: 'as-needed',
  // Arabic is opt-in via the NavBar switcher until the consumer surfaces
  // (landing, auth, matches) are translated — with detection on, every
  // Arabic-Accept-Language browser would be 307'd into English pages
  // mirrored RTL. Re-enable once those slices land.
  localeDetection: false,
  // Persist the chosen locale for a year (default cookie is session-scoped).
  localeCookie: { maxAge: 60 * 60 * 24 * 365 },
  // Do NOT add `domains` here without re-reviewing middleware.ts: domain
  // routing unlocks next-intl's cross-host redirects, and the middleware
  // replays refreshed Supabase auth cookies onto every response it returns.
})

export type Locale = (typeof routing.locales)[number]
