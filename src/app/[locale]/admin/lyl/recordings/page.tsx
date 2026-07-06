// Admin page: /admin/lyl/recordings
//
// Lists every parse + assignment state row for LYL with controls to:
//   - manually override the parse (home/away subclub + age)
//   - clear an existing override (back to cron control)
//   - re-trigger a single recording's sync
//   - kick off a full manual sync
//   - view recent sync-run summaries
//
// Auth is enforced server-side here (getAuthUserStrict + isPlatformAdmin
// before render); the API routes the client component calls re-check on
// every request. Belt-and-braces, matches existing /admin/* pattern.

import { getLocale } from 'next-intl/server'
import { redirect } from '@/i18n/navigation'
import { getAuthUserStrict } from '@/lib/supabase/server'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { LylRecordingsClient } from './LylRecordingsClient'

// The [locale] layout's generateStaticParams would otherwise prerender this
// page at build time, baking the unauthenticated redirect into a static
// shell. Auth must run per-request.
export const dynamic = 'force-dynamic'

export default async function LylRecordingsAdminPage() {
  const { user } = await getAuthUserStrict()
  if (!user)
    return redirect({
      href: '/auth/login?redirect=/admin/lyl/recordings',
      locale: await getLocale(),
    })
  if (!(await isPlatformAdmin(user.id)))
    return redirect({ href: '/', locale: await getLocale() })

  return <LylRecordingsClient />
}
