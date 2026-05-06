import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { isPlatformAdmin } from '@/lib/admin/auth'
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@braintwopoint0/playback-commons/ui'
import { VerifyPlayerButton } from './verify-player-button'
import { ChevronLeft } from 'lucide-react'

export const metadata = {
  title: 'Roster · Manage',
}

interface PageProps {
  params: Promise<{ slug: string }>
}

interface RosterRow {
  membershipId: string
  profileId: string
  fullName: string | null
  username: string | null
  jerseyNumber: number | null
  isVerified: boolean
}

export default async function RosterPage({ params }: PageProps) {
  const { slug } = await params
  const { user } = await getAuthUser()
  if (!user) redirect(`/login?next=/org/${slug}/manage/roster`)

  const supabase = createServiceClient() as any

  const { data: org } = await supabase
    .from('organizations')
    .select('id, name, slug')
    .eq('slug', slug)
    .maybeSingle()
  if (!org) notFound()

  const isAdmin =
    (await isVenueAdmin(user.id, org.id)) || (await isPlatformAdmin(user.id))
  if (!isAdmin) {
    redirect(`/org/${slug}`)
  }

  // Roster: org_members where role='player' AND active. Join profiles for display.
  const { data: members } = await supabase
    .from('organization_members')
    .select(
      'id, profile_id, jersey_number, profiles:profile_id (id, full_name, username)'
    )
    .eq('organization_id', org.id)
    .eq('role', 'player')
    .eq('is_active', true)
    .order('jersey_number', { ascending: true, nullsFirst: false })

  const memberRows = (members ?? []) as any[]
  const profileIds = memberRows.map((m) => m.profile_id).filter(Boolean)

  // Active verifications by THIS org for THIS profile (not variant-scoped here —
  // the roster page issues profile-wide club verifications).
  const verifiedSet = new Set<string>()
  if (profileIds.length > 0) {
    const { data: verifications } = await supabase
      .from('profile_verifications')
      .select('profile_id')
      .eq('verifying_org_id', org.id)
      .is('revoked_at', null)
      .in('profile_id', profileIds)
    ;(verifications ?? []).forEach((v: any) => verifiedSet.add(v.profile_id))
  }

  const roster: RosterRow[] = memberRows.map((m) => {
    const profile = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles
    return {
      membershipId: m.id as string,
      profileId: m.profile_id as string,
      fullName: profile?.full_name ?? null,
      username: profile?.username ?? null,
      jerseyNumber: (m.jersey_number as number | null) ?? null,
      isVerified: verifiedSet.has(m.profile_id),
    }
  })

  const verifiedCount = roster.filter((r) => r.isVerified).length

  return (
    <div className="container mx-auto py-8 px-4 max-w-4xl">
      <Link
        href={`/org/${slug}/manage`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-6"
      >
        <ChevronLeft className="h-4 w-4" />
        Back to manage
      </Link>

      <Card>
        <CardHeader>
          <CardTitle>{org.name} · Roster</CardTitle>
          <CardDescription>
            {roster.length} active player
            {roster.length === 1 ? '' : 's'} · {verifiedCount} verified by this
            club
          </CardDescription>
        </CardHeader>
        <CardContent>
          {roster.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No active players on the roster yet.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {roster.map((row) => (
                <div
                  key={row.membershipId}
                  className="flex items-center justify-between gap-4 py-3"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center text-sm font-mono">
                      {row.jerseyNumber !== null ? row.jerseyNumber : '–'}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">
                        {row.fullName ?? row.username ?? 'Unknown player'}
                      </div>
                      {row.username && (
                        <Link
                          href={`/p/${row.username}`}
                          className="text-xs text-muted-foreground hover:underline"
                        >
                          @{row.username}
                        </Link>
                      )}
                    </div>
                  </div>
                  <VerifyPlayerButton
                    profileId={row.profileId}
                    organizationId={org.id}
                    initialVerified={row.isVerified}
                  />
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
