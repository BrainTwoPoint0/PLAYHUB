// GET/PUT /api/venue/[venueId]/pitch-calibration?sceneId=
//
// Venue-admin pitch-boundary calibration for a camera scene (Spiideo/Clutch).
// GET returns the scene's ACTIVE calibration (gated to venue admins/platform
// admins here — stricter than the table's member-read RLS, which exists for
// direct-read consumers like dashboards). PUT saves a new
// calibration: validates the marks, runs the ADVISORY mesh solve (reprojection
// error shown to the operator for accept/redo), then atomically supersedes the
// previous active row via the playhub_activate_pitch_calibration RPC.
//
// Writes are venue-admin (not platform-only like group-tier-config): the marks
// don't move money, and the venue operator is exactly who knows their pitch.

import { NextRequest, NextResponse } from 'next/server'

import { isPlatformAdmin } from '@/lib/admin/auth'
import { meshBaseUrl } from '@/lib/panorama/mesh'
import { solveErrorBand } from '@/lib/panorama/pitch-band'
import { proposePitchMarksFromTracklets } from '@/lib/panorama/pitch-assist'
import {
  PITCH_LENGTH_BOUNDS,
  PITCH_WIDTH_BOUNDS,
  validateMarks,
} from '@/lib/panorama/pitch-marks'
import {
  MarkUnprojectableError,
  parseMeshGeometry,
  solvePitchHomography,
  type MeshGeometry,
} from '@/lib/panorama/pitch-solver'
import { parseTracklets } from '@/lib/panorama/tracklets'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { getSignedObjectUrl, listObjects } from '@/lib/s3/client'
import {
  createServiceClient,
  getAuthUser,
  getAuthUserStrict,
} from '@/lib/supabase/server'

type RouteContext = { params: Promise<{ venueId: string }> }

const MESH_FETCH_TIMEOUT_MS = 8000

/** Fetch + parse the scene mesh from the public panorama-meshes bucket. */
async function loadSceneMesh(
  sourceGameId: string,
  signal: AbortSignal
): Promise<MeshGeometry> {
  const base = meshBaseUrl(sourceGameId)
  const [sceneRes, vertsRes, idxRes] = await Promise.all([
    fetch(`${base}/scene.json`, { signal }),
    fetch(`${base}/vertices.bin`, { signal }),
    fetch(`${base}/indices.bin`, { signal }),
  ])
  if (!sceneRes.ok || !vertsRes.ok || !idxRes.ok) {
    throw new Error(
      `mesh fetch failed (${sceneRes.status}/${vertsRes.status}/${idxRes.status})`
    )
  }
  return parseMeshGeometry(
    await sceneRes.json(),
    await vertsRes.arrayBuffer(),
    await idxRes.arrayBuffer()
  )
}

/** Look up the scene's registered de-warp mesh source game, or null when no
 *  mesh is registered. THROWS on a DB error — callers must not conflate an
 *  infrastructure failure with the terminal "no mesh" state. */
async function meshSourceGameId(
  serviceClient: any,
  sceneId: string
): Promise<string | null> {
  const { data, error } = await serviceClient
    .from('playhub_panorama_scene_meshes')
    .select('source_game_id')
    .eq('scene_id', sceneId)
    .maybeSingle()
  if (error) throw error
  return data?.source_game_id ?? null
}

