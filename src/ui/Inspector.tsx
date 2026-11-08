import { useEffect, useRef, useState, type ReactNode, useLayoutEffect, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { useStore, defaultSettings, type Settings } from '../store'
import { audioEngine } from '../audio/engine'
import {
  BoundColorRow,
  BoundSliderRow,
  BoundSwitchRow,
  ColorRow,
  Detail,
  SearchableBlock,
  SearchGroup,
  useSearchQuery,
  SearchProvider,
  Section,
  SelectRow,
  SliderRow,
  VerticalSliderBands,
  useEffectiveSetting,
  LookAnchorContext,
  BoundCountRow,
} from './controls'
import { GradientStops, removeGradientStop } from './look/GradientStops'
import { PresetSwatch } from './look/PresetSwatch'
import { ImagePicker } from './look/ImagePicker'
import { useBarColors, useEffectiveLook } from './look/useLookState'
import { VelocityCurveEditor } from './VelocityCurveEditor'
import { Button, Icon, IconButton, Panel, GEOMETRY, usePresence } from './kit'
import { useShell } from './shell/uiState'
import { useTakeInProgress } from './shell/takeFocus'
import { useIdle } from './shell/idle'
import { useCustomTexture } from '../notes/customTexture'
import { CAMERA_LIMITS } from '../scene/cameraLimits'
import { getHandsStatus, subscribeHandsStatus } from '../hands/motion'
import {
  STAGE_BACKGROUND_ACCEPTED_TYPES,
  useStageBackground,
} from '../scene/stageBackground'
import { showAlert } from './confirm'
import {
  GRADIENT_COLOR_KEYS,
  GRADIENT_POS_KEYS,
  HIT_LINE_GRADIENT_COLOR_KEYS,
  HIT_LINE_GRADIENT_POS_KEYS,
  RANDOM_COLOR_KEYS,
} from '../notes/noteColor'
import {
  NOTE_LOOK_PRESETS,
  matchNoteLookPreset,
  lightsForMaterialSwitch,
} from '../notes/looks/noteLook'

const EQ_LABELS = ['80', '250', '800', '2.5k', '6k', '12k']

// Short alias used for the per-row `defaultValue` props that wire up
// double-click-to-reset on every control.
const def = defaultSettings

// ── Atomic settings mutation helpers ─────────────────────────────────
//
// Each section below mutates settings by name without going through a
// shared `update(patch)` closure — that closure captured the whole
// `settings` object and forced Inspector to subscribe to all of it. The
// Bound* row wrappers subscribe per-key internally, and these helpers
// give the few hand-rolled callsites the same begin/end bracketing
// without forcing a wide subscription on the parent component.
function atomicUpdate(patch: Partial<Settings>): void {
  const s = useStore.getState()
  s.beginSettingsEdit()
  s.updateSettings(patch)
  s.endSettingsEdit()
}

// ── Sub-group ────────────────────────────────────────────────────────
//
// Rows that are parameters OF the control immediately above them — a
// texture preset, a wave toggle, a glow toggle — rather than siblings of
// it. Without the rule they sit at the same level as everything else in
// the section and nothing says what they belong to.
//
// Section-level "Enabled" switches deliberately do NOT get one: the
// section header already groups their rows, so wrapping the whole body
// would add a rule and no information.
//
// Every child returns null when the Inspector's search filter excludes
// it, at which point the wrapper collapses to zero height and the rule
// goes with it instead of being left behind over empty space.
// `label` names the parent control. Rows inside drop the redundant
// prefix from what they display — "Intensity" under a Glow toggle, not
// "Glow Intensity" — and `SearchGroup` folds the name back in for the
// Inspector's search, so typing "glow" still finds every row under it.
// `heading` also shows the label above the group, for groups that have
// no parent control naming them (the note-look parameter groups); it
// hides while searching so a filtered-out group leaves no stray title.
function SubGroup({ label, heading, children }: { label: string; heading?: boolean; children: ReactNode }) {
  const query = useSearchQuery()
  return (
    <div className="grid gap-3 empty:hidden">
      {heading && !query && <div className="pt-1 text-label text-ink">{label}</div>}
      <SearchGroup label={label}>{children}</SearchGroup>
    </div>
  )
}

// ── Camera section ───────────────────────────────────────────────────
function CameraSection() {
  const { t } = useTranslation('inspector')
  const cameraPos = useEffectiveSetting('cameraPos')
  const cameraLookAt = useEffectiveSetting('cameraLookAt')
  // Re-express the cartesian camera state as the seven knobs the user
  // actually thinks in terms of (orbit triple + pivot triple + FOV).
  const dx = cameraPos[0] - cameraLookAt[0]
  const dy = cameraPos[1] - cameraLookAt[1]
  const dz = cameraPos[2] - cameraLookAt[2]
  const distance = Math.hypot(dx, dy, dz) || 1e-6
  const phi = Math.acos(Math.max(-1, Math.min(1, dy / distance)))
  const theta = Math.atan2(dx, dz)
  const tiltDeg = 90 - (phi * 180) / Math.PI
  const yawDeg = (theta * 180) / Math.PI
  const writeOrbit = (
    nextDistance: number,
    nextTiltDeg: number,
    nextYawDeg: number,
  ) => {
    // Pull the tilt slightly off the poles to keep yaw recoverable.
    const TILT_EPS = 0.01
    const clampedTilt = Math.max(
      -90 + TILT_EPS,
      Math.min(90 - TILT_EPS, nextTiltDeg),
    )
    const nextPhi = ((90 - clampedTilt) * Math.PI) / 180
    const nextTheta = (nextYawDeg * Math.PI) / 180
    const sinPhi = Math.sin(nextPhi)
    const nx = nextDistance * sinPhi * Math.sin(nextTheta)
    const ny = nextDistance * Math.cos(nextPhi)
    const nz = nextDistance * sinPhi * Math.cos(nextTheta)
    atomicUpdate({
      cameraPos: [
        cameraLookAt[0] + nx,
        cameraLookAt[1] + ny,
        cameraLookAt[2] + nz,
      ],
    })
  }
  const writePivot = (axis: 0 | 1 | 2, value: number) => {
    const delta = value - cameraLookAt[axis]
    const nextLookAt: [number, number, number] = [...cameraLookAt]
    const nextPos: [number, number, number] = [...cameraPos]
    nextLookAt[axis] = value
    nextPos[axis] += delta
    atomicUpdate({ cameraLookAt: nextLookAt, cameraPos: nextPos })
  }
  return (
    <>
      <SliderRow
        label={t('camera.distance')}
        value={distance}
        min={CAMERA_LIMITS.distance.min}
        max={CAMERA_LIMITS.distance.max}
        step={0.1}
        onChange={(v) => writeOrbit(v, tiltDeg, yawDeg)}
        defaultValue={def.cameraPos[2]}
        scopeKey="cameraPos"
      />
      <SliderRow
        label={t('camera.horizontal')}
        value={yawDeg}
        min={CAMERA_LIMITS.horizontalDeg.min}
        max={CAMERA_LIMITS.horizontalDeg.max}
        step={1}
        onChange={(v) => writeOrbit(distance, tiltDeg, v)}
        format={(v) => `${Math.round(v)}°`}
        defaultValue={0}
        scopeKey="cameraPos"
      />
      <SliderRow
        label={t('camera.vertical')}
        value={tiltDeg}
        min={CAMERA_LIMITS.verticalDeg.min}
        max={CAMERA_LIMITS.verticalDeg.max}
        step={1}
        onChange={(v) => writeOrbit(distance, v, yawDeg)}
        format={(v) => `${Math.round(v)}°`}
        defaultValue={0}
        scopeKey="cameraPos"
      />
      <SliderRow
        label={t('camera.pivotX')}
        value={cameraLookAt[0]}
        min={CAMERA_LIMITS.pivotX.min}
        max={CAMERA_LIMITS.pivotX.max}
        step={0.05}
        onChange={(v) => writePivot(0, v)}
        defaultValue={def.cameraLookAt[0]}
        scopeKey="cameraLookAt"
      />
      <SliderRow
        label={t('camera.pivotY')}
        value={cameraLookAt[1]}
        min={CAMERA_LIMITS.pivotY.min}
        max={CAMERA_LIMITS.pivotY.max}
        step={0.05}
        onChange={(v) => writePivot(1, v)}
        defaultValue={def.cameraLookAt[1]}
        scopeKey="cameraLookAt"
      />
      <SliderRow
        label={t('camera.pivotZ')}
        value={cameraLookAt[2]}
        min={CAMERA_LIMITS.pivotZ.min}
        max={CAMERA_LIMITS.pivotZ.max}
        step={0.05}
        onChange={(v) => writePivot(2, v)}
        defaultValue={def.cameraLookAt[2]}
        scopeKey="cameraLookAt"
      />
    </>
  )
}

// ── Notes: track color rows ──────────────────────────────────────────
function TrackColorRows() {
  const { t: tr } = useTranslation('inspector')
  const song = useStore((st) => st.song)
  const trackColors = useEffectiveSetting('trackColors')
  const noteColor = useEffectiveSetting('noteColor')
  const noteTracks =
    song?.tracks.map((t, idx) => ({ t, idx })).filter(({ t }) => t.hasNotes) ?? []
  if (noteTracks.length === 0) {
    return <BoundColorRow label={tr('row.color')} settingKey="noteColor" />
  }
  // The base colour stays editable: it colours live playing and every
  // track without its own colour.
  return (
    <>
      <BoundColorRow label={tr('coloring.baseColor')} settingKey="noteColor" />
      <p className="text-caption text-ink-faint">{tr('coloring.baseColorHint')}</p>
      {noteTracks.map(({ t, idx }) => {
        const key = String(idx)
        const hasOverride = trackColors[key] !== undefined
        const value = trackColors[key] ?? noteColor
        return (
          <ColorRow
            key={idx}
            label={t.name}
            value={value}
            onChange={(v) =>
              atomicUpdate({ trackColors: { ...trackColors, [key]: v } })
            }
            defaultValue={noteColor}
            isModified={hasOverride}
            onReset={
              hasOverride
                ? () => {
                    const next = { ...trackColors }
                    delete next[key]
                    atomicUpdate({ trackColors: next })
                  }
                : undefined
            }
          />
        )
      })}
    </>
  )
}

// ── Notes: colouring (solid + per-track / gradient / random palette) ──
function NoteColorControls() {
  const { t } = useTranslation('inspector')
  const mode = useStore((st) => st.settings.noteColorMode)
  const stops = useStore((st) => Math.round(st.settings.noteGradientStops))
  const count = useStore((st) => Math.round(st.settings.noteRandomCount))
  const randomBy = useStore((st) => st.settings.noteRandomBy)
  return (
    <>
      <SelectRow
        label={t('coloring.type')}
        value={mode}
        options={[
          { value: 'solid', label: t('coloring.modes.solid') },
          { value: 'gradient', label: t('coloring.modes.gradient') },
          { value: 'random', label: t('coloring.modes.random') },
          { value: 'hand', label: t('coloring.modes.hand') },
        ]}
        onChange={(v) => atomicUpdate({ noteColorMode: v })}
        defaultValue={def.noteColorMode}
        scopeKey="noteColorMode"
      />
      {mode === 'solid' && <TrackColorRows />}
      {mode === 'hand' && (
        <SubGroup label={t('coloring.modes.hand')}>
          <BoundColorRow label={t('coloring.leftHand')} settingKey="noteHandColorL" />
          <BoundColorRow label={t('coloring.rightHand')} settingKey="noteHandColorR" />
          <BoundColorRow label={t('coloring.noHand')} settingKey="noteColor" />
        </SubGroup>
      )}
      {mode === 'gradient' && (
        <SubGroup label={t('coloring.modes.gradient')}>
          <BoundCountRow label={t('coloring.stops')} settingKey="noteGradientStops" min={2} max={5} />
          <BoundSliderRow label={t('coloring.softness')} settingKey="noteGradientSoftness" min={0} max={1} step={0.01} />
          <GradientStops
            label={t('coloring.modes.gradient')}
            colorKeys={GRADIENT_COLOR_KEYS}
            posKeys={GRADIENT_POS_KEYS}
            count={stops}
            countKey="noteGradientStops"
            softnessKey="noteGradientSoftness"
            angleKey="noteGradientAngle"
          />
          <GradientStopRows colorKeys={GRADIENT_COLOR_KEYS} posKeys={GRADIENT_POS_KEYS} countKey="noteGradientStops" count={stops} />
          <BoundSliderRow label={t('coloring.angle')} settingKey="noteGradientAngle" min={0} max={360} step={1} />
        </SubGroup>
      )}
      {mode === 'random' && (
        <SubGroup label={t('coloring.modes.random')}>
          <SelectRow
            label={t('coloring.randomBy')}
            value={randomBy}
            options={[
              { value: 'note', label: t('coloring.randomBys.note') },
              { value: 'pitch', label: t('coloring.randomBys.pitch') },
              { value: 'pitchClass', label: t('coloring.randomBys.pitchClass') },
            ]}
            onChange={(v) => atomicUpdate({ noteRandomBy: v })}
            defaultValue={def.noteRandomBy}
            scopeKey="noteRandomBy"
          />
          <BoundSliderRow label={t('coloring.seed')} settingKey="noteRandomSeed" min={0} max={99} step={1} />
          <BoundCountRow label={t('coloring.paletteSize')} settingKey="noteRandomCount" min={1} max={5} />
          {RANDOM_COLOR_KEYS.slice(0, count).map((k, i) => (
            <BoundColorRow key={k} label={t('coloring.paletteColor', { n: i + 1 })} settingKey={k} />
          ))}
        </SubGroup>
      )}
    </>
  )
}

// ── Pitch labels (notes / keys): naming selects ──────────────────────
function PitchLabelRows({ target }: { target: 'note' | 'key' }) {
  const { t } = useTranslation('inspector')
  const formatKey = target === 'note' ? 'noteLabelFormat' : 'keyLabelFormat'
  const accidentalKey = target === 'note' ? 'noteLabelAccidental' : 'keyLabelAccidental'
  const format = useStore((st) => st.settings[formatKey])
  const accidental = useStore((st) => st.settings[accidentalKey])
  return (
    <>
      <SelectRow
        label={t('labels.format')}
        value={format}
        options={[
          { value: 'letter', label: t('labels.formats.letter') },
          { value: 'letterOctave', label: t('labels.formats.letterOctave') },
        ]}
        onChange={(v) => atomicUpdate({ [formatKey]: v })}
        defaultValue={def[formatKey]}
        scopeKey={formatKey}
      />
      <SelectRow
        label={t('labels.accidental')}
        value={accidental}
        options={[
          { value: 'sharp', label: t('labels.accidentals.sharp') },
          { value: 'flat', label: t('labels.accidentals.flat') },
        ]}
        onChange={(v) => atomicUpdate({ [accidentalKey]: v })}
        defaultValue={def[accidentalKey]}
        scopeKey={accidentalKey}
      />
    </>
  )
}

/** What note labels show: pitch, finger number (set in the selection card), or both. */
function NoteLabelContentRow() {
  const { t } = useTranslation('inspector')
  const content = useStore((st) => st.settings.noteLabelContent)
  return (
    <SelectRow
      label={t('labels.show')}
      value={content}
      options={[
        { value: 'pitch', label: t('labels.shows.pitch') },
        { value: 'finger', label: t('labels.shows.finger') },
        { value: 'both', label: t('labels.shows.both') },
      ]}
      onChange={(v) => atomicUpdate({ noteLabelContent: v })}
      defaultValue={def.noteLabelContent}
      scopeKey="noteLabelContent"
    />
  )
}

function NoteLabelPositionRow() {
  const { t } = useTranslation('inspector')
  const position = useStore((st) => st.settings.noteLabelPosition)
  return (
    <SelectRow
      label={t('labels.position')}
      value={position}
      options={[
        { value: 'keyboard', label: t('labels.positions.keyboard') },
        { value: 'center', label: t('labels.positions.center') },
        { value: 'far', label: t('labels.positions.far') },
      ]}
      onChange={(v) => atomicUpdate({ noteLabelPosition: v })}
      defaultValue={def.noteLabelPosition}
      scopeKey="noteLabelPosition"
    />
  )
}

function KeyLabelsModeRow() {
  const { t } = useTranslation('inspector')
  const mode = useStore((st) => st.settings.keyLabelsMode)
  return (
    <SelectRow
      label={t('labels.keys')}
      value={mode}
      options={[
        { value: 'c', label: t('labels.keyModes.c') },
        { value: 'white', label: t('labels.keyModes.white') },
        { value: 'all', label: t('labels.keyModes.all') },
      ]}
      onChange={(v) => atomicUpdate({ keyLabelsMode: v })}
      defaultValue={def.keyLabelsMode}
      scopeKey="keyLabelsMode"
    />
  )
}

// ── Notes: texture subsection (depends on noteTexture preset) ────────
function TextureControls() {
  const { t } = useTranslation('inspector')
  // Older projects may still carry the removed 'liquid' / 'gem' values.
  const noteTexture = useStore((st) => (st.settings.noteTexture === 'custom' ? 'custom' : 'solid'))
  const customFileName = useCustomTexture((st) => st.fileName)
  const customBytes = useCustomTexture((st) => st.fileBytes)
  const customMime = useCustomTexture((st) => st.fileMime)
  const setCustomFile = useCustomTexture((st) => st.setFromFile)
  return (
    <>
      <SelectRow
        label={t('texture.texture')}
        value={noteTexture}
        options={[
          { value: 'solid', label: t('texture.solid') },
          { value: 'custom', label: t('texture.customImage') },
        ]}
        onChange={(v) => atomicUpdate({ noteTexture: v })}
        defaultValue={def.noteTexture}
      />
      <SubGroup label={t('texture.texture')}>
        {noteTexture === 'custom' && (
          <ImagePicker
            label={t('texture.customImage')}
            fileName={customFileName}
            bytes={customBytes}
            mime={customMime}
            accept={['image/*']}
            onPick={(file) => setCustomFile(file)}
            onClear={() => void setCustomFile(null)}
          />
        )}
        {noteTexture === 'custom' && (
          <>
            <BoundSliderRow label={t('texture.scale')} settingKey="noteTextureScale" min={0.01} max={4} step={0.01} />
            <BoundSliderRow label={t('texture.offsetX')} settingKey="noteTextureOffsetX" min={-3} max={3} step={0.01} />
            <BoundSliderRow label={t('texture.offsetY')} settingKey="noteTextureOffsetY" min={-3} max={3} step={0.01} />
            <BoundSliderRow label={t('texture.animationSpeedX')} settingKey="noteAnimSpeedX" min={-3} max={3} step={0.05} />
            <BoundSliderRow label={t('texture.animationSpeedY')} settingKey="noteAnimSpeedY" min={-3} max={3} step={0.05} />
            <BoundSliderRow label={t('texture.blur')} settingKey="noteTextureBlur" min={0} max={6} step={0.05} />
            <BoundSliderRow label={t('texture.perNoteVariation')} settingKey="noteTextureVariation" min={0} max={1} step={0.01} />
            <BoundSliderRow label={t('texture.contrast')} settingKey="noteTextureContrast" min={0.3} max={20} step={0.1} />
          </>
        )}
      </SubGroup>

    </>
  )
}

// ── Note look: the 2D (sprite) material ─────────────────────────────
function Sprite2dControls() {
  const { t } = useTranslation('inspector')
  const outline = useStore((st) => st.settings.note2dOutline)
  const texture = useStore((st) => st.settings.note2dTexture)
  return (
    <>
      <SubGroup heading label={t('look.lighting')}>
        <BoundSliderRow label={t('look.intensity')} settingKey="noteLightIntensity" min={0} max={2} step={0.01} />
        <BoundSliderRow label={t('look.ambient')} settingKey="noteAmbient" min={0} max={1} step={0.01} />
        <BoundSliderRow label={t('look.azimuth')} settingKey="noteLightAzimuth" min={-180} max={180} step={1} />
        <BoundSliderRow label={t('look.elevation')} settingKey="noteLightElevation" min={0} max={90} step={1} />
        <BoundSliderRow label={t('look.fill')} settingKey="noteFillIntensity" min={0} max={1} step={0.01} />
        <BoundSliderRow label={t('look.fillAzimuth')} settingKey="note2dFillAzimuth" min={-180} max={180} step={1} />
        <BoundSliderRow label={t('look.fillElevation')} settingKey="note2dFillElevation" min={0} max={90} step={1} />
      </SubGroup>
      <SubGroup heading label={t('look.body2d')}>
        <BoundSliderRow label={t('look.rimWidth')} settingKey="note2dRimWidth" min={0} max={0.15} step={0.001} />
        <BoundSliderRow label={t('look.rimTilt')} settingKey="note2dRimTilt" min={0} max={89} step={1} />
        <BoundSliderRow label={t('look.hollow')} settingKey="note2dHollow" min={0} max={0.1} step={0.001} />
        <BoundSliderRow label={t('look.gloss')} settingKey="note2dGloss" min={0} max={1} step={0.01} />
        <BoundSliderRow label={t('look.glossPower')} settingKey="note2dGlossPower" min={1} max={128} step={1} />
        <BoundSliderRow label={t('look.exposure')} settingKey="note2dExposure" min={0.5} max={3} step={0.01} />
        <BoundSliderRow label={t('look.whiten')} settingKey="note2dWhiten" min={0} max={2} step={0.01} />
        <BoundSliderRow label={t('look.whitenStart')} settingKey="note2dWhitenStart" min={0} max={1.5} step={0.01} />
        <BoundSliderRow label={t('look.keySplit')} settingKey="note2dKeySplit" min={0} max={0.3} step={0.005} />
      </SubGroup>
      <SubGroup heading label={t('look.glow')}>
        <BoundSliderRow label={t('look.amount')} settingKey="note2dGlow" min={0} max={2} step={0.01} />
        <BoundSliderRow label={t('look.glowRadius')} settingKey="note2dGlowRadius" min={0.005} max={0.15} step={0.001} />
        <BoundSliderRow label={t('look.glowTail')} settingKey="note2dGlowTail" min={0} max={1} step={0.01} />
        <BoundSliderRow label={t('look.whiten')} settingKey="note2dGlowWhiten" min={0} max={1} step={0.01} />
        <BoundSliderRow label={t('look.glowBoost')} settingKey="note2dGlowBoost" min={0} max={3} step={0.01} />
      </SubGroup>
      <SubGroup heading label={t('look.outline')}>
        <SelectRow
          label={t('look.outlineMode')}
          value={outline}
          options={[
            { value: 'off', label: t('look.outlineModes.off') },
            { value: 'whole', label: t('look.outlineModes.whole') },
            { value: 'half', label: t('look.outlineModes.half') },
          ]}
          onChange={(v) => atomicUpdate({ note2dOutline: v })}
          defaultValue={def.note2dOutline}
          scopeKey="note2dOutline"
        />
        {outline !== 'off' && (
          <>
            <BoundSliderRow label={t('look.width')} settingKey="note2dOutlineWidth" min={0} max={0.08} step={0.001} />
            <BoundSliderRow label={t('look.outlineTint')} settingKey="note2dOutlineTint" min={0} max={1} step={0.01} />
            <BoundSliderRow label={t('look.outlineShade')} settingKey="note2dOutlineShade" min={0} max={2} step={0.01} />
            <BoundSliderRow label={t('look.outlineGrey')} settingKey="note2dOutlineGrey" min={0} max={1} step={0.01} />
            <BoundSliderRow label={t('look.brightness')} settingKey="note2dOutlineBrightness" min={0} max={2} step={0.01} />
            <BoundSliderRow label={t('look.relief')} settingKey="note2dOutlineRelief" min={0} max={1} step={0.01} />
          </>
        )}
      </SubGroup>
      <SubGroup heading label={t('look.shimmer')}>
        <BoundSliderRow label={t('look.amount')} settingKey="note2dShimmer" min={0} max={1} step={0.01} />
        <BoundSliderRow label={t('look.gain')} settingKey="note2dShimmerGain" min={0} max={2} step={0.01} />
        <BoundSliderRow label={t('look.scale')} settingKey="note2dShimmerScale" min={0.05} max={2} step={0.01} />
        <BoundSliderRow label={t('look.speed')} settingKey="note2dShimmerSpeed" min={0} max={3} step={0.01} />
        <BoundSliderRow label={t('look.lockToNote')} settingKey="note2dShimmerLock" min={0} max={1} step={0.01} />
      </SubGroup>
      <SubGroup heading label={t('look.emboss')}>
        <BoundSwitchRow label={t('row.enabled')} settingKey="note2dTexture" />
        {texture && (
          <>
            <BoundSliderRow label={t('look.scale')} settingKey="note2dTextureScale" min={0.05} max={2} step={0.01} />
            <BoundSliderRow label={t('look.stretch')} settingKey="note2dTextureStretch" min={0.2} max={8} step={0.05} />
            <BoundSliderRow label={t('look.contrast')} settingKey="note2dTextureContrast" min={0} max={1} step={0.01} />
            <BoundSliderRow label={t('look.gain')} settingKey="note2dTextureGain" min={0} max={2} step={0.01} />
            <BoundSliderRow label={t('look.relief')} settingKey="note2dTextureRelief" min={0} max={2} step={0.01} />
            <BoundSliderRow label={t('look.speed')} settingKey="note2dTextureSpeed" min={0} max={1} step={0.01} />
            <BoundSliderRow label={t('look.lockToNote')} settingKey="note2dTextureLock" min={0} max={1} step={0.01} />
          </>
        )}
      </SubGroup>
    </>
  )
}

// ── Note look: preset + material + reflective parameters ────────────
function NoteLookControls() {
  const { t } = useTranslation('inspector')
  // The preset the effective look matches (the targeted pin's snapshot
  // over base, like every Bound* row), or 'custom' once edited.
  const preset = useStore((st) => {
    const time = st.editingKeyframeTime
    const kf =
      time === null ? undefined : st.settings.settingsKeyframes.find((p) => Math.abs(p.time - time) < 1e-6)
    return matchNoteLookPreset({ ...st.settings, ...kf?.settings }) ?? 'custom'
  })
  const lookSettings = useEffectiveLook()
  const barColors = useBarColors()
  const material = useStore((st) => st.settings.noteMaterial)
  const shape = useStore((st) => st.settings.noteShape)
  const pattern = useStore((st) => st.settings.notePattern)
  const surface = useStore((st) => st.settings.noteSurface)
  const bump = useStore((st) => st.settings.noteBump)
  return (
    <>
      <SearchableBlock label={t('look.preset')}>
        <PresetSwatch
          label={t('look.preset')}
          value={preset}
          look={lookSettings}
          colors={barColors}
          onChange={(v) => atomicUpdate(NOTE_LOOK_PRESETS[v])}
        />
      </SearchableBlock>
      <SelectRow
        label={t('look.material')}
        value={material}
        options={[
          { value: 'flat', label: t('look.flat') },
          { value: 'reflective', label: t('look.reflective') },
          { value: 'realistic', label: t('look.realistic') },
          { value: 'sprite', label: t('look.sprite') },
        ]}
        onChange={(v) => atomicUpdate({ noteMaterial: v, ...lightsForMaterialSwitch(material, v) })}
        defaultValue={def.noteMaterial}
        scopeKey="noteMaterial"
      />
      {material !== 'sprite' && (
        <SelectRow
          label={t('look.shape')}
          value={shape}
          options={[
            { value: 'round', label: t('look.shapes.round') },
            { value: 'gem', label: t('look.shapes.gem') },
            { value: 'angled', label: t('look.shapes.angled') },
          ]}
          onChange={(v) => atomicUpdate({ noteShape: v })}
          defaultValue={def.noteShape}
          scopeKey="noteShape"
        />
      )}
      <BoundSliderRow label={t('row.cornerRadius')} settingKey="noteCornerRadius" min={0} max={0.3} step={0.005} />
      {/* The flat material's emissive + legacy edge; the other materials
          draw their own outline / rim band (Detail). */}
      {material === 'flat' && (
        <BoundSliderRow label={t('row.emissive')} settingKey="noteEmissive" min={0} max={20} step={0.1} />
      )}
      {/* everything past the everyday rows: the material's own groups */}
      <Detail id="look">
      {material === 'flat' && (
        <SubGroup heading label={t('section.edge')}>
          <BoundSwitchRow label={t('row.enabled')} settingKey="edgeEnabled" />
          <BoundColorRow label={t('row.edgeColor')} settingKey="noteEdgeColor" />
          <BoundSliderRow label={t('row.edgeWidth')} settingKey="noteEdgeWidth" min={0} max={0.1} step={0.001} />
          <BoundSliderRow label={t('row.edgeIntensity')} settingKey="noteEdgeIntensity" min={0} max={5} step={0.05} />
        </SubGroup>
      )}
      {material === 'sprite' && <Sprite2dControls />}
      {(material === 'reflective' || material === 'realistic') && (
        <>
          <SubGroup heading label={t('look.lighting')}>
            <BoundSliderRow label={t('look.intensity')} settingKey="noteLightIntensity" min={0} max={2} step={0.01} />
            <BoundSliderRow label={t('look.ambient')} settingKey="noteAmbient" min={0} max={1} step={0.01} />
            <BoundSliderRow label={t('look.azimuth')} settingKey="noteLightAzimuth" min={-180} max={180} step={1} />
            <BoundSliderRow label={t('look.elevation')} settingKey="noteLightElevation" min={0} max={90} step={1} />
            <BoundSliderRow label={t('look.fill')} settingKey="noteFillIntensity" min={0} max={1} step={0.01} />
          </SubGroup>
          <SubGroup heading label={t('look.surface')}>
            <BoundSliderRow label={t('look.reflectivity')} settingKey="noteReflectivity" min={0} max={2} step={0.01} />
            <BoundSliderRow label={t('look.transparency')} settingKey="noteTransparency" min={0} max={1} step={0.01} />
            <BoundSliderRow label={t('look.saturation')} settingKey="noteSaturation" min={0} max={2} step={0.01} />
            <BoundSliderRow label={t('look.sheen')} settingKey="noteSheen" min={0} max={1} step={0.01} />
          </SubGroup>
          {material === 'realistic' && (
            <SubGroup heading label={t('look.surfaceMaps')}>
              <SelectRow
                label={t('look.surfaceSet')}
                value={surface}
                options={[
                  { value: 'scales', label: t('look.surfaces.scales') },
                  { value: 'volcanic', label: t('look.surfaces.volcanic') },
                ]}
                onChange={(v) => atomicUpdate({ noteSurface: v })}
                defaultValue={def.noteSurface}
                scopeKey="noteSurface"
              />
              <BoundSliderRow label={t('look.albedoGain')} settingKey="noteAlbedoGain" min={0} max={5} step={0.05} />
              <BoundSliderRow label={t('look.specular')} settingKey="noteSpecular" min={0} max={2} step={0.01} />
              <BoundSliderRow label={t('look.emission')} settingKey="noteEmission" min={0} max={1} step={0.01} />
              <BoundSliderRow label={t('look.contrast')} settingKey="noteSurfaceContrast" min={0} max={4} step={0.05} />
              <BoundSliderRow label={t('look.cells')} settingKey="noteSurfaceCells" min={0} max={24} step={1} />
              <BoundSliderRow label={t('look.irregularity')} settingKey="noteSurfaceIrregularity" min={0} max={1} step={0.05} />
            </SubGroup>
          )}
          <SubGroup heading label={t('look.pattern')}>
            <SelectRow
              label={t('look.patternSource')}
              value={pattern}
              options={[
                { value: 'water', label: t('look.patterns.water') },
                { value: 'crystal', label: t('look.patterns.crystal') },
                { value: 'lights', label: t('look.patterns.lights') },
              ]}
              onChange={(v) => atomicUpdate({ notePattern: v })}
              defaultValue={def.notePattern}
              scopeKey="notePattern"
            />
            <BoundSliderRow label={t('look.amount')} settingKey="notePatternAmount" min={0} max={1} step={0.01} />
            <BoundSliderRow label={t('look.brightness')} settingKey="notePatternBrightness" min={-1} max={1} step={0.01} />
            <BoundSliderRow label={t('look.contrast')} settingKey="notePatternContrast" min={0} max={4} step={0.05} />
            <BoundSliderRow label={t('look.scale')} settingKey="notePatternScale" min={0.5} max={20} step={0.05} />
            <BoundSliderRow label={t('look.density')} settingKey="notePatternDensity" min={0.1} max={2} step={0.01} />
            <BoundSliderRow label={t('look.speed')} settingKey="notePatternSpeed" min={0} max={3} step={0.01} />
            <BoundSliderRow label={t('look.sharpness')} settingKey="notePatternSharpness" min={0} max={4} step={0.05} />
            <BoundSliderRow label={t('look.distortion')} settingKey="notePatternDistortion" min={0} max={1} step={0.01} />
            <BoundSliderRow label={t('look.lockToNote')} settingKey="notePatternLock" min={0} max={1} step={0.01} />
            <BoundSliderRow label={t('look.knee')} settingKey="notePatternKnee" min={0} max={2} step={0.01} />
            <BoundSliderRow label={t('look.kneeSoftness')} settingKey="notePatternKneeSoftness" min={0} max={1} step={0.01} />
            <BoundSliderRow label={t('look.ribbon')} settingKey="notePatternRibbon" min={0} max={1} step={0.01} />
            <BoundSliderRow label={t('look.drift')} settingKey="notePatternDrift" min={-1} max={1} step={0.01} />
          </SubGroup>
          <SubGroup heading label={t('look.bevel')}>
            <BoundSliderRow label={t('look.width')} settingKey="noteBevelWidth" min={0} max={0.15} step={0.001} />
            <BoundSliderRow label={t('look.depth')} settingKey="noteBevelDepth" min={0} max={4} step={0.05} />
            <BoundSliderRow label={t('look.profile')} settingKey="noteBevelProfile" min={0} max={1} step={0.01} />
            <BoundSliderRow label={t('look.softness')} settingKey="noteBevelSoftness" min={0} max={1} step={0.01} />
            <BoundSliderRow label={t('look.reflect')} settingKey="noteBevelReflect" min={0} max={1} step={0.01} />
            <BoundSliderRow label={t('look.rimShade')} settingKey="noteRimShade" min={-1} max={1} step={0.01} />
            <BoundSliderRow label={t('look.rimFade')} settingKey="noteRimFade" min={0} max={1} step={0.01} />
          </SubGroup>
          <SubGroup heading label={t('look.bump')}>
            {material !== 'realistic' && (
              <SelectRow
                label={t('look.bumpType')}
                value={bump}
                options={[
                  { value: 'none', label: t('look.bumps.none') },
                  { value: 'hammered', label: t('look.bumps.hammered') },
                  { value: 'cast', label: t('look.bumps.cast') },
                  { value: 'crystal', label: t('look.bumps.crystal') },
                ]}
                onChange={(v) => atomicUpdate({ noteBump: v })}
                defaultValue={def.noteBump}
                scopeKey="noteBump"
              />
            )}
            {(material === 'realistic' || bump !== 'none') && (
              <>
                <BoundSliderRow label={t('look.scale')} settingKey="noteBumpScale" min={0.3} max={10} step={0.05} />
                <BoundSliderRow label={t('look.depth')} settingKey="noteBumpDepth" min={0} max={3} step={0.05} />
                <BoundSliderRow label={t('look.softness')} settingKey="noteBumpSoftness" min={0} max={1} step={0.01} />
                <BoundSliderRow label={t('look.melt')} settingKey="noteBumpMelt" min={0} max={1} step={0.01} />
                <BoundSwitchRow label={t('look.scatter')} settingKey="noteBumpScatter" />
                <BoundSliderRow label={t('look.facetEdges')} settingKey="noteFacetEdges" min={0} max={10} step={0.1} />
              </>
            )}
          </SubGroup>
          <SubGroup heading label={t('look.outline')}>
            <BoundSliderRow label={t('look.width')} settingKey="noteOutlineWidth" min={0} max={0.05} step={0.001} />
            <BoundSliderRow label={t('look.brightness')} settingKey="noteOutlineBrightness" min={0} max={2} step={0.01} />
            <BoundColorRow label={t('look.color')} settingKey="noteOutlineColor" />
            <BoundSliderRow label={t('look.blend')} settingKey="noteOutlineBlend" min={0} max={1} step={0.01} />
            <BoundSliderRow label={t('look.reflect')} settingKey="noteOutlineReflect" min={0} max={2} step={0.01} />
          </SubGroup>
          <SubGroup heading label={t('look.rimBand')}>
            <BoundSliderRow label={t('look.width')} settingKey="noteRimBand" min={0} max={0.03} step={0.0005} />
            <BoundSliderRow label={t('look.brightness')} settingKey="noteRimBandBrightness" min={0} max={2} step={0.01} />
            <BoundColorRow label={t('look.color')} settingKey="noteRimBandColor" />
            <BoundSliderRow label={t('look.blend')} settingKey="noteRimBandBlend" min={0} max={1} step={0.01} />
            <BoundSliderRow label={t('look.gap')} settingKey="noteRimGap" min={0} max={0.03} step={0.0005} />
            <BoundSliderRow label={t('look.gapDark')} settingKey="noteRimGapDark" min={0} max={1} step={0.01} />
          </SubGroup>

          <SubGroup heading label={t('look.highlight')}>
            <BoundSliderRow label={t('look.amount')} settingKey="noteHighlight" min={0} max={2} step={0.01} />
            <BoundSliderRow label={t('look.threshold')} settingKey="noteHighlightThreshold" min={0} max={1.5} step={0.005} />
            <BoundSliderRow label={t('look.softness')} settingKey="noteHighlightSoftness" min={0.02} max={1.5} step={0.01} />
          </SubGroup>
          <SubGroup heading label={t('look.cloud')}>
            <BoundSliderRow label={t('look.amount')} settingKey="noteCloud" min={0} max={2} step={0.01} />
            <BoundSliderRow label={t('look.scale')} settingKey="noteCloudScale" min={0.05} max={2} step={0.01} />
            <BoundSliderRow label={t('look.softness')} settingKey="noteCloudSoftness" min={0} max={1} step={0.01} />
            <BoundSliderRow label={t('look.clear')} settingKey="noteCloudClear" min={0} max={1} step={0.01} />
          </SubGroup>
          <SubGroup heading label={t('look.frost')}>
            <BoundSliderRow label={t('look.amount')} settingKey="noteFrost" min={0} max={1} step={0.01} />
            <BoundSliderRow label={t('look.grain')} settingKey="noteFrostGrain" min={0} max={1} step={0.01} />
            <BoundSliderRow label={t('look.grainSize')} settingKey="noteFrostScale" min={0.001} max={0.05} step={0.001} />
            <BoundSliderRow label={t('look.veil')} settingKey="noteFrostVeil" min={0} max={1} step={0.01} />
          </SubGroup>
          <SubGroup heading label={t('look.silk')}>
            <BoundSliderRow label={t('look.amount')} settingKey="noteSilk" min={0} max={1} step={0.01} />
            <BoundSliderRow label={t('look.scale')} settingKey="noteSilkScale" min={0.2} max={5} step={0.05} />
            <BoundSliderRow label={t('look.speed')} settingKey="noteSilkSpeed" min={0} max={3} step={0.01} />
          </SubGroup>
        </>
      )}
      {shape === 'round' && material !== 'sprite' && (
        <SubGroup heading label={t('look.merge')}>
          <BoundSliderRow label={t('look.mergeRadius')} settingKey="noteMergeRadius" min={0} max={0.1} step={0.001} />
          <BoundSliderRow label={t('look.mergeColorSpread')} settingKey="noteMergeColorSpread" min={0} max={3} step={0.01} />
          <BoundSwitchRow label={t('look.mergeSameKey')} settingKey="noteMergeSameKey" />
          <BoundSliderRow label={t('look.mergeLegatoClose')} settingKey="noteMergeLegatoClose" min={0} max={1} step={0.01} />
          <BoundSliderRow label={t('look.mergeCrease')} settingKey="noteMergeCrease" min={0} max={2} step={0.01} />
        </SubGroup>
      )}
      </Detail>
    </>
  )
}

// ── Scene: project-level background image ───────────────────────────
function BackgroundImageControls() {
  const { t } = useTranslation('inspector')
  const fileName = useStageBackground((state) => state.fileName)
  const bgBytes = useStageBackground((state) => state.fileBytes)
  const bgMime = useStageBackground((state) => state.fileMime)
  const setBackgroundFile = useStageBackground((state) => state.setFromFile)
  const fit = useStore((state) => state.settings.backgroundImageFit)

  const chooseImage = async (file: File) => {
    try {
      await setBackgroundFile(file)
    } catch (error) {
      await showAlert({
        title: t('backgroundImage.loadErrorTitle'),
        message: t('backgroundImage.loadErrorMessage', {
          name: file.name,
          detail: error instanceof Error ? error.message : String(error),
        }),
        tone: 'error',
      })
    }
  }

  return (
    <>
      <SubGroup heading label={t('backgroundImage.title')}>
        <SearchableBlock label={`${t('backgroundImage.title')} ${t('backgroundImage.chooseImage')}`}>
          <ImagePicker
            label={t('backgroundImage.title')}
            fileName={fileName}
            bytes={bgBytes}
            mime={bgMime}
            accept={STAGE_BACKGROUND_ACCEPTED_TYPES}
            onPick={chooseImage}
            onClear={() => void setBackgroundFile(null)}
          />
        </SearchableBlock>
        {fileName && (
          <>
            <SelectRow
              label={t('backgroundImage.fit')}
              value={fit}
              options={[
                { value: 'cover', label: t('backgroundImage.cover') },
                { value: 'contain', label: t('backgroundImage.contain') },
                { value: 'stretch', label: t('backgroundImage.stretch') },
              ]}
              onChange={(value) => atomicUpdate({ backgroundImageFit: value })}
              defaultValue={def.backgroundImageFit}
            />
            {/* Framing, mirroring the custom note texture's scale +
                offset pair so both image sources are adjusted the same
                way. Ranges match `noteTextureScale` / `noteTextureOffset*`. */}
            <BoundSliderRow
              label={t('backgroundImage.scale')}
              settingKey="backgroundImageScale"
              min={0.1}
              max={4}
              step={0.01}
            />
            <BoundSliderRow
              label={t('backgroundImage.rotation')}
              settingKey="backgroundImageRotation"
              min={-180}
              max={180}
              step={1}
              format={(v) => `${Math.round(v)}°`}
            />
            <BoundSliderRow
              label={t('backgroundImage.offsetX')}
              settingKey="backgroundImageOffsetX"
              min={-1}
              max={1}
              step={0.01}
            />
            <BoundSliderRow
              label={t('backgroundImage.offsetY')}
              settingKey="backgroundImageOffsetY"
              min={-1}
              max={1}
              step={0.01}
            />
            <BoundSliderRow
              label={t('backgroundImage.opacity')}
              settingKey="backgroundImageOpacity"
              min={0}
              max={1}
              step={0.01}
            />
          </>
        )}
      </SubGroup>
    </>
  )
}

// ── Effects: "Colour" = follow the notes | solid (one pattern for flash,
// particles and key glow; the hit line adds its own gradient) ──────────
function FollowColorRows({
  followKey,
  colorKey,
}: {
  followKey: 'flashFollowNote' | 'particleColorFollowNote' | 'keyGlowFollowNote'
  colorKey: 'flashColor' | 'particleColor' | 'keyGlowColor'
}) {
  const { t } = useTranslation('inspector')
  const follow = useStore((st) => st.settings[followKey])
  return (
    <>
      <SelectRow
        label={t('coloring.color')}
        value={follow ? 'note' : 'solid'}
        options={[
          { value: 'note', label: t('coloring.modes.note') },
          { value: 'solid', label: t('coloring.modes.solid') },
        ]}
        onChange={(v) => atomicUpdate({ [followKey]: v === 'note' })}
        defaultValue={def[followKey] ? 'note' : 'solid'}
        scopeKey={followKey}
      />
      {!follow && (
        <SubGroup label={t('coloring.color')}>
          <BoundColorRow label={t('coloring.solidColor')} settingKey={colorKey} />
        </SubGroup>
      )}
    </>
  )
}

// ── Hit line: colouring (solid / own gradient / follow the notes) ──────
function HitLineColorControls() {
  const { t } = useTranslation('inspector')
  const mode = useStore((st) => st.settings.hitLineColorMode)
  const stops = useStore((st) => Math.round(st.settings.hitLineGradientStops))
  // random / by-hand note colours have no single colour to follow: the line keeps its own
  const ownColor = useStore(
    (st) =>
      st.settings.hitLineColorMode === 'solid' ||
      (st.settings.hitLineColorMode === 'note' && (st.settings.noteColorMode === 'random' || st.settings.noteColorMode === 'hand')),
  )
  return (
    <>
      <SelectRow
        label={t('coloring.color')}
        value={mode}
        options={[
          { value: 'note', label: t('coloring.modes.note') },
          { value: 'solid', label: t('coloring.modes.solid') },
          { value: 'gradient', label: t('coloring.modes.gradient') },
        ]}
        onChange={(v) => atomicUpdate({ hitLineColorMode: v })}
        defaultValue={def.hitLineColorMode}
        scopeKey="hitLineColorMode"
      />
      {mode === 'note' && ownColor && (
        <p className="text-caption text-ink-faint">{t('coloring.randomNotesHint')}</p>
      )}
      {ownColor && (
        <SubGroup label={t('coloring.color')}>
          <BoundColorRow label={t('coloring.solidColor')} settingKey="hitLineColor" />
        </SubGroup>
      )}
      {mode === 'gradient' && (
        <SubGroup label={t('coloring.modes.gradient')}>
          <BoundCountRow label={t('coloring.stops')} settingKey="hitLineGradientStops" min={2} max={5} />
          <BoundSliderRow label={t('coloring.softness')} settingKey="hitLineGradientSoftness" min={0} max={1} step={0.01} />
          <GradientStops
            label={t('coloring.modes.gradient')}
            colorKeys={HIT_LINE_GRADIENT_COLOR_KEYS}
            posKeys={HIT_LINE_GRADIENT_POS_KEYS}
            count={stops}
            countKey="hitLineGradientStops"
            softnessKey="hitLineGradientSoftness"
          />
          <GradientStopRows
            colorKeys={HIT_LINE_GRADIENT_COLOR_KEYS}
            posKeys={HIT_LINE_GRADIENT_POS_KEYS}
            countKey="hitLineGradientStops"
            count={stops}
          />
        </SubGroup>
      )}
    </>
  )
}

/**
 * One colour row per active stop (positions are set by dragging the stops on the gradient bar). Above two
 * stops each row can remove its stop, the first one included; the later stops move up.
 */
function GradientStopRows({
  colorKeys,
  posKeys,
  countKey,
  count,
}: {
  colorKeys: readonly (typeof GRADIENT_COLOR_KEYS | typeof HIT_LINE_GRADIENT_COLOR_KEYS)[number][]
  posKeys: readonly (typeof GRADIENT_POS_KEYS | typeof HIT_LINE_GRADIENT_POS_KEYS)[number][]
  countKey: 'noteGradientStops' | 'hitLineGradientStops'
  count: number
}) {
  const { t } = useTranslation('inspector')
  return (
    <>
      {colorKeys.slice(0, count).map((k, i) => (
        <BoundColorRow
          key={k}
          label={t('coloring.stopColor', { n: i + 1 })}
          settingKey={k}
          onRemove={count > 2 ? () => removeGradientStop(colorKeys, posKeys, countKey, i) : undefined}
        />
      ))}
    </>
  )
}

// ── Audio: EQ band row ───────────────────────────────────────────────
function EqRow() {
  const { t } = useTranslation('inspector')
  const eqBands = useStore((st) => st.settings.eqBands)
  return (
    <SearchableBlock label={t('eq.block')}>
      <div className="select-none text-ink-muted">{t('eq.label')}</div>
      <VerticalSliderBands
        values={eqBands}
        labels={EQ_LABELS}
        min={-12}
        max={12}
        step={0.5}
        onChange={(i, v) => {
          const next = eqBands.slice()
          next[i] = v
          atomicUpdate({ eqBands: next })
        }}
        defaultValues={def.eqBands}
      />
    </SearchableBlock>
  )
}

// ── Notes: fall direction select ─────────────────────────────────────
function FallDirectionRow() {
  const { t } = useTranslation('inspector')
  const fallDirection = useStore((st) => st.settings.fallDirection)
  return (
    <SelectRow
      label={t('row.direction')}
      value={fallDirection}
      options={[
        { value: 'down', label: t('direction.topToBottom') },
        { value: 'up', label: t('direction.bottomToTop') },
      ]}
      onChange={(v) => atomicUpdate({ fallDirection: v })}
      defaultValue={def.fallDirection}
      scopeKey="fallDirection"
    />
  )
}

// ── Particles: blending select ───────────────────────────────────────
function ParticleBlendingRow() {
  const { t } = useTranslation('inspector')
  const blending = useStore((st) => st.settings.particleBlending)
  return (
    <SelectRow
      label={t('row.particleBlending')}
      value={blending}
      options={[
        { value: 'alpha', label: t('particleBlending.alpha') },
        { value: 'additive', label: t('particleBlending.additive') },
      ]}
      onChange={(v) => atomicUpdate({ particleBlending: v })}
      defaultValue={def.particleBlending}
      scopeKey="particleBlending"
    />
  )
}

// ── Audio: pre-delay needs unit conversion (s ↔ ms) ──────────────────
function PreDelayRow() {
  const { t } = useTranslation('inspector')
  const reverbPreDelay = useStore((st) => st.settings.reverbPreDelay)
  return (
    <SliderRow
      label={t('row.preDelay')}
      value={reverbPreDelay * 1000}
      min={0}
      max={200}
      step={1}
      onChange={(v) => atomicUpdate({ reverbPreDelay: v / 1000 })}
      defaultValue={def.reverbPreDelay * 1000}
    />
  )
}

// ── Keyframes header ─────────────────────────────────────────────────
//
// Shown ONLY while the playhead sits on a keyframe (`editingKeyframeTime`, kept by `PinTargetSync`: the nearest
// keyframe at or before the head). Names it, steps to its neighbours and shows all keyframes across the song.

const fmtClock = (sec: number) => {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Select a keyframe and move the playhead to it (the same two calls as a click on the timeline's keyframe lane). */
function goToKeyframe(time: number): void {
  const t = Math.max(0, time)
  useStore.getState().selectKeyframe(time)
  audioEngine.seek(t)
  useStore.getState().setCurrentTime(t)
}

function KeyframesHeader() {
  const { t } = useTranslation('inspector')
  const keyframes = useStore((st) => st.settings.settingsKeyframes)
  const editing = useStore((st) => st.editingKeyframeTime)
  const songDuration = useStore((st) => st.song?.duration ?? 0)
  const currentTime = useStore((st) => st.currentTime)
  if (editing === null) return null
  const idx = keyframes.findIndex((p) => Math.abs(p.time - editing) < 1e-6)
  if (idx < 0) return null
  const last = keyframes[keyframes.length - 1].time
  const span = Math.max(songDuration, last, currentTime, 1)
  const pct = (sec: number) => `${Math.min(100, Math.max(0, (sec / span) * 100))}%`
  const prev = keyframes[idx - 1]
  const next = keyframes[idx + 1]
  return (
    <div className="grid gap-2 border-b border-glass-edge py-2.5 pl-4 pr-3">
      <div className="flex items-center gap-1.5">
        <Icon.KeyframeIcon className="h-3.5 w-3.5 flex-none" />
        <span className="text-heading">{t('keyframes.title', { time: fmtClock(keyframes[idx].time) })}</span>
        <span className="ml-auto flex flex-none items-center">
          <IconButton size="sm" label={t('keyframes.prev')} isDisabled={!prev} onPress={() => prev && goToKeyframe(prev.time)}>
            <Icon.ChevronLeftIcon />
          </IconButton>
          <IconButton size="sm" label={t('keyframes.next')} isDisabled={!next} onPress={() => next && goToKeyframe(next.time)}>
            <Icon.ChevronRightIcon />
          </IconButton>
        </span>
      </div>
      <div role="group" aria-label={t('keyframes.strip')} className="px-1.5">
        <div className="relative h-4">
          <div aria-hidden className="absolute inset-x-0 top-[7px] h-0.5 rounded-[1px] bg-fill-track" />
          {keyframes.map((k, i) => (
            <button
              key={k.time}
              type="button"
              aria-label={fmtClock(k.time)}
              aria-current={i === idx || undefined}
              onClick={() => goToKeyframe(k.time)}
              className="nf-focus absolute top-0 -ml-2 grid h-4 w-4 cursor-pointer place-items-center rounded-field p-0 outline-none"
              style={{ left: pct(k.time) }}
            >
              <span
                className={clsx(
                  'h-2.5 w-2.5 rotate-45 rounded-[2px] border-[1.5px]',
                  i === idx ? 'border-ink bg-ink' : 'border-ink-muted',
                )}
              />
            </button>
          ))}
          <span
            aria-hidden
            className="pointer-events-none absolute -bottom-0.5 -top-0.5 -ml-px w-0.5 bg-ink-muted"
            style={{ left: pct(currentTime) }}
          />
        </div>
      </div>
    </div>
  )
}

type InspectorTab = 'notes' | 'effects' | 'keyboard' | 'scene' | 'sound'
const INSPECTOR_TABS: InspectorTab[] = ['notes', 'effects', 'keyboard', 'scene', 'sound']
const TAB_STORAGE_KEY = 'inspector.tab'

function readStoredTab(): InspectorTab {
  try {
    const v = window.localStorage.getItem(TAB_STORAGE_KEY)
    if (v && (INSPECTOR_TABS as string[]).includes(v)) return v as InspectorTab
  } catch {
    /* storage unavailable — start on the first tab */
  }
  return 'notes'
}

// One tab's cards. Only the active tab renders; while searching every
// tab renders its matches under the tab's name (hidden when it has none).
function TabPanel({ title, active, children }: { title: string; active: boolean; children: ReactNode }) {
  const q = useSearchQuery()
  const ref = useRef<HTMLDivElement>(null)
  const [hasMatch, setHasMatch] = useState(true)
  // Checked a frame after the query changes: the cards inside hide
  // themselves in their own layout effects first.
  useEffect(() => {
    if (!q) {
      setHasMatch(true)
      return
    }
    const id = requestAnimationFrame(() =>
      setHasMatch(!!ref.current && ref.current.querySelector('[data-search-label]') !== null),
    )
    return () => cancelAnimationFrame(id)
  }, [q])
  if (!q && !active) return null
  return (
    <div ref={ref} hidden={!!q && !hasMatch}>
      {q && (
        <div className="px-4 pt-3 text-caption text-ink-faint">{title}</div>
      )}
      {children}
    </div>
  )
}


/** What the hands are waiting for (download / preparing / making the motion), or why they are missing. Nothing once ready. */
function HandsStatusLine() {
  const { t } = useTranslation('inspector')
  const st = useSyncExternalStore(subscribeHandsStatus, getHandsStatus)
  const pct = (f: number) => Math.round(Math.max(0, Math.min(1, f)) * 100)
  const text =
    st.state === 'loading' ? t(st.stage === 'download' ? 'hands.download' : 'hands.prepare', { pct: pct(st.fraction) })
    : st.state === 'working' ? t('hands.working', { pct: pct(st.fraction) })
    : st.state === 'error' ? t('hands.error')
    : null
  if (!text) return null
  return <p className={clsx('text-caption tabular-nums', st.state === 'error' ? 'text-danger' : 'text-ink-muted')}>{text}</p>
}

export function Inspector() {
  const lookOpen = useShell((st) => st.lookOpen)
  // a take in progress has the screen to itself
  const takeInProgress = useTakeInProgress()
  const { mounted, leaving } = usePresence(lookOpen && !takeInProgress)
  if (!mounted) return null
  return <LookPanel leaving={leaving} />
}

function LookPanel({ leaving }: { leaving: boolean }) {
  // Closing the panel under the pointer must not leave the chrome hidden.
  useEffect(() => () => useIdle.getState().setOverPanel(false), [])
  const { t } = useTranslation('inspector')
  const reset = useStore((st) => st.resetSettings)
  const keyframeTargeted = useStore((st) => st.editingKeyframeTime !== null)
  const setLookOpen = useShell((st) => st.setLookOpen)
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [tab, setTabState] = useState<InspectorTab>(readStoredTab)
  const panelRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const setTab = (next: InspectorTab) => {
    setTabState(next)
    // each tab starts at its top, not at the previous tab's scroll offset
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    try {
      window.localStorage.setItem(TAB_STORAGE_KEY, next)
    } catch {
      /* storage unavailable — the tab is just not remembered */
    }
  }
  const searchButtonRef = useRef<HTMLButtonElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const tabsRowRef = useRef<HTMLDivElement>(null)
  const closeSearch = () => {
    const hadFocus = searchInputRef.current?.parentElement?.contains(document.activeElement)
    setQuery('')
    setSearchOpen(false)
    // keyboard users land back on the search button (after it leaves `inert`)
    if (hadFocus) requestAnimationFrame(() => searchButtonRef.current?.focus())
  }
  // The field stays mounted so it can grow out of / fold back into the search button; the hidden half is inert.
  useEffect(() => {
    if (tabsRowRef.current) tabsRowRef.current.inert = searchOpen
    const field = searchInputRef.current?.parentElement
    if (field) field.inert = !searchOpen
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  return (
    <LookAnchorContext.Provider value={panelRef}>
      <Panel
        ref={panelRef}
        aria-label={t('panel.title')}
        className={clsx('fixed z-20 nf-enter-right', leaving && 'nf-leaving')}
        onPointerEnter={(e) => e.pointerType === 'mouse' && useIdle.getState().setOverPanel(true)}
        onPointerLeave={() => useIdle.getState().setOverPanel(false)}
        style={{
          right: GEOMETRY.EDGE,
          top: GEOMETRY.EDGE + GEOMETRY.BAR + GEOMETRY.GAP,
          bottom: GEOMETRY.PILL_BOTTOM + GEOMETRY.PILL + GEOMETRY.GAP,
          width: GEOMETRY.PANEL,
        }}
      >
        <div className="relative flex flex-none items-center border-b border-glass-edge p-2">
          <div
            ref={tabsRowRef}
            className={clsx(
              'flex flex-1 items-center gap-1 transition-opacity duration-150 ease-[var(--ease-out)]',
              searchOpen && 'opacity-0',
            )}
          >
            <SegmentedTabs tab={tab} onChange={setTab} />
            <IconButton ref={searchButtonRef} size="sm" label={t('search.open')} onPress={() => setSearchOpen(true)}>
              <Icon.SearchIcon />
            </IconButton>
          </div>
          {/* Grows leftward out of the search button (`nf-reveal-left`). */}
          <div data-open={searchOpen || undefined} className="nf-reveal-left absolute inset-x-2 top-1/2 -translate-y-1/2">
            <Icon.SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Escape') closeSearch()
              }}
              aria-label={t('search.open')}
              placeholder={t('search.placeholder')}
              spellCheck={false}
              className="nf-focus h-8 w-full rounded-tab bg-fill-field pl-9 pr-9 text-body text-ink outline-none placeholder:text-ink-faint"
            />
            <IconButton
              size="sm"
              label={t('search.clear')}
              tooltip={false}
              onPress={closeSearch}
              className="absolute right-0.5 top-1/2 -translate-y-1/2 text-ink-muted"
            >
              <Icon.CloseIcon />
            </IconButton>
          </div>
        </div>
        <KeyframesHeader />
        <SearchProvider query={query}>
          <div ref={scrollRef} className="scroll-thin min-h-0 flex-1 overflow-y-auto">
            <TabPanel title={t('tab.notes')} active={tab === 'notes'}>
              <Section title={t('section.style')}>
                <NoteLookControls />
              </Section>
              <Section title={t('section.coloring')}>
                <NoteColorControls />
              </Section>
              <Section title={t('section.falling')} enabledKey="notesEnabled">
                <BoundSliderRow label={t('row.fallTime')} settingKey="fallDurationSec" min={0.5} max={8} step={0.1} />
                <BoundSliderRow label={t('row.width')} settingKey="noteWidthScale" min={0.2} max={1.5} step={0.01} />
                <BoundSliderRow label={t('row.opacity')} settingKey="noteOpacity" min={0} max={1} step={0.01} />
                <BoundSliderRow label={t('row.minLength')} settingKey="noteMinLength" min={0} max={0.6} step={0.01} />
                <FallDirectionRow />
              </Section>
              <Section title={t('section.noteLabels')} enabledKey="noteLabelsEnabled">
                <NoteLabelContentRow />
                <PitchLabelRows target="note" />
                <NoteLabelPositionRow />
                <BoundSliderRow label={t('labels.size')} settingKey="noteLabelSize" min={0.3} max={2} step={0.01} />
                <BoundColorRow label={t('row.color')} settingKey="noteLabelColor" />
                <BoundSliderRow label={t('row.opacity')} settingKey="noteLabelOpacity" min={0} max={1} step={0.01} />
                <BoundSliderRow label={t('labels.outlineWidth')} settingKey="noteLabelOutlineWidth" min={0} max={1} step={0.01} />
                <BoundColorRow label={t('labels.outlineColor')} settingKey="noteLabelOutlineColor" />
                <BoundSliderRow label={t('labels.offset')} settingKey="noteLabelOffset" min={0} max={1} step={0.01} />
              </Section>
              <Section title={t('section.texture')} defaultOpen={false}>
                <TextureControls />
              </Section>
            </TabPanel>

            <TabPanel title={t('tab.effects')} active={tab === 'effects'}>
              <Section title={t('section.hitLine')} enabledKey="hitLineEnabled">
                <HitLineColorControls />
                <BoundSliderRow label={t('row.barIntensity')} settingKey="hitLineIntensity" min={0} max={8} step={0.05} />
                <BoundSliderRow label={t('row.barThickness')} settingKey="hitLineThickness" min={0} max={1} step={0.01} />
                <BoundSliderRow label={t('row.barHalo')} settingKey="hitLineBarHalo" min={0} max={6} step={0.05} />
                <BoundSwitchRow label={t('row.waveEnabled')} settingKey="hitLineWaveEnabled" />
                <Detail id="hitLine">
                  <BoundSliderRow label={t('row.barY')} settingKey="hitLineBarY" min={-1} max={1} step={0.01} />
                  <SubGroup heading label={t('group.wave')}>
                    <BoundSliderRow label={t('row.waveIntensity')} settingKey="hitLineWaveIntensity" min={0} max={4} step={0.05} />
                    <BoundSliderRow label={t('row.waveY')} settingKey="hitLineWaveY" min={-1} max={1} step={0.01} />
                    <BoundSliderRow label={t('row.waveAmplitude')} settingKey="hitLineWaveAmplitude" min={0} max={1} step={0.01} />
                    <BoundSliderRow label={t('row.waveScale')} settingKey="hitLineWaveScale" min={0.5} max={200} step={0.5} />
                    <BoundSliderRow label={t('row.waveScrollSpeed')} settingKey="hitLineWaveScrollSpeed" min={-3} max={3} step={0.05} />
                    <BoundSliderRow label={t('row.waveMorphSpeed')} settingKey="hitLineWaveMorphSpeed" min={0} max={3} step={0.05} />
                    <BoundSliderRow label={t('row.waveThickness')} settingKey="hitLineWaveThickness" min={0} max={0.2} step={0.005} />
                    <BoundSliderRow label={t('row.waveHalo')} settingKey="hitLineWaveHalo" min={0} max={3} step={0.05} />
                    <BoundSliderRow label={t('row.waveGrain')} settingKey="hitLineWaveGrain" min={0} max={3} step={0.05} />
                  </SubGroup>
                </Detail>
              </Section>

              <Section title={t('section.particles')} enabledKey="particlesEnabled">
                <FollowColorRows followKey="particleColorFollowNote" colorKey="particleColor" />
                <BoundSliderRow label={t('row.particleCount')} settingKey="particleDotCount" min={0} max={10} step={0.05} />
                <BoundSliderRow label={t('row.particleSize')} settingKey="particleDotSize" min={0} max={3} step={0.01} />
                <BoundSliderRow label={t('row.particleOpacity')} settingKey="particleDotOpacity" min={0} max={1} step={0.01} />
                <BoundSliderRow label={t('row.particleBrightness')} settingKey="particleDotBrightness" min={0} max={3} step={0.01} />
                <BoundSliderRow label={t('row.particleLife')} settingKey="particleLife" min={0.1} max={3} step={0.05} />
                <BoundSliderRow label={t('row.particleRise')} settingKey="particleRise" min={0} max={4} step={0.05} />
                <Detail id="particles">
                  <ParticleBlendingRow />
                  <BoundSliderRow label={t('row.particleSpread')} settingKey="particleSpread" min={0} max={2} step={0.01} />
                  <BoundSliderRow label={t('row.emitterWidth')} settingKey="particleEmitterWidth" min={0} max={3} step={0.05} />
                  <SubGroup heading label={t('group.turbulence')}>
                    <BoundSliderRow label={t('row.flowStrength')} settingKey="particleFlowStrength" min={0} max={4} step={0.05} />
                    <BoundSliderRow label={t('row.flowX')} settingKey="particleFlowX" min={0} max={2} step={0.01} />
                    <BoundSliderRow label={t('row.flowY')} settingKey="particleFlowY" min={0} max={2} step={0.01} />
                    <BoundSliderRow label={t('row.flowZ')} settingKey="particleFlowZ" min={0} max={2} step={0.01} />
                    <BoundSliderRow label={t('row.octaves')} settingKey="particleFlowOctaves" min={1} max={4} step={1} />
                    <BoundSliderRow label={t('row.octaveScale')} settingKey="particleFlowOctaveScale" min={0.5} max={3} step={0.01} />
                    <BoundSliderRow label={t('row.octaveGain')} settingKey="particleFlowOctaveGain" min={0} max={2} step={0.01} />
                    <BoundSliderRow label={t('row.flowFrequency')} settingKey="particleFlowFrequency" min={0.1} max={5} step={0.05} />
                    <BoundSliderRow label={t('row.flowEvolution')} settingKey="particleFlowEvolution" min={0} max={5} step={0.05} />
                    <BoundSliderRow label={t('row.flowFollow')} settingKey="particleFlowFollow" min={0} max={1} step={0.01} />
                  </SubGroup>
                  <SubGroup heading label={t('group.motion')}>
                    <BoundSliderRow label={t('row.launchSpeed')} settingKey="particleLaunchSpeed" min={0} max={5} step={0.05} />
                    <BoundSliderRow label={t('row.randomDirection')} settingKey="particleRandomDirection" min={0} max={1} step={0.01} />
                    <BoundSliderRow label={t('row.randomSpeed')} settingKey="particleRandomSpeed" min={0} max={1} step={0.01} />
                    <BoundSliderRow label={t('row.airFriction')} settingKey="particleAirFriction" min={0} max={2} step={0.01} />
                    <BoundSliderRow label={t('row.gravityCurl')} settingKey="particleGravityCurl" min={0} max={2} step={0.01} />
                    <BoundSliderRow label={t('row.twirl')} settingKey="particleTwirl" min={0} max={3} step={0.05} />
                    <BoundSliderRow label={t('row.twirlVariance')} settingKey="particleTwirlVariance" min={0} max={2} step={0.05} />
                    <BoundSwitchRow label={t('row.motionTrail')} settingKey="particleMotionTrail" />
                  </SubGroup>
                  <SubGroup heading label={t('group.rays')}>
                    <BoundSwitchRow label={t('row.enabled')} settingKey="particleRaysEnabled" />
                    <BoundSliderRow label={t('row.rayLength')} settingKey="particleRayLength" min={0} max={4} step={0.05} />
                    <BoundSliderRow label={t('row.rayOpacity')} settingKey="particleRayOpacity" min={0} max={1} step={0.01} />
                    <BoundSliderRow label={t('row.rayAngle')} settingKey="particleRayAngle" min={-180} max={180} step={1} />
                    <BoundSliderRow label={t('row.raySpread')} settingKey="particleRaySpread" min={-180} max={180} step={1} />
                  </SubGroup>
                  <SubGroup heading label={t('group.fog')}>
                    <BoundSwitchRow label={t('row.enabled')} settingKey="particleFogEnabled" />
                    <BoundSliderRow label={t('row.fogCount')} settingKey="particleFogCount" min={0} max={5} step={0.05} />
                    <BoundSliderRow label={t('row.fogOpacity')} settingKey="particleFogOpacity" min={0} max={1} step={0.01} />
                  </SubGroup>
                </Detail>
              </Section>

              {/* Bloom is a global post-process applied AFTER all the visual
                  emitters above, so it closes the tab. */}
              <Section title={t('section.bloom')} enabledKey="bloomEnabled">
                <BoundSliderRow label={t('row.bloomIntensity')} settingKey="bloomIntensity" min={0} max={4} step={0.05} />
                <BoundSliderRow label={t('row.bloomThreshold')} settingKey="bloomThreshold" min={0} max={1} step={0.01} />
                <BoundSliderRow label={t('row.bloomRadius')} settingKey="bloomRadius" min={0} max={1} step={0.01} />
                <BoundSliderRow label={t('row.bloomSmoothing')} settingKey="bloomSmoothing" min={0} max={1} step={0.01} />
              </Section>

              <Section title={t('section.flash')} enabledKey="flashEnabled">
                <FollowColorRows followKey="flashFollowNote" colorKey="flashColor" />
                <BoundSliderRow label={t('row.flashBrightness')} settingKey="flashBrightness" min={0} max={1} step={0.01} />
                <BoundSliderRow label={t('row.flashIntensity')} settingKey="flashIntensity" min={0} max={2} step={0.05} />
                <BoundSliderRow label={t('row.flashSize')} settingKey="flashSize" min={0.3} max={5} step={0.05} />
                <Detail id="flash">
                  <BoundSliderRow label={t('row.flashWidth')} settingKey="flashWidth" min={0.3} max={5} step={0.05} />
                  <BoundSliderRow label={t('row.flashHalo')} settingKey="flashHaloWidth" min={0} max={2} step={0.05} />
                </Detail>
              </Section>
            </TabPanel>

            <TabPanel title={t('tab.scene')} active={tab === 'scene'}>
              <Section title={t('section.background')}>
                {/* Colour and image are siblings, not alternatives: the image
                    composites OVER the colour, which still shows through at
                    opacity < 1 and in whatever the fit / scale / offset leaves
                    uncovered. The framing rows appear only once an image is
                    loaded, the way `TextureControls` gates its rows. */}
                <BoundColorRow
                  label={t('backgroundImage.selectColor')}
                  settingKey="backgroundColor"
                />
                <BackgroundImageControls />
              </Section>
              <Section title={t('section.camera')}>
                <CameraSection />
                <p className="text-caption text-ink-faint">{t('camera.hint')}</p>
              </Section>
              <Section title={t('section.view')}>
                <BoundSwitchRow label={t('row.octaveLines')} settingKey="octaveLinesEnabled" />
                <BoundSwitchRow label={t('row.highFpsPreview')} settingKey="previewHighFps" />
              </Section>
            </TabPanel>

            <TabPanel title={t('tab.keyboard')} active={tab === 'keyboard'}>
              <Section title={t('section.keyboard')}>
                <BoundSliderRow label={t('row.keyboardY')} settingKey="keyboardScreenY" min={0} max={1} step={0.01} />
                <BoundSliderRow label={t('row.brightness')} settingKey="keyboardBrightness" min={0} max={2} step={0.01} />
                <BoundColorRow label={t('row.whiteKeys')} settingKey="whiteKeyColor" />
                <BoundColorRow label={t('row.blackKeys')} settingKey="blackKeyColor" />
                <BoundColorRow label={t('row.wood')} settingKey="woodColor" />
              </Section>
              <Section title={t('section.keyLabels')} enabledKey="keyLabelsEnabled">
                <KeyLabelsModeRow />
                <PitchLabelRows target="key" />
                <BoundSliderRow label={t('labels.size')} settingKey="keyLabelSize" min={0.3} max={2} step={0.01} />
                <BoundSliderRow label={t('row.opacity')} settingKey="keyLabelOpacity" min={0} max={1} step={0.01} />
                <BoundColorRow label={t('labels.whiteKeyColor')} settingKey="keyLabelWhiteColor" />
                <BoundColorRow label={t('labels.blackKeyColor')} settingKey="keyLabelBlackColor" />
                <BoundSliderRow label={t('labels.keyOffset')} settingKey="keyLabelOffset" min={0} max={0.8} step={0.01} />
              </Section>
              <Section title={t('section.keyGlow')} enabledKey="keyGlowEnabled">
                <FollowColorRows followKey="keyGlowFollowNote" colorKey="keyGlowColor" />
                <BoundSliderRow label={t('row.glowIntensity')} settingKey="keyGlowIntensity" min={0} max={5} step={0.05} />
                <BoundSliderRow label={t('row.glowDecay')} settingKey="keyGlowDecay" min={0.05} max={2} step={0.01} />
              </Section>
              <Section title={t('section.hands')} enabledKey="handsEnabled">
                <p className="text-caption text-ink-faint">{t('hands.hint')}</p>
                <HandsStatusLine />
                <BoundSliderRow label={t('row.handsBrightness')} settingKey="handsBrightness" min={0} max={3} step={0.05} />
                <BoundSliderRow label={t('row.handsFlashLight')} settingKey="handsFlashLight" min={0} max={2} step={0.05} />
                <BoundSwitchRow label={t('row.handsMotionBlur')} settingKey="handsMotionBlur" />
                <BoundSliderRow label={t('row.handsBlurSamples')} settingKey="handsBlurSamples" min={2} max={16} step={1} />
              </Section>
            </TabPanel>

            <TabPanel title={t('tab.sound')} active={tab === 'sound'}>
              <Section title={t('section.audio')}>
                <BoundSwitchRow label={t('row.pedalEnabled')} settingKey="pedalEnabled" />
                <BoundSliderRow label={t('row.transpose')} settingKey="transpose" min={-24} max={24} step={1} />
                <BoundSliderRow label={t('row.release')} settingKey="releaseTime" min={0.01} max={1.5} step={0.01} />
                <EqRow />
                <Detail id="audio">
                  <BoundSliderRow label={t('row.detune')} settingKey="samplerDetune" min={-100} max={100} step={1} />
                  <VelocityCurveEditor />
                  <BoundSliderRow label={t('row.velocityCompensation')} settingKey="velocityCompensation" min={0} max={1} step={0.05} />
                </Detail>
              </Section>
              <Section title={t('section.reverb')} enabledKey="reverbEnabled">
                <BoundSliderRow label={t('row.reverbDry')} settingKey="reverbDry" min={0} max={2} step={0.01} />
                <BoundSliderRow label={t('row.reverbWet')} settingKey="reverbWet" min={0} max={2} step={0.01} />
                <BoundSliderRow label={t('row.reverbSize')} settingKey="reverbSize" min={0.3} max={5} step={0.1} />
                <BoundSliderRow label={t('row.reverbDecayTime')} settingKey="reverbDecayTime" min={0.1} max={8} step={0.05} />
                <Detail id="reverb">
                  <BoundSliderRow label={t('row.reverbDecay')} settingKey="reverbDecay" min={0} max={6} step={0.05} />
                  <PreDelayRow />
                  <BoundSliderRow label={t('row.reverbDamping')} settingKey="reverbDamping" min={0} max={0.99} step={0.01} />
                  <BoundSliderRow label={t('row.reverbHiCut')} settingKey="reverbHiCut" min={500} max={20000} step={100} />
                  <BoundSliderRow label={t('row.reverbLowCut')} settingKey="reverbLowCut" min={20} max={1000} step={10} />
                </Detail>
              </Section>
            </TabPanel>
          </div>
        </SearchProvider>
        <div className="flex flex-none items-center justify-between gap-2 border-t border-glass-edge px-2 py-1.5">
          <Button
            variant="quiet"
            size="sm"
            icon={<Icon.ResetIcon />}
            onPress={() => reset()}
            className="text-ink-muted"
          >
            {keyframeTargeted ? t('reset.keyframe') : t('reset.button')}
          </Button>
          <IconButton size="sm" label={t('keyframes.close')} onPress={() => setLookOpen(false)}>
            <Icon.CloseIcon />
          </IconButton>
        </div>
      </Panel>
    </LookAnchorContext.Provider>
  )
}

/** The five areas as tabs; the selected fill slides to the chosen tab. Arrow keys move between tabs. */
function SegmentedTabs({ tab, onChange }: { tab: InspectorTab; onChange: (t: InspectorTab) => void }) {
  const { t } = useTranslation('inspector')
  const listRef = useRef<HTMLDivElement>(null)
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null)
  useLayoutEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-tab="${tab}"]`)
    if (el) setPill({ x: el.offsetLeft, w: el.offsetWidth })
  }, [tab])
  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = INSPECTOR_TABS.indexOf(tab)
    const next =
      e.key === 'ArrowRight' ? INSPECTOR_TABS[(i + 1) % INSPECTOR_TABS.length]
      : e.key === 'ArrowLeft' ? INSPECTOR_TABS[(i + INSPECTOR_TABS.length - 1) % INSPECTOR_TABS.length]
      : null
    if (!next) return
    e.preventDefault()
    onChange(next)
    listRef.current?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus()
  }
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={t('tab.label')}
      onKeyDown={onKeyDown}
      className="relative flex min-w-0 flex-1 gap-0.5"
    >
      {pill && (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 rounded-tab bg-fill-selected transition-[transform,width] duration-200 ease-[var(--ease-out)] motion-reduce:transition-none"
          style={{ width: pill.w, transform: `translateX(${pill.x}px)` }}
        />
      )}
      {INSPECTOR_TABS.map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          data-tab={id}
          tabIndex={tab === id ? 0 : -1}
          aria-selected={tab === id}
          onClick={() => onChange(id)}
          className={clsx(
            'nf-focus relative h-8 flex-auto cursor-pointer whitespace-nowrap rounded-tab px-1.5 text-center text-label outline-none transition-colors duration-150',
            tab === id ? 'text-ink' : 'text-ink-muted hover:text-ink',
          )}
        >
          {t(`tab.${id}`)}
        </button>
      ))}
    </div>
  )
}
