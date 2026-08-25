# The vault as a table

The `vault.frame()` method returns a pandas DataFrame with one row per note and one column per built-in field. It also adds a column for each frontmatter key found in the vault, prefixed with `fm_`.

Use `frame()` to analyze all notes at once. The first call installs pandas into the kernel. This takes several seconds. If pandas installation fails because you are offline, the call raises `VaultError` with code `missing_dependency`.

Fetch the vault as a table and display it with pagination. The cell below calls `vault.frame()` wrapped in a try/except block to catch any errors. The table shows five rows per page.

```marimo
import marimo as mo
from obsidian_marimo import vault, VaultError

try:
    df = await vault.frame()
    mo.ui.table(df, page_size=5)
except VaultError as e:
    mo.md(f"Error: {e.code} - {e.reason}")
```

Show the frontmatter columns. Each key found in any note's frontmatter becomes a column prefixed with `fm_`. The cell below lists all columns that start with `fm_`. The corpus includes three frontmatter keys: `fm_status`, `fm_rating`, and `fm_author`.

```marimo
fm_columns = [col for col in df.columns if col.startswith("fm_")]
fm_columns
```
