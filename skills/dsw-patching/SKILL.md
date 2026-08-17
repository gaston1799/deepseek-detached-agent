---
name: dsw-patching
description: Reliable file editing with the dsw patch tools — patch_files same-file multi-edit ordering, CRLF/LF-tolerant matching, and when to fall back to a script.
---

# dsw patching

## patch_files
- Multiple edits to the **same file apply in order** within one call: each
  `old_string` is matched against the content *as modified by earlier edits in
  the same call*.
- Preflight: every `old_string` must match before **any** file is written; if
  one fails, nothing is written.
- **CRLF/LF line endings are normalized for matching**, and inserted text uses
  the file's dominant line ending — an `old_string` written with `\n` matches a
  CRLF file.
- `replace_all: true` replaces every occurrence.

## patch_text_file
- Single replacement (first occurrence) or `replace_all`.
- Same CRLF/LF normalization.

## If "old_string not found"
1. Re-read the exact surrounding lines (`read_text_file`) and copy the text
   verbatim — check tabs vs spaces, trailing whitespace, invisible Unicode.
2. Shrink the anchor to a smaller unique fragment.
3. For huge/generated/minified files, `search_code` to find the line range, then
   patch a small unique window inside it.
4. Last resort: a temporary Node script using index/regex replacement with
   match-count assertions (`write_text_file` → `node script` → delete).

## Gotchas
- `write_text_file` writes exactly what you give it (LF); Windows checkouts are
  often CRLF — the patch tools now handle the mismatch, so do not rewrite whole
  files to "fix" line endings.
- When a patch result looks wrong, re-read the file and compare, never assume
  the tool reported truth.
