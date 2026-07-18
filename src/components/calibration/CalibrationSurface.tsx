'use client'

// Pitch-calibration marking surface: the venue's curved de-warp mesh rendered
// with a MEDIAN STILL as the texture (players averaged away, line paint
// clean), pannable/zoomable, with click-to-place mark handles and a live
// boundary overlay.
//
// Geometry invariants (do not "simplify"):
// - The mesh UV attribute IS the raw-frame coordinate (u,v ∈ [0,1], v=0 top),
//   so a THREE.Raycaster intersection's interpolated `.uv` × (frameW, frameH)
//   is exactly the PitchMark uv the backend solves with. No NDC inversion.
// - The fov-adaptive blend shader is NEVER applied here: picks and overlay
//   projection assume the exact pinhole camera (raycast sees CPU geometry;
//   the GPU must render the same thing).
// - Overlay boundary lines slerp between endpoint world rays (~16 samples per
//   edge): rays to points on a straight world line lie on a great circle, so
//   the sampled polyline is geometrically exact and degrades gracefully when
//   an endpoint leaves the frustum.

import { Frame, Minus, Plus } from 'lucide-react'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'

import {
  buildExactPanorama,
  type SceneProjection,
} from '@/components/video/VirtualPanoramaPlayer'
import type { MarkName, PitchMark } from '@/lib/panorama/pitch-marks'
import {
  parseMeshGeometry,
  uvToRay,
  type MeshGeometry,
} from '@/lib/panorama/pitch-solver'
import { curvedFovMax, horizontalFov } from '@/lib/panorama/projection'
import { cn } from '@braintwopoint0/playback-commons/utils'

const DEG = Math.PI / 180
const FOV_MIN = 4
const OPEN_FOV_CAP = 95 // pure-pinhole open view; wider gets too stretchy
const DRAG_SLOP_PX = 4
const EDGE_SAMPLES = 16
const HANDLE_R = 9

// View-relative codes, NOT compass: an admin who knows their venue's real
// orientation would read "NW" as geography and place it at the actual
// north-west corner, silently swapping the pitch topology.
const MARK_CODE: Record<MarkName, string> = {
  corner_nw: 'FAR L',
  corner_ne: 'FAR R',
  corner_se: 'NEAR R',
  corner_sw: 'NEAR L',
  midline_n: 'MID FAR',
  midline_s: 'MID NEAR',
}

const CORNER_LOOP: MarkName[] = [
  'corner_nw',
  'corner_ne',
  'corner_se',
  'corner_sw',
]

export interface CalibrationSurfaceProps {
  sceneJson: { projections: SceneProjection[] }
  verticesBin: ArrayBuffer
  indicesBin: ArrayBuffer
  stillUrl: string
  frameWidth: number
  frameHeight: number
  marks: PitchMark[]
  selected: MarkName | null
  errorMark: MarkName | null
  /** The mark the next surface click places (null = clicks only select). */
  placing: MarkName | null
  onPlace: (uv: [number, number]) => void
  onDragMark: (name: MarkName, uv: [number, number]) => void
  onSelectMark: (name: MarkName | null) => void
  /** Presigned still failed to load (likely expired) — parent refetches. */
  onStillError?: () => void
  /** Localized labels for the internal chrome (zoom buttons, surface name). */
  labels?: {
    zoomIn: string
    zoomOut: string
    resetView: string
    surface: string
  }
  className?: string
}

interface ViewState {
  pan: number // radians
  tilt: number // radians
  fov: number // degrees, vertical
}

