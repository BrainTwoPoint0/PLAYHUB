'use client'

import { SiteFooter } from '@braintwopoint0/playback-commons/ui'
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

export default function Footer() {
  return (
    <SiteFooter
      columns={columns}
      newsletterEndpoint="https://playbacksports.ai/api/newsletter/subscribe"
      newsletterSource="playhub-footer"
    />
  )
}
