'use client'

import { useState, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import {
  Button,
  Skeleton,
  EmptyState,
} from '@braintwopoint0/playback-commons/ui'
import { FadeIn } from '@/components/FadeIn'
import { Building2 } from 'lucide-react'

interface Org {
  id: string
  name: string
  slug: string
  type: string
  logo_url: string | null
}

export default function OrgSelectorPage() {
  const t = useTranslations('org.selector')
  const router = useRouter()
  const [orgs, setOrgs] = useState<Org[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchOrgs()
  }, [])

  async function fetchOrgs() {
    try {
      setLoading(true)
      const res = await fetch('/api/org')
      const data = await res.json()

      if (data.error) {
        setError(data.error)
        return
      }

      const orgList = data.organizations || []
      setOrgs(orgList)

      if (orgList.length === 1) {
        router.replace(`/org/${orgList[0].slug}/manage`)
      }
    } catch {
      setError(t('loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
        <div className="mb-10 space-y-3">
          <Skeleton className="h-3 w-[140px]" />
          <Skeleton className="h-9 w-[250px]" />
          <Skeleton className="h-4 w-[300px]" />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="rounded-xl border border-border bg-card p-6"
            >
              <div className="flex items-center gap-4 mb-4">
                <Skeleton className="w-12 h-12 rounded-full" />
                <div className="space-y-2 flex-1">
                  <Skeleton className="h-5 w-[140px]" />
                  <Skeleton className="h-3 w-[100px]" />
                </div>
              </div>
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
        <div className="rounded-xl border border-border bg-card p-6">
          <p dir="auto" className="text-red-400">
            {error}
          </p>
          <Button
            className="mt-4"
            variant="outline"
            onClick={() => router.push('/')}
          >
            {t('backToHome')}
          </Button>
        </div>
      </div>
    )
  }

  if (orgs.length === 0) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
        <EmptyState
          icon={<Building2 className="h-10 w-10" />}
          title={t('noOrgsTitle')}
          description={t('noOrgsDescription')}
          action={
            <Button variant="outline" onClick={() => router.push('/')}>
              {t('backToHome')}
            </Button>
          }
        />
      </div>
    )
  }

  const knownTypes = ['group', 'league', 'academy', 'venue']

  return (
    <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
      <FadeIn>
        <p className="text-muted-foreground text-xs font-semibold tracking-[0.25em] uppercase mb-3">
          {t('eyebrow')}
        </p>
        <h1 className="text-3xl md:text-4xl font-bold text-[var(--timberwolf)] mb-2">
          {t('title')}
        </h1>
        <p className="text-muted-foreground mb-10">{t('subtitle')}</p>
      </FadeIn>

      <div className="grid gap-4 md:grid-cols-2">
        {orgs.map((org, i) => (
          <FadeIn key={org.id} delay={i * 100}>
            <div
              className="cursor-pointer rounded-xl border border-border bg-card hover:border-[var(--timberwolf)]/25 hover:bg-muted/50 transition-colors duration-300"
              onClick={() => router.push(`/org/${org.slug}/manage`)}
            >
              <div className="p-6">
                <div className="flex items-center gap-4 mb-4">
                  {org.logo_url ? (
                    <img
                      src={org.logo_url}
                      alt={org.name}
                      className="w-12 h-12 rounded-full object-cover"
                    />
                  ) : (
                    <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
                      <span className="text-xl font-bold text-[var(--timberwolf)]">
                        {org.name.charAt(0)}
                      </span>
                    </div>
                  )}
                  <div>
                    <h2 className="text-lg font-semibold text-[var(--timberwolf)]">
                      {org.name}
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      {knownTypes.includes(org.type)
                        ? t(`types.${org.type}`)
                        : org.type}
                    </p>
                  </div>
                </div>
                <Button variant="outline" className="w-full">
                  {t('manage')}
                </Button>
              </div>
            </div>
          </FadeIn>
        ))}
      </div>
    </div>
  )
}
