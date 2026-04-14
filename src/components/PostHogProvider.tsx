'use client'

import { useEffect, Suspense } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import posthog from 'posthog-js'
import { useAuth } from '@braintwopoint0/playback-commons/auth'

function PostHogPageview() {
  const pathname = usePathname()
  const searchParams = useSearchParams()

  useEffect(() => {
    if (!pathname || !posthog.__loaded) return
    const query = searchParams?.toString()
    const url = query ? `${pathname}?${query}` : pathname
    posthog.capture('$pageview', { $current_url: window.location.origin + url })
  }, [pathname, searchParams])

  return null
}

function PostHogIdentifier() {
  const { user } = useAuth()

  useEffect(() => {
    if (!posthog.__loaded) return
    if (user?.id) {
      posthog.identify(user.id, {
        email: user.email,
        username: (user as { username?: string }).username,
      })
    } else {
      posthog.reset()
    }
  }, [user])

  return null
}

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY
    if (!key || posthog.__loaded) return

    posthog.init(key, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://eu.i.posthog.com',
      person_profiles: 'identified_only',
      capture_pageview: false,
      capture_pageleave: true,
    })
  }, [])

  return (
    <>
      <Suspense fallback={null}>
        <PostHogPageview />
      </Suspense>
      <PostHogIdentifier />
      {children}
    </>
  )
}
