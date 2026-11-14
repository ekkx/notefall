// Skinned-mesh hands (Godot XR Tools "Hand_Nails_L/R", CC0, Miodrag Sejic): the rig's bones are driven straight from the
// HandPose joints. Bones live OUTSIDE the scene graph and we write each bone.matrixWorld ourselves:
//   position = our joint, orientation = rest orientation swung so the bone axis points at our next joint (twist from the
//   hand's lateral axis, so fingers keep their hinge plane), scale = model scale with the bone axis stretched to OUR
//   segment length. So the pose skeleton is the truth for contact; the mesh is just skinned onto it.
// Nothing is allocated per frame. A procedural forearm tube (same skin material) hides the model's open wrist.

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { flashLights } from '../keyboard/flashLights'
import { KEYBOARD_Y } from '../keyboard/layout'
import { MAX_LIGHTS } from '../keyboard/whiteKeyShader'
import { FINGER_R, TIP_TAPER, fingerRadius } from './handDims'
import type { Hand, HandPose, HandPoses, Vec3 } from './types'

/** Godot XR Tools hand models (CC0, see public/hand-models/godot/LICENSE.md). */
const HAND_MODEL_DIR = `${import.meta.env.BASE_URL}hand-models/godot/`
const HAND_LEN = 1.78 // wu (178 mm)
/** Measured against the pose (see report): the mesh pad stops ~4 mm short of our capsule end and is slimmer than it. */
/** Fallback for `MeshHand.tipExt`, which is now measured from the loaded model (the nails mesh gave ~0.04). */
export const TIP_EXT = 0.04
/** Which Godot hand mesh drives the hands: `plain` (hand_l/r.gltf, no nails) or `nails` (Hand_Nails_L/R.gltf). */
export type MeshModel = 'plain' | 'nails'
export const MESH_MODEL: MeshModel = 'plain'
export const FINGER_THICK = 1.12
const TH_MIN = 0.92, TH_MAX = 1.12
/** Share of linear-blend skinning's volume loss at a bend (1/cos(theta/2) - 1) that is given back as extra cross-section. */
const BEND_BULGE = 0.7
/** Mesh v2 wrist flare / palm remap (reshape of wrist + metacarpal verts). Off: judged odd without the forearm. */
const PALM_REMAP = false
/** Target anthropometry in mm along the hand axis Y (0 = wrist joint, + = toward the fingers). Wrist breadth 59.1 mm
 *  (Rogers 2008, via skeleton.ts); wrist depth ~38 mm and a palm ~28 mm thick at the knuckles (adult hand-surgery /
 *  ANSUR-style means, ESTIMATE). The forearm widens to ~72 x 54 mm near the elbow (ANSUR forearm breadth ~ 70 mm). */
const PALM_W_TARGET: [number, number][] = [[-6, 58], [14, 60], [40, 68], [85, 78], [100, 76]]
const PALM_D_TARGET: [number, number][] = [[-6, 38], [14, 36], [40, 31], [85, 27], [100, 26]]
const interp = (t: [number, number][], y: number) => {
  if (y <= t[0][0]) return t[0][1]
  for (let i = 1; i < t.length; i++) if (y <= t[i][0]) { const u = (y - t[i - 1][0]) / (t[i][0] - t[i - 1][0]); return t[i - 1][1] + u * (t[i][1] - t[i - 1][1]) }
  return t[t.length - 1][1]
}
/** `plane` = twist from each finger's own bend plane (default), `knuckle` = the old knuckle-row axis (lab A/B only). */
const TWIST_MODE: 'plane' | 'knuckle' = 'plane'
const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little']
const SEGS4 = ['Metacarpal', 'Proximal', 'Distal', 'Tip']
const SEGS5 = ['Metacarpal', 'Proximal', 'Intermediate', 'Distal', 'Tip']

type Entry = {
  bone: THREE.Bone
  kind: 'wrist' | 'palm' | 'chain'
  f: number
  /** index into pose.bases (-1 = use fingers[f][ci]) / chain index */
  base: boolean
  ci: number
  next: number // entry index of the next joint (-1 = tip)
  prev: number // previous entry in the chain (for tips)
  restPos: THREE.Vector3
  restQ: THREE.Quaternion
  restBasisT: THREE.Matrix4
  restLen: number
  axisL: THREE.Vector3 // bone axis in the bone's own rest frame
  ibm: THREE.Matrix4
  /** cross-section scale perpendicular to the bone axis (target radius / measured radius) */
  th: number
  /** th before the per-frame bend-volume compensation */
  thBase: number
}
type TipProbe = { f: number; e: number; vertex: number; bind: THREE.Vector3; palmar: boolean }

export type TipStats = {
  enabled: boolean
  /** counts + sums over pressed fingers (press > 0.5) */
  n: number
  axisErrSum: number; axisErrMax: number // mesh extremity vs pose tip + dir * r
  palmErrSum: number; palmErrMax: number // mesh palmar-most tip vertex vs pose tip - dorsal * r
  boneErrMax: number
  /** signed: mesh extremity along the finger axis minus capsule end (+ = protrudes) */
  axisSigned: number; nAxis: number
  /** signed: lowest mesh tip vertex z minus (pose tip z - r) (+ = hovers above the contact level, - = sinks) */
  zSigned: number; zMin: number; zMax: number
}

const tmpV = new THREE.Vector3()
const tmpV2 = new THREE.Vector3()
const tmpM = new THREE.Matrix4()
const tmpM2 = new THREE.Matrix4()
const tmpQ = new THREE.Quaternion()
const tmpS = new THREE.Vector3()

/** Right-handed (a, l', a x l') frame: l' = l with its component along a removed. */
function frameMatrix(out: THREE.Matrix4, a: THREE.Vector3, l: THREE.Vector3, alt: THREE.Vector3) {
  tmpV.copy(l).addScaledVector(a, -a.dot(l))
  if (tmpV.lengthSq() < 1e-6) tmpV.copy(alt).addScaledVector(a, -a.dot(alt))
  tmpV.normalize()
  tmpV2.crossVectors(a, tmpV)
  out.makeBasis(a, tmpV, tmpV2)
}

