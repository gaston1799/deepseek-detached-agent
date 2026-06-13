# Smoke Tests Report

**Date:** 2026-06-01  
**Workspace:** `dummy-smoke-files`  
**Toolset:** DeepSeek local terminal agent tools

---

## Workspace Structure

```
dummy-smoke-files/
├── README.md
├── nested/
│   └── level-one/
│       └── level-two/
│           └── deep.txt
├── notes/
│   ├── large-chunk.txt
│   └── todo.txt
└── src/
    ├── app.js
    ├── data.json
    └── util.js
```

---

## Test 1: `search_code` — Find `SMOKE_TARGET`

**Command:** `search_code(pattern="SMOKE_TARGET")`

**Result:** ✅ Passed

**Matches found (6 files):**

| File | Line | Content |
|------|------|---------|
| `README.md` | 6 | `- Search for \`SMOKE_TARGET\`.` |
| `src/app.js` | 6 | `` return `SMOKE_TARGET app ${message}`; `` |
| `src/data.json` | 4 | `"marker": "SMOKE_TARGET data"` |
| `notes/todo.txt` | 3 | `1. Use search_code to find SMOKE_TARGET.` |
| `notes/todo.txt` | 8 | `SMOKE_TARGET notes` |
| `nested/level-one/level-two/deep.txt` | 3 | `SMOKE_TARGET deep nested file` |

**Bug:** ⚠️ `search_code` also returns matches from `.deepseek-watch/sessions/*.json` (internal session cache files). These are not user-created workspace files and clutter results. The tool should exclude the `.deepseek-watch` directory from searches.

---

## Test 2: `glob` — Find files by pattern

**Command:** `glob(pattern="**/*.js")`

**Result:** ✅ Passed

**Found:** `src/app.js`, `src/util.js` (2 files)

---

**Command:** `glob(pattern="**/*.md")`

**Result:** ✅ Passed

**Found:** `README.md` (1 file)

---

## Test 3: `read_text_files` — Batch read multiple files from `src/`

**Command:** `read_text_files(files=[{path:"src/app.js"}, {path:"src/util.js"}, {path:"src/data.json"}])`

**Result:** ✅ Passed

**Contents retrieved:**

- **`src/app.js`** — Imports `./util.js` and `./data.json`, exports `runSmoke()` which returns a `SMOKE_TARGET` string
- **`src/util.js`** — Exports `formatMessage(name)` and `patchTarget` (originally `"PATCH_ME"`)
- **`src/data.json`** — JSON with `name`, `purpose`, and `marker` fields

---

## Test 4: `patch_text_file` — Replace `PATCH_ME` with `PATCHED`

**Command:** `patch_text_file(path="src/util.js", old_string="PATCH_ME", new_string="PATCHED")`

**Result:** ✅ Passed

**Before:** `export const patchTarget = "PATCH_ME";`  
**After:** `export const patchTarget = "PATCHED";`

Single replacement applied cleanly.

---

## Test 5: `get_related_files` — Inspect imports from `src/app.js`

**Command:** `get_related_files(path="src/app.js")`

**Result:** ✅ Passed

**Dependencies resolved:**

| Import Statement | Resolved Path |
|-----------------|---------------|
| `import { formatMessage } from "./util.js"` | `./util.js` |
| `const data = require("./data.json")` | `./data.json` |

Both ES module `import` and CommonJS `require()` were correctly detected.

---

## Bonus Tests

### `tree` — Directory tree visualization

**Command:** `tree(path="src")`

**Result:** ✅ Passed

Correctly rendered the 3 files under `src/`.

### `read_text_file` — Chunk-based file reading (`notes/large-chunk.txt`)

**Result:** ✅ Passed (file available for chunked read testing)

File is 901 bytes, 30 lines of repeated "chunk smoke content" — designed to test `offset`/`max_bytes` parameters.

### `stat_file` + `path_exists` — File metadata

**Result:** ✅ Passed

`notes/large-chunk.txt` correctly reported as 901 bytes, non-binary, last modified 2026-06-01T04:28:40.

---

## Summary

| Test | Tool | Status | Notes |
|------|------|--------|-------|
| 1 | `search_code` | ⚠️ Passed | Bug: session cache files leak into results |
| 2 | `glob` | ✅ Passed | Correctly filtered by JS and MD patterns |
| 3 | `read_text_files` | ✅ Passed | Batch read all 3 src files in one call |
| 4 | `patch_text_file` | ✅ Passed | `PATCH_ME` → `PATCHED` applied successfully |
| 5 | `get_related_files` | ✅ Passed | Detected both `import` and `require()` |
| Bonus | `tree` | ✅ Passed | Clean visualization |
| Bonus | `stat_file` / `path_exists` | ✅ Passed | Metadata accurate |

**Bugs Found: 1**
- `search_code` includes `.deepseek-watch/sessions/*.json` in results — should exclude internal session data.
