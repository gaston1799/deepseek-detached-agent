export const PROVIDERS = {
  deepseek: {
    label: "DeepSeek",
    envKey: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    contextLimit: 1_048_576
  },
  glm: {
    label: "GLM",
    envKey: "GLM_API_KEY",
    baseUrl: "https://api.z.ai/api/paas/v4",
    model: "glm-4.7",
    contextLimit: 204_800
  }
};

export function normalizeProvider(provider) {
  const value = String(provider || "deepseek").trim().toLowerCase();
  if (!PROVIDERS[value]) throw new Error(`Unknown provider '${provider}'. Use deepseek or glm.`);
  return value;
}

export function providerConfig(provider) {
  return PROVIDERS[normalizeProvider(provider)];
}

export function contextLimitFor(provider, model) {
  const normalized = normalizeProvider(provider);
  const name = String(model || providerConfig(normalized).model).toLowerCase();
  if (normalized === "glm" && /glm-4\.5|glm-4-32b/.test(name)) return 131_072;
  return providerConfig(normalized).contextLimit;
}
