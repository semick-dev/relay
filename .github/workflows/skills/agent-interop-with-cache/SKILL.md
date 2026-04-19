---
name: agent-interop-with-cache
description: A skill for reading Azure DevOps build definitions from the Relay cache.
---

# Skill: Reading Azure DevOps Build Definitions from Relay Cache

## What This Is

The `ado-relay` VS Code extension caches Azure DevOps REST responses as JSON files on disk. You can read these files directly to get a full list of build definitions for any ADO project the user has previously browsed in Relay — no PAT or network access required.

## When To Use This

Use this when you need to look up an Azure DevOps build definition by name (or search for one), and the user has the Relay extension installed. This avoids needing a PAT or live ADO API access for read-only definition lookups.

## Storage Root

The cache lives under the VS Code global storage for the extension:

```
~/.vscode-server/data/User/globalStorage/semick-dev.ado-relay/.relay/cache/
```

> On local VS Code (non-remote) the root is instead:
> - Linux: `~/.config/Code/User/globalStorage/semick-dev.ado-relay/.relay/cache/`
> - macOS: `~/Library/Application Support/Code/User/globalStorage/semick-dev.ado-relay/.relay/cache/`

## How The Cache Works

Every cached REST response produces two files, named by the SHA-256 of its cache key:

```
{digest}.json       ← metadata (cache key, timestamp, TTL, path to body)
{digest}.body.json  ← the actual response payload
```

The **cache key** is `"GET "` + the normalized ADO URL. For definitions the key is:

```
GET https://dev.azure.com/{org}/{project}/_apis/build/definitions?api-version=7.1
```

The digest is `sha256(key)` in hex.

## Finding Definitions On Disk

### Step 1 — Locate the cache directory

```bash
CACHE_DIR="$HOME/.vscode-server/data/User/globalStorage/semick-dev.ado-relay/.relay/cache"
```

### Step 2 — Scan metadata files to find definitions caches

Every `.json` file that is **not** a `.body.json` is a metadata record. Read its `key` field to identify what it caches.

```bash
for f in "$CACHE_DIR"/*.json; do
  [[ "$f" == *.body.json ]] && continue
  python3 -c "
import json, sys
rec = json.load(open(sys.argv[1]))
if '/build/definitions?' in rec['key']:
    print(rec['key'], '->', rec['bodyPath'])
" "$f"
done
```

This prints one line per project whose definitions are cached, e.g.:

```
GET https://dev.azure.com/azure-sdk/internal/_apis/build/definitions?api-version=7.1 -> /.../.relay/cache/2e3c...65.body.json
```

### Step 3 — Read the body file

The body file is a JSON array of definition summaries:

```json
[
  {
    "id": 1001,
    "name": "cpp - vcpkg",
    "path": "\\",
    "revision": 42,
    "queueStatus": "enabled"
  }
]
```

Each entry has:

| Field         | Type   | Description                                |
|---------------|--------|--------------------------------------------|
| `id`          | number | ADO definition ID                          |
| `name`        | string | Human-readable pipeline name               |
| `path`        | string | Folder path (backslash-separated, `"\\"`=root) |
| `revision`    | number | Definition revision number                 |
| `queueStatus` | string | `"enabled"` or `"disabled"`                |

### Step 4 — Search for a definition by name

```bash
BODY_FILE="$CACHE_DIR/2e3c7c5b8e0f240fa7d91b73856a0605c5a64f0a23121e57aed72d5434e21765.body.json"
python3 -c "
import json, sys
defs = json.load(open(sys.argv[1]))
q = sys.argv[2].lower()
for d in defs:
    if q in d['name'].lower():
        print(f\"{d['id']:>6}  {d['name']}\")
" "$BODY_FILE" "vcpkg"
```

## Shortcut: Compute The Digest Directly

If you already know the org and project, you can compute the filename without scanning:

```python
import hashlib
org = "azure-sdk"
project = "internal"
key = f"GET https://dev.azure.com/{org}/{project}/_apis/build/definitions?api-version=7.1"
digest = hashlib.sha256(key.encode()).hexdigest()
# metadata: {digest}.json
# body:     {digest}.body.json
```

## Freshness

The metadata `.json` file contains `timestamp` (ISO 8601) and `ttlSeconds` (default 900 for definitions). Data older than the TTL is stale but still readable — it just means Relay would re-fetch on next UI access. For definition name lookups this staleness is almost never a problem since definitions change infrequently.

## What You Cannot Get From Disk Cache Alone

- **Build errors / task logs**: these are stored separately under `.relay/build/{buildId}/` and require the user to have viewed that specific build in Relay. If the user has a PAT available, hit the ADO API directly instead.
- **Queue metadata / parameters**: not cached on disk (fetched live per queue attempt).
- **Live build status**: the builds cache has a 60-second TTL and is usually stale.
