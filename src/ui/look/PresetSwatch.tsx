import { Radio, RadioGroup } from 'react-aria-components'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import type { Settings } from '../../store'
import { NOTE_LOOK_PRESETS, NOTE_LOOK_PRESET_NAMES, type NoteLookPreset } from '../../notes/looks/noteLook'

// Thumbnails rendered by the real note shader (three notes in a neutral warm white, no
// particles or guide lines), regenerated with _local/redesign/tools/capture-preset-thumbs.mjs
// whenever a preset changes. The chip tints them with the current note colours.
const THUMBS = import.meta.glob('./presets/*.jpg', { eager: true, query: '?url', import: 'default' }) as Record<
  string,
  string
>
const thumbUrl = (name: NoteLookPreset): string | undefined => THUMBS[`./presets/${name}.jpg`]

type LookLike = Pick<Settings, 'noteMaterial' | 'noteShape'>

/** The preset picture for a look that matches none: the first preset of the same material and shape. */
function nearestPreset(look: LookLike): NoteLookPreset {
  return (
    NOTE_LOOK_PRESET_NAMES.find(
      (n) =>
        NOTE_LOOK_PRESETS[n].noteMaterial === look.noteMaterial && NOTE_LOOK_PRESETS[n].noteShape === look.noteShape,
    ) ??
    NOTE_LOOK_PRESET_NAMES.find((n) => NOTE_LOOK_PRESETS[n].noteMaterial === look.noteMaterial) ??
    NOTE_LOOK_PRESET_NAMES[0]
  )
}

/** The rendered preset, tinted by the current note colours (multiply keeps the shading, takes the hue). */
function Thumb({ name, colors }: { name: NoteLookPreset; colors: string[] }) {
  const stops = colors.length > 1 ? colors : [colors[0] ?? '#fff', colors[0] ?? '#fff']
  // Picture and tint are one background, so the rounded corners cut them together: as two layers, each was smoothed
  // on its own and a light edge of the tint showed at the corners.
  return (
    <span
      className="relative block h-14 overflow-hidden rounded-tab bg-cover bg-center"
      style={{
        backgroundImage: `linear-gradient(90deg, ${stops.join(', ')}), url("${thumbUrl(name)}")`,
        backgroundBlendMode: 'multiply, normal',
      }}
    >
      {/* Ring above the tint so it stays ink. */}
      <span
        aria-hidden
        className="absolute inset-0 rounded-tab shadow-[inset_0_0_0_1.5px_transparent] transition-shadow duration-150 group-data-[hovered]:shadow-[inset_0_0_0_1.5px_var(--glass-edge)] group-data-[selected]:!shadow-[inset_0_0_0_1.5px_var(--ink)]"
      />
    </span>
  )
}

/**
 * The note-look presets as a radio grid of chips. `value` is the matching preset or 'custom' (a look matching
 * none: it gets a chip of its own, pictured by the nearest preset, and nothing else is selected).
 */
export function PresetSwatch({
  value,
  onChange,
  look,
  colors,
  label,
}: {
  value: NoteLookPreset | 'custom'
  onChange: (v: NoteLookPreset) => void
  /** The current look, for the Custom chip's picture. */
  look: LookLike
  /** Colours of the current note colouring, left to right. */
  colors: string[]
  label: string
}) {
  const { t } = useTranslation('inspector')
  const chipClass =
    'group nf-focus relative grid cursor-pointer gap-[5px] rounded-tab text-center text-caption text-ink-muted outline-none transition-colors duration-150 data-[hovered]:text-ink data-[selected]:text-ink'
  return (
    <RadioGroup
      aria-label={label}
      value={value === 'custom' ? null : value}
      onChange={(v) => onChange(v as NoteLookPreset)}
      className="grid grid-cols-4 gap-2"
    >
      {value === 'custom' && (
        <div role="presentation" data-selected className={clsx(chipClass, 'cursor-default text-ink')}>
          <Thumb name={nearestPreset(look)} colors={colors} />
          {t('look.presets.custom')}
        </div>
      )}
      {NOTE_LOOK_PRESET_NAMES.map((name) => (
        <Radio key={name} value={name} className={chipClass}>
          <Thumb name={name} colors={colors} />
          <span className="truncate">{t(`look.presets.${name}`)}</span>
        </Radio>
      ))}
    </RadioGroup>
  )
}
