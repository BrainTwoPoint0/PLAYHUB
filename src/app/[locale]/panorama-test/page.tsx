'use client'

/**
 * DEV-ONLY harness for the Spiideo-mesh de-warp. Query params:
 *   ?inspect=1  → orbit an external camera around the mesh (see its 3D shape)
 *   ?proj=both|0|1 → render both projection strips or just one (default 0)
 *   ?swap=0 ?flipv=1 ?flipy=1 → texture UV tuning
 *   ?flat=1 → stock pinhole projection (disable the fov-adaptive blend, for A/B)
 *   ?blo= ?bhi= ?bmax= → blend ramp overrides (vfov deg lo/hi, max blend 0..1)
 * Not shipped (404 in prod).
 */

import { useEffect, useState } from 'react'
import { notFound } from 'next/navigation'
import { VirtualPanoramaPlayer } from '@/components/video/VirtualPanoramaPlayer'

export default function PanoramaTestPage() {
  if (process.env.NODE_ENV === 'production') notFound()

  const [q, setQ] = useState({
    swap: true,
    flipv: false,
    flipy: false,
    debug: false,
    inspect: false,
    proj: 'both' as 'both' | '0' | '1',
    ortho: false,
    dewarp: false,
    ov: undefined as number | undefined,
    scale: undefined as number | undefined,
    dy: undefined as number | undefined,
    wa: undefined as number | undefined,
    wb: undefined as number | undefined,
    flat: false,
    blo: undefined as number | undefined,
    bhi: undefined as number | undefined,
    bmax: undefined as number | undefined,
    bdlo: undefined as number | undefined,
    bdhi: undefined as number | undefined,
    ky: undefined as number | undefined,
    // vp-mesh-kuwait (v4, Nazwa scene) + vp-raw-kuwait.mp4 (its RAW 4K fisheye
    // VP) are the matching pair. Gotchas: the old /vp-mesh (July 2 format) no
    // longer renders with current buildExactPanorama (alternating-triangle
    // artifact), and /panorama-test.mp4 is a 1080p PRODUCED clip — meshing it
    // double-warps (jagged frame edges).
    mesh: '/vp-mesh-kuwait',
    auto: '',
    src: '/vp-raw-kuwait.mp4',
  })
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    const pr = p.get('proj')
    const num = (k: string) => {
      const v = p.get(k)
      return v !== null && Number.isFinite(Number(v)) ? Number(v) : undefined
    }
    setQ({
      swap: p.get('swap') !== '0',
      flipv: p.get('flipv') === '1',
      flipy: p.get('flipy') === '1',
      debug: p.get('debug') === '1',
      inspect: p.get('inspect') === '1',
      proj: pr === '1' ? '1' : pr === '0' ? '0' : 'both',
      ortho: p.get('ortho') === '1',
      dewarp: p.get('dewarp') === '1',
      ov: num('ov'),
      scale: num('scale'),
      dy: num('dy'),
      wa: num('wa'),
      wb: num('wb'),
      flat: p.get('flat') === '1',
      blo: num('blo'),
      bhi: num('bhi'),
      bmax: num('bmax'),
      bdlo: num('bdlo'),
      bdhi: num('bdhi'),
      ky: num('ky'),
      mesh: p.get('mesh') || '/vp-mesh-kuwait',
      auto: p.get('auto') || '',
      src: p.get('src') || '/vp-raw-kuwait.mp4',
    })
  }, [])

  return (
    <div className="min-h-screen space-y-4 bg-[var(--night)] p-6 text-[var(--timberwolf)]">
      <h1 className="text-2xl font-semibold tracking-tight">
        VirtualPanorama de-warp (real mesh)
      </h1>
      <p className="text-sm text-[var(--ash-grey)]">
        Raw 4K VP + Spiideo mesh · current:{' '}
        <span className="tabular-nums text-[var(--timberwolf)]">
          proj={q.proj} · inspect={String(q.inspect)} · swap={String(q.swap)} ·
          flipv=
          {String(q.flipv)} · flipy={String(q.flipy)}
        </span>
        . Try <code>?proj=1</code>, <code>?proj=both</code>,{' '}
        <code>?inspect=1</code>.
      </p>
      <div className="max-w-5xl">
        <VirtualPanoramaPlayer
          key={`${q.swap}-${q.flipv}-${q.flipy}-${q.debug}-${q.inspect}-${q.proj}-${q.ortho}-${q.dewarp}-${q.ov}-${q.scale}-${q.dy}-${q.wa}-${q.wb}-${q.flat}-${q.blo}-${q.bhi}-${q.bmax}-${q.bdlo}-${q.bdhi}-${q.ky}-${q.mesh}-${q.src}-${q.auto}`}
          src={q.src}
          autoSrc={q.auto || undefined}
          meshBaseUrl={q.mesh}
          uvSwap={q.swap}
          flipV={q.flipv}
          flipTexY={q.flipy}
          debug={q.debug}
          inspect={q.inspect}
          proj={q.proj}
          ortho={q.ortho || q.dewarp}
          dewarp={q.dewarp}
          seamOverlap={q.ov}
          seamScale={q.scale}
          seamShiftY={q.dy}
          seamWarpA={q.wa}
          seamWarpB={q.wb}
          flatProjection={q.flat}
          blendFovLo={q.blo}
          blendFovHi={q.bhi}
          blendMax={q.bmax}
          blendFovDownLo={q.bdlo}
          blendFovDownHi={q.bdhi}
          keystone={q.ky}
          autoplay
        />
      </div>
    </div>
  )
}
