/**
 * Bundled demo projects. Drop `.nfz` files into `src/demos/` and they
 * appear in the Toolbar's "Demo Songs" menu automatically — Vite's
 * `import.meta.glob(?url)` resolves each file to a hashed asset URL at
 * build time, so demos ship as static assets alongside the app.
 *
 * The menu label IS the filename (minus `.nfz`), with `_` standing in
 * for `:` since Windows can't check out a path containing a colon —
 * `Scizzie_ Aquatic Ambience (arr. Aschrra).nfz` reads as
 * "Scizzie: Aquatic Ambience (arr. Aschrra)". Deriving it from the path
 * keeps the menu free of network work: a demo is fetched only when the
 * user picks it, never just to show its name (demos can bundle
 * multi-MB audio). Sorted by label so the order is deterministic.
 */

const modules = import.meta.glob('./demos/*.nfz', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

export type DemoEntry = {
  label: string
  url: string
}

function labelFromPath(path: string): string {
  const file = path.split('/').pop() ?? path
  return file.replace(/\.nfz$/i, '').replace(/_/g, ':')
}

export const DEMOS: DemoEntry[] = Object.entries(modules)
  .map(([path, url]) => ({ label: labelFromPath(path), url }))
  .sort((a, b) => a.label.localeCompare(b.label))

/** The demo a first visit starts with. */
export const FIRST_VISIT_DEMO = DEMOS.find((d) => d.label.startsWith('Schubert: Impromptu No. 3'))
