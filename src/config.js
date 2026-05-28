import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export function configPath() {
  const base = process.env.APPDATA || process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "deepseek-detached-agent", "config.json");
}

export async function readConfig() {
  try {
    return JSON.parse(await readFile(configPath(), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

export async function writeConfig(config) {
  const file = configPath();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await chmod(file, 0o600);
  } catch {
    // Windows may ignore POSIX modes; the config still lives in the user profile.
  }
}

export async function getDeepSeekApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const config = await readConfig();
  return config.deepseekApiKey || "";
}

export async function setDeepSeekApiKey(apiKey) {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error("API key cannot be empty.");
  const config = await readConfig();
  config.deepseekApiKey = trimmed;
  await writeConfig(config);
}
