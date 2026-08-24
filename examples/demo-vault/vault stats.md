# Vault stats — a meta notebook

This notebook analyzes **the vault itself**, using the plugin's
`obsidian_marimo` module:

- `vault.base` — the vault's `app://` URL
- `await vault.read(path)` — text of any vault file, always fresh
- `await vault.files(ext="md")` — every file of one type (path, ext, size, mtime)

`vault.files()` with no argument lists every file in the vault, attachments
included, so this notebook asks for markdown only.

## Refresh control

The scan reruns when you click refresh (or pick an auto-interval).

```marimo
import marimo as mo
from obsidian_marimo import vault

refresh = mo.ui.refresh(options=["5s", "30s"])
refresh
```

## Every note, as data

```marimo
from datetime import datetime

refresh.value  # rerun on refresh

notes = []
for f in await vault.files(ext="md"):
    text = await vault.read(f["path"])
    notes.append({
        "note": f["path"].removesuffix(".md"),
        "words": len(text.split()),
        "lines": text.count("\n") + 1,
        "chars": len(text),
        "fences": text.count("```") // 2,
        "links": text.count("[["),
        "modified": datetime.fromtimestamp(f["mtime"] / 1000).strftime("%Y-%m-%d %H:%M"),
    })
notes.sort(key=lambda n: -n["words"])
mo.ui.table(notes, label="every note in the vault", page_size=10)
```

## Totals

```marimo
total_words = sum(n["words"] for n in notes)
total_chars = sum(n["chars"] for n in notes)
mo.md(
    f"**{total_words:,}** words and **{total_chars:,}** characters "
    f"across {len(notes)} notes — "
    f"largest: **{notes[0]['note']}** ({notes[0]['words']} words)"
)
```

## Words per note

```marimo
import matplotlib.pyplot as plt

plt.figure(figsize=(8, 2.6))
plt.barh([n["note"] for n in reversed(notes)], [n["words"] for n in reversed(notes)])
plt.xlabel("words")
plt.tight_layout()
plt.gca()
```
