import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedSearch } from "../src/search.js";
import { readArtifactRange, searchArtifact } from "../src/artifacts.js";

const root = await mkdtemp(join(tmpdir(), "dsw-search-"));
try {
  await writeFile(join(root, "normal.js"), "alpha\nneedle here\nomega\nneedle again\n", "utf8");
  await writeFile(join(root, "bundle.js"), `const x="${"needle ".repeat(3000)}";`, "utf8");

  const first = await boundedSearch({ cwd: root, taskId: "test", pattern: "needle", path: "normal.js", maxMatches: 1, maxTotalChars: 2000, contextChars: 20 });
  assert.equal(first.matches.length, 1);
  assert.ok(first.next_page_token);
  assert.ok(first.matches[0].path);
  assert.equal(first.matches[0].line, 2);
  assert.ok(first.matches[0].snippet.length <= 1200);
  assert.ok(first.artifact.id);

  const second = await boundedSearch({ cwd: root, taskId: "test", pattern: "needle", path: "normal.js", maxMatches: 1, pageToken: first.next_page_token });
  assert.equal(second.matches.length, 1);
  assert.notEqual(second.matches[0].character_offset, first.matches[0].character_offset);

  const bundle = await boundedSearch({ cwd: root, taskId: "test", pattern: "needle", path: "bundle.js", maxMatches: 2, contextChars: 10 });
  assert.equal(bundle.matches[0].minified, true);
  assert.ok(bundle.matches[0].snippet.length < 100);

  const range = await readArtifactRange({ cwd: root, taskId: "test", artifact: first.artifact.id, maxBytes: 100 });
  assert.ok(range.content.includes("matches"));
  const artifactMatches = await searchArtifact({ cwd: root, taskId: "test", artifact: first.artifact.id, pattern: "needle", maxMatches: 1 });
  assert.equal(artifactMatches.matches.length, 1);
  console.log("bounded search/artifact checks passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
