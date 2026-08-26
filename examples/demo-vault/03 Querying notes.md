# Querying notes

The vault provides `vault.notes()` to list all notes. You can filter by folder or tag, and you can apply additional filters in plain Python code.

List all notes in the vault. The cell below calls `vault.notes()` without filters and counts the result.

```marimo
import marimo as mo
from obsidian_marimo import vault

all_notes = await vault.notes()
total_count = len(all_notes)
total_count
```

Filter notes in Python using the frontmatter `status` field. The cell below keeps only those notes where the `status` field equals `"read"`. Two notes in the vault carry this status.

```marimo
read_notes = [n for n in all_notes if n.frontmatter.get("status") == "read"]
len(read_notes)
```

Filter notes by folder using the `folder` parameter. The cell below returns all notes in the `library/` folder. The library holds five notes.

```marimo
library_notes = await vault.notes(folder="library/")
len(library_notes)
```

Filter notes by tag using the `tag` parameter. The cell below returns all notes that carry the `#book` tag. Three notes in the vault carry this tag.

```marimo
book_notes = await vault.notes(tag="#book")
len(book_notes)
```

Query the hosting note with `vault.self()`. The cell below fetches metadata about this note, including its path and the list of its headings.

```marimo
self_note = await vault.self()
self_note.path
```

```marimo
heading_count = len(self_note.headings)
heading_count
```

See the [Vault access section](https://github.com/kirangadhave/obsidian-marimo-notes#vault-access) in the README for the full list of `Note` attributes.
