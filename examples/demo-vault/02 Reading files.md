# Reading files

The vault provides three ways to read files. Use `vault.read()` to fetch one file as text, `vault.read_bytes()` to fetch binary data, and `vault.read_many()` to fetch many files at once.

Read a single note as text. The cell below fetches `library/Dune.md` and displays its first heading.

```marimo
import marimo as mo
from obsidian_marimo import vault

dune_text = await vault.read("library/Dune.md")
first_heading = next(line for line in dune_text.split('\n') if line.startswith('# '))
first_heading
```

Read a file as bytes. The cell below fetches `data/sales.csv` and shows its size in bytes.

```marimo
csv_bytes = await vault.read_bytes("data/sales.csv")
len(csv_bytes)
```

Read multiple files at once. The cell below fetches all three book notes from the library. The library holds five notes total. Three of them carry the `#book` tag. The cell shows the character count for each book.

```marimo
book_paths = [
    "library/Dune.md",
    "library/Antifragile.md",
    "library/The Pragmatic Programmer.md",
]
book_texts = await vault.read_many(book_paths)
result = {path: len(text) for path, text in zip(book_paths, book_texts)}
result
```

Load structured data from a CSV file. The data folder holds input files only. Nothing in this vault writes to the data folder. The cell below loads `data/sales.csv` with Python's built-in `csv` module and counts the rows. The file contains thirty-six data rows.

```marimo
import csv
import io

csv_data = await vault.read_bytes("data/sales.csv")
csv_text = csv_data.decode("utf-8")
reader = csv.DictReader(io.StringIO(csv_text))
row_count = sum(1 for _ in reader)
row_count
```