async function sceneForVenue(
  serviceClient: any,
  sceneId: string,
  venueId: string
): Promise<{ scene_id: string; provider: string } | null> {
  const { data } = await serviceClient
    .from('playhub_scene_venue_mapping')
    .select('scene_id, organization_id, provider')
    .eq('scene_id', sceneId)
    .maybeSingle()
  if (!data || data.organization_id !== venueId) return null
  return data
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { venueId } = await params
  const { user } = await getAuthUser()
  if (!user) {
    return NextResponse.json(
      { error: 'Unauthorized', code: 'unauthorized' },
      { status: 401 }
    )
  }
  const sceneId = request.nextUrl.searchParams.get('sceneId')
  // Same hygiene as PUT: the exact-match DB gate makes a longer string
  // harmless today, but this string reaches an S3 list prefix — keep both
  // handlers validating identically so a refactor can't diverge them.
  if (!sceneId || sceneId.length > 128) {
    return NextResponse.json(
      { error: 'sceneId is required', code: 'bad_request' },
      { status: 400 }
    )
  }
  const [isAdmin, isPlatform] = await Promise.all([
    isVenueAdmin(user.id, venueId),
    isPlatformAdmin(user.id),
  ])
  if (!isAdmin && !isPlatform) {
    return NextResponse.json(
      { error: 'Forbidden', code: 'forbidden' },
      { status: 403 }
    )
  }

  const serviceClient = createServiceClient() as any
  const scene = await sceneForVenue(serviceClient, sceneId, venueId)
  if (!scene) {
    return NextResponse.json(
      { error: 'Scene not found for this venue', code: 'not_found' },
      { status: 404 }
    )
  }

  const { data, error } = await serviceClient
    .from('playhub_pitch_calibrations')
    .select('*')
    .eq('scene_id', sceneId)
    .eq('status', 'active')
    .maybeSingle()

  if (error) {
    console.error('Failed to fetch pitch calibration:', error)
    return NextResponse.json(
      { error: 'Failed to fetch pitch calibration', code: 'internal' },
      { status: 500 }
    )
  }

  // ?propose=1 marks the MARKING-CLIENT call, which additionally needs the
  // mesh source, the occupancy proposal, and the newest still. The venue-page
  // status card GETs without it and reads only `active` — skip the S3 list +
  // presign + mesh lookups on that hot path (it fires one GET per scene per
  // page load). Fields stay in the response shape (null) either way.
  let proposal = null
  let proposalStatus: ProposalStatus | undefined
  let sourceGameId: string | null = null
  let frame: { s3Key: string; url: string } | null = null
  if (request.nextUrl.searchParams.get('propose') === '1') {
    // A DB failure here must NOT read as the terminal "no mesh registered"
    // state on the client — surface it as a retryable 500 instead.
    try {
      sourceGameId = await meshSourceGameId(serviceClient, sceneId)
    } catch (err) {
      console.error('Failed to resolve mesh source game:', err)
      return NextResponse.json(
        { error: 'Failed to resolve scene mesh', code: 'internal' },
        { status: 500 }
      )
    }

    // Assist: seed the marking UI with corners derived from tracklet
    // occupancy (a rough, systematically-inset starting quad; admin drags to
    // the painted lines). Best-effort — never fails the GET. proposalStatus
    // tells the UI WHY a proposal is absent (no tracklets yet vs a transient
    // CDN failure) so the operator knows whether to mark manually or retry.
    const r = await buildProposal(sourceGameId)
    proposal = r.proposal
    proposalStatus = r.status

    // The marking surface needs a still of the raw panorama. Stills are
    // written by the player-tracklets Batch job (median frame, private S3);
    // newest wins so a recalibration marks on recent footage. Best-effort —
    // absence renders as the UI's no_frame state, an S3 outage must not hide
    // the active row. Zero-byte objects (console-created prefix markers) are
    // not stills.
    try {
      const stills = await listObjects(`calibration-stills/${sceneId}/`)
      const newest = stills
        .filter((o) => o.lastModified && o.size > 0)
        .sort(
          (a, b) => b.lastModified!.getTime() - a.lastModified!.getTime()
        )[0]
      if (newest) {
        frame = {
          s3Key: newest.key,
          url: await getSignedObjectUrl(newest.key, 60 * 60),
        }
      }
    } catch (err) {
      console.error('Failed to resolve calibration still:', err)
    }
  }

  // Auth-gated response folding a MUTABLE row (active, superseded by PUT) — must
  // never be cached by a shared intermediary, and can't carry a positive TTL.
  return NextResponse.json(
    {
      active: data ?? null,
      proposal,
      proposalStatus,
      frame,
      meshSourceGameId: sourceGameId,
    },
    { headers: { 'Cache-Control': 'private, no-store' } }
  )
}

type ProposalStatus = 'ok' | 'no_mesh' | 'no_tracklets' | 'unavailable'

/** Best-effort occupancy proposal for a scene, with a reason when absent. */
async function buildProposal(sourceGameId: string | null): Promise<{
  proposal: Awaited<ReturnType<typeof proposePitchMarksFromTracklets>>
  status: ProposalStatus
}> {
  try {
    if (!sourceGameId) return { proposal: null, status: 'no_mesh' }
    const signal = AbortSignal.timeout(MESH_FETCH_TIMEOUT_MS)
    const base = meshBaseUrl(sourceGameId)
    const [mesh, trackRes] = await Promise.all([
      loadSceneMesh(sourceGameId, signal),
      fetch(`${base}/tracklets.json`, { signal }),
    ])
    if (!trackRes.ok) return { proposal: null, status: 'no_tracklets' }
    const tracklets = parseTracklets(await trackRes.json())
    if (!tracklets) return { proposal: null, status: 'no_tracklets' }
    const proposal = proposePitchMarksFromTracklets(tracklets, mesh, 3840, 2160)
    return { proposal, status: proposal ? 'ok' : 'no_tracklets' }
  } catch (err) {
    console.error('Pitch proposal failed:', err)
    return { proposal: null, status: 'unavailable' }
  }
}

