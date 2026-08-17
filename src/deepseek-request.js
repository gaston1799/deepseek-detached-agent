export function applyThinkingOptions(body, opts) {
  // Accept both { thinking: "enabled" } (wrapper opts) and { type: "disabled" }
  // (compactor) shapes. Without a usable value, omit `thinking` entirely so the
  // request never sends an empty object (DeepSeek 400s on thinking missing `type`).
  const thinkingType = opts.thinking ?? opts.type;
  if (thinkingType !== undefined && thinkingType !== null) {
    body.thinking = { type: thinkingType };
    if (thinkingType === "enabled") {
      body.reasoning_effort = opts.effort;
    }
  }
  return body;
}
