import { getRequestConfig } from 'next-intl/server'
import { hasLocale } from 'next-intl'
import deepmerge from 'deepmerge'
import { routing } from './routing'

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale
  // NOTE: do not return a locale with Unicode extensions (e.g.
  // 'ar-u-nu-latn') — next-intl's Link uses this value for URL prefixing
  // and would emit /ar-u-nu-latn/... hrefs. Digit pinning happens via the
  // named 'latn' number format below plus per-call formatter options.
  const locale = hasLocale(routing.locales, requested)
    ? requested
    : routing.defaultLocale

  // en.json is the source of truth. Other locales are deep-merged over it so
  // any untranslated key falls back to English instead of throwing — this is
  // what allows es.json to stay empty until it gets a content pass.
  const en = (await import('../../messages/en.json')).default
  const messages =
    locale === 'en'
      ? en
      : deepmerge(en, (await import(`../../messages/${locale}.json`)).default)

  return {
    locale,
    messages,
    formats: {
      // numberingSystem 'latn' pins Western digits for Arabic — engines
      // disagree on the default for plain 'ar' (Chrome renders ٠١٢).
      // ar.json references the 'latn' number format for interpolated
      // numbers ({count, number, latn}) since ICU interpolation ignores
      // per-call formatter options. Flip to 'arab' everywhere here if
      // Eastern Arabic numerals are preferred.
      number: {
        latn: { numberingSystem: 'latn' },
      },
      dateTime: {
        short: {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          numberingSystem: 'latn',
        },
        monthShort: { month: 'short', numberingSystem: 'latn' },
        full: {
          dateStyle: 'medium',
          timeStyle: 'short',
          numberingSystem: 'latn',
        },
      },
    },
  }
})