export function CalibrationSurface(props: CalibrationSurfaceProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  // Live props for the RAF loop / handlers without re-running the main effect.
  const propsRef = useRef(props)
  propsRef.current = props

  const { sceneJson, verticesBin, indicesBin, stillUrl } = props

  useEffect(() => {
    const host = hostRef.current
    const svg = svgRef.current
    if (!host || !svg) return
    let disposed = false
    let raf = 0
    let renderer: THREE.WebGLRenderer | null = null
    const disposables: { dispose: () => void }[] = []
    const cleanups: (() => void)[] = []

    // --- geometry (GPU render + CPU picks share the same buffers) ---
    const view = buildExactPanorama(
      verticesBin,
      indicesBin,
      sceneJson.projections
    )
    let cpuMesh: MeshGeometry | null = null
    try {
      cpuMesh = parseMeshGeometry(sceneJson, verticesBin, indicesBin)
    } catch {
      cpuMesh = null // overlay rays degrade; picking still works via raycast
    }

    const fovMax = curvedFovMax(view.tiltMin, view.tiltMax, FOV_MIN)
    const openView = (): ViewState => ({
      pan: (view.panMin + view.panMax) / 2,
      tilt: (view.tiltMin + view.tiltMax) / 2,
      fov: Math.min(fovMax, OPEN_FOV_CAP),
    })
    let viewState = openView()

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(viewState.fov, 16 / 9, 0.01, 100)
    const camRight = new THREE.Vector3()

    const clampViewState = (v: ViewState): ViewState => {
      // frame-on-mesh: shrink pan by the frame's half-extents (midpoint
      // collapse when inverted); tilt-down free to the window floor.
      const fov = Math.min(Math.max(v.fov, FOV_MIN), fovMax)
      const aspect = camera.aspect || 16 / 9
      const hHalf = (horizontalFov(fov, aspect) / 2) * DEG
      const vHalf = (fov / 2) * DEG
      const panMid = (view.panMin + view.panMax) / 2
      const tiltMid = (view.tiltMin + view.tiltMax) / 2
      const panLo = Math.min(view.panMin + hHalf, panMid)
      const panHi = Math.max(view.panMax - hHalf, panMid)
      const tiltLo = Math.min(view.tiltMin, tiltMid)
      const tiltHi = Math.max(view.tiltMax - vHalf, tiltMid)
      return {
        pan: Math.min(Math.max(v.pan, panLo), panHi),
        tilt: Math.min(Math.max(v.tilt, tiltLo), tiltHi),
        fov,
      }
    }

    // --- still texture ---
    const loader = new THREE.TextureLoader()
    loader.setCrossOrigin('anonymous')
    const texture = loader.load(
      stillUrl,
      () => {
        /* first render happens in the RAF loop regardless */
      },
      undefined,
      () => {
        if (!disposed) propsRef.current.onStillError?.()
      }
    )
    texture.colorSpace = THREE.SRGBColorSpace
    texture.flipY = false // mesh UV convention: v=0 top
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter
    disposables.push(texture)

    // --- mesh composition (player's curved path, minus the blend shader) ---
    const baseMat = new THREE.MeshBasicMaterial({
      map: texture,
      side: THREE.DoubleSide,
    })
    const blendMat = new THREE.MeshBasicMaterial({
      map: texture,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      vertexColors: true,
    })
    disposables.push(baseMat, blendMat, ...view.geometries)
    const meshes: THREE.Mesh[] = []
    const gs = view.geometries
    meshes.push(new THREE.Mesh(gs[gs.length - 1], baseMat))
    for (let gi = gs.length - 2; gi >= 0; gi--) {
      const m = new THREE.Mesh(gs[gi], blendMat)
      m.renderOrder = gs.length - 1 - gi
      meshes.push(m)
    }
    for (const m of meshes) scene.add(m)

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    renderer.setClearColor(0x05_09_07, 1)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    host.appendChild(renderer.domElement)
    Object.assign(renderer.domElement.style, {
      width: '100%',
      height: '100%',
      display: 'block',
      touchAction: 'none',
    })

    const resize = () => {
      const w = host.clientWidth
      const h = host.clientHeight
      if (!renderer || w === 0 || h === 0) return
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      viewState = clampViewState(viewState) // aspect changes the pan clamp
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(host)
    cleanups.push(() => ro.disconnect())

    // --- picking ---
    const raycaster = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    /** client px → raw-frame uv px via mesh intersection, or null off-mesh. */
    const pickUv = (
      clientX: number,
      clientY: number
    ): [number, number] | null => {
      const rect = host.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return null
      ndc.set(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -(((clientY - rect.top) / rect.height) * 2 - 1)
      )
      raycaster.setFromCamera(ndc, camera)
      const hits = raycaster.intersectObjects(meshes, false)
      const hit = hits[0]
      if (!hit || !hit.uv) return null
      const { frameWidth, frameHeight } = propsRef.current
      // the mesh deliberately keeps a ±2% out-of-frame band (edge coverage);
      // content there is ClampToEdge smear and validateMarks rejects
      // out-of-frame uv at save time — clamp picks into the frame
      return [
        Math.min(Math.max(hit.uv.x * frameWidth, 0), frameWidth),
        Math.min(Math.max(hit.uv.y * frameHeight, 0), frameHeight),
      ]
    }

    // --- overlay: world rays per mark (cached), projected each frame ---
    const rayCache = new Map<string, THREE.Vector3 | null>()
    const markRay = (mark: PitchMark): THREE.Vector3 | null => {
      const { frameWidth, frameHeight } = propsRef.current
      const key = `${mark.name}:${mark.uv[0]}:${mark.uv[1]}`
      if (rayCache.has(key)) return rayCache.get(key)!
      let dir: THREE.Vector3 | null = null
      if (cpuMesh) {
        const r = uvToRay(
          cpuMesh,
          mark.uv[0],
          mark.uv[1],
          frameWidth,
          frameHeight
        )
        if (r) dir = new THREE.Vector3(r.ray[0], r.ray[1], r.ray[2])
      }
      if (rayCache.size > 512) rayCache.clear()
      rayCache.set(key, dir)
      return dir
    }

    const camSpace = new THREE.Vector3()
    const projTmp = new THREE.Vector3()
    /** world ray → overlay px, or null when behind the camera. */
    const rayToScreen = (dir: THREE.Vector3): [number, number] | null => {
      camSpace.copy(dir).applyMatrix4(camera.matrixWorldInverse)
      if (camSpace.z >= -1e-6) return null // behind the camera (looks down −Z)
      projTmp.copy(dir).project(camera)
      const w = host.clientWidth
      const h = host.clientHeight
      return [((projTmp.x + 1) / 2) * w, ((1 - projTmp.y) / 2) * h]
    }

    const slerpA = new THREE.Vector3()
    const slerpB = new THREE.Vector3()
    const slerpDir = (
      a: THREE.Vector3,
      b: THREE.Vector3,
      t: number,
      out: THREE.Vector3
    ): THREE.Vector3 => {
      const an = slerpA.copy(a).normalize()
      const bn = slerpB.copy(b).normalize()
      const dot = Math.min(1, Math.max(-1, an.dot(bn)))
      const omega = Math.acos(dot)
      if (omega < 1e-6) return out.copy(an)
      const so = Math.sin(omega)
      return out
        .copy(an)
        .multiplyScalar(Math.sin((1 - t) * omega) / so)
        .addScaledVector(bn, Math.sin(t * omega) / so)
    }

    // --- overlay DOM (imperative — repositioned every frame) ---
    const SVG_NS = 'http://www.w3.org/2000/svg'
    while (svg.firstChild) svg.removeChild(svg.firstChild)
    // Cased keylines (the Spotlight ring recipe: dark stroke UNDER the
    // emerald one — what keeps emerald legible on any grass tone), not a
    // per-frame drop-shadow filter.
    const edgesGroup = document.createElementNS(SVG_NS, 'g')
    svg.appendChild(edgesGroup)
    const edgePaths: SVGPathElement[] = []
    const edgeCasings: SVGPathElement[] = []
    for (let i = 0; i < 5; i++) {
      // 4 boundary edges + 1 midline
      const casing = document.createElementNS(SVG_NS, 'path')
      casing.setAttribute('fill', 'none')
      casing.setAttribute('stroke', 'rgba(6,10,8,0.55)')
      casing.setAttribute('stroke-width', '4')
      if (i === 4) casing.setAttribute('stroke-dasharray', '6 5')
      edgesGroup.appendChild(casing)
      edgeCasings.push(casing)
    }
    for (let i = 0; i < 5; i++) {
      const p = document.createElementNS(SVG_NS, 'path')
      p.setAttribute('fill', 'none')
      p.setAttribute('stroke', i === 4 ? 'rgba(52,211,153,0.75)' : '#34d399')
      p.setAttribute('stroke-width', '2')
      if (i === 4) p.setAttribute('stroke-dasharray', '6 5')
      edgesGroup.appendChild(p)
      edgePaths.push(p)
    }
    const handlesGroup = document.createElementNS(SVG_NS, 'g')
    svg.appendChild(handlesGroup)

    interface Handle {
      g: SVGGElement
      casing: SVGCircleElement
      ring: SVGCircleElement
      label: SVGTextElement
    }
    const handles = new Map<MarkName, Handle>()
    const ensureHandle = (name: MarkName): Handle => {
      let h = handles.get(name)
      if (h) return h
      const g = document.createElementNS(SVG_NS, 'g')
      g.setAttribute('style', 'pointer-events: auto; cursor: grab;')
      g.setAttribute('data-mark', name)
      // keyboard path: focus selects the mark so arrow-nudge is reachable
      // without a pointer
      g.setAttribute('tabindex', '0')
      g.setAttribute('role', 'button')
      g.setAttribute('aria-label', MARK_CODE[name])
      g.addEventListener('focus', () => propsRef.current.onSelectMark(name))
      const halo = document.createElementNS(SVG_NS, 'circle')
      halo.setAttribute('r', String(HANDLE_R + 12))
      halo.setAttribute('fill', 'transparent')
      const casing = document.createElementNS(SVG_NS, 'circle')
      casing.setAttribute('r', String(HANDLE_R))
      casing.setAttribute('fill', 'none')
      casing.setAttribute('stroke', 'rgba(6,10,8,0.55)')
      casing.setAttribute('stroke-width', '4')
      const ring = document.createElementNS(SVG_NS, 'circle')
      ring.setAttribute('r', String(HANDLE_R))
      ring.setAttribute('fill', 'rgba(10,16,13,0.35)')
      ring.setAttribute('stroke-width', '2')
      const crossV = document.createElementNS(SVG_NS, 'line')
      crossV.setAttribute('y1', '-4')
      crossV.setAttribute('y2', '4')
      const crossH = document.createElementNS(SVG_NS, 'line')
      crossH.setAttribute('x1', '-4')
      crossH.setAttribute('x2', '4')
      for (const c of [crossV, crossH]) {
        c.setAttribute('stroke', '#d6d5c9')
        c.setAttribute('stroke-width', '1.5')
      }
      const label = document.createElementNS(SVG_NS, 'text')
      label.setAttribute('y', String(HANDLE_R + 14))
      label.setAttribute('text-anchor', 'middle')
      label.setAttribute(
        'style',
        'font: 600 11px Inter, sans-serif; paint-order: stroke; stroke: rgba(10,16,13,0.9); stroke-width: 3px;'
      )
      label.textContent = MARK_CODE[name]
      g.append(halo, casing, ring, crossV, crossH, label)
      g.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return
        e.stopPropagation()
        e.preventDefault()
        draggingMark = { name, pointerId: e.pointerId }
        g.style.cursor = 'grabbing'
        propsRef.current.onSelectMark(name)
        try {
          ;(e.target as Element).setPointerCapture?.(e.pointerId)
        } catch {
          /* capture is best-effort */
        }
      })
      handlesGroup.appendChild(g)
      handles.set(name, (h = { g, casing, ring, label }))
      return h
    }

    const updateOverlay = () => {
      const { marks, selected, errorMark } = propsRef.current
      const byName = new Map(marks.map((m) => [m.name, m]))
      // drop handles for removed marks (deleted midline)
      for (const [name, h] of handles) {
        if (!byName.has(name)) {
          h.g.remove()
          handles.delete(name)
        }
      }
      for (const mark of marks) {
        const h = ensureHandle(mark.name)
        const dir = markRay(mark)
        const px = dir ? rayToScreen(dir) : null
        if (!px) {
          h.g.setAttribute('visibility', 'hidden')
          continue
        }
        h.g.setAttribute('visibility', 'visible')
        h.g.setAttribute('transform', `translate(${px[0]}, ${px[1]})`)
        const isSel = selected === mark.name
        const isErr = errorMark === mark.name
        // corners sit ON painted white lines — a white selection ring would
        // vanish exactly while nudging; selection = same hue, bigger/heavier
        const color = isErr ? '#f59e0b' : '#34d399'
        const r = isSel ? HANDLE_R + 2 : HANDLE_R
        h.ring.setAttribute('stroke', color)
        h.ring.setAttribute('r', String(r))
        h.ring.setAttribute('stroke-width', isSel ? '3' : '2')
        h.casing.setAttribute('r', String(r))
        h.casing.setAttribute('stroke-width', isSel ? '5' : '4')
        h.ring.setAttribute(
          'fill',
          isSel ? `${color}33` : 'rgba(10,16,13,0.35)'
        )
        // white label: the ring carries the state hue; small text needs the
        // luminance on busy footage (jersey-badge recipe)
        h.label.setAttribute('fill', 'rgba(255,255,255,0.92)')
      }
      // boundary edges between placed corners; midline dashed
      const edgeDefs: [MarkName, MarkName][] = [
        [CORNER_LOOP[0], CORNER_LOOP[1]],
        [CORNER_LOOP[1], CORNER_LOOP[2]],
        [CORNER_LOOP[2], CORNER_LOOP[3]],
        [CORNER_LOOP[3], CORNER_LOOP[0]],
        ['midline_n', 'midline_s'],
      ]
      const sample = new THREE.Vector3()
      edgeDefs.forEach(([a, b], i) => {
        const ma = byName.get(a)
        const mb = byName.get(b)
        const ra = ma ? markRay(ma) : null
        const rb = mb ? markRay(mb) : null
        if (!ra || !rb) {
          edgePaths[i].setAttribute('d', '')
          edgeCasings[i].setAttribute('d', '')
          return
        }
        let d = ''
        let pen = false
        for (let s = 0; s <= EDGE_SAMPLES; s++) {
          const px = rayToScreen(slerpDir(ra, rb, s / EDGE_SAMPLES, sample))
          if (!px) {
            pen = false
            continue
          }
          d += `${pen ? 'L' : 'M'}${px[0].toFixed(1)} ${px[1].toFixed(1)}`
          pen = true
        }
        edgePaths[i].setAttribute('d', d)
        edgeCasings[i].setAttribute('d', d)
      })
    }

    // --- interaction ---
    // Every gesture is bound to ONE pointerId: without it, a second finger
    // resting on the surface drags the mark grabbed by the first, and its
    // lift places a mark nobody clicked.
    let draggingMark: { name: MarkName; pointerId: number } | null = null
    let pointerDown: {
      x: number
      y: number
      view: ViewState
      pointerId: number
    } | null = null
    let cameraDragging = false

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || pointerDown || draggingMark) return
      pointerDown = {
        x: e.clientX,
        y: e.clientY,
        view: { ...viewState },
        pointerId: e.pointerId,
      }
      cameraDragging = false
      host.setPointerCapture?.(e.pointerId)
    }
    const onPointerMove = (e: PointerEvent) => {
      if (draggingMark) {
        if (e.pointerId !== draggingMark.pointerId) return
        const uv = pickUv(e.clientX, e.clientY)
        if (uv) propsRef.current.onDragMark(draggingMark.name, uv)
        return
      }
      if (!pointerDown || e.pointerId !== pointerDown.pointerId) return
      const dx = e.clientX - pointerDown.x
      const dy = e.clientY - pointerDown.y
      if (!cameraDragging && Math.hypot(dx, dy) < DRAG_SLOP_PX) return
      cameraDragging = true
      const w = host.clientWidth || 1
      const h = host.clientHeight || 1
      const hFovRad = horizontalFov(pointerDown.view.fov, w / h) * DEG
      const vFovRad = pointerDown.view.fov * DEG
      viewState = clampViewState({
        pan: pointerDown.view.pan - (dx / w) * hFovRad,
        tilt: pointerDown.view.tilt + (dy / h) * vFovRad,
        fov: pointerDown.view.fov,
      })
    }
    const endMarkDrag = () => {
      if (!draggingMark) return
      handles.get(draggingMark.name)?.g.style.removeProperty('cursor')
      draggingMark = null
    }
    const onPointerUp = (e: PointerEvent) => {
      if (draggingMark) {
        if (e.pointerId === draggingMark.pointerId) endMarkDrag()
        return
      }
      if (!pointerDown || e.pointerId !== pointerDown.pointerId) return
      const wasClick = !cameraDragging
      pointerDown = null
      cameraDragging = false
      if (!wasClick) return
      const { placing, onPlace, onSelectMark } = propsRef.current
      if (placing) {
        const uv = pickUv(e.clientX, e.clientY)
        if (uv) onPlace(uv)
      } else {
        onSelectMark(null)
      }
    }
    // pointercancel (edge swipe, notification shade, palm rejection) can
    // replace pointerup — a wedged draggingMark would teleport a placed
    // corner on the next stray tap
    const onPointerCancel = (e: PointerEvent) => {
      if (draggingMark?.pointerId === e.pointerId) endMarkDrag()
      if (pointerDown?.pointerId === e.pointerId) {
        pointerDown = null
        cameraDragging = false
      }
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      viewState = clampViewState({
        ...viewState,
        fov: viewState.fov * Math.exp(e.deltaY * 0.001),
      })
    }
    host.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
    host.addEventListener('wheel', onWheel, { passive: false })
    cleanups.push(() => {
      host.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
      host.removeEventListener('wheel', onWheel)
    })

    // Screen-space nudge: project the mark's ray, offset by pixels, raycast
    // back to uv — arrows always move the mark the way the eye sees, even
    // where the mesh is locally rotated. Fallback: shift uv directly.
    const nudgeSelected = (dxPx: number, dyPx: number) => {
      const { marks, selected, onDragMark, frameWidth, frameHeight } =
        propsRef.current
      if (!selected) return
      const mark = marks.find((m) => m.name === selected)
      if (!mark) return
      const dir = markRay(mark)
      const px = dir ? rayToScreen(dir) : null
      if (px) {
        const rect = host.getBoundingClientRect()
        const uv = pickUv(rect.left + px[0] + dxPx, rect.top + px[1] + dyPx)
        if (uv) {
          onDragMark(selected, uv)
          return
        }
      }
      onDragMark(selected, [
        Math.min(Math.max(mark.uv[0] + dxPx, 0), frameWidth),
        Math.min(Math.max(mark.uv[1] + dyPx, 0), frameHeight),
      ])
    }
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (e.key === 'Escape') {
        propsRef.current.onSelectMark(null)
        return
      }
      // arrows only act (and only preventDefault) with a mark selected —
      // otherwise they must keep scrolling the page/panel
      if (!propsRef.current.selected) return
      const step = e.shiftKey ? 10 : 1
      switch (e.key) {
        case 'ArrowLeft':
          nudgeSelected(-step, 0)
          break
        case 'ArrowRight':
          nudgeSelected(step, 0)
          break
        case 'ArrowUp':
          nudgeSelected(0, -step)
          break
        case 'ArrowDown':
          nudgeSelected(0, step)
          break
        default:
          return
      }
      e.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    cleanups.push(() => window.removeEventListener('keydown', onKeyDown))

    // Zoom controls reach in via DOM events from the JSX buttons below.
    const onZoomEvent = (e: Event) => {
      const detail = (e as CustomEvent<'in' | 'out' | 'reset'>).detail
      if (detail === 'reset') viewState = clampViewState(openView())
      else
        viewState = clampViewState({
          ...viewState,
          fov: detail === 'in' ? viewState.fov / 1.3 : viewState.fov * 1.3,
        })
    }
    host.addEventListener('calibration-zoom', onZoomEvent)
    cleanups.push(() =>
      host.removeEventListener('calibration-zoom', onZoomEvent)
    )

    // --- render loop ---
    let framedErrorMark: MarkName | null = null
    const tick = () => {
      if (disposed || !renderer) return
      // a mark rejected as unprojectable is exactly the mark most likely to
      // be off-screen — aim the camera at it once per error
      const errMark = propsRef.current.errorMark
      if (errMark !== framedErrorMark) {
        framedErrorMark = errMark
        if (errMark) {
          const m = propsRef.current.marks.find((mk) => mk.name === errMark)
          const dir = m ? markRay(m) : null
          if (dir) {
            const n = dir.clone().normalize()
            viewState = clampViewState({
              pan: Math.atan2(n.dot(view.right), n.dot(view.forward)),
              tilt: Math.asin(Math.min(1, Math.max(-1, n.dot(view.up)))),
              fov: viewState.fov,
            })
          }
        }
      }
      camera.position.set(0, 0, 0)
      if (camera.fov !== viewState.fov) {
        camera.fov = viewState.fov
        camera.updateProjectionMatrix()
      }
      const dir = view.forward.clone().applyAxisAngle(view.up, viewState.pan)
      const rightNow = camRight
        .copy(view.right)
        .applyAxisAngle(view.up, viewState.pan)
      dir.applyAxisAngle(rightNow, viewState.tilt)
      camera.up.copy(view.up)
      camera.lookAt(dir)
      camera.updateMatrixWorld()
      renderer.render(scene, camera)
      const w = host.clientWidth
      const h = host.clientHeight
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
      updateOverlay()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      for (const fn of cleanups) fn()
      for (const d of disposables) d.dispose()
      if (renderer) {
        renderer.dispose()
        // still-expiry remounts churn contexts; browsers cap ~16 live ones
        renderer.forceContextLoss()
        renderer.domElement.remove()
        renderer = null
      }
      while (svg.firstChild) svg.removeChild(svg.firstChild)
    }
  }, [sceneJson, verticesBin, indicesBin, stillUrl])

  const zoom = (detail: 'in' | 'out' | 'reset') => {
    hostRef.current?.dispatchEvent(
      new CustomEvent('calibration-zoom', { detail })
    )
  }

  const labels = props.labels
  const zoomBtn =
    'flex h-9 w-9 items-center justify-center rounded-md border border-zinc-700 bg-[var(--night)]/80 text-[var(--timberwolf)] backdrop-blur transition-colors hover:border-[var(--ash-grey)] md:h-8 md:w-8'

  return (
    <div
      aria-label={labels?.surface}
      className={cn(
        'relative h-full w-full overflow-hidden rounded-xl border border-zinc-800 bg-[#050907]',
        props.placing ? 'cursor-crosshair' : 'cursor-grab',
        props.className
      )}
    >
      <div ref={hostRef} className="absolute inset-0" />
      <svg
        ref={svgRef}
        className="pointer-events-none absolute inset-0 h-full w-full"
      />
      <div className="absolute bottom-3 right-3 flex flex-col gap-1.5">
        <button
          type="button"
          aria-label={labels?.zoomIn ?? 'Zoom in'}
          title={labels?.zoomIn}
          onClick={() => zoom('in')}
          className={zoomBtn}
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label={labels?.zoomOut ?? 'Zoom out'}
          title={labels?.zoomOut}
          onClick={() => zoom('out')}
          className={zoomBtn}
        >
          <Minus className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label={labels?.resetView ?? 'Reset view'}
          title={labels?.resetView}
          onClick={() => zoom('reset')}
          className={zoomBtn}
        >
          <Frame className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
