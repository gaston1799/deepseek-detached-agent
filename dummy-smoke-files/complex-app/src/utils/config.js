import fs from "node:fs";
import path from "node:path";

export function loadConfig(relativePath) {
  const absolute = path.resolve(process.cwd(), relativePath);
  return JSON.parse(fs.readFileSync(absolute, "utf8"));
}

