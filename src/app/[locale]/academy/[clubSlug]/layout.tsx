'use client'

import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { usePathname } from '@/i18n/navigation'
import { Link } from '@/i18n/navigation'

const tabs = [
  { labelKey: 'content', segment: 'content' },
  { labelKey: 'accessAudit', segment: 'access' },
] as const

export default function AcademyClubLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const t = useTranslations('academy.tabs')
  const pathname = usePathname()
  const params = useParams()
  const clubSlug = params.clubSlug as string
  const basePath = `/academy/${clubSlug}`

  // Determine active tab from pathname
  const activeSegment = tabs.find((t) =>
    pathname.includes(`/${t.segment}`)
  )?.segment

  // Only show tabs if we're on a tab page (not the bare /academy/[clubSlug])
  const showTabs = activeSegment !== undefined

  return (
    <div className="min-h-screen bg-[var(--night)]">
      {showTabs && (
        <div
          className="border-b"
          style={{ borderColor: 'rgba(185,186,163,0.08)' }}
        >
          <div className="container mx-auto max-w-5xl px-4 sm:px-6">
            <nav className="flex gap-6" aria-label={t('ariaLabel')}>
              {tabs.map((tab) => {
                const href = `${basePath}/${tab.segment}`
                const isActive = activeSegment === tab.segment
                return (
                  <Link
                    key={tab.segment}
                    href={href}
                    className={`relative py-3 text-sm transition-colors ${
                      isActive
                        ? 'text-[var(--timberwolf)]'
                        : 'text-muted-foreground/50 hover:text-muted-foreground'
                    }`}
                  >
                    {t(tab.labelKey)}
                    {isActive && (
                      <span className="absolute bottom-0 left-0 right-0 h-px bg-[var(--timberwolf)]" />
                    )}
                  </Link>
                )
              })}
            </nav>
          </div>
        </div>
      )}
      {children}
    </div>
  )
}
