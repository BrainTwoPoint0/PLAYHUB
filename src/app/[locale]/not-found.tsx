import type { Metadata } from 'next'
import { NotFound } from '@braintwopoint0/playback-commons/ui'

export const metadata: Metadata = {
  title: 'Page not found',
}

export default function NotFoundPage() {
  return (
    <NotFound
      brand="PLAYHUB"
      ctaLabel="Browse matches"
      ctaHref="/matches"
      links={[
        { label: 'Home', href: '/' },
        { label: 'Browse matches', href: '/matches' },
        { label: 'My recordings', href: '/recordings' },
      ]}
    />
  )
}
