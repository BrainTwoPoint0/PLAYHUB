import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { ChevronLeft } from 'lucide-react'
import { JerseyMapEditor } from './jersey-map-editor'

export const metadata = {
  title: 'Jersey Map',
}

interface PageProps {
  params: Promise<{ slug: string; recordingId: string }>
}

export default async function JerseyMapPage({ params }: PageProps) {
  const { slug, recordingId } = await params
  const { user } = await getAuthUser()
  if (!user) {
    redirect(
      `/login?next=/org/${slug}/manage/recordings/${recordingId}/jersey-map`
    )
  }

  const supabase = createServiceClient() as any

  const { data: org } = await supabase
    .from('organizations')
    .select('id, name, slug')
    .eq('slug', slug)
    .maybeSingle()
  if (!org) notFound()

  const isAdmin =
    (await isVenueAdmin(user.id, org.id)) || (await isPlatformAdmin(user.id))
  if (!isAdmin) redirect(`/org/${slug}`)

  const { data: recording } = await supabase
    .from('playhub_match_recordings')
    .select('id, organization_id, title, match_date, home_team, away_team')
    .eq('id', recordingId)
    .maybeSingle()
  if (!recording) notFound()
  // Hard fail if the recording isn't owned by this org — prevents the trigger's
  // org-consistency CHECK from being the only line of defense.
  if (recording.organization_id !== org.id) {
    notFound()
  }

  // Fetch active player roster + the existing jersey map in parallel.
  const [{ data: members }, { data: existing }] = await Promise.all([
    supabase
      .from('organization_members')
      .select(
        'id, profile_id, jersey_number, profiles:profile_id (id, full_name, username)'
      )
      .eq('organization_id', org.id)
      .eq('role', 'player')
      .eq('is_active', true)
      .order('jersey_number', { ascending: true, nullsFirst: false }),
    supabase
      .from('match_jersey_maps')
      .select('jersey_number, profile_id, notes, locked_at')
      .eq('recording_id', recordingId)
      .eq('club_org_id', org.id)
      .order('jersey_number', { ascending: true }),
  ])

  const roster = ((members ?? []) as any[]).map((m) => {
    const profile = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles
    return {
      profileId: m.profile_id as string,
      fullName: (profile?.full_name as string | null) ?? null,
      username: (profile?.username as string | null) ?? null,
      defaultJerseyNumber: (m.jersey_number as number | null) ?? null,
    }
  })

  const existingEntries = ((existing ?? []) as any[]).map((e) => ({
    jerseyNumber: e.jersey_number as number,
    profileId: (e.profile_id as string | null) ?? null,
    notes: (e.notes as string | null) ?? null,
    lockedAt: (e.locked_at as string | null) ?? null,
  }))

  const alreadyLocked = existingEntries.some((e) => e.lockedAt !== null)

  return (
    <div className="container mx-auto py-8 px-4 max-w-3xl">
      <Link
        href={`/org/${slug}/manage`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-6"
      >
        <ChevronLeft className="h-4 w-4" />
        Back to manage
      </Link>

      <JerseyMapEditor
        recordingId={recording.id}
        recordingTitle={recording.title}
        homeTeam={recording.home_team}
        awayTeam={recording.away_team}
        matchDate={recording.match_date}
        roster={roster}
        existingEntries={existingEntries}
        alreadyLocked={alreadyLocked}
      />
    </div>
  )
}
