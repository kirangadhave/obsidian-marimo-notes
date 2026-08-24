```marimo
import marimo as mo
from obsidian_marimo import vault

notes = await vault.notes()
me = await vault.self()
files = await vault.files(ext="csv")
mo.md(f"{len(notes)} notes, self={me.path}, csv={[f['path'] for f in files]}")
```
