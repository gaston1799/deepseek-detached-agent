#!/usr/bin/env node
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

function usage() {
  return `dswait

Usage:
  dswait <file> [--timeout <ms>] [--interval <ms>]

Options:
  --timeout <ms>    Give up after this many milliseconds. Default: 600000
  --interval <ms>   Poll interval in milliseconds. Default: 1000
  -h, --help        Show help.
`;
}

function parseArgs(argv) {
  const opts = { timeout: 600000, interval: 1000 };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };

    if (arg === "-h" || arg === "--help") opts.help = true;
    else if (arg === "--timeout") opts.timeout = Number.parseInt(next(), 10);
    else if (arg === "--interval") opts.interval = Number.parseInt(next(), 10);
    else if (!opts.file) opts.file = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return opts;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function exists(path) {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

async function run() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    process.stdout.write(usage());
    return;
  }

  if (!opts.file) throw new Error("Provide a file path to wait for.");
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) throw new Error("--timeout must be a positive number.");
  if (!Number.isFinite(opts.interval) || opts.interval <= 0) throw new Error("--interval must be a positive number.");

  const target = resolve(opts.file);
  const deadline = Date.now() + opts.timeout;

  while (Date.now() <= deadline) {
    if (await exists(target)) return;
    await sleep(opts.interval);
  }

  process.exit(1);
}

run().catch(() => {
  process.exit(1);
});
