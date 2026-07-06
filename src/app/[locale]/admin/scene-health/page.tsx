// Admin page: /admin/scene-health
//
// Spiideo camera/scene health (from playhub_spiideo_scene_health, refreshed
// every 15 min by the spiideo-health Lambda) plus CloudControl device actions:
// scene speed test and test recording.
//
// Auth is enforced server-side here (getAuthUserStrict + isPlatformAdmin before
// render); the /api/admin/scene-health routes re-check on every request.
// Belt-and-braces, matches the existing /admin/* pattern.

import { getLocale } from 'next-intl/server'
import { redirect } from '@/i18n/navigation'
import { getAuthUserStrict } from '@/lib/supabase/server'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { SceneHealthClient } from './SceneHealthClient'

// The [locale] layout's generateStaticParams would otherwise prerender this
// page at build time, baking the unauthenticated redirect into a static
// shell. Auth must run per-request.
export const dynamic = 'force-dynamic'

export default async function SceneHealthAdminPage() {
  const { user } = await getAuthUserStrict()
  if (!user)
    return redirect({
      href: '/auth/login?redirect=/admin/scene-health',
      locale: await getLocale(),
    })
  if (!(await isPlatformAdmin(user.id)))
    return redirect({ href: '/', locale: await getLocale() })

  return <SceneHealthClient />
}
