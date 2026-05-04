import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import NavBar from '@/components/NavBar'
import Footer from '@/components/Footer'
import { AuthProvider } from '@braintwopoint0/playback-commons/auth'
import { GotchaProvider } from '@/components/GotchaProvider'
import { PostHogProvider } from '@/components/PostHogProvider'

const inter = Inter({ subsets: ['latin'] })

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL || 'https://playhub.playbacksports.ai'

export const viewport: Viewport = {
  themeColor: '#0a100d',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
}

export const metadata: Metadata = {
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
    locale: 'en_GB',
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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
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
      </body>
    </html>
  )
}
