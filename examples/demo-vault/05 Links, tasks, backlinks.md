# Links, tasks, backlinks

The vault tracks all links between notes, all tasks (checkboxes) across the vault, and unresolved links that point at files that do not exist. Use these methods to analyze the note graph and track work.

Fetch the forward link graph. The cell below calls `vault.links()`, which returns a dict with `resolved` and `unresolved` edges. The corpus contains five resolved links and one unresolved link.

```marimo
import marimo as mo
from obsidian_marimo import vault

links = await vault.links()
resolved_count = sum(len(targets) for targets in links["resolved"].values())
unresolved_count = sum(len(targets) for targets in links["unresolved"].values())
mo.md(f"**{resolved_count}** resolved links, **{unresolved_count}** unresolved link")
```

Fetch backlinks to a specific note. The cell below calls `vault.backlinks()`, which returns a list of source paths that link to `library/Book A.md`. Two notes in the vault link to Book A: `library/Reading list.md` and `library/Notes on fiction.md`.

```marimo
backlinks = await vault.backlinks("library/Book A.md")
backlinks
```

To verify these results match what you see in Obsidian, open the backlinks pane for `library/Book A.md` inside Obsidian and compare it with the list above. Both sources will show the same two notes.

Fetch all tasks in the vault. Tasks are checkboxes. The cell below fetches tasks with `done=False` to show uncompleted checkboxes. The corpus contains four open tasks.

```marimo
open_tasks = await vault.tasks(done=False)
len(open_tasks)
```

Fetch only completed tasks. The cell below fetches tasks with `done=True`. The corpus contains two completed tasks.

```marimo
done_tasks = await vault.tasks(done=True)
len(done_tasks)
```

Find unresolved links on a note. Unresolved links point at files that do not exist. The cell below fetches the unresolved links on `library/Reading list.md`. The note references `[[Book D]]`, which is not a file in the vault.

```marimo
library_notes = await vault.notes(folder="library/")
reading_list_note = next((n for n in library_notes if n.name == "Reading list"), None)
reading_list_note.unresolved if reading_list_note else []
```
