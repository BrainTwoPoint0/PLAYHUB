// Panorama de-warp mesh serving. The calibration mesh (scene.json + vertices.bin
// + indices.bin, ~750 KB) is per physical camera and NON-PII (pure geometry — it
// encodes lens calibration + camera pose, no imagery). So it lives in a PUBLIC,
// CDN-cacheable Supabase Storage bucket (same pattern as scene-snapshots) and is
// shared across every viewer of a venue — never behind a per-viewer signed URL,
// which would defeat caching.
//
// Keyed by the recording's spiideo_game_id for v1 (one mesh per game). The camera
// is fixed, so this is really per-scene; game-keying avoids a live game→scene
// Spiideo lookup on every watch-page render and can be de-duped to scene later.

const MESH_BUCKET = 'panorama-meshes'

function supabaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL not set')
  return url.replace(/\/$/, '')
}

/**
 * Public base URL for a game's de-warp mesh. The VirtualPanoramaPlayer appends
 * `/scene.json`, `/vertices.bin`, `/indices.bin` (and optional `/tuning.json`).
 * Returns null when there's no game to key on.
 *
 * TRUST INVARIANT: `gameId` is interpolated into the path un-encoded, which is
 * safe ONLY because it is always a DB/service-role-written id (spiideo_game_id
 * / source_game_id), never caller input. The host is fixed and the id is
 * appended to the PATH, so a malformed value can at worst 404 on the same
 * trusted Supabase host — no external SSRF. If a code path ever lets a user set
 * the id feeding this, encode it and re-audit the server-side fetchers.
 */
export function meshBaseUrl(gameId: string | null | undefined): string | null {
  if (!gameId) return null
  return `${supabaseUrl()}/storage/v1/object/public/${MESH_BUCKET}/${gameId}`
}

/**
 * Whether a de-warp mesh has been generated for this game (checks scene.json).
 * Cheap public HEAD — no auth. Lets the watch page offer "Explore the pitch"
 * only when a mesh actually exists, so users never hit a broken de-warp.
 * Any absence (404) or error → false (degrade to Auto-only), never throws.
 */
export async function meshExists(
  gameId: string | null | undefined
): Promise<boolean> {
  const base = meshBaseUrl(gameId)
  if (!base) return false
  try {
    const res = await fetch(`${base}/scene.json`, { method: 'HEAD' })
    return res.ok
  } catch {
    return false
  }
}

export { MESH_BUCKET }
