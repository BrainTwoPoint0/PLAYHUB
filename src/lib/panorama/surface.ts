// De-warp surface availability, resolved once and shared by every page that
// mounts the panorama player (/watch/[id] and /recordings/[id]).
//
// Two concerns, deliberately separate:
//  - resolveWatchPanorama() — SERVER side. Does this recording have a published
//    mesh, and (for a half-framed recording) what pan sub-window does its
//    scene's CURRENT active calibration imply? Both degrade to null on any
//    failure: a broken calibration must never block a watch/review page.
//  - panoramaDefaults() — PURE. Given the resolved mesh + the raw-VP capture
//    status, which surface should the page OPEN on, and should it offer the
//    Explore toggle at all?
//
// They live together so the two pages can't drift on the availability rule —
// the recordings API and the watch page previously would have had to duplicate
// the same 50-line derivation.

import { meshBaseUrl, meshExists } from '@/lib/panorama/mesh'
import { panWindowForFocus, type PanWindow } from '@/lib/panorama/pitch-focus'
import { hasMidline } from '@/lib/panorama/pitch-marks'
import { parseMeshGeometry } from '@/lib/panorama/pitch-solver'

/** The subset of playhub_match_recordings this module reads. */
export interface PanoramaRecordingRow {
  status?: string | null
  spiideo_game_id?: string | null
  spiideo_scene_id?: string | null
  pitch_focus?: string | null
  panorama_capture_status?: string | null
  panorama_s3_key?: string | null
}

/** Half-pitch focus values that imply a pan window. Anything else = full frame. */
const HALF_FOCUS = new Set(['left_half', 'right_half'])

/** Per-asset budget for the half-framing mesh fetches. See the call site. */
const MESH_FETCH_TIMEOUT_MS = 3000

/**
 * Is the raw VP already banked — i.e. will opening the de-warp be served from
 * the existing object rather than actuating a multi-GB capture?
 *
 * This is deliberately the EXACT condition of the panorama-source route's fast
 * path (`if (rec.panorama_s3_key)`), because that is the property the caller
 * needs: "a POST here returns a signed URL and submits no job". Do not soften
 * it to `panorama_capture_status === 'ready'`. The two agree today (the
 * producer writes key + status in one update) but they fail in opposite
 * directions, and only the key is load-bearing:
 *
 *  - key set, status not 'ready' (operator reset, partial write) → the route
 *    serves it instantly, but a status-based check would open flat forever.
 *  - status 'ready', key gone (lifecycle purge, manual delete) → a status-based
 *    check would auto-fire, the route would fall through to the CAS, and the
 *    CAS *cannot claim a 'ready' row by construction* → `pending` → the page
 *    sits on a disabled "Preparing…" for the full 5-minute deadline, on every
 *    single load.
 *
 * `status !== 'published'` is a hard no: panorama-source 404s on it, so
 * auto-opening would only burn a request.
 */
export function isPanoramaBanked(rec: PanoramaRecordingRow): boolean {
  return rec.status === 'published' && !!rec.panorama_s3_key
}

export interface ResolvedPanorama {
  /** Public mesh base URL, or null when no mesh is published for this game. */
  meshBaseUrl: string | null
  /** Half-pitch pan window (radians), or null for full framing. */
  panWindow: PanWindow | null
}

/**
 * Resolve the de-warp mesh + half-framing window for a recording.
 *
 * Availability keys off the Spiideo game (+ a published mesh), NOT content_type:
 * a Spiideo recording's default view is the hosted Play production
 * ('hosted_video'), but it still has a pannable raw panorama we can de-warp.
 * `meshExists` is a cheap public HEAD; a miss keeps the page on the flat player.
 *
 * Mesh artifacts are mostly-stable but DO get regenerated on calibration refits
 * (2026-07-12/13) — staleness is bound to a day rather than cached forever.
 *
 * @param serviceClient a service-role Supabase client (RLS bypassed)
 */
export async function resolveWatchPanorama(
  serviceClient: any,
  recording: PanoramaRecordingRow
): Promise<ResolvedPanorama> {
  let resolvedMeshUrl: string | null = null
  if (recording.spiideo_game_id) {
    const base = meshBaseUrl(recording.spiideo_game_id)
    if (base && (await meshExists(recording.spiideo_game_id))) {
      resolvedMeshUrl = base
    }
  }

  let panWindow: PanWindow | null = null
  if (
    resolvedMeshUrl &&
    recording.pitch_focus &&
    // Membership test, not `!== 'full'`: an unrecognised focus value would
    // otherwise reach panWindowForFocus, index HALF_MARKS to undefined and
    // throw into the catch-all below, reporting "derivation failed" for what
    // is really "not a half-pitch recording".
    HALF_FOCUS.has(recording.pitch_focus) &&
    recording.spiideo_scene_id
  ) {
    try {
      const { data: cal } = await serviceClient
        .from('playhub_pitch_calibrations')
        .select('marks, frame_width, frame_height')
        .eq('scene_id', recording.spiideo_scene_id)
        .eq('status', 'active')
        .maybeSingle()
      if (cal?.marks && hasMidline(cal.marks)) {
        // Timeouts for the same reason meshExists has one: this runs inside
        // request handlers that also carry the page's primary payload, and a
        // HANG is not an error the catch below can see.
        const opts = {
          next: { revalidate: 86400 },
          signal: AbortSignal.timeout(MESH_FETCH_TIMEOUT_MS),
        }
        const [sceneRes, vertsRes, idxRes] = await Promise.all([
          fetch(`${resolvedMeshUrl}/scene.json`, opts),
          fetch(`${resolvedMeshUrl}/vertices.bin`, opts),
          fetch(`${resolvedMeshUrl}/indices.bin`, opts),
        ])
        if (sceneRes.ok && vertsRes.ok && idxRes.ok) {
          const mesh = parseMeshGeometry(
            await sceneRes.json(),
            await vertsRes.arrayBuffer(),
            await idxRes.arrayBuffer()
          )
          panWindow = panWindowForFocus(
            mesh,
            cal.marks,
            Number(cal.frame_width) || 3840,
            Number(cal.frame_height) || 2160,
            recording.pitch_focus as any
          )
        }
      }
    } catch (err) {
      console.error('pitch-focus window derivation failed:', err)
    }
  }

  return { meshBaseUrl: resolvedMeshUrl, panWindow }
}

export interface PanoramaDefaults {
  /** Offer the flat↔de-warp toggle at all. */
  canExplore: boolean
  /** Which surface the page should OPEN on. */
  defaultSurface: 'flat' | 'dewarp'
}

/**
 * Which surface a page opens on.
 *
 * The de-warp only becomes the DEFAULT when the raw VP is already banked
 * (`captureReady`). Anything else keeps the flat production as the opening
 * surface: the Explore toggle is still offered (a click then triggers the
 * multi-GB capture, exactly as on /watch today), but a page LOAD must never
 * actuate one.
 */
export function panoramaDefaults(input: {
  meshBaseUrl: string | null
  captureReady: boolean
}): PanoramaDefaults {
  if (!input.meshBaseUrl) return { canExplore: false, defaultSurface: 'flat' }
  return {
    canExplore: true,
    defaultSurface: input.captureReady ? 'dewarp' : 'flat',
  }
}
