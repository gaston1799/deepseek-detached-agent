# Architecture Notes

`src/main.js` wires route modules into a tiny fake router.

The service layer intentionally contains patch markers:

- `PATCH_COMPLEX_ALPHA`
- `PATCH_COMPLEX_BETA`

The search marker `COMPLEX_TARGET` appears across JavaScript, JSON, and Markdown files.

