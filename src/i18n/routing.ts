import { defineRouting } from 'next-intl/routing'

export const routing = defineRouting({
  locales: ['en', 'ar', 'es'],
  defaultLocale: 'en',
  // English URLs stay unprefixed (/venue); other locales get a prefix (/ar/venue)
  localePrefix: 'as-needed',
})

export type Locale = (typeof routing.locales)[number]
