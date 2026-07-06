import type { Metadata, Viewport } from 'next'
import { Inter, IBM_Plex_Sans_Arabic } from 'next/font/google'
import { notFound } from 'next/navigation'
import { NextIntlClientProvider, hasLocale } from 'next-intl'
import { setRequestLocale } from 'next-intl/server'
import { DirectionProvider } from '@radix-ui/react-direction'
import '../globals.css'
import NavBar from '@/components/NavBar'
import Footer from '@/components/Footer'
import { AuthProvider } from '@braintwopoint0/playback-commons/auth'
import { GotchaProvider } from '@/components/GotchaProvider'
import { PostHogProvider } from '@/components/PostHogProvider'
import { routing } from '@/i18n/routing'

const inter = Inter({ subsets: ['latin'] })

// Includes latin so English brand/team/venue names render consistently
// inside Arabic pages. Not a variable font — weights must be listed.
const plexArabic = IBM_Plex_Sans_Arabic({
  subsets: ['arabic', 'latin'],
  weight: ['400', '500', '600', '700'],
})

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL || 'https://playhub.playbacksports.ai'

const OG_LOCALES: Record<string, string> = {
  en: 'en_GB',
  ar: 'ar_AE',
  es: 'es_ES',
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }))
}

export const viewport: Viewport = {
  themeColor: '#0a100d',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  return {
    metadataBase: new URL(APP_URL),
    title: {
      default: 'PLAYHUB - Your game. On demand.',
      template: '%s | PLAYHUB',
    },
    description:
      'Full match recordings from clubs and academies. Buy a match, subscribe for the season, or watch the moments your kid was in - on any device.',
    applicationName: 'PLAYHUB',
    authors: [{ name: 'PLAYBACK Sports Ltd' }],
    keywords: [
      'PLAYHUB',
      'PLAYBACK',
      'match recordings',
      'academy subscriptions',
      'youth football',
      'Veo',
      'Spiideo',
      'match footage',
    ],
    alternates: { canonical: '/' },
    openGraph: {
      type: 'website',
      siteName: 'PLAYHUB',
      title: 'PLAYHUB - Your game. On demand.',
      description:
        'Full match recordings from clubs and academies. Buy a match, subscribe for the season, or watch the moments your kid was in.',
      url: '/',
      locale: OG_LOCALES[locale] ?? OG_LOCALES.en,
    },
    twitter: {
      card: 'summary_large_image',
      site: '@playbacksports',
      creator: '@playbacksports',
      title: 'PLAYHUB - Your game. On demand.',
      description:
        'Full match recordings from clubs and academies. Academy subscriptions and per-match purchases.',
    },
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        'max-image-preview': 'large',
        'max-snippet': -1,
        'max-video-preview': -1,
      },
    },
  }
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) {
    notFound()
  }
  // Enables static rendering for pages below this layout despite the
  // [locale] dynamic param.
  setRequestLocale(locale)

  const dir = locale === 'ar' ? 'rtl' : 'ltr'

  return (
    <html lang={locale} dir={dir}>
      <body
        className={locale === 'ar' ? plexArabic.className : inter.className}
      >
        <NextIntlClientProvider>
          <DirectionProvider dir={dir}>
            <GotchaProvider>
              <AuthProvider>
                <PostHogProvider>
                  <div className="flex min-h-screen flex-col">
                    <NavBar />
                    <main className="flex-1">{children}</main>
                    <Footer />
                  </div>
                </PostHogProvider>
              </AuthProvider>
            </GotchaProvider>
          </DirectionProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
