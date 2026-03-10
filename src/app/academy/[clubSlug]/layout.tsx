'use client'

import { usePathname, useParams } from 'next/navigation'
import Link from 'next/link'

const tabs = [
  { label: 'Content', segment: 'content' },
  { label: 'Access Audit', segment: 'access' },
]

export default function AcademyClubLayout({
  children,
}: {
  children: React.ReactNode
}) {
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
            <nav className="flex gap-6" aria-label="Academy tabs">
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
                    {tab.label}
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
