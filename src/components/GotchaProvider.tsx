'use client'

import { GotchaProvider as Provider } from 'gotcha-feedback'

export function GotchaProvider({ children }: { children: React.ReactNode }) {
  const apiKey = process.env.NEXT_PUBLIC_GOTCHA_API_KEY

  if (!apiKey) {
    return <>{children}</>
  }

  return <Provider apiKey={apiKey}>{children}</Provider>
}
