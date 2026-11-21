// Dev-only panel (lil-gui): the No-audio switch and a few readouts (fps, frame time, the hands' status).
import GUI from 'lil-gui'
import { getHandsStatus } from '../hands/motion'
import { devNoAudio, setDevNoAudio, setDevTools } from './mode'

const POS_KEY = 'nf:dev:panel' // { x, y, open }

function loadPos(): { x: number; y: number; open: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(POS_KEY) ?? 'null')
    if (v && typeof v.x === 'number' && typeof v.y === 'number') return { x: v.x, y: v.y, open: v.open !== false }
  } catch {
    /* ignore */
  }
  return { x: window.innerWidth - 336, y: 8, open: true }
}
function savePos(el: HTMLElement, open: boolean): void {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify({ x: el.offsetLeft, y: el.offsetTop, open }))
  } catch {
    /* ignore */
  }
}
/** Positions the panel and keeps its title bar inside the viewport. */
function placePanel(el: HTMLElement, x: number, y: number): void {
  const w = el.offsetWidth || 320
  el.style.right = 'auto'
  el.style.left = `${Math.max(0, Math.min(x, window.innerWidth - Math.min(w, 120)))}px`
  el.style.top = `${Math.max(0, Math.min(y, window.innerHeight - 28))}px`
}
/** Drag by the title bar; a drag does not toggle the collapse (click is swallowed once). */
function enableDrag(gui: GUI, root: HTMLElement): () => void {
  const title = gui.$title
  title.style.cursor = 'move'
  title.style.touchAction = 'none'
  let start: { px: number; py: number; x: number; y: number } | null = null
  let moved = false
  const down = (e: PointerEvent) => {
    start = { px: e.clientX, py: e.clientY, x: root.offsetLeft, y: root.offsetTop }
    moved = false
    title.setPointerCapture(e.pointerId)
  }
  const move = (e: PointerEvent) => {
    if (!start) return
    const dx = e.clientX - start.px
    const dy = e.clientY - start.py
    if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return
    moved = true
    placePanel(root, start.x + dx, start.y + dy)
  }
  const up = () => {
    if (start && moved) savePos(root, !gui._closed)
    start = null
  }
  const click = (e: MouseEvent) => {
    if (moved) {
      e.stopImmediatePropagation()
      moved = false
    }
  }
  title.addEventListener('pointerdown', down)
  title.addEventListener('pointermove', move)
  title.addEventListener('pointerup', up)
  title.addEventListener('pointercancel', up)
  title.addEventListener('click', click, true)
  return () => {}
}

export function openDevPanel(): { destroy: () => void } {
  const gui = new GUI({ title: 'notefall dev', width: 320, autoPlace: false })
  document.body.appendChild(gui.domElement)
  const root = gui.domElement
  root.style.cssText += ';position:fixed;z-index:1000;max-height:calc(100vh - 16px);overflow-y:auto'
  const saved = loadPos()
  placePanel(root, saved.x, saved.y)
  if (!saved.open) gui.close()
  gui.onOpenClose((g) => {
    if (g === gui) savePos(root, gui._closed === false)
  })
  const dragCleanup = enableDrag(gui, root)
  const onResize = () => {
    placePanel(root, root.offsetLeft, root.offsetTop)
    savePos(root, !gui._closed)
  }
  window.addEventListener('resize', onResize)

  // --- mode ---
  const mode = { noAudio: devNoAudio(), off: () => setDevTools(false) }
  const fMode = gui.addFolder('Mode')
  fMode.add(mode, 'noAudio').name('No audio (skip sample load)').onChange((v: boolean) => setDevNoAudio(v))
  fMode.add(mode, 'off').name('Dev tools off (Ctrl+Alt+D)')

  // --- readouts ---
  const ro = { fps: 0, frameMs: 0, hands: '' }
  const fRo = gui.addFolder('Readouts')
  for (const k of Object.keys(ro) as (keyof typeof ro)[]) fRo.add(ro, k).disable().listen()
  let raf = 0
  let last = performance.now()
  let acc = 0
  let frames = 0
  const loop = (t: number) => {
    const dt = t - last
    last = t
    ro.frameMs = Math.round(dt * 10) / 10
    acc += dt
    frames++
    if (acc >= 500) {
      ro.fps = Math.round((frames * 1000) / acc)
      acc = 0
      frames = 0
      const hs = getHandsStatus()
      ro.hands = 'fraction' in hs ? `${hs.state} ${Math.round(hs.fraction * 100)}%` : hs.state
    }
    raf = requestAnimationFrame(loop)
  }
  raf = requestAnimationFrame(loop)

  return {
    destroy: () => {
      cancelAnimationFrame(raf)
      dragCleanup()
      window.removeEventListener('resize', onResize)
      gui.destroy()
    },
  }
}
