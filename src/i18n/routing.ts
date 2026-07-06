import { defineRouting } from 'next-intl/routing'

export const routing = defineRouting({
  locales: ['en', 'ar', 'es'],
  defaultLocale: 'en',
  // English URLs stay unprefixed (/venue); other locales get a prefix (/ar/venue)
  localePrefix: 'as-needed',
  // Do NOT add `domains` here without re-reviewing middleware.ts: domain
  // routing unlocks next-intl's cross-host redirects, and the middleware
  // replays refreshed Supabase auth cookies onto every response it returns.
})

export type Locale = (typeof routing.locales)[number]
