# Complex Smoke App

This fixture is a fake service for testing DeepSeek tools on a larger workspace.

Smoke targets:
- Search for `COMPLEX_TARGET`.
- Use `get_related_files` on `src/main.js`, `src/routes/orders.js`, and `src/services/orderService.js`.
- Use `read_text_files` on multiple files under `src/`.
- Use `glob` with `src/**/*.js`, `config/*.json`, and `tests/**/*.spec.js`.
- Use `patch_files` to replace `PATCH_COMPLEX_ALPHA` and `PATCH_COMPLEX_BETA`.
- Use `tree` from `complex-app`.

