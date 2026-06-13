# Smoke App Bug Report

Audit of `complex-app` based on the README smoke targets.  
Running on: **Node v23.6.0**, **win32 x64**, **workspace root** = `complex-app`.

---

## 🐛 Bug 1 — Missing `package.json` (FATAL)

The entire project uses ES module syntax (`import`/`export` across 10+ files) but **no `package.json` exists**. Without `{ "type": "module" }`, Node.js will refuse to load any `.js` file containing `import` statements. The app cannot start, and the tests cannot run.

**Files affected:** All `.js` files under `src/` and `tests/`.

---

## 🐛 Bug 2 — Wrong config path in `src/main.js`

**File:** `src/main.js`, line 7  
**Code:** `const config = loadConfig("../config/app.json");`  
**Bug:** `loadConfig()` resolves relative to `process.cwd()` (project root).  
`path.resolve(process.cwd(), "../config/app.json")` resolves to **one directory above the workspace** (e.g., `...\Documents\deepseek agent\config\app.json`), which does not exist.  
**Fix:** Change to `"config/app.json"` (no `..`).

---

## 🐛 Bug 3 — JSON imports lack import attributes

**Files:**
- `src/services/orderService.js` — `import seedOrders from "../data/orders.json"`
- `src/services/userService.js` — `import seedUsers from "../data/users.json"`

**Bug:** Node.js requires either `assert { type: "json" }` (Node <18) or `with { type: "json" }` (Node 18+) when importing a JSON module. Without an import attribute this may fail or produce a deprecation warning in strict ESM mode.

**Fix:**  
```js
import seedOrders from "../data/orders.json" with { type: "json" };
import seedUsers from "../data/users.json" with { type: "json" };
```

---

## 🐛 Bug 4 — Tests exist but cannot be executed

**Files:** `tests/orders.spec.js`, `tests/users.spec.js`  
**Bug:** Both test files export functions (`testListOrders`, `testCreateOrder`, `testListUsers`) but **no test runner or entry point** imports or invokes them. There is no `package.json` with a test command, no `node --test` script, and no `run()` call. The test code is dead code.

---

## 🐛 Bug 5 — Placeholder/marker strings left in runtime code

The following hardcoded placeholder strings appear in production paths and are almost certainly unintentional for real use:

| File | String | Likely Intent |
|---|---|---|
| `src/services/orderService.js` | `status: "PATCH_COMPLEX_ALPHA"` | Should be a dynamic/default status like `"pending"` |
| `src/services/orderService.js` | `note: "COMPLEX_TARGET_ORDER"` | Fallback placeholder leaked into production |
| `src/services/userService.js` | `marker: "COMPLEX_TARGET_USER"` | Debug/marker field returned to API consumers |
| `src/main.js` | `marker: "COMPLEX_TARGET_MAIN"` | Debug/marker field returned from `bootstrap()` |
| `config/app.json` | `"COMPLEX_TARGET_CONFIG"` | Debug flag value |

These `COMPLEX_TARGET_*` and `PATCH_COMPLEX_*` strings are smoke-test markers that should be replaced with real values or removed before deployment.

---

## 🐛 Bug 6 — No `.gitignore`

There is no `.gitignore`, so `node_modules/`, `.env`, and any generated artifacts would be tracked if added.

---

## Summary

| # | Severity | Issue |
|---|---|---|
| 1 | 🔴 **FATAL** | Missing `package.json` — app cannot load ESM |
| 2 | 🔴 **FATAL** | Config path resolved above project root |
| 3 | 🟡 **HIGH** | JSON imports missing required attributes |
| 4 | 🟡 **HIGH** | Tests are dead code with no runner |
| 5 | 🟢 **LOW** | Placeholder/marker strings leaked into runtime |
| 6 | 🟢 **LOW** | Missing `.gitignore` |

To fix all bugs at once: create `package.json` with `"type": "module"`, fix the config path in `main.js`, add JSON import attributes, and wire up a test runner.
