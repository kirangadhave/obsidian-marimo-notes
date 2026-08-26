# Start here

This vault teaches the obsidian-marimo plugin by running it. Read notes 00 to 08 in order. Each note builds on the ones before it.

Your first load downloads Pyodide, a Python runtime for the browser. This download takes a minute or more. Subsequent loads are much faster because Pyodide stays cached.

Islands render in light colors regardless of your vault theme. For more details, see the README [caveats section](https://github.com/kirangadhave/obsidian-marimo-notes#caveats).

The vault demonstrates live features. The README [Vault access section](https://github.com/kirangadhave/obsidian-marimo-notes#vault-access) documents the full API.

Run the cell below to confirm Python works. You must see the text "Python is live" appear within seconds.

```marimo
import marimo as mo
mo.md("Python is live")
```
