# BrandSentinel browser extension (Chrome, Edge, Brave)

Check what you write against your brand guidelines **where you write it**: social composers, CMS editors, webmail.
Every finding shows the approved guideline, fact, claim or regulation behind it (evidence-or-silence), with a one-click fix.
Free: no Chrome Web Store account needed.

## 1. Install (2 minutes)
1. Sign in to your deployed BrandSentinel, open **Account**, and press **Download extension**. Unzip it somewhere permanent.
2. Open `chrome://extensions` (Edge: `edge://extensions`) and switch on **Developer mode**.
3. Click **Load unpacked** and choose the unzipped `brandsentinel-extension` folder. Pin the shield icon.

## 2. Connect
1. On the **Account** page create an **API key** (name it, for example, "Chrome on laptop"). It is shown once: copy it.
2. Click the extension icon. Server address: your Render URL, for example `https://your-app.onrender.com`. Paste the key.
3. Press **Save and test connection**. You should see "Connected to <your organisation> as <you>".
   Chrome may ask to allow access to your server; this is optional.

## 3. Use it
* Click into any text box. A small **BrandSentinel** pill appears at the bottom right.
* Click it (or just stop typing if "Check automatically" is on). Findings appear with severity, the flagged text and the **cited source**.
* **Use "..."** replaces exactly the flagged words. **Show in text** selects them. **Dismiss** hides a finding for this page.
* **Save to BrandSentinel** keeps the text as a content item so reviewers can approve it and issue a clearance certificate.
* **Deep check** also asks the optional AI assistant (only if your admin enabled it and Confidential Mode is off).
* Limits: 30 checks per minute and 3,000 per day per key, 20,000 characters per check. When a limit is reached the pill shows "Paused".

Works in plain text fields, textareas and rich editors (contenteditable, TinyMCE, Quill, Trix, CKEditor, ProseMirror, Gutenberg, webmail-style
boxes). Findings in rich editors are underlined with the browser's highlight API without changing your content.
Password and card fields, and text shorter than 8 characters, are never read.

## Privacy: what leaves your browser
* **Only the text of the text box you are checking**, and only when you click Check or when auto-check fires after you stop typing,
  and only **to your own BrandSentinel server**. Nothing goes to any third party by the extension.
* The page address (host name only), the editor type and a SHA-256 hash of the text are recorded in your organisation's audit log.
  The text itself is not written to the audit log by inline checks.
* The API key is stored in the extension's own storage and is readable only by the extension's background worker; web pages and the
  on-page script cannot read it. Turn off auto-check in the popup if you prefer to check only on demand.
* Revoke a lost or shared key any time on the Account page: it stops working immediately.

## Troubleshooting
| Symptom | Fix |
|---|---|
| "Could not reach ..." | Render's free plan sleeps after 15 idle minutes. Wait about a minute and try again. |
| "rejected this API key" | The key was revoked or mistyped. Create a new one on the Account page. |
| "Slow down ... Try again in N s" | Per-key rate limit. Wait, or turn auto-check off. |
| Pill never appears | Click inside the text box first. Chrome pages (`chrome://`), the Web Store and PDF viewers do not allow extensions. |
| Fix says "the text changed" | You kept typing after the check. The results were refreshed: apply the fix again. |
| Editor ignores the fix | A few custom editors block scripted edits: use **Show in text** and edit by hand. |
| Gmail / LinkedIn / X | Their composers are rich text boxes and are handled generically. They were not part of our automated tests (see extension-e2e/README.md). |

## For developers
Manifest V3. `background.js` (API calls, relays between frames), `content.js` (editor agent in every frame, UI in the top frame inside a
closed shadow root), `popup.*` (connect screen). API contract: `GET /api/gate/me`, `POST /api/gate/check`, `POST /api/gate/save`.
