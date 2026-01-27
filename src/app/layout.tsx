import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import NavBar from '@/components/NavBar'
import Footer from '@/components/Footer'
import { AuthProvider } from '@/lib/auth/context'
import { GotchaProvider } from '@/components/GotchaProvider'

const inter = Inter({ subsets: ['latin'] })

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
            <NavBar />
            {children}
            <Footer />
          </AuthProvider>
        </GotchaProvider>
      </body>
    </html>
  )
}
