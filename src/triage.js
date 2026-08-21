import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { writeArtifact } from "./artifacts.js";

function asciiStrings(buffer, min = 5, max = 500) {
  const values = []; let current = "";
  for (const byte of buffer) {
    if (byte >= 32 && byte < 127) current += String.fromCharCode(byte);
    else { if (current.length >= min) values.push(current); current = ""; if (values.length >= max) break; }
  }
  if (current.length >= min && values.length < max) values.push(current);
  return values;
}

function unique(values) { return [...new Set(values)].slice(0, 200); }

export async function peTriage({ cwd = process.cwd(), taskId, path }) {
  const file = resolve(cwd, path);
  const info = await stat(file);
  if (!info.isFile()) throw new Error("PE triage path must be a file.");
  const buffer = await readFile(file);
  const result = { path, bytes: buffer.length, is_pe: false, architecture: null, sections: [], imports: [], exports: [], digital_signature: null, clr: false, electron: false, indicators: [], urls: [], domains: [], paths: [] };
  if (buffer.length < 0x40 || buffer.toString("ascii", 0, 2) !== "MZ") return result;
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 24 > buffer.length || buffer.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") return result;
  result.is_pe = true;
  const machine = buffer.readUInt16LE(peOffset + 4);
  result.architecture = machine === 0x8664 ? "x64" : machine === 0x14c ? "x86" : machine === 0xaa64 ? "arm64" : `machine_0x${machine.toString(16)}`;
  const sectionCount = buffer.readUInt16LE(peOffset + 6);
  const optionalSize = buffer.readUInt16LE(peOffset + 20);
  const optionalOffset = peOffset + 24;
  const magic = optionalOffset + 2 <= buffer.length ? buffer.readUInt16LE(optionalOffset) : 0;
  const dataDirectoryOffset = optionalOffset + (magic === 0x20b ? 112 : 96);
  const importRva = dataDirectoryOffset + 8 <= buffer.length ? buffer.readUInt32LE(dataDirectoryOffset + 8) : 0;
  const clrRva = dataDirectoryOffset + 8 * 15 + 4 <= buffer.length ? buffer.readUInt32LE(dataDirectoryOffset + 8 * 14) : 0;
  result.clr = Boolean(clrRva);
  const sectionOffset = optionalOffset + optionalSize;
  for (let i = 0; i < sectionCount && sectionOffset + i * 40 + 40 <= buffer.length; i += 1) {
    const at = sectionOffset + i * 40;
    result.sections.push({ name: buffer.toString("ascii", at, at + 8).replace(/\0.*$/, ""), virtual_size: buffer.readUInt32LE(at + 8), raw_size: buffer.readUInt32LE(at + 16), characteristics: `0x${buffer.readUInt32LE(at + 36).toString(16)}` });
  }
  const strings = asciiStrings(buffer, 6, 2000);
  result.urls = unique(strings.filter((value) => /^https?:\/\//i.test(value)));
  result.domains = unique(strings.filter((value) => /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(value)));
  result.paths = unique(strings.filter((value) => /^(?:[A-Za-z]:\\|\\\\|\/home\/|\/opt\/)/.test(value)));
  result.imports = unique(strings.filter((value) => /\.(?:dll|sys)$/i.test(value)));
  result.electron = strings.some((value) => /electron|chromium|asar|node\.dll|node_modules/i.test(value));
  result.digital_signature = strings.some((value) => /Authenticode|WIN_CERTIFICATE/i.test(value)) ? "indicated" : "unknown";
  if (result.electron) result.indicators.push("electron_or_chromium_strings");
  if (result.clr) result.indicators.push("clr_dotnet");
  if (result.sections.some((section) => section.raw_size > 20 * 1024 * 1024)) result.indicators.push("large_embedded_section");
  const artifact = await writeArtifact({ cwd, taskId, kind: "pe-triage", name: `${path.split(/[\\/]/).pop()}.triage.json`, data: JSON.stringify(result, null, 2), metadata: { source: path } });
  return { ...result, artifact };
}