class MeshHand {
  hand: Hand
  sgn: number
  group = new THREE.Group()
  mesh!: THREE.SkinnedMesh
  entries: Entry[] = []
  s = 1
  // rest hand frame (ex ulnar, ey distal, ez dorsal)
  restFrameT = new THREE.Matrix4()
  restEx = new THREE.Vector3()
  restEz = new THREE.Vector3()
  wristRest = new THREE.Vector3()
  // forearm
  forearm!: THREE.Mesh
  ringOff = new THREE.Vector3() // wrist-ring centre in the rest hand frame (x ulnar, y distal, z dorsal), model units
  ringA = 0.03
  ringB = 0.02
  probes: TipProbe[] = []
  ready = false
  // per-frame scratch
  P: THREE.Vector3[] = []
  A: THREE.Vector3[] = []
  K: number[] = []
  ex = new THREE.Vector3()
  ey = new THREE.Vector3()
  ez = new THREE.Vector3()
  fr = new THREE.Matrix4()
  b1 = new THREE.Matrix4()
  delta = new THREE.Matrix4()
  /** per-finger twist reference (see update) and, for diagnostics, the mesh PIP/DIP hinge's max deviation from the pose bend plane (deg) */
  /** how far the distal bone is stretched so the mesh pad reaches our capsule end (wu): measured per model at load */
  tipExt = TIP_EXT
  latRef = [0, 1, 2, 3, 4].map(() => new THREE.Vector3())
  thumbL = new THREE.Vector3()
  planeDev = [0, 0, 0, 0, 0]
  planeN = [0, 1, 2, 3, 4].map(() => new THREE.Vector3())

  constructor(hand: Hand, mat: THREE.Material, parent: THREE.Object3D) {
    this.hand = hand
    this.sgn = hand === 'R' ? 1 : -1
    this.group.visible = false
    parent.add(this.group)
    this.mat = mat
  }
  mat: THREE.Material

