// /venue/[venueId]/calibration/[sceneId] — venue-admin pitch marking surface.
// Auth is enforced by the pitch-calibration API the client calls (401/403
// render as the forbidden state); this shell only unpacks params. ?name=
// carries the scene's display name from the venue page (cosmetic only).

import { PitchCalibrationClient } from '@/components/calibration/PitchCalibrationClient'

export const dynamic = 'force-dynamic'

export default async function PitchCalibrationPage({
  params,
  searchParams,
}: {
  params: Promise<{ venueId: string; sceneId: string }>
  searchParams: Promise<{ name?: string }>
}) {
  const { venueId, sceneId } = await params
  const { name } = await searchParams
  return (
    <PitchCalibrationClient
      venueId={venueId}
      sceneId={sceneId}
      sceneName={name}
    />
  )
}
