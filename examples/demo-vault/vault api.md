# Vault API

Python cells query and write the vault they live in. Query results arrive as
ordinary Python objects, so you filter and process them with ordinary Python.

## Query notes

Every note comes back with its metadata. Filter the list in Python. There is no
query language to learn.

```marimo
import marimo as mo
from obsidian_marimo import vault, VaultError

notes = await vault.notes()
tagged = [n for n in notes if n.tags]
mo.md(f"**{len(notes)}** notes, **{len(tagged)}** of them tagged")
```

## A table of everything

`vault.frame()` builds one row per note. The first call installs pandas into
the kernel, so it takes a few seconds. The guard keeps the note readable when
the install cannot run.

```marimo
try:
    view = mo.ui.table(await vault.frame(), page_size=5)
except VaultError as err:
    view = mo.md(f"No table: {err}")

view
```

## The hosting note

A cell reads the note that contains it. Paste one fence into many notes, and
each copy reports on its own note.

```marimo
me = await vault.self()
mo.md(f"This notebook lives in `{me.path}`, which has {len(me.headings)} headings")
```

## A guarded write

A cell re-runs whenever its references change, so a write bound to a slider
writes on every drag tick. The run button makes the write deliberate.

```marimo
record = mo.ui.run_button(label="Record a line")
record
```

```marimo
mo.stop(not record.value)

await vault.append("data/log.txt", f"recorded from {me.path}\n")
mo.md("Written to `data/log.txt`.")
```

