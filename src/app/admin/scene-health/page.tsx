// Admin page: /admin/scene-health
//
// Spiideo camera/scene health (from playhub_spiideo_scene_health, refreshed
// every 15 min by the spiideo-health Lambda) plus CloudControl device actions:
// scene speed test and test recording.
//
// Auth is enforced server-side here (getAuthUserStrict + isPlatformAdmin before
// render); the /api/admin/scene-health routes re-check on every request.
// Belt-and-braces, matches the existing /admin/* pattern.

import { redirect } from 'next/navigation'
import { getAuthUserStrict } from '@/lib/supabase/server'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { SceneHealthClient } from './SceneHealthClient'

export default async function SceneHealthAdminPage() {
  const { user } = await getAuthUserStrict()
  if (!user) redirect('/auth/login?redirect=/admin/scene-health')
  if (!(await isPlatformAdmin(user.id))) redirect('/')

  return <SceneHealthClient />
}
