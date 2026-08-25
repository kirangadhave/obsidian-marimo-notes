# Writing back

The plugin validates writes and raises `VaultError` on refusal. A write never fails silently. See note 08 for refusal examples.

Create a run button to make writes deliberate. When a cell references the button, it re-runs when the button value changes. The guard `mo.stop(not go.value)` stops the cell until you press the button.

```marimo
import marimo as mo
from obsidian_marimo import vault

go = mo.ui.run_button(label="Run the writes")
go
```

Write a file to `scratch/hello.md`. The cell below writes to the scratch folder and checks that the file exists.

```marimo
mo.stop(not go.value)

await vault.write("scratch/hello.md", "# Hello\n\nThis file was written by marimo.")
hello_exists = await vault.exists("scratch/hello.md")
mo.md(f"File exists: {hello_exists}")
```

Append text twice to `scratch/log.txt` in the same cell. The appends accumulate inside the 500 millisecond debounce window. The cell below reads the file and shows both lines landed.

```marimo
mo.stop(not go.value)

await vault.append("scratch/log.txt", "First append\n")
await vault.append("scratch/log.txt", "Second append\n")
log_content = await vault.read("scratch/log.txt")
mo.md(f"Log file:\n\n```\n{log_content}```")
```

Set frontmatter on `scratch/hello.md`. Add a key and value, then read the frontmatter to show it was set. The cell below sets and reads frontmatter.

```marimo
mo.stop(not go.value)

await vault.set_frontmatter("scratch/hello.md", {"written_by": "marimo"})
fm_after_set = await vault.frontmatter("scratch/hello.md")
mo.md(f"Frontmatter:\n\n```\n{fm_after_set}```")
```

Remove the frontmatter key with `vault.UNSET`. The key disappears after the second call.

```marimo
mo.stop(not go.value)

await vault.set_frontmatter("scratch/hello.md", {"written_by": vault.UNSET})
fm_after_unset = await vault.frontmatter("scratch/hello.md")
mo.md(f"Frontmatter after removal:\n\n```\n{fm_after_unset}```")
```

Write a file and trash it. The cell below writes a temporary file, trashes it, and checks that it no longer exists.

```marimo
mo.stop(not go.value)

await vault.write("scratch/temp.md", "Temporary file")
await vault.trash("scratch/temp.md")
temp_gone = await vault.exists("scratch/temp.md")
mo.md(f"File exists after trash: {temp_gone}")
```

The write debounce window is 500 milliseconds per path. The promise resolves when the write lands in the vault, not when the call is accepted. An unchanged text write is skipped. Read the README section [Debounce behavior](https://github.com/kirangadhave/obsidian-marimo#debounce-behavior) for details.

Everything this note writes lands in `scratch/`. Git ignores the scratch folder, so deleting it is safe. You can clean up after experimenting.
