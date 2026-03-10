import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import NavBar from '@/components/NavBar'
import { Footer } from '@braintwopoint0/playback-commons/ui'
import { AuthProvider } from '@braintwopoint0/playback-commons/auth'
import { GotchaProvider } from '@/components/GotchaProvider'

const inter = Inter({ subsets: ['latin'] })

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

export const metadata: Metadata = {
  title: 'PLAYHUB - Match Recordings Marketplace',
  description: 'Buy and sell professional match recordings and highlight reels',
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
            <div className="flex min-h-screen flex-col">
              <NavBar />
              <main className="flex-1">{children}</main>
              <Footer />
            </div>
          </AuthProvider>
        </GotchaProvider>
      </body>
    </html>
  )
}
