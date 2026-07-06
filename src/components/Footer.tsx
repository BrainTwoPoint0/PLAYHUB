'use client'

import { useTranslations } from 'next-intl'
import { SiteFooter } from '@braintwopoint0/playback-commons/ui'
import type { FooterColumnDef } from '@braintwopoint0/playback-commons/ui'

export default function Footer() {
  const t = useTranslations('footer')

  const columns: FooterColumnDef[] = [
    {
      title: t('browse'),
      links: [
        { label: t('matches'), href: '/matches' },
        { label: t('academy'), href: '/academy' },
      ],
    },
    {
      title: t('account'),
      links: [
        { label: t('recordings'), href: '/recordings' },
        { label: t('signIn'), href: '/auth/login' },
      ],
    },
    {
      title: t('company'),
      links: [
        {
          label: t('aboutPlayback'),
          href: 'https://playbacksports.ai',
          external: true,
        },
        {
          label: t('press'),
          href: 'https://playbacksports.ai/press',
          external: true,
        },
        {
          label: t('contact'),
          href: 'https://playbacksports.ai/#contact',
          external: true,
        },
      ],
    },
    {
      title: t('legal'),
      links: [
        { label: t('terms'), href: '/legal/terms' },
        {
          label: t('privacy'),
          href: 'https://playbacksports.ai/legal/privacy',
          external: true,
        },
        {
          label: t('cookies'),
          href: 'https://playbacksports.ai/legal/cookies',
          external: true,
        },
      ],
    },
  ]

  return (
    <SiteFooter
      columns={columns}
      newsletterEndpoint="https://playbacksports.ai/api/newsletter/subscribe"
      newsletterSource="playhub-footer"
      newsletterLabel={t('newsletterLabel')}
      newsletterTitle={t('newsletterTitle')}
      newsletterSubtitle={t('newsletterSubtitle')}
    />
  )
}