  async load() {
    const g = await new GLTFLoader().loadAsync(`${HAND_MODEL_DIR}hand_${this.hand.toLowerCase()}.gltf`)
    let mesh: THREE.SkinnedMesh | null = null
    g.scene.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh })
    if (!mesh) throw new Error('no skinned mesh')
    this.mesh = mesh
    const m = this.mesh
    m.removeFromParent()
    m.material = this.mat
    m.frustumCulled = false
    m.castShadow = true
    m.receiveShadow = true
    m.renderOrder = 5
    m.raycast = () => {}
    m.matrixAutoUpdate = false
    m.matrix.identity()
    this.group.add(m)
    const bones = m.skeleton.bones
    const ibm = m.skeleton.boneInverses
    const sfx = '_' + this.hand
    const byName = new Map<string, number>()
    bones.forEach((b, i) => byName.set(b.name, i))
    const rest = ibm.map((x) => new THREE.Matrix4().copy(x).invert())
    const posOf = (i: number) => new THREE.Vector3().setFromMatrixPosition(rest[i])
    const quatOf = (i: number) => new THREE.Quaternion().setFromRotationMatrix(rest[i])

    const mk = (i: number, kind: Entry['kind'], f: number, ci: number, base: boolean): Entry => ({
      bone: bones[i], kind, f, ci, base, next: -1, prev: -1, restPos: posOf(i), restQ: quatOf(i), restBasisT: new THREE.Matrix4(),
      restLen: 0, axisL: new THREE.Vector3(0, 1, 0), ibm: ibm[i], th: FINGER_THICK, thBase: FINGER_THICK,
    })
    const E = this.entries
    E.push(mk(byName.get('Wrist' + sfx)!, 'wrist', -1, 0, false))
    E.push(mk(byName.get('Palm' + sfx)!, 'palm', -1, 0, false))
    for (let f = 0; f < 5; f++) {
      const segs = f === 0 ? SEGS4 : SEGS5
      let prev = -1
      segs.forEach((sg, k) => {
        const e = mk(byName.get(`${FINGERS[f]}_${sg}${sfx}`)!, 'chain', f, k, k === 0)
        // pose joint: thumb chain [CMC, MCP, IP, tip] <-> [Metacarpal, Proximal, Distal, Tip];
        // others bases[f] <-> Metacarpal, fingers[f][0..3] <-> Proximal, Intermediate, Distal, Tip
        e.ci = f === 0 ? k : k - 1
        e.prev = prev
        if (prev >= 0) E[prev].next = E.length
        prev = E.length
        E.push(e)
      })
    }
    // rest hand frame from rest bones
    const rp = (name: string) => posOf(byName.get(name + sfx)!)
    this.wristRest.copy(rp('Wrist'))
    const idx = rp('Index_Proximal'), lit = rp('Little_Proximal')
    const mean = rp('Index_Proximal').add(rp('Middle_Proximal')).add(rp('Ring_Proximal')).add(rp('Little_Proximal')).multiplyScalar(0.25)
    this.restEx.copy(lit).sub(idx).normalize()
    this.ey.copy(mean).sub(this.wristRest)
    this.ey.addScaledVector(this.restEx, -this.ey.dot(this.restEx)).normalize()
    this.restEz.crossVectors(this.restEx, this.ey).multiplyScalar(this.sgn)
    this.restFrameT.makeBasis(this.restEx, this.ey, this.restEz).transpose()
    // per-bone rest direction, length, basis
    for (const e of E) {
      if (e.kind !== 'chain') continue
      const nx = e.next >= 0 ? E[e.next] : null
      const a = new THREE.Vector3()
      if (nx) a.copy(nx.restPos).sub(e.restPos)
      else a.copy(e.restPos).sub(E[e.prev].restPos)
      e.restLen = nx ? a.length() : E[e.prev].restLen
      a.normalize()
      e.axisL.copy(a).applyQuaternion(tmpQ.copy(e.restQ).invert())
      frameMatrix(tmpM, a, e.f === 0 ? this.restEz : this.restEx, e.f === 0 ? this.restEx : this.restEz)
      e.restBasisT.copy(tmpM).transpose()
    }
    // E[tip] restLen was read before the previous entry's was set only if order differs; chains are in order so ok.
    const tipOf = E.find((e) => e.f === 2 && e.ci === 3)!
    this.s = HAND_LEN / tipOf.restPos.distanceTo(this.wristRest)
    this.P = E.map(() => new THREE.Vector3())
    this.A = E.map(() => new THREE.Vector3())
    this.K = E.map(() => 1)

    // ---- rest-geometry re-proportioning (bind space; the bones stay where they are) ----
    this.reshape(m, byName, sfx)

    // wrist opening: the proximal-most vertices (bind space)
    const pos = m.geometry.attributes.position as THREE.BufferAttribute
    const bind = m.bindMatrix
    const n = pos.count
    const bp = new Array<THREE.Vector3>(n)
    let tmin = Infinity, tmax = -Infinity
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(bind)
      bp[i] = v
      const t = tmpV.copy(v).sub(this.wristRest).dot(this.ey)
      if (t < tmin) tmin = t
      if (t > tmax) tmax = t
    }
    const ringV: THREE.Vector3[] = []
    for (let i = 0; i < n; i++) if (tmpV.copy(bp[i]).sub(this.wristRest).dot(this.ey) < tmin + 0.01 * (tmax - tmin)) ringV.push(bp[i])
    const c = new THREE.Vector3()
    ringV.forEach((v) => c.add(v))
    c.multiplyScalar(1 / ringV.length)
    let a1 = 0, a2 = 0
    for (const v of ringV) { a1 = Math.max(a1, Math.abs(tmpV.copy(v).sub(c).dot(this.restEx))); a2 = Math.max(a2, Math.abs(tmpV.copy(v).sub(c).dot(this.restEz))) }
    this.ringA = a1; this.ringB = a2
    tmpV.copy(c).sub(this.wristRest)
    this.ringOff.set(tmpV.dot(this.restEx), tmpV.dot(this.ey), tmpV.dot(this.restEz))
    // the opening is flared to the target wrist ellipse (58 x 38 mm) centred on our wrist axis
    this.ringA = 29 / (this.s * 100)
    this.ringB = 19 / (this.s * 100)
    // (the stock wrist sits ~5 mm toward the thumb and ~4.5 mm palmar of our joint centre: measured on the skinned mesh)
    this.ringOff.x = -5 / (this.s * 100)
    this.ringOff.z = -4.5 / (this.s * 100)

    // tip probes: skinned vertices used for the tip-error measurement
    const si = m.geometry.attributes.skinIndex as THREE.BufferAttribute
    const sw = m.geometry.attributes.skinWeight as THREE.BufferAttribute
    const tipGap: number[] = []
    for (let f = 0; f < 5; f++) {
      const ei = E.findIndex((e) => e.f === f && e.next === -1 && e.kind === 'chain')
      const e = E[ei]
      const bi = byName.get(e.bone.name)!
      const bj = byName.get(E[e.prev].bone.name)!
      const a = tmpV2.copy(e.restPos).sub(E[e.prev].restPos).normalize().clone()
      let bestA = -Infinity, bestP = -Infinity, ia = -1, ip = -1
      for (let i = 0; i < n; i++) {
        let w = 0
        for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === bi || si.getComponent(i, k) === bj) w += sw.getComponent(i, k)
        if (w < 0.5) continue
        const along = tmpV.copy(bp[i]).sub(e.restPos).dot(a)
        const down = -tmpV.copy(bp[i]).sub(e.restPos).dot(this.restEz)
        if (along > bestA) { bestA = along; ia = i }
        if (down > bestP) { bestP = down; ip = i }
      }
      if (ia >= 0) { this.probes.push({ f, e: ei, vertex: ia, bind: bp[ia], palmar: false });  }
      if (ip >= 0) this.probes.push({ f, e: ei, vertex: ip, bind: bp[ip], palmar: true })
    }

    // (mesh extremity beyond the rest tip joint vs our capsule radius: the stretch that makes the pad meet the capsule end)
    void tipGap

    // forearm: unit tube y in [-1, 0.04] (0 = wrist ring, -1 = elbow), x / z unit ellipse scaled by the profile
    const N = 9, M = 20
    const verts: number[] = [], idxs: number[] = []
    for (let k = 0; k <= N; k++) {
      const t = k / N
      const y = k === 0 ? 0.1 : -t
      const u = Math.min(1, t / 0.4)
      const sm = u * u * (3 - 2 * u)
      const tuck = k === 0 ? 0.8 : 1 // the end inside the hand is smaller so no rim shows
      const rx = 0.97 * tuck * (1 + 0.1 * sm + 0.14 * t) // 58 -> ~72 mm breadth
      const rz = 0.97 * tuck * (1 + 0.22 * sm + 0.2 * t) // 38 -> ~54 mm depth
      for (let j = 0; j < M; j++) {
        const th = (j / M) * Math.PI * 2
        verts.push(Math.cos(th) * rx, y, Math.sin(th) * rz)
      }
    }
    for (let k = 0; k < N; k++) for (let j = 0; j < M; j++) {
      const a = k * M + j, b = k * M + ((j + 1) % M), c2 = (k + 1) * M + j, d = (k + 1) * M + ((j + 1) % M)
      idxs.push(a, c2, b, b, c2, d)
    }
    const cc = verts.length / 3
    verts.push(0, -1, 0)
    for (let j = 0; j < M; j++) idxs.push(N * M + j, cc, N * M + ((j + 1) % M))
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
    geo.setIndex(idxs)
    geo.computeVertexNormals()
    this.forearm = new THREE.Mesh(geo, this.mat)
    this.forearm.matrixAutoUpdate = false
    this.forearm.frustumCulled = false
    this.forearm.castShadow = true
    this.forearm.receiveShadow = false
    this.forearm.renderOrder = 5
    this.forearm.raycast = () => {}
    this.group.add(this.forearm)
    this.ready = true
  }


  /** per-segment measured / target finger radii (mm), for the report */
  report: { name: string; measured: number; target: number; th: number }[] = []
  palmReport = ''

  /** Edit the rest mesh: (1) wrist/palm-weighted vertices -> target breadth / depth profile centred on OUR wrist axis,
   *  flaring the open wrist to the 58 x 38 mm ellipse; (2) per-bone cross-section scale `th` so each finger segment's mean
   *  radius equals handDims' FINGER_R taper. Metacarpal bones keep th = 1 (their width comes from the pose). */
  private reshape(m: THREE.SkinnedMesh, byName: Map<string, number>, sfx: string) {
    const E = this.entries
    const pos = m.geometry.attributes.position as THREE.BufferAttribute
    const si = m.geometry.attributes.skinIndex as THREE.BufferAttribute
    const sw = m.geometry.attributes.skinWeight as THREE.BufferAttribute
    const names = m.skeleton.bones.map((b) => b.name)
    const wristish = names.map((n) => n === 'Wrist' + sfx || n === 'Palm' + sfx)
    const metac = names.map((n) => /^(Index|Middle|Ring|Little)_Metacarpal/.test(n))
    const k = this.s * 100 // model unit -> mm
    const ex = this.restEx, ey = this.ey, ez = this.restEz, w0 = this.wristRest
    const v = new THREE.Vector3()
    const n = pos.count
    // finger radii first (measured on the unedited mesh)
    const per = E.map(() => ({ sum: 0, n: 0 }))
    const boneEntry = new Map<number, number>()
    E.forEach((e, i) => boneEntry.set(byName.get(e.bone.name)!, i))
    for (let i = 0; i < n; i++) {
      let bi = -1, bw = 0
      for (let j = 0; j < 4; j++) { const wj = sw.getComponent(i, j); if (wj > bw) { bw = wj; bi = si.getComponent(i, j) } }
      if (bw < 0.5) continue
      const ei = boneEntry.get(bi)
      if (ei === undefined) continue
      const e = E[ei]
      if (e.kind !== 'chain' || e.next < 0) continue
      const a = tmpV2.copy(E[e.next].restPos).sub(e.restPos)
      const len = a.length()
      a.multiplyScalar(1 / len)
      v.fromBufferAttribute(pos, i).sub(e.restPos)
      const t = v.dot(a) / len
      if (t < 0.12 || t > 0.9) continue
      per[ei].sum += v.addScaledVector(a, -v.dot(a)).length()
      per[ei].n++
    }
    E.forEach((e, i) => {
      if (e.kind !== 'chain') return
      if (e.f >= 1 && e.base) { e.th = 1; return } // metacarpal
      if (e.f === 0 && e.base) return
      if (e.next < 0) { e.th = E[e.prev].th; return }
      if (per[i].n < 3) return
      const meas = (per[i].sum / per[i].n) * k
      const u = e.f === 0 ? (e.ci === 1 ? 0.25 : 0.8) : [0.17, 0.5, 0.83][e.ci]
      const target = FINGER_R[e.f] * 100 * (1 - (1 - TIP_TAPER) * u)
      e.th = Math.min(1.6, Math.max(0.6, target / meas))
      this.report.push({ name: e.bone.name, measured: +meas.toFixed(1), target: +target.toFixed(1), th: +e.th.toFixed(2) })
    })
    // v3: the per-bone th jumps between neighbours (index: 0.95 / 0.82 / 1.07) read as necks and a squashed middle phalanx;
    // clamp to a narrow band and smooth along each chain (the skin only blends over +-6 mm around a joint).
    for (let f = 1; f < 5; f++) {
      const ids = E.map((_, i) => i).filter((i) => E[i].f === f && E[i].kind === 'chain' && !E[i].base && E[i].next >= 0)
      const raw = ids.map((i) => Math.min(TH_MAX, Math.max(TH_MIN, E[i].th)))
      ids.forEach((i, q) => {
        const a = raw[Math.max(0, q - 1)], b = raw[q], c = raw[Math.min(raw.length - 1, q + 1)]
        E[i].th = 0.25 * a + 0.5 * b + 0.25 * c
        const t = E[i].next
        if (E[t].next < 0) E[t].th = E[i].th
      })
    }
    E.forEach((e) => { e.thBase = e.th })
    // palm / open wrist: measure the stock cross-sections (4 mm bins along the hand axis), then remap to the targets
    const BIN = 4, NB = 40, Y0 = -12
    const bx0 = new Array(NB).fill(Infinity), bx1 = new Array(NB).fill(-Infinity)
    const bz0 = new Array(NB).fill(Infinity), bz1 = new Array(NB).fill(-Infinity)
    const wpOf = (i: number) => { let wp = 0; for (let j = 0; j < 4; j++) if (wristish[si.getComponent(i, j)]) wp += sw.getComponent(i, j); return wp }
    const wmOf = (i: number) => { let wm = 0; for (let j = 0; j < 4; j++) if (metac[si.getComponent(i, j)]) wm += sw.getComponent(i, j); return wm }
    for (let i = 0; i < n; i++) {
      const wp = wpOf(i), wm = wmOf(i)
      if (wp < 0.3 && wm < 0.3) continue
      v.fromBufferAttribute(pos, i).sub(w0)
      const X = v.dot(ex) * k, Y = v.dot(ey) * k, Z = v.dot(ez) * k
      const b = Math.floor((Y - Y0) / BIN)
      if (b < 0 || b >= NB) continue
      if (wp >= 0.3) { bx0[b] = Math.min(bx0[b], X); bx1[b] = Math.max(bx1[b], X) }
      bz0[b] = Math.min(bz0[b], Z); bz1[b] = Math.max(bz1[b], Z)
    }
    const fill = (arr: number[], isMin: boolean) => {
      // running envelope: the opening is a ring (a bin sees only part of it), so take the widest of a +-1 neighbourhood
      const o = arr.slice()
      for (let b = 0; b < NB; b++) for (let d = -1; d <= 1; d++) { const q = arr[b + d]; if (q !== undefined && Number.isFinite(q)) o[b] = isMin ? Math.min(o[b], q) : Math.max(o[b], q) }
      let last = NaN
      for (let b = 0; b < NB; b++) { if (Number.isFinite(o[b])) last = o[b]; else if (Number.isFinite(last)) o[b] = last }
      for (let b = NB - 1; b >= 0; b--) { if (!Number.isFinite(o[b]) && Number.isFinite(o[b + 1])) o[b] = o[b + 1] }
      return o
    }
    const X0 = fill(bx0, true), X1 = fill(bx1, false), Z0 = fill(bz0, true), Z1 = fill(bz1, false)
    const at = (arr: number[], Y: number) => { const f = (Y - Y0) / BIN - 0.5, b = Math.max(0, Math.min(NB - 2, Math.floor(f))), u = Math.max(0, Math.min(1, f - b)); return arr[b] * (1 - u) + arr[b + 1] * u }
    this.palmReport = Array.from({ length: 12 }, (_, q) => { const Y = -8 + q * 10; return `${Y}: W ${(at(X1, Y) - at(X0, Y)).toFixed(0)} D ${(at(Z1, Y) - at(Z0, Y)).toFixed(0)}` }).join(' | ')
    let nx = 0
    for (let i = 0; i < n && PALM_REMAP; i++) {
      const wp = wpOf(i), wm = wmOf(i)
      if (wp <= 0 && wm <= 0) continue
      v.fromBufferAttribute(pos, i).sub(w0)
      const X = v.dot(ex) * k, Y = v.dot(ey) * k, Z = v.dot(ez) * k
      const kx = interp(PALM_W_TARGET, Y) / Math.max(10, at(X1, Y) - at(X0, Y))
      const kz = interp(PALM_D_TARGET, Y) / Math.max(10, at(Z1, Y) - at(Z0, Y))
      const X2 = (X - (at(X0, Y) + at(X1, Y)) / 2) * kx
      const Z2 = (Z - (at(Z0, Y) + at(Z1, Y)) / 2) * kz
      const dx = (X2 - X) * wp / k, dz = (Z2 - Z) * (wp + wm) / k
      v.fromBufferAttribute(pos, i)
      v.addScaledVector(ex, dx).addScaledVector(ez, dz)
      pos.setXYZ(i, v.x, v.y, v.z)
      nx++
    }
    pos.needsUpdate = true
  }

  /** pose joint for an entry */
  joint(e: Entry, p: HandPose, out: THREE.Vector3) {
    let v: Vec3
    if (e.kind === 'wrist' || e.kind === 'palm') v = p.wrist
    else if (e.base) v = p.bases[e.f]
    else v = p.fingers[e.f][e.ci]
    return out.set(v[0], v[1], v[2])
  }

  tipCalibrated = false
  private calN = 0
  private calKey = NaN
  private calG0 = 0
  private calG1 = 0
  /** The distal-bone stretch `tipExt` is calibrated per loaded model on the first frame with pressed fingers: the mesh's
   *  mean pad-to-capsule-end gap (the `axisSigned` probe measure, linear in tipExt) is measured at two stretches and tipExt
   *  set to where it vanishes. (A closed form from the rest mesh missed by ~1 mm: pressed tips tilt, the pad flattens.) */
  private calibrateTip(p: HandPose, showForearm: boolean) {
    const tmp: TipStats = { enabled: true, n: 0, axisErrSum: 0, axisErrMax: 0, palmErrSum: 0, palmErrMax: 0, boneErrMax: 0, axisSigned: 0, nAxis: 0, zSigned: 0, zMin: Infinity, zMax: -Infinity }
    if (this.probes.filter((q) => !q.palmar && p.press[q.f] > 0.5).length < 1) return
    const gap = (ext: number) => {
      this.tipExt = ext
      tmp.axisSigned = 0; tmp.nAxis = 0
      this.step(p, tmp, showForearm, false)
      return tmp.axisSigned / Math.max(1, tmp.nAxis)
    }
    const key = p.wrist[0] * 7.1 + p.fingers[1][3][0] * 3.7 + p.fingers[2][3][1]
    if (key === this.calKey) return // (the same frame again: wait for the pose to move)
    this.calKey = key
    const a0 = gap(0), a1 = gap(0.04)
    this.calG0 += a0; this.calG1 += a1
    const g0 = this.calG0 / (this.calN + 1), g1 = this.calG1 / (this.calN + 1)
    this.calN++
    this.tipExt = g1 > g0 + 1e-6 ? Math.min(0.08, Math.max(0, (0 - g0) * 0.04 / (g1 - g0))) : TIP_EXT
    if (this.calN < 14) return // average over a few pressed frames
    this.tipCalibrated = true
  }

  update(p: HandPose | null, st: TipStats, showForearm: boolean, debug = false) {
    this.group.visible = !!p && this.ready
    if (!p || !this.ready) return
    if (!this.tipCalibrated) this.calibrateTip(p, showForearm)
    this.step(p, st, showForearm, debug)
  }

  private step(p: HandPose, st: TipStats, showForearm: boolean, debug: boolean) {
    const E = this.entries
    // hand frame from the pose
    this.ex.set(p.fingers[4][0][0] - p.fingers[1][0][0], p.fingers[4][0][1] - p.fingers[1][0][1], p.fingers[4][0][2] - p.fingers[1][0][2]).normalize()
    tmpV.set(0, 0, 0)
    for (let f = 1; f < 5; f++) tmpV.x += p.fingers[f][0][0] * 0.25, tmpV.y += p.fingers[f][0][1] * 0.25, tmpV.z += p.fingers[f][0][2] * 0.25
    tmpV.x -= p.wrist[0]; tmpV.y -= p.wrist[1]; tmpV.z -= p.wrist[2]
    this.ey.copy(tmpV).addScaledVector(this.ex, -tmpV.dot(this.ex)).normalize()
    this.ez.crossVectors(this.ex, this.ey).multiplyScalar(this.sgn)
    this.fr.makeBasis(this.ex, this.ey, this.ez)
    this.delta.multiplyMatrices(this.fr, this.restFrameT) // rest hand frame -> current hand frame
    const hq = new THREE.Quaternion() // (one small allocation-free reuse below)
    void hq
    // joint positions + aim directions + stretch
    for (let i = 0; i < E.length; i++) this.joint(E[i], p, this.P[i])
    for (let i = 0; i < E.length; i++) {
      const e = E[i]
      if (e.kind !== 'chain') continue
      if (e.next >= 0) {
        this.A[i].copy(this.P[e.next]).sub(this.P[i])
        const len = this.A[i].length()
        this.K[i] = len / (e.restLen * this.s)
        if (E[e.next].next === -1) this.K[i] *= 1 + this.tipExt / Math.max(len, 0.05)
        if (len > 1e-6) this.A[i].multiplyScalar(1 / len)
        else this.A[i].copy(e.prev >= 0 ? this.A[e.prev] : this.ey)
      } else {
        this.A[i].copy(this.A[e.prev])
        this.K[i] = this.K[e.prev]
      }
    }
    // Twist reference per finger. Our fingers flex in a hinge plane (tilted per finger by FLEX_ROLL, rotated with the
    // MCP abduction), whose normal is NOT the knuckle-row axis; aiming each bone's lateral axis at the knuckle row put
    // the mesh's PIP / DIP hinge off our bend plane, so the finger looked bent sideways. Use the bend-plane normal
    // (sum of the oriented segment cross products: |sum| ~ sin of the total bend), fading to the knuckle-row axis as
    // the finger straightens (the normal is then ill-defined).
    for (let f = 1; f < 5; f++) {
      const lat = this.latRef[f]
      lat.copy(this.ex)
      this.planeDev[f] = 0
      const c = [E.findIndex((e) => e.kind === 'chain' && e.f === f && e.ci === 0), 0, 0, 0]
      for (let k = 1; k < 4; k++) c[k] = E[c[k - 1]].next
      if (c.some((i) => i < 0)) continue
      tmpV.set(0, 0, 0)
      for (let k = 0; k < 2; k++) tmpV.add(tmpV2.crossVectors(this.A[c[k]], this.A[c[k + 1]]))
      const mag = tmpV.length()
      if (tmpV.dot(this.ex) < 0) tmpV.negate() // orient like the knuckle row
      if (mag > 1e-6) tmpV.multiplyScalar(1 / mag)
      const nrm = this.planeN[f].copy(tmpV)
      if (TWIST_MODE === 'plane' && mag > 1e-6) {
        const w = Math.min(1, Math.max(0, (mag - 0.09) / (0.4 - 0.09))) // sin 5 deg .. sin 23.5 deg
        lat.multiplyScalar(1 - w).addScaledVector(nrm, w).normalize()
      }
      // diagnostic: deviation of the lateral axis each bone is twisted by (projected off its own axis) from the bend plane
      if (mag > 0.17) {
        let dev = 0
        for (let k = 0; k < 3; k++) {
          tmpV2.copy(lat).addScaledVector(this.A[c[k]], -this.A[c[k]].dot(lat)).normalize()
          dev = Math.max(dev, Math.acos(Math.min(1, Math.abs(tmpV2.dot(nrm)))) * 180 / Math.PI)
        }
        this.planeDev[f] = dev
      }
    }
    const s = this.s
    // bend-volume compensation: linear blend skinning pinches a segment by ~cos(theta/2) at a bent joint, so a segment
    // between two bent joints (the middle phalanx) is squashed most; widen it by the larger of its two end bends.
    for (let i = 0; i < E.length; i++) {
      const e = E[i]
      if (e.kind !== 'chain' || e.next < 0) continue
      const bend = (a: THREE.Vector3, b: THREE.Vector3) => Math.acos(Math.min(1, Math.max(-1, a.dot(b))))
      const t0 = e.prev >= 0 ? bend(this.A[e.prev], this.A[i]) : 0
      const t1 = E[e.next].next >= 0 ? bend(this.A[i], this.A[e.next]) : 0
      e.th = e.thBase * (1 + BEND_BULGE * (1 / Math.cos(0.5 * Math.min(1.4, Math.max(t0, t1))) - 1))
      if (E[e.next].next < 0) E[e.next].th = e.th
    }
    for (let i = 0; i < E.length; i++) {
      const e = E[i]
      if (e.kind === 'wrist') {
        tmpQ.setFromRotationMatrix(this.delta).multiply(e.restQ)
        tmpS.set(s, s, s)
        e.bone.matrixWorld.compose(this.P[i], tmpQ, tmpS)
      } else if (e.kind === 'palm') {
        tmpV.copy(e.restPos).sub(this.wristRest).applyMatrix4(tmpM.extractRotation(this.delta)).multiplyScalar(s).add(this.P[0])
        tmpQ.setFromRotationMatrix(this.delta).multiply(e.restQ)
        tmpS.set(s, s, s)
        e.bone.matrixWorld.compose(tmpV, tmpQ, tmpS)
      } else {
        if (e.f === 0 && p.thumbRef) {
          // Round 32: the thumb's roll follows the CMC / MCP / IP axes (the hand's dorsal axis carried down the chain), not the palm normal
          const r = p.thumbRef[Math.min(e.ci, 2)]
          this.thumbL.set(r[0], r[1], r[2])
          frameMatrix(this.b1, this.A[i], this.thumbL, this.ex)
        } else frameMatrix(this.b1, this.A[i], e.f === 0 ? this.ez : this.latRef[e.f], e.f === 0 ? this.ex : this.ez)
        tmpM2.multiplyMatrices(this.b1, e.restBasisT)
        tmpQ.setFromRotationMatrix(tmpM2).multiply(e.restQ)
        const th = e.th, k = this.K[i] - th
        tmpS.set(s * (th + k * e.axisL.x * e.axisL.x), s * (th + k * e.axisL.y * e.axisL.y), s * (th + k * e.axisL.z * e.axisL.z))
        e.bone.matrixWorld.compose(this.P[i], tmpQ, tmpS)
      }
    }
    // forearm tube
    this.forearm.visible = showForearm
    if (showForearm) {
      const o = this.ringOff
      const cx = p.wrist[0] + s * (o.x * this.ex.x + o.y * this.ey.x + o.z * this.ez.x)
      const cy = p.wrist[1] + s * (o.x * this.ex.y + o.y * this.ey.y + o.z * this.ez.y)
      const cz = p.wrist[2] + s * (o.x * this.ex.z + o.y * this.ey.z + o.z * this.ez.z)
      const fx = cx - p.elbow[0], fy = cy - p.elbow[1], fz = cz - p.elbow[2]
      const len = Math.hypot(fx, fy, fz) || 1
      tmpV.set(fx / len, fy / len, fz / len) // forearm axis, toward the hand
      tmpV2.copy(this.ex).addScaledVector(tmpV, -this.ex.dot(tmpV)).normalize() // lateral
      const zf = new THREE.Vector3() // small, only per hand per frame — replaced below by scratch
      void zf
      const m = this.forearm.matrix
      // columns: X = lateral * a, Y = axis * len, Z = dorsal * b (dorsal = sgn * lateral x axis)
      const zx = this.sgn * (tmpV2.y * tmpV.z - tmpV2.z * tmpV.y)
      const zy = this.sgn * (tmpV2.z * tmpV.x - tmpV2.x * tmpV.z)
      const zz = this.sgn * (tmpV2.x * tmpV.y - tmpV2.y * tmpV.x)
      const a = this.ringA * s, b = this.ringB * s
      m.set(
        tmpV2.x * a, tmpV.x * len, zx * b, cx,
        tmpV2.y * a, tmpV.y * len, zy * b, cy,
        tmpV2.z * a, tmpV.z * len, zz * b, cz,
        0, 0, 0, 1,
      )
      this.forearm.matrixWorldNeedsUpdate = true
    }
    this.drawDebug(debug)
    // tip error vs the pose (pressed fingers only)
    if (st.enabled) this.measure(p, st)
  }

  dbgLines: THREE.LineSegments | null = null
  dbgPts: THREE.Points | null = null
  /** pose skeleton on top of the mesh: lines joint -> next joint (white), joint dots (yellow; PIP/DIP-ish = red). */
  private drawDebug(on: boolean) {
    if (!this.dbgLines) {
      const mk = (o: THREE.Object3D) => { o.frustumCulled = false; o.renderOrder = 20; o.matrixAutoUpdate = false; this.group.add(o) }
      const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.entries.length * 6), 3))
      this.dbgLines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }))
      const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.entries.length * 3), 3))
      this.dbgPts = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0xffe000, size: 7, sizeAttenuation: false, depthTest: false, transparent: true }))
      mk(this.dbgLines); mk(this.dbgPts)
    }
    this.dbgLines.visible = this.dbgPts!.visible = on
    if (!on) return
    const lp = this.dbgLines.geometry.attributes.position as THREE.BufferAttribute
    const pp = this.dbgPts!.geometry.attributes.position as THREE.BufferAttribute
    this.entries.forEach((e, i) => {
      const a = this.P[i]
      pp.setXYZ(i, a.x, a.y, a.z)
      const b = e.next >= 0 ? this.P[e.next] : a
      lp.setXYZ(i * 2, a.x, a.y, a.z); lp.setXYZ(i * 2 + 1, b.x, b.y, b.z)
    })
    lp.needsUpdate = true; pp.needsUpdate = true
  }

  private measure(p: HandPose, st: TipStats) {
    const E = this.entries
    for (const pr of this.probes) {
      if (p.press[pr.f] <= 0.5) continue
      // CPU skin of one vertex
      const m = this.mesh
      const si = m.geometry.attributes.skinIndex as THREE.BufferAttribute
      const sw = m.geometry.attributes.skinWeight as THREE.BufferAttribute
      tmpS.set(0, 0, 0)
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(pr.vertex, k)
        if (w === 0) continue
        const bi = si.getComponent(pr.vertex, k)
        tmpM.multiplyMatrices(m.skeleton.bones[bi].matrixWorld, m.skeleton.boneInverses[bi])
        tmpS.addScaledVector(tmpV.copy(pr.bind).applyMatrix4(tmpM), w)
      }
      const tip = p.fingers[pr.f][3]
      const r = fingerRadius(pr.f, 1)
      const ai = pr.e
      if (pr.palmar) tmpV.set(tip[0] - this.ez.x * r, tip[1] - this.ez.y * r, tip[2] - this.ez.z * r)
      else tmpV.set(tip[0] + this.A[ai].x * r, tip[1] + this.A[ai].y * r, tip[2] + this.A[ai].z * r)
      const err = tmpS.distanceTo(tmpV)
      if (pr.palmar) { const dz = tmpS.z - (tip[2] - r); st.zSigned += dz; st.zMin = Math.min(st.zMin, dz); st.zMax = Math.max(st.zMax, dz) } else { st.axisSigned += tmpS.sub(tmpV).dot(this.A[ai]); st.nAxis++; tmpS.add(tmpV) }
      if (pr.palmar) { st.palmErrSum += err; st.palmErrMax = Math.max(st.palmErrMax, err); st.n++ } else { st.axisErrSum += err; st.axisErrMax = Math.max(st.axisErrMax, err) }
      st.boneErrMax = Math.max(st.boneErrMax, E[ai].bone.matrixWorld.elements.length ? tmpV2.setFromMatrixPosition(E[ai].bone.matrixWorld).distanceTo(tmpV.set(tip[0], tip[1], tip[2])) : 0)
    }
  }
}

