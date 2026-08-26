#!/usr/bin/env bash
# Opens the demo vault (examples/demo-vault) in Obsidian, scaffolding it if
# needed. Also symlinks .context/vault → examples/demo-vault for tooling that
# expects the old location. The plugin is symlinked into the vault, so
# `pnpm dev` rebuilds are picked up on plugin reload.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VAULT="$ROOT/examples/demo-vault"
PLUGIN_LINK="$VAULT/.obsidian/plugins/marimo-notes"

if [[ ! -f "$ROOT/main.js" ]]; then
	echo "main.js missing — building plugin first"
	(cd "$ROOT" && pnpm build)
fi

mkdir -p "$VAULT/.obsidian/plugins"
ln -sfn ../../../.. "$PLUGIN_LINK"
mkdir -p "$ROOT/.context"
[[ -e "$ROOT/.context/vault" ]] || ln -s ../examples/demo-vault "$ROOT/.context/vault"

if [[ ! -f "$VAULT/.obsidian/community-plugins.json" ]]; then
	echo '["marimo-notes"]' > "$VAULT/.obsidian/community-plugins.json"
fi

DEMO="$VAULT/marimo demo.md"
if [[ ! -f "$DEMO" ]]; then
	cat > "$DEMO" <<'EOF'
# marimo demo

Two `marimo` blocks sharing one reactive notebook — move the slider and the
cell below reruns.

```marimo
import marimo as mo
slider = mo.ui.slider(0, 10, value=3, label="x")
slider
```

```marimo
mo.md(f"x² = **{slider.value ** 2}**")
```

## marimo markdown flavor

This fence uses marimo's notebook-as-markdown syntax (`python {.marimo}`):

```python {.marimo}
mo.md(f"A pure-python cell: {sum(range(100))}")
```

A plain python block stays a plain code block:

```python
print("not a marimo cell")
```
EOF
fi

# obsidian://open only works for vaults Obsidian already knows about, so
# register this one in obsidian.json first.
REGISTERED="$(python3 - "$VAULT" <<'PY'
import json, os, secrets, sys, time

vault = sys.argv[1]
config = os.path.expanduser("~/Library/Application Support/obsidian/obsidian.json")
os.makedirs(os.path.dirname(config), exist_ok=True)
try:
    with open(config) as f:
        data = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    data = {}
vaults = data.setdefault("vaults", {})
if any(v.get("path") == vault for v in vaults.values()):
    print("existing")
else:
    vaults[secrets.token_hex(8)] = {"path": vault, "ts": int(time.time() * 1000)}
    with open(config, "w") as f:
        json.dump(data, f)
    print("added")
PY
)"

if [[ "$REGISTERED" == "added" ]] && pgrep -xq Obsidian; then
	# Obsidian only reads obsidian.json on launch and overwrites it on exit.
	echo "Restarting Obsidian to pick up the new vault…"
	osascript -e 'tell application "Obsidian" to quit'
	sleep 2
fi

ENCODED="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$VAULT")"
open "obsidian://open?path=$ENCODED"
echo "Opened vault: $VAULT"
echo "If prompted, choose 'Trust author and enable plugins'."
