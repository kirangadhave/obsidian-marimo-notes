# Staying current

The plugin batches vault changes and pushes them to the notebook every 500 milliseconds. Python drops its cached `notes()`, `files()`, and `links()` results when a batch arrives. The next call returns fresh data without a kernel restart.

A cell does not re-run on its own when the vault changes. To follow the vault, put `mo.ui.refresh` in one cell and read it in another. The second cell depends on the first, so it re-runs on every tick.

Create a refresh control with a default interval of 5 seconds. The cell below defines `refresh` as output.

```marimo
import marimo as mo
from obsidian_marimo import vault

refresh = mo.ui.refresh(default_interval="5s")
refresh
```

Read the refresh control and fetch the current note count. The cell below reads `refresh`, calls `await vault.notes()`, and shows the count.

```marimo
refresh

notes = await vault.notes()
mo.md(f"{len(notes)} notes")
```

Create a new note in the vault while this notebook runs. Wait for one tick of the refresh control. Watch the count increase. Then delete the note from the vault and watch the count decrease. The counts update automatically as the vault changes.
