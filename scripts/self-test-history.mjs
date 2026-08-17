// Self-test for src/history.js resume rendering.
import assert from "node:assert";
import { historyBody, historyTitle, renderChatHistory } from "../src/history.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  PASS ${name}`);
}

const colorOff = { color: false };

check("historyTitle roles", () => {
  assert.equal(historyTitle({ role: "user" }), "you");
  assert.equal(historyTitle({ role: "assistant" }), "assistant");
  assert.equal(historyTitle({ role: "tool" }), "tool");
});

check("historyBody truncates long assistant content", () => {
  const long = "x".repeat(2000);
  const body = historyBody({ role: "assistant", content: long });
  assert.ok(body.endsWith("..."), "truncated with marker");
  assert.ok(body.length < 950, "capped near 900 chars");
});

check("renderChatHistory shows FULL final assistant message", () => {
  const tail = "FINAL_ANSWER_SENTINEL_" + "y".repeat(13000); // > 12000 cap, sentinel at front
  const long = "x".repeat(2000);
  const session = {
    config: { permission: "ask" },
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: long },           // older, will truncate
      { role: "user", content: "second question" },
      { role: "assistant", content: `# Heading\n\n${tail}` }, // last, full
    ],
  };
  const chunks = [];
  renderChatHistory(colorOff, session, { write: (s) => chunks.push(s) });
  const out = chunks.join("");
  assert.ok(out.includes("assistant (latest)"), "last message marked latest");
  assert.ok(out.includes("FINAL_ANSWER_SENTINEL_"), "full last answer head present (not truncated at 900)");
  assert.ok(out.includes("… [truncated"), "over-long final message capped with marker");
  assert.ok(out.includes("..."), "older message truncated");
  assert.ok(out.includes("4 of 4 shown"), "count line correct");
});

check("renderChatHistory shows hidden-count for old messages", () => {
  const messages = [];
  for (let i = 0; i < 30; i += 1) {
    messages.push({ role: "user", content: `q${i}` }, { role: "assistant", content: `a${i}` });
  }
  const chunks = [];
  renderChatHistory(colorOff, { config: {}, messages }, { write: (s) => chunks.push(s) });
  const out = chunks.join("");
  assert.ok(out.includes("42 older messages hidden"), "hidden count noted");
  assert.ok(out.includes("a29"), "last answer visible");
});

check("renderChatHistory empty session", () => {
  const chunks = [];
  renderChatHistory(colorOff, { config: {}, messages: [] }, { write: (s) => chunks.push(s) });
  assert.ok(chunks.join("").includes("No previous messages."));
});

console.log(`\nAll ${passed} history checks passed.`);
