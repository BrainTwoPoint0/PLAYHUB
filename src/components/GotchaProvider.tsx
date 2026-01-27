'use client'

import { GotchaProvider as Provider } from 'gotcha-feedback'

export function GotchaProvider({ children }: { children: React.ReactNode }) {
  // Try both env var names for flexibility
  const apiKey = process.env.GOTCHA_API_KEY

  if (!apiKey) {
    return <>{children}</>
  }

  return (
    <Provider apiKey={apiKey} debug={false}>
      {children}
    </Provider>
  )
}
