# What is refused

Markdown is executable in many vaults through plugins like Dataview and Templater. The validator cannot block this without blocking `.md`, and writing markdown is the point. Read a notebook from someone else before you run it. See the README [Threat model](https://github.com/kirangadhave/obsidian-marimo-notes#threat-model) for details.

```marimo
import marimo as mo
from obsidian_marimo import vault, VaultError

async def refused(coro):
    """Catch and return a VaultError from a coroutine."""
    try:
        await coro
        return None
    except VaultError as err:
        return err
```

Each rule below shows the refused call in a static block. The live cell under it runs that call through `refused` and shows the error.

The plugin rejects writes to paths that walk out of the vault with `..`.

```python
await vault.write("../secrets.txt", "test")
```

```marimo
err_path = await refused(vault.write("../secrets.txt", "test"))
mo.md(f"**Code:** `{err_path.code}`\n\n**Message:** {err_path.message}")
```

The plugin rejects writes to the Obsidian configuration directory.

```python
await vault.write(".obsidian/app.json", "{}")
```

```marimo
err_config = await refused(vault.write(".obsidian/app.json", "{}"))
mo.md(f"**Code:** `{err_config.code}`\n\n**Message:** {err_config.message}")
```

The plugin rejects writes to files with disallowed extensions.

```python
await vault.write("scratch/tool.py", "print('hello')")
```

```marimo
err_ext = await refused(vault.write("scratch/tool.py", "print('hello')"))
mo.md(f"**Code:** `{err_ext.code}`\n\n**Message:** {err_ext.message}")
```

The plugin rejects writes to the note that hosts this notebook.

```python
self_note = await vault.self()
await vault.write(self_note.path, "# Replaced")
```

```marimo
self_note = await vault.self()
err_self = await refused(vault.write(self_note.path, "# Replaced"))
mo.md(f"**Code:** `{err_self.code}`\n\n**Message:** {err_self.message}")
```

The plugin rejects operations on files that do not exist.

```python
await vault.trash("nonexistent/file.md")
```

```marimo
err_missing = await refused(vault.trash("nonexistent/file.md"))
mo.md(f"**Code:** `{err_missing.code}`\n\n**Message:** {err_missing.message}")
```

The plugin rejects writes through symlinked folders when the setting "Allow writes through symlinked folders" is off. See the README section [Symlink setting](https://github.com/kirangadhave/obsidian-marimo-notes#symlink-setting) to enable this rule or turn it off.