export async function PUT(request: NextRequest, { params }: RouteContext) {
  const { venueId } = await params
  const { user } = await getAuthUserStrict()
  if (!user) {
    return NextResponse.json(
      { error: 'Unauthorized', code: 'unauthorized' },
      { status: 401 }
    )
  }
  const [isAdmin, isPlatform] = await Promise.all([
    isVenueAdmin(user.id, venueId),
    isPlatformAdmin(user.id),
  ])
  if (!isAdmin && !isPlatform) {
    return NextResponse.json(
      { error: 'Forbidden', code: 'forbidden' },
      { status: 403 }
    )
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body', code: 'bad_request' },
      { status: 400 }
    )
  }

  const sceneId = typeof body.sceneId === 'string' ? body.sceneId : null
  const frameS3Key =
    typeof body.frameS3Key === 'string' && body.frameS3Key.length > 0
      ? body.frameS3Key
      : null
  const frameWidth = Number(body.frameWidth ?? 3840)
  const frameHeight = Number(body.frameHeight ?? 2160)
  const pitchLengthM = Number(body.pitchLengthM)
  const pitchWidthM = Number(body.pitchWidthM)

  if (!sceneId || sceneId.length > 128 || !frameS3Key) {
    return NextResponse.json(
      { error: 'sceneId and frameS3Key are required', code: 'bad_request' },
      { status: 400 }
    )
  }
  // frameS3Key is persisted and will later be presigned for display: pin it to
  // this scene's calibration-stills prefix so a stored key can never reference
  // another tenant's object (stored-reference IDOR), and allowlist characters.
  if (
    !frameS3Key.startsWith(`calibration-stills/${sceneId}/`) ||
    frameS3Key.includes('..') ||
    !/^[\w!.*'()/-]{1,512}$/.test(frameS3Key)
  ) {
    return NextResponse.json(
      { error: 'Invalid frameS3Key', code: 'bad_request' },
      { status: 400 }
    )
  }
  const MAX_FRAME_DIM = 16384
  if (
    !Number.isInteger(frameWidth) ||
    !Number.isInteger(frameHeight) ||
    frameWidth <= 0 ||
    frameHeight <= 0 ||
    frameWidth > MAX_FRAME_DIM ||
    frameHeight > MAX_FRAME_DIM
  ) {
    return NextResponse.json(
      { error: 'Invalid frame dimensions', code: 'bad_request' },
      { status: 400 }
    )
  }
  const inBounds = (v: number, [lo, hi]: [number, number]) =>
    Number.isFinite(v) && v >= lo && v <= hi
  if (
    !inBounds(pitchLengthM, PITCH_LENGTH_BOUNDS) ||
    !inBounds(pitchWidthM, PITCH_WIDTH_BOUNDS)
  ) {
    return NextResponse.json(
      {
        error: `pitchLengthM must be ${PITCH_LENGTH_BOUNDS[0]}-${PITCH_LENGTH_BOUNDS[1]}m and pitchWidthM ${PITCH_WIDTH_BOUNDS[0]}-${PITCH_WIDTH_BOUNDS[1]}m`,
        code: 'bad_request',
      },
      { status: 400 }
    )
  }

  const validated = validateMarks(body.marks, frameWidth, frameHeight)
  if ('error' in validated) {
    return NextResponse.json(
      { error: validated.error.detail, code: validated.error.code },
      { status: 400 }
    )
  }

  const serviceClient = createServiceClient() as any
  const scene = await sceneForVenue(serviceClient, sceneId, venueId)
  if (!scene) {
    return NextResponse.json(
      { error: 'Scene not found for this venue', code: 'not_found' },
      { status: 404 }
    )
  }

  // The scene's de-warp mesh is the geometry ground truth the marks solve
  // through (and the surface the marking UI rendered). No mesh = no marking
  // surface = nothing meaningful to save.
  const { data: meshRow } = await serviceClient
    .from('playhub_panorama_scene_meshes')
    .select('source_game_id')
    .eq('scene_id', sceneId)
    .maybeSingle()
  if (!meshRow?.source_game_id) {
    return NextResponse.json(
      {
        error:
          'Scene has no de-warp mesh registered; calibrate after the mesh is ingested',
        code: 'no_mesh',
      },
      { status: 409 }
    )
  }

  let solve
  try {
    const signal = AbortSignal.timeout(MESH_FETCH_TIMEOUT_MS)
    const mesh = await loadSceneMesh(meshRow.source_game_id, signal)
    solve = solvePitchHomography(
      mesh,
      validated.marks,
      { lengthM: pitchLengthM, widthM: pitchWidthM },
      frameWidth,
      frameHeight
    )
  } catch (err) {
    if (err instanceof MarkUnprojectableError) {
      return NextResponse.json(
        {
          error: `Mark ${err.markName} falls outside the camera's mesh coverage — nudge it inside the de-warped view`,
          code: 'mark_unprojectable',
          markName: err.markName,
        },
        { status: 422 }
      )
    }
    // Everything else reachable here is a mesh-artifact failure (CDN fetch or
    // parse) — an infrastructure problem, NOT bad marks. The code must say so
    // or the operator gets sent into a pointless redo loop.
    console.error('Pitch calibration mesh fetch/parse failed:', err)
    return NextResponse.json(
      {
        error: 'Scene mesh could not be loaded; try again later',
        code: 'mesh_unavailable',
      },
      { status: 502 }
    )
  }

  // Red-band solves SAVE for reference but never ACTIVATE: the same
  // solveErrorBand verdict the result screen shows (shared lib — lockstep is
  // the product guarantee). A red solve means the marks or the camera model
  // are wrong; letting it go live would feed watch half-framing and the
  // tracklets field filter garbage geometry. The prior active calibration
  // (if any) stays in place; the admin adjusts, or the camera model gets
  // refit and a re-save activates then.
  const band = solveErrorBand(solve.reprojectionErrorPx, validated.marks)
  let data: unknown
  let error: { message?: string } | null = null
  if (band === 'bad') {
    const inserted = await serviceClient
      .from('playhub_pitch_calibrations')
      .insert({
        scene_id: sceneId,
        venue_organization_id: venueId,
        provider: scene.provider,
        source: 'operator',
        status: 'draft',
        frame_s3_key: frameS3Key,
        frame_width: frameWidth,
        frame_height: frameHeight,
        mesh_source_game_id: meshRow.source_game_id,
        marks: validated.marks,
        pitch_length_m: pitchLengthM,
        pitch_width_m: pitchWidthM,
        solver_version: solve.solverVersion,
        homography: solve.homography,
        field_polygon_rayn: solve.fieldPolygonRayn,
        reprojection_error_px: solve.reprojectionErrorPx,
        created_by: user.id,
      })
      .select()
      .single()
    data = inserted.data
    error = inserted.error
  } else {
    const activated = await serviceClient.rpc(
      'playhub_activate_pitch_calibration',
      {
        p_scene_id: sceneId,
        p_venue_organization_id: venueId,
        p_provider: scene.provider,
        p_source: 'operator',
        p_frame_s3_key: frameS3Key,
        p_frame_width: frameWidth,
        p_frame_height: frameHeight,
        p_mesh_source_game_id: meshRow.source_game_id,
        p_marks: validated.marks,
        p_pitch_length_m: pitchLengthM,
        p_pitch_width_m: pitchWidthM,
        p_solver_version: solve.solverVersion,
        p_homography: solve.homography,
        p_field_polygon_rayn: solve.fieldPolygonRayn,
        p_reprojection_error_px: solve.reprojectionErrorPx,
        p_created_by: user.id,
      }
    )
    data = activated.data
    error = activated.error
  }

  if (error) {
    console.error('Failed to save pitch calibration:', error)
    return NextResponse.json(
      { error: 'Failed to save pitch calibration', code: 'internal' },
      { status: 500 }
    )
  }

  return NextResponse.json({
    calibration: data,
    activated: band !== 'bad',
    solve: {
      reprojectionErrorPx: solve.reprojectionErrorPx,
      perMarkErrorRad: solve.perMarkErrorRad,
      perMarkErrorPx: solve.perMarkErrorPx,
    },
  })
}
