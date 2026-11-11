# Extension end-to-end test

Loads the real extension into real Chromium and drives real editor components against a real BrandSentinel server (in-memory database).

* Editors, served locally from npm (no internet needed): **TinyMCE** (iframe based, the WordPress classic editor), **Quill** (Medium-style),
  **Trix** (Rails ActionText / Basecamp), a plain **textarea**, and a **webmail-style contenteditable** (`div[role=textbox]`, how Gmail composes).
* Per editor (11 scenarios): pill appears, typed text matches the editor model, Check lists findings with citations, highlights, stale text is
  never overwritten, Apply replaces the exact span (editor API confirms), Dismiss, Save creates an item, audit log has `ext.check` with host and hash and the chain verifies.
* Also: auto-check, password / card / short-text fields are never sent, friendly rate-limit message, popup connect screen, key not visible to pages.

```
npm install
npm test            # needs ../server and ../extension; starts its own servers on ports 4050-4052
# options: SERVER_DIR=... CHROME_PATH=... SHOTS_DIR=... E2E_PORT=4050 npm test
```
Needs Playwright (`npm install` gets it) and a Chromium/Chrome that supports extensions in `--headless=new` mode
(`npx playwright install chromium`). Screenshots go to `./shots`.

**Not covered:** the hosted Gmail, WordPress.com, LinkedIn or X sites. They are not reachable from CI sandboxes and need a real login. The extension handles
their composers generically (contenteditable), so test them by hand once before relying on them.