// Matte, slightly darker than a plain skin tone: the keys multiply their albedo by the same brightness and sit in the same light.

const SKIN = { L: 0x7a5646, R: 0x80594a }

export function createMeshHands(parent: THREE.Object3D) {
  const root = new THREE.Group()
  root.name = 'meshHands'
  parent.add(root)
  // Lighting shared by both hands. Albedo / sheen / rim are scaled by `keyboardBrightness` (the keys do the same), so on a
  // dark scene the hands are as dim as the keys; the flash lights (`keyboard/flashLights.ts`) are added on top like the
  // white-key shader does. Standard-material path, so the Bloom on/off colour space is handled by three.
  const lightU = {
    uBright: { value: 1 },
    uSkinGain: { value: 1 },
    uFlashStrength: { value: 0 },
    uFlashXY: { value: flashLights.xy },
    uFlashI: { value: flashLights.handIntensities },
    uFlashC: { value: flashLights.colors },
    uFlashFall: { value: new THREE.Vector2(1, 1) },
  }
  const mkMat = (c: number) => {
    const mat = new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.82, metalness: 0, specularIntensity: 0.25, envMapIntensity: 0, side: THREE.DoubleSide })
    // cheap AO (contact darkening toward the key plane, world z) + a barely visible neutral rim; matte skin, no sheen.
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, lightU)
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSkinW;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvSkinW = (modelMatrix * vec4(transformed, 1.0)).xyz;')
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vSkinW;
          #define FLASH_N ${MAX_LIGHTS}
          uniform float uBright;
          uniform float uSkinGain;
          uniform float uFlashStrength;
          uniform vec2 uFlashXY[FLASH_N];
          uniform float uFlashI[FLASH_N];
          uniform vec3 uFlashC[FLASH_N];
          uniform vec2 uFlashFall;`)
        .replace('#include <opaque_fragment>', `
          float skinAO = mix(0.62, 1.0, smoothstep(0.02, 0.5, vSkinW.z));
          float grazing = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 2.5);
          outgoingLight = (outgoingLight * skinAO + vec3(0.03) * uBright * grazing * (0.4 + 0.6 * skinAO)) * uSkinGain;
          if (uFlashStrength > 0.001) {
            // Flash lights: wrap diffuse + a small specular, Gaussian falloff (same X / Y widths as the key glow, a tight one in
            // height) so only fingers near a lit key pick it up. Flash y is keyboard-local, hands are in world space: + KEYBOARD_Y.
            vec3 nW = normalize(inverseTransformDirection(normal, viewMatrix));
            vec3 vW = normalize(cameraPosition - vSkinW);
            vec3 flashSum = vec3(0.0);
            vec3 glowSum = vec3(0.0);
            for (int fi = 0; fi < FLASH_N; fi++) {
              float fInt = uFlashI[fi];
              if (fInt < 0.005) continue;
              vec3 toL = vec3(uFlashXY[fi].x, uFlashXY[fi].y + ${KEYBOARD_Y.toFixed(3)}, 0.04) - vSkinW;
              float fall = exp(-toL.x * toL.x * uFlashFall.x - toL.y * toL.y * uFlashFall.y - toL.z * toL.z * 5.0);
              vec3 lW = normalize(toL);
              float wrap = pow(clamp(dot(nW, lW) * 0.5 + 0.5, 0.0, 1.0), 2.0);
              float spec = pow(max(dot(nW, normalize(lW + vW)), 0.0), 24.0) * 0.35;
              // The same light also glows from the hit line above the keys (luminous notes landing + the line): a soft,
              // wide area term that reaches the back of the hand / knuckles, using the slot's note colour.
              vec3 toG = vec3(uFlashXY[fi].x, uFlashXY[fi].y + ${KEYBOARD_Y.toFixed(3)}, 0.35) - vSkinW;
              float gFall = exp(-toG.x * toG.x * uFlashFall.x * 0.6 - toG.y * toG.y * 0.9 - toG.z * toG.z * 0.8);
              float gWrap = clamp(dot(nW, normalize(toG)) * 0.6 + 0.4, 0.0, 1.0);
              glowSum += uFlashC[fi] * fInt * gFall * gWrap * gWrap * mix(vec3(1.0), diffuseColor.rgb * 2.0, 0.6) * 0.7;
              flashSum += uFlashC[fi] * fInt * fall * (wrap * mix(vec3(1.0), diffuseColor.rgb * 2.0, 0.6) + spec);
            }
            outgoingLight += (flashSum + glowSum) * uFlashStrength;
          }
          // forearm / wrist end fades to black so the cut disappears into the dark foreground
          outgoingLight *= smoothstep(${(KEYBOARD_Y - 1.0).toFixed(3)}, ${(KEYBOARD_Y - 0.25).toFixed(3)}, vSkinW.y);
          #include <opaque_fragment>`)
    }
    return mat
  }
  const mats = { L: mkMat(SKIN.L), R: mkMat(SKIN.R) }
  const hands = { L: new MeshHand('L', mats.L, root), R: new MeshHand('R', mats.R, root) }
  const stats: TipStats = { enabled: false, n: 0, axisErrSum: 0, axisErrMax: 0, palmErrSum: 0, palmErrMax: 0, boneErrMax: 0, axisSigned: 0, nAxis: 0, zSigned: 0, zMin: Infinity, zMax: -Infinity }
  const loaded = Promise.all([hands.L.load(), hands.R.load()]).then(() => undefined)
  loaded.catch((e) => console.error('mesh hands failed', e))
  return {
    loaded,
    get ready() { return hands.L.ready && hands.R.ready },
    setVisible(v: boolean) { root.visible = v },
    /** Per-frame lighting: `brightness` = resolved keyboardBrightness, `skin` = handsBrightness (the scene-lit skin only, not the
     *  flash lights; perceptual: 2 looks about twice as bright, so the gain is skin^2.2 in linear light), `flashLight` = handsFlashLight (0 = off). */
    setLighting(brightness: number, skin: number, flashLight: number) {
      lightU.uBright.value = brightness
      lightU.uSkinGain.value = Math.pow(Math.max(0, skin), 2.2)
      lightU.uFlashStrength.value = flashLights.strength * flashLights.boost * flashLight
      lightU.uFlashFall.value.set(flashLights.falloffX, flashLights.falloffY)
      mats.L.color.setHex(SKIN.L).multiplyScalar(brightness); mats.R.color.setHex(SKIN.R).multiplyScalar(brightness)
    },
    stats,
    update(poses: HandPoses, showForearm: boolean, debug = false) {
      hands.L.update(poses.L, stats, showForearm, debug)
      hands.R.update(poses.R, stats, showForearm, debug)
    },
    dispose() { parent.remove(root); mats.L.dispose(); mats.R.dispose() },
  }
}
