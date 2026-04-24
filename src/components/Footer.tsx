'use client'

import { Footer as CommonsFooter } from '@braintwopoint0/playback-commons/ui'
import type { FooterColumnDef } from '@braintwopoint0/playback-commons/ui'

const columns: FooterColumnDef[] = [
  {
    title: 'Browse',
    links: [
      { label: 'Matches', href: '/matches' },
      { label: 'Academy', href: '/academy' },
    ],
  },
  {
    title: 'Account',
    links: [
      { label: 'Recordings', href: '/recordings' },
      { label: 'Sign in', href: '/auth/login' },
    ],
  },
  {
    title: 'Company',
    links: [
      {
        label: 'About PLAYBACK',
        href: 'https://playbacksports.ai',
        external: true,
      },
      {
        label: 'Press',
        href: 'https://playbacksports.ai/press',
        external: true,
      },
      {
        label: 'Contact',
        href: 'https://playbacksports.ai/#contact',
        external: true,
      },
    ],
  },
  {
    title: 'Legal',
    links: [
      { label: 'Terms', href: '/legal/terms' },
      {
        label: 'Privacy',
        href: 'https://playbacksports.ai/legal/privacy',
        external: true,
      },
      {
        label: 'Cookies',
        href: 'https://playbacksports.ai/legal/cookies',
        external: true,
      },
    ],
  },
]

const NEWSLETTER_ENDPOINT = 'https://playbacksports.ai/api/newsletter/subscribe'

async function handleNewsletterSubmit(email: string) {
  const res = await fetch(NEWSLETTER_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      source: 'playhub-footer',
      // Honeypot field the subscribe endpoint expects — must be empty.
      website: '',
    }),
  })
  if (!res.ok) {
    throw new Error(
      res.status === 429
        ? 'Too many requests. Please try again shortly.'
        : 'Subscription failed. Please try again.'
    )
  }
}

export default function Footer() {
  return (
    <CommonsFooter
      columns={columns}
      newsletter
      newsletterAction={handleNewsletterSubmit}
    />
  )
}
