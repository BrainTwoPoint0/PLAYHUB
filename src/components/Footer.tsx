'use client'

import { useLocale, useTranslations } from 'next-intl'
import { getPathname } from '@/i18n/navigation'
import { SiteFooter } from '@braintwopoint0/playback-commons/ui'
import type { FooterColumnDef } from '@braintwopoint0/playback-commons/ui'

export default function Footer() {
  const t = useTranslations('footer')
  const locale = useLocale()

  // The commons SiteFooter renders plain next/link, which doesn't know about
  // the locale prefix — internal hrefs must be prefixed here or /ar users
  // silently drop back to English on footer navigation.
  const localized = (href: string) => getPathname({ href, locale })

  const columns: FooterColumnDef[] = [
    {
      title: t('browse'),
      links: [
        { label: t('matches'), href: localized('/matches') },
        { label: t('academy'), href: localized('/academy') },
      ],
    },
    {
      title: t('account'),
      links: [
        { label: t('recordings'), href: localized('/recordings') },
        { label: t('signIn'), href: localized('/auth/login') },
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
        { label: t('terms'), href: localized('/legal/terms') },
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
      newsletterStrings={{
        placeholder: t('newsletterPlaceholder'),
        emailLabel: t('newsletterEmailLabel'),
        ariaLabel: t('newsletterAriaLabel'),
        submitLabel: t('newsletterSubmit'),
        sendingLabel: t('newsletterSending'),
        successMessage: t('newsletterSuccess'),
        invalidEmailMessage: t('newsletterInvalidEmail'),
        serverErrorMessage: t('newsletterServerError'),
        rateLimitedMessage: t('newsletterRateLimited'),
      }}
    />
  )
}
