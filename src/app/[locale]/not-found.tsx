import type { Metadata } from 'next'
import { getLocale, getTranslations } from 'next-intl/server'
import { getPathname } from '@/i18n/navigation'
import { NotFound } from '@braintwopoint0/playback-commons/ui'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('notFound')
  return { title: t('metaTitle') }
}

export default async function NotFoundPage() {
  const t = await getTranslations('notFound')
  const locale = await getLocale()

  // The commons NotFound renders plain next/link — internal hrefs must carry
  // the locale prefix or /ar users drop back to English.
  const localized = (href: string) => getPathname({ href, locale })

  return (
    <NotFound
      brand="PLAYHUB"
      title={t('title')}
      description={t('description')}
      ctaLabel={t('browseMatches')}
      ctaHref={localized('/matches')}
      links={[
        { label: t('home'), href: localized('/') },
        { label: t('browseMatches'), href: localized('/matches') },
        { label: t('myRecordings'), href: localized('/recordings') },
      ]}
    />
  )
}
