import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { peTriage } from "../src/triage.js";

const cwd = await mkdtemp(join(tmpdir(), "dsw-triage-"));
try {
  const file = join(cwd, "sample.exe");
  const buffer = Buffer.alloc(512);
  buffer.write("MZ", 0, "ascii");
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.write("PE\0\0", 0x80, "ascii");
  buffer.writeUInt16LE(0x8664, 0x84);
  buffer.writeUInt16LE(1, 0x86);
  buffer.writeUInt16LE(240, 0x94);
  buffer.writeUInt16LE(0x20b, 0x98);
  buffer.write("electron chromium example.com https://example.com", 300, "ascii");
  await writeFile(file, buffer);
  const result = await peTriage({ cwd, taskId: "test", path: "sample.exe" });
  assert.equal(result.is_pe, true);
  assert.equal(result.architecture, "x64");
  assert.equal(result.electron, true);
  assert.ok(result.artifact.id);
  console.log("PE triage checks passed");
} finally { await rm(cwd, { recursive: true, force: true }); }
