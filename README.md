# marimo islands

Obsidian plugin that renders [marimo](https://marimo.io) cells as live, reactive
WASM islands inside notes. Python runs in-browser via Pyodide — no server, no
local Python install.

## Usage

Write cells in a `marimo` fence:

````markdown
```marimo
import marimo as mo
slider = mo.ui.slider(0, 10, value=3)
slider
```

```marimo
slider.value * 2
```
````

All `marimo` blocks in one note share a single reactive notebook: moving the
slider reruns the dependent cell below it.

marimo's own [notebook-as-markdown format](https://docs.marimo.io/guides/exporting/markdown/)
is also supported — fences like ```` ```python {.marimo} ```` are upgraded to
islands, so a file produced by `marimo export md notebook.py` renders as a
runnable notebook when opened in Obsidian.

Both fence flavors render in reading view and in live preview. In live preview,
the island replaces the fence while the cursor is outside it. To edit the
source, move the cursor into the block or click the `</>` button on the
island.

## How it works

Built on [marimo islands](https://docs.marimo.io/guides/island_example/), the
same runtime behind marimo-anywhere (quarto-marimo, jupyter-book-marimo,
mdx-marimo):

1. Each code block is rendered into the DOM contract the islands runtime
   expects:
   ```html
   <marimo-island data-app-id="note-…" data-reactive="true">
     <marimo-cell-output>…</marimo-cell-output>
     <marimo-cell-code hidden><!-- URL-encoded Python --></marimo-cell-code>
   </marimo-island>
   ```
2. The [`@marimo-team/islands`](https://www.npmjs.com/package/@marimo-team/islands)
   runtime (pinned in `src/main.ts`, versioned in lockstep with marimo) is
   dynamically imported from jsDelivr on first use, along with its stylesheet.
3. Its exported `initialize()` scans the DOM, stitches all islands with the same
   `data-app-id` into one notebook file, and executes it in a Pyodide web
   worker. `initialize()` is idempotent, so it is re-called (debounced) as
   Obsidian renders blocks.

Two render paths feed step 1. Reading view uses a markdown post-processor. Live
preview uses a CodeMirror state field (`src/live-preview.ts`) that replaces each
fence with a block widget, because live preview draws fences as editor text and
the reading-view post-processor never runs there.

Unlike the static-site integrations, no build-time Python step is needed — the
runtime executes the embedded code client-side; build-time output is only a
hydration nicety.

## Vendoring / offline

```bash
./scripts/vendor-islands.sh   # islands runtime (~29 MB) → vendor/islands
./scripts/vendor-pyodide.sh   # Pyodide core + boot wheels (~20 MB) → vendor/pyodide
```

With both vendored, notebooks using marimo + the Python stdlib run fully
offline; the plugin falls back to jsDelivr when vendor/ is absent. The pyodide
script also patches the vendored worker chunk to honor
`globalThis.__PYODIDE_BASE__` / `__MARIMO_LOCK__`, which the plugin injects
via its worker shim.

## Caveats

- Extra package imports in notebooks (numpy, pandas, …) still fetch from the
  CDN at runtime — vendoring covers the marimo core only.
- Obsidian quirks handled by the plugin (see comments in `src/main.ts`):
  Electron's `process` in workers breaks Pyodide's environment detection
  (worker shim), CSP blocks remote styles (inlined, titled "marimo-islands" so
  shadow roots adopt it), live-preview/reading-view DOM duplication (only
  visible islands are reactive), and recreated block DOM rebinding without a
  kernel restart (data-mo-code + cell index map).
- Islands are marked an early/experimental feature upstream.

## Development

```bash
pnpm install
pnpm dev    # watch build
pnpm build  # type-check + production build
pnpm vault  # scaffold + open the demo vault (examples/demo-vault) in Obsidian
```

`pnpm vault` symlinks the plugin into the test vault and opens it via the
`obsidian://` URL scheme; on first open, choose "Trust author and enable
plugins". For any other vault, symlink this folder into
`<vault>/.obsidian/plugins/marimo-islands/` and enable "marimo islands" in
Community plugins.
The "Reinitialize notebooks in open notes" command forces a re-scan.

## Release

Release prep lands through a normal PR. The workflow never pushes to `main`.

1. `node scripts/pin-islands.mjs` — pin the islands runtime to the latest
   marimo release.
2. `node scripts/version-bump.mjs <x.y.z>` — set the version in
   `package.json`, `manifest.json`, and `versions.json`.
3. Open a PR with these changes and merge it.
4. Run the "Release" workflow from the Actions tab. It builds, tags `main`
   with the manifest version, and creates a draft GitHub release with
   `main.js`, `manifest.json`, and `styles.css`.
5. Review and publish the draft release.
