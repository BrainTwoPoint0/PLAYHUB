'use client'

import { useLocale } from 'next-intl'
import { usePathname, useRouter } from '@/i18n/navigation'
import { Globe } from 'lucide-react'
import { cn } from '@braintwopoint0/playback-commons/utils'

// en ⇄ ar toggle; the label always names the language you would switch TO,
// in that language. Spanish joins once es.json has content.
export function LanguageSwitcher({
  className,
  onSwitched,
}: {
  className?: string
  onSwitched?: () => void
}) {
  const locale = useLocale()
  const router = useRouter()
  const pathname = usePathname()

  // startsWith survives region/extension variants (ar-KW etc.)
  const isArabic = locale.startsWith('ar')
  const target = isArabic ? 'en' : 'ar'
  const label = isArabic ? 'English' : 'العربية'

  function handleSwitch() {
    // window.location.search instead of useSearchParams(): NavBar renders in
    // the layout of statically generated pages, and useSearchParams would
    // force a Suspense/CSR bailout there.
    const query = typeof window !== 'undefined' ? window.location.search : ''
    router.replace(pathname + query, { locale: target })
    onSwitched?.()
  }

  return (
    <button
      type="button"
      onClick={handleSwitch}
      lang={target}
      className={cn(
        'inline-flex items-center gap-2 rounded-md text-sm text-muted-foreground',
        'hover:text-[var(--timberwolf)] hover:bg-accent/50 transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--timberwolf)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--night)]',
        className
      )}
    >
      <Globe className="h-4 w-4 shrink-0" />
      {label}
    </button>
  )
}
