# Tooling Requests — Large Repository Support

This is a wishlist of tool/API improvements that would dramatically improve agent effectiveness in large (500+ file, nested, monorepo) codebases. Sorted roughly by impact.

---

## 1. Native Grep / Ripgrep Tool

**Problem:** Today the only way to search across files is `rg` via the shell (`run_cmd` / `run_powershell`). If the user blocks shell execution, all cross-file search is dead. Even when allowed, shell error handling is inconsistent across platforms.

**Ask:** A first-class `search_code` tool.

```ts
search_code({
  pattern: string,          // regex or literal
  path?: string,            // subdirectory to scope to (default: workspace root)
  glob?: string,            // file filter, e.g. "*.ts"
  ignore_case?: boolean,
  max_results?: number,     // default 200
  context_lines?: number,   // lines of surrounding context (0–5)
  respect_gitignore?: boolean // default true
})
```

---

## 2. Recursive File Listing with Filtering

**Problem:** `list_workspace_files` is flat (no tree), capped at 80 entries, and has no pattern filter. A monorepo with `packages/*/src` is unnavigable.

**Ask:** Upgrade `list_workspace_files`:

```ts
list_workspace_files({
  path?: string,
  recursive?: boolean,       // default false → backwards compat
  glob?: string,             // e.g. "src/**/*.ts"
  exclude_glob?: string,     // e.g. "**/node_modules/**"
  max?: number,              // default 200
  offset?: number,           // pagination cursor
  type?: "file" | "dir" | "all"
})
```

---

## 3. Batch / Multi-File Read

**Problem:** To understand a feature, I often need 3–6 files simultaneously. Each `read_text_file` is a round-trip. On large tasks this adds tens of seconds of latency.

**Ask:** Accept an array of file paths:

```ts
read_text_files({
  files: [
    { path: "src/a.ts", start_line?: number, end_line?: number },
    { path: "src/b.ts" }
  ]
})
// Returns: { [path]: string | { error: string } }
```

---

## 4. Git-Aware Primitives

**Problem:** `get_runtime_context` gives `git_branch` — that's it. No diff, no status, no blame. In a large repo, "what changed recently" is the single most important navigation signal.

**Ask:**

```ts
git_diff({
  staged?: boolean,
  unstaged?: boolean,
  target_branch?: string,  // e.g. "main"
  path?: string
})

git_status({ path?: string })

git_log({
  path?: string,
  max_entries?: number      // default 20
})

git_blame({
  file_path: string,
  start_line: number,
  end_line: number
})
```

These are strictly read-only. No commit, no push, no staging. The safety model is unchanged.

---

## 5. File Metadata

**Problem:** I can't see file size, modification time, or whether a file is binary without shelling out. A 50 MB minified bundle looks the same as a 200-byte config in `list_workspace_files`.

**Ask:** Add optional metadata to `list_workspace_files`:

```ts
list_workspace_files({
  include_metadata?: boolean   // default false
})
// Each entry gains: { size_bytes, modified_iso, is_binary }
```

Also expose a `stat_file(path)` for single-file checks—useful before deciding whether to read a potentially large file.

---

## 6. Multi-File Patch / Structured Edit

**Problem:** `patch_text_file` operates on one file, one old_string at a time. A refactor touching 8 files requires 8 sequential tool calls. Each risks the old_string not matching (whitespace drift), wasting the turn.

**Ask:**

```ts
patch_files({
  edits: [
    { path: string, old_string: string, new_string: string },
    ...
  ]
})
// Atomic: all must match or none apply. Returns per-file status.
```

Optionally, accept a unified-diff string that gets parsed and applied:

```ts
apply_diff({ diff: string })
```

---

## 7. Workspace-Level Context Cache / Working Set

**Problem:** Every new turn, I re-read the same key files (configs, package.json, main entry points) because I have no persistence between turns except the conversation itself. In large repos, the "orientation tax" is high.

**Ask:** A transient key-value store scoped to the session:

```ts
cache_set({ key: string, value: string })

cache_get({ key: string })  // → string | null
```

I'd cache things like "entry point is `src/index.ts`", "the router is in `src/router.ts`", "the DB schema is in `prisma/schema.prisma`". This shrinks the need to re-scan on every turn.

---

## 8. Glob-Based File Discovery (Without Shell)

**Problem:** `list_workspace_files` with glob support (request #2) would help, but for zero-shell environments, I still need a dead-simple `glob` tool:

```ts
glob({
  pattern: string,           // e.g. "packages/*/package.json"
  max?: number               // default 100
})
// Returns: string[] of matching paths
```

---

## 9. Streaming / Chunked Read for Large Files

**Problem:** `read_text_file` with `max_bytes` is awkward for iterating through a large file. I can't easily say "read the next 2000 bytes starting where I left off."

**Ask:** Add a `cursor` return so I can chain reads:

```ts
// Response includes:
{
  content: string,
  next_offset: number | null,   // null = EOF
  total_bytes: number
}
```

Then `read_text_file({ path, offset: next_offset, max_bytes: 2000 })` is natural.

---

## 10. Ignore-File Awareness

**Problem:** When I search or list, I hit `node_modules`, `.git`, `dist`, `__pycache__`, etc. I work around it with `rg --glob '!node_modules'` but it's manual and error-prone.

**Ask:** Tools that traverse the filesystem should automatically respect `.gitignore` and a configurable `exclude_patterns` list. A global config like:

```json
{
  "exclude_patterns": ["node_modules", ".git", "dist", "*.min.js"]
}
```

And an override per-tool-call: `exclude_patterns?: string[]`.

---

## Quick Hits (Lower Effort, Still Impactful)

| # | Ask | Why |
|---|-----|-----|
| 11 | `path_exists(path)` — check file/dir existence without listing | Avoids wasted `read_text_file` calls on missing files |
| 12 | `is_text_file(path)` — sniff first 512 bytes for null bytes | Avoids attempting to read PNGs/`.exe`/`.jar` |
| 13 | `get_related_files(path)` — return files imported by `path` (quick regex on import/require/include lines) | Jump-to-definition-lite without an LSP |
| 14 | Bump `max_entries` on `list_workspace_files` to at least 500 | Monorepos easily have 200+ files even excluding deps |
| 15 | `tree(path, max_depth)` — visual directory tree output | Fast mental model of repo structure |

---

## Summary

The highest-leverage additions are **grep** (#1), **recursive filtered listing** (#2), and **batch reads** (#3). Together they eliminate the "shell as bottleneck" problem and cut the round-trip count by 50–70% on large-repo tasks. Git-awareness (#4) and a working-set cache (#7) close the gap between a fresh agent session and an experienced developer who already knows where everything lives.
