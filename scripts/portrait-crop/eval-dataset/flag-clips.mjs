#!/usr/bin/env node
// Ambiguity scorer — the "which clips need a human" brain of the correction→label
// flywheel. Pure reducer over signals already in <clip>_raw.json (detect_ball
// output); no model, no ML. Auto-crop runs on everything; this decides the small
// subset a human should polish in CVAT (and where), and those corrections become
// the next training labels.
//
// Signals:
//   undetected   — frames where the ball was lost (source not ball/tracked):
//                  airborne / occluded / off-screen. The detection wall.
//   disagreement — frames with >=2 strong candidates far apart: multi-ball,
//                  adjacent-pitch, or a distractor competing with the real ball.
//   teleport     — large frame-to-frame jumps in the SELECTED track: the crop jumps.
//
// Emits a per-clip composite score, the dominant reasons, and the time windows to
// review (so the human jumps straight to the hard seconds instead of scrubbing).
//
// Usage:
//   node flag-clips.mjs                 # score every clip with a _raw.json
//   node flag-clips.mjs <clipId> ...    # score specific clips
//   node flag-clips.mjs --json          # machine-readable (for the CVAT auto-task step)
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIPS = join(HERE, 'clips')

const CONF_MIN = 0.15 // a candidate strong enough to be "a ball"
const COMPETE_FRAC = 0.5 // a rival counts only if conf >= this * the top candidate's
const FAR_PX = 300 // two strong candidates this far apart = disagreement
const TELEPORT_PX = 350 // selected-track jump this large = a switch
const UNDETECTED_FRAC = 0.3 // >30% of frames ball-lost → review
const DISAGREE_FRAC = 0.08 // >8% of frames ambiguous → review
const TELEPORTS_MAX = 3 // more track-switches than this → review
const MIN_WINDOW = 3 // frames; ignore blips shorter than this

function contiguousWindows(times, flags) {
  const w = []
  let s = null
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] && s === null) s = i
    else if (!flags[i] && s !== null) {
      if (i - s >= MIN_WINDOW) w.push([times[s], times[i - 1]])
      s = null
    }
  }
  if (s !== null && flags.length - s >= MIN_WINDOW)
    w.push([times[s], times[flags.length - 1]])
  return w
}

function score(clipId) {
  let raw
  try {
    raw = JSON.parse(readFileSync(join(CLIPS, `${clipId}_raw.json`)))
  } catch {
    return { clipId, error: 'no _raw.json' }
  }
  const pos = raw.positions || []
  const n = pos.length
  if (!n) return { clipId, error: 'no positions' }
  const times = pos.map((p) => p.time)

  // 1. undetected: the ball was lost and the crop fell back to cluster/center.
  const lost = pos.map((p) => p.source !== 'ball' && p.source !== 'tracked')
  const fracLost = lost.filter(Boolean).length / n

  // 2. disagreement: a frame where a GENUINELY COMPETITIVE rival candidate (conf
  // >= COMPETE_FRAC of the top one) sits FAR_PX from the top candidate — i.e. two
  // plausible balls, not the top ball plus low-conf noise. Needs all_candidates.
  const hasCands = (raw.all_candidates || []).length > 0
  const byT = new Map()
  for (const c of raw.all_candidates || []) {
    if ((c.conf ?? 0) < CONF_MIN) continue
    const k = Math.round(c.time * 1000)
    let arr = byT.get(k)
    if (!arr) byT.set(k, (arr = []))
    arr.push(c)
  }
  const disagree = pos.map((p) => {
    const cs = byT.get(Math.round(p.time * 1000)) || []
    if (cs.length < 2) return false
    let best = cs[0]
    for (const c of cs) if ((c.conf ?? 0) > (best.conf ?? 0)) best = c
    const floor = COMPETE_FRAC * (best.conf ?? 0)
    return cs.some(
      (c) =>
        c !== best &&
        (c.conf ?? 0) >= floor &&
        Math.hypot(c.x - best.x, c.y - best.y) > FAR_PX
    )
  })
  const fracDisagree = disagree.filter(Boolean).length / n

  // 3. teleports in the selected ball/tracked track.
  let teleports = 0
  let lastX = null
  for (const p of pos) {
    if (p.source === 'ball' || p.source === 'tracked') {
      if (lastX !== null && Math.abs(p.x - lastX) > TELEPORT_PX) teleports++
      lastX = p.x
    }
  }

  const reasons = []
  if (fracLost > UNDETECTED_FRAC)
    reasons.push(`undetected ${Math.round(fracLost * 100)}%`)
  if (fracDisagree > DISAGREE_FRAC)
    reasons.push(`disagreement ${Math.round(fracDisagree * 100)}%`)
  if (teleports > TELEPORTS_MAX) reasons.push(`${teleports} track-switches`)

  // Review windows: where the human should look (union of lost + disagreement spans).
  const flag = pos.map((_, i) => lost[i] || disagree[i])
  const windows = contiguousWindows(times, flag).map(
    ([a, b]) => `${a.toFixed(1)}-${b.toFixed(1)}s`
  )

  const s = Math.min(
    1,
    (fracLost / UNDETECTED_FRAC) * 0.5 +
      (fracDisagree / DISAGREE_FRAC) * 0.3 +
      (teleports / TELEPORTS_MAX) * 0.2
  )
  return {
    clipId,
    needsReview: reasons.length > 0,
    score: +s.toFixed(2),
    fracLost: +fracLost.toFixed(2),
    fracDisagree: +fracDisagree.toFixed(2),
    teleports,
    reasons,
    windows,
    cands: hasCands, // false = disagreement could not be assessed (re-detect for a full read)
  }
}

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const ids = argv.filter((a) => !a.startsWith('--'))
const clipIds = ids.length
  ? ids
  : readdirSync(CLIPS)
      .filter((f) => f.endsWith('_raw.json'))
      .map((f) => f.replace('_raw.json', ''))
const out = clipIds.map(score).sort((a, b) => (b.score || 0) - (a.score || 0))

if (asJson) {
  console.log(JSON.stringify(out, null, 2))
} else {
  for (const r of out) {
    if (r.error) {
      console.log(`·  ${r.clipId}: ${r.error}`)
      continue
    }
    const tag = r.needsReview ? '⚠ REVIEW' : r.cands ? '✓ ok    ' : '? partial'
    console.log(`${tag}  score=${r.score.toFixed(2)}  ${r.clipId}`)
    if (r.needsReview)
      console.log(
        `            ${r.reasons.join(' | ')}  →  ${r.windows.slice(0, 4).join(', ')}${
          r.windows.length > 4 ? ` …(+${r.windows.length - 4})` : ''
        }`
      )
    else if (!r.cands)
      console.log(
        `            all_candidates empty — disagreement not assessed; re-detect for a full read`
      )
  }
}
