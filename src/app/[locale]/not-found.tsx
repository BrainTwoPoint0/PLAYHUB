import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { NotFound } from '@braintwopoint0/playback-commons/ui'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('notFound')
  return { title: t('metaTitle') }
}

export default async function NotFoundPage() {
  const t = await getTranslations('notFound')
  return (
    <NotFound
      brand="PLAYHUB"
      title={t('title')}
      description={t('description')}
      ctaLabel={t('browseMatches')}
      ctaHref="/matches"
      links={[
        { label: t('home'), href: '/' },
        { label: t('browseMatches'), href: '/matches' },
        { label: t('myRecordings'), href: '/recordings' },
      ]}
    />
  )
}
