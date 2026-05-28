export function applyThinkingOptions(body, opts) {
  body.thinking = { type: opts.thinking };
  if (opts.thinking === "enabled") {
    body.reasoning_effort = opts.effort;
  }
  return body;
}
