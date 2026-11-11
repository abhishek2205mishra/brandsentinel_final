# BrandSentinel v2.1 — Deployment Guide (Render + MongoDB Atlas + free hosted AI)

This guide takes the project from your VS Code folder to a live URL. Everything used here has a free tier. No Ollama or local model is needed.

## Start here: the whole path in 10 steps (from zero to a live URL)

1. **Install tools:** Node.js 22 LTS (nodejs.org), Git (git-scm.com), VS Code. Create free accounts on GitHub, MongoDB Atlas, Render, and Google AI Studio (or Groq).
2. **Unzip** `brandsentinel-v2.1.zip` and open the `bs-pro` folder in VS Code (File → Open Folder).
3. **Atlas:** follow section 2 (user, `0.0.0.0/0`, connection string). Never paste the string into chat or commit it.
4. **AI key:** section 3 (free Gemini key).
5. **Run locally:** section 4. `npm run db:check` must say "All good". This catches 90% of deploy problems in 30 seconds.
6. **GitHub:** section 5. Create an empty repo (no README), push the project. Confirm `server/.env` is NOT on GitHub.
7. **Render:** section 6. New → Blueprint → pick the repo → enter `MONGODB_URI` and `GEMINI_API_KEY` → Apply.
8. **Wait** for the build (3 to 6 minutes). Watch the Logs tab. "BrandSentinel running on port" means it is up.
9. **Verify:** section 7 checklist.
10. **Before sharing:** change demo passwords, or set `SEED_DEMO=false` and `ALLOW_REGISTRATION=false` in Render → Environment.

**Updating later:** change code, `git add . && git commit -m "msg" && git push`. Render redeploys automatically.

---

## UI redesign (v2.1)

No backend or API changes: every feature works as before (31/31 server tests pass; the browser flow was re-tested end to end).

- **Themes:** "Midnight" (dark, default) and "Pearl" (light). Toggle with the sun/moon button (also on the login page). The choice is remembered in the browser.
- **Look:** glass surfaces, soft shadows, 20 to 26px rounded corners, violet → indigo → sky gradient accents, cyan highlights, mesh-gradient background.
- **Font:** Plus Jakarta Sans, bundled with the app (no external font request, so the CSP stays strict).
- **Login / Sign up:** split screen with animated gradient hero and floating preview cards, floating-label inputs, glowing button with loading spinner, one-click demo roles.
- **Charts (Recharts):** gradient area charts, gradient bars, donut, progress ring, sparklines, themed glass tooltips, only faint horizontal grid lines. Key metrics show trend badges (green = good, red = bad, e.g. fewer issues is green) comparing the last 7 days with the 7 before.
- **Dashboard:** bento grid, staggered fade-in-up animation (disabled automatically for users who prefer reduced motion).
- **Content list:** click any column header to sort (keyboard accessible).
- **Design tokens** live at the top of `client/src/styles.css`; change `--brand`, `--brand-2` and `--grad` to re-colour the whole app.

---

## 0. What changed from the demo version

| Area | Demo version | v2 (this project) |
|---|---|---|
| Database | SQLite file | **MongoDB Atlas** (free M0). Same numeric ids, same API, so the UI behaves exactly as before |
| AI assistant | Local Ollama | **Hosted Gemini or Groq** (free tiers). Same safety gates: redaction, quotes must exist verbatim, clause must exist, Purpose Lock, ledger entry, Confidential Mode blocks it entirely |
| Uploaded files | Server disk | Stored in MongoDB (Render's disk is wiped on every deploy) |
| Security | Basic | Helmet security headers + CSP, per-IP rate limits (API, sign-up, gate API, submissions), NoSQL-injection sanitising, async bcrypt, production refuses to start with weak or missing secrets |
| Reliability | Single process | Health check with DB ping, graceful shutdown, request ids + JSON logs, audit log safe under concurrent writers, AI circuit breaker (a quota error never slows reviews) |
| New features | – | Fuzzy brand-name matching (catches "Novabrw"), more claim patterns (award, clinically tested, lifetime guarantee…), inclusive-language pack (INC-1), printable **Review Report**, change password, **System status** and **AI test connection** in Governance, `npm run db:check` |
| Accuracy | 40 labelled samples | 60 labelled samples (incl. 19 tricky clean ones): precision 1.0, recall 1.0 |
| Hosting | local only | `render.yaml`, `Dockerfile`, `vercel.json`, GitHub Actions CI |

Everything in the original feature list still works. The 19 original tests were ported and pass, and 12 more were added (31 total).

---

## 1. Environment variables (what YOU must set)

Set these in `server/.env` locally, and in the Render dashboard for production. Never commit real values.

| Variable | Required | What it is | Where to get it |
|---|---|---|---|
| `MONGODB_URI` | **Yes** | Atlas connection string | Atlas → Connect → Drivers (Step 2) |
| `MONGODB_DB` | No (default `brandsentinel`) | Database name | You choose |
| `JWT_SECRET` | **Yes** | Signs login tokens, 32+ characters | Generate (below) |
| `CERT_SECRET` | **Yes** | Signs clearance certificates, 32+ characters. **Never change it after approvals exist**, or old certificates stop verifying | Generate (below) |
| `GEMINI_API_KEY` | For AI (pick one) | Google AI Studio key | aistudio.google.com → Get API key (Step 3) |
| `GROQ_API_KEY` | For AI (alternative) | Groq key | console.groq.com → API Keys |
| `LLM_PROVIDER` | No | `gemini` or `groq`. Auto-detected from whichever key is set | |
| `GEMINI_MODEL` / `GROQ_MODEL` | No | Model names. Defaults: `gemini-2.5-flash`, `llama-3.3-70b-versatile`. **Provider model names change over time**: if the test in Step 7 fails with HTTP 404, pick a current free model from the provider's docs and set this variable | |
| `CLIENT_ORIGIN` | Only for split hosting | Your Vercel URL(s), comma-separated | Step 9 |
| `SEED_DEMO` | No (default `true`) | Loads the NovaBrew demo organisation if the database is empty | |
| `ALLOW_REGISTRATION` | No (default `true`) | Lets anyone create an organisation from the login page. Set `false` for a locked-down demo | |
| `SLACK_WEBHOOK_URL` | No | Posts notifications to Slack | Slack incoming webhook |
| `NODE_ENV` | Production | `production` on Render (the blueprint sets it) | |

Generate the two secrets (run twice, use a different value for each):
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

**Security rule:** your Atlas username and password are credentials. Keep them only in `.env` and the Render dashboard. If you ever paste them into a chat, a screenshot or Git, reset the password in Atlas → Database Access immediately.

---

## 2. MongoDB Atlas (free)

1. Sign in at cloud.mongodb.com and open your cluster (`brandsentinel`, free M0).
2. **Database Access → Add New Database User.** Authentication: Password. Pick a username and a strong password (letters and digits only avoids encoding trouble). Role: **Read and write to any database**.
3. **Network Access → Add IP Address → "Allow access from anywhere" (`0.0.0.0/0`).** Render's free tier has no fixed IP, so this is required. Security still comes from the password and TLS.
4. **Database → Connect → Drivers.** Copy the string. Yours looks like:
   ```
   mongodb+srv://<db_username>:<db_password>@brandsentinel.rffklws.mongodb.net/?retryWrites=true&w=majority
   ```
   Replace `<db_username>` and `<db_password>` with your values (remove the `<` `>`). If the password has special characters, URL-encode them (`@` → `%40`, `#` → `%23`, `/` → `%2F`).
5. No collections need creating. The app creates them and all indexes automatically.

## 3. Hosted AI key (free, optional but recommended)

**Gemini:** open aistudio.google.com, sign in, **Get API key → Create API key**. Use it as `GEMINI_API_KEY`.
**Groq (alternative):** console.groq.com → API Keys → Create. Use it as `GROQ_API_KEY`.
Free tiers have rate limits. The app handles them: it retries once, then pauses AI for a minute and carries on with the rules engine, so reviews never fail because of the AI.

## 4. Run it locally first (recommended)

Requires Node 20+ (22 recommended).
```bash
cd server
npm install
cp .env.example .env          # Windows: copy .env.example .env
# edit server/.env: fill MONGODB_URI, JWT_SECRET, CERT_SECRET (and GEMINI_API_KEY)
npm run db:check              # must print "All good"
npm run seed                  # loads the NovaBrew demo data into Atlas (about 1 to 2 minutes)
cd ../client
npm install
npm run build
cd ../server
npm start                     # open http://localhost:4000
```
Demo logins (password `Demo@1234`): `admin@`, `creator@`, `kabir@`, `reviewer@`, `approver@`, `agency@`, `auditor@` all at `novabrew.test`.

Development with live reload: `npm run dev` in `server`, and `npm run dev` in `client` (open http://localhost:5173).
No Atlas yet? Leave `MONGODB_URI` empty and the server uses an in-memory database (data is lost on restart). Good for a quick look only.

## 5. Put the code on GitHub

```bash
cd brandsentinel            # the project root
git init
git add .
git commit -m "BrandSentinel v2"
git branch -M main
git remote add origin https://github.com/<you>/brandsentinel.git
git push -u origin main
```
`.gitignore` already excludes `node_modules`, `client/dist` and `server/.env`. Check that `.env` is not in the commit.

## 6. Deploy on Render (one service: UI + API)

1. render.com → **New → Blueprint** → connect the GitHub repo. Render reads `render.yaml`.
   (Manual alternative: New → Web Service, Runtime Node, Build command `npm --prefix client ci --include=dev && npm --prefix client run build && npm --prefix server ci --omit=dev`, Start command `npm --prefix server start`, Health check path `/api/health`.)
2. When asked, fill the variables marked "sync: false": `MONGODB_URI`, `GEMINI_API_KEY` (and `GROQ_API_KEY` if used). `JWT_SECRET` and `CERT_SECRET` are generated for you.
3. Deploy. The first build takes a few minutes. Open the `https://<name>.onrender.com` URL.
4. On first start the server loads the demo organisation in the background. Give it 1 to 2 minutes, then sign in with `admin@novabrew.test` / `Demo@1234`. (If you already ran `npm run seed` locally against the same Atlas database, it is already there.)
5. **Change the demo passwords** (Account page) or set `SEED_DEMO=false` and `ALLOW_REGISTRATION=false` before sharing the link publicly.

**Free tier behaviour:** Render free web services sleep after about 15 minutes idle and take up to a minute to wake. Before a demo, open the URL once. To keep it warm, add a free UptimeRobot monitor on `https://<name>.onrender.com/api/health` every 5 minutes.

## 7. Verify the deployment (2-minute checklist)

1. `https://<name>.onrender.com/api/health` returns `{"ok":true,"db":"up",...}`.
2. Sign in as **admin** → Governance → Settings and privacy → **System status** shows Database `mongo · connected`.
3. Same page: the AI toggle section shows your provider. Tick "Use the AI assistant", click **Test connection**. You want "working · N ms".
4. New review → paste: `Our new roast is India's #1 coffee, now 30% off this festive offer!!! Visit Novabrw today.` → you should see claims, facts, tone and a "looks like a misspelling" finding, each citing its source.
5. Open the item → **Report** opens a printable report (use Print → Save as PDF).
6. Governance → AI disclosure ledger shows the model calls with `sent externally: yes` and the redaction count. Turn on Confidential Mode and re-check: the ledger records the AI call as blocked.

## 8. Tests and quality gates

```bash
cd server
npm test            # 31 tests (memory database)
npm run eval        # 60-sample precision/recall report
npm run db:check    # connection check for your Atlas string
# Against a real MongoDB (use a throwaway database; the name MUST end in _test):
MONGODB_DB=brandsentinel_test npm run test:mongo
```
`test:mongo` refuses to run unless the database name ends in `_test`, so it can never wipe your real data. GitHub Actions (`.github/workflows/ci.yml`) runs tests, eval and the client build on every push.

## 9. Optional: frontend on Vercel, API on Render

Only if you specifically want Vercel. The simplest setup is Render alone (Step 6).
1. Deploy the API on Render as in Step 6, and add `CLIENT_ORIGIN=https://<your-app>.vercel.app`.
2. Vercel → New Project → import the repo → **Root Directory: `client`** → Framework: Vite. Add environment variable `VITE_API_URL=https://<name>.onrender.com` (no trailing slash). Deploy.
3. Do not host the Express API itself on Vercel. It needs a long-running server, uploads and a persistent database pool, which suit Render (or a container) better.

## 10. Container alternative

`docker build -t brandsentinel . && docker run -p 4000:4000 --env-file server/.env -e NODE_ENV=production brandsentinel`

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| `Configuration error: JWT_SECRET must be…` | Set both secrets (32+ chars) in Render env vars |
| `db:check` says bad auth | Wrong username/password, or special characters not URL-encoded |
| `db:check` times out | Atlas Network Access must include `0.0.0.0/0` |
| Login says wrong password right after first deploy | The demo data is still loading (check `/api/health` → `"seeding":false`) |
| AI test fails with HTTP 404 | The model name is outdated. Set `GEMINI_MODEL` or `GROQ_MODEL` to a current free model |
| AI test fails with HTTP 429 | Free-tier rate limit. Wait a minute, or switch provider |
| Page loads but API calls fail (split hosting) | `VITE_API_URL` missing at build time, or `CLIENT_ORIGIN` does not match your Vercel URL exactly |
| Old approvals no longer verify | `CERT_SECRET` was changed. Restore the old value |

## 12. Honest limitations

- **Verification gap:** the MongoDB layer was tested here against an in-process engine that implements the same interface and the same query operators, and the Atlas-specific code (connection, index creation, counters) is a thin wrapper around the official driver. It was **not** run against a live MongoDB or Atlas in my environment. That is why `npm run db:check` and `npm run test:mongo` exist: run both once with your connection string before the demo.
- The hosted AI could not be called live from here either. The Gemini and Groq request/response handling was tested against a mock server that follows their documented formats.
- Accuracy numbers come from our own labelled set, so they show no regressions, not real-world accuracy.
- Rule-based checks are conservative by design. The AI assistant adds nuance but is always verified and never publishes anything.
- Regulatory packs are plain-language summaries, not legal advice.
- Still not built: Chrome extension, Figma plugin, video checks, SSO, email delivery (notifications are in-app and optional Slack).
- Single-instance assumptions: login rate limiting is in memory. For several instances, put a shared limiter in front.

## 13. Round 3 upgrades: what to set and how to use them

Everything below works on the free Render + Atlas setup. **Nothing new is mandatory**: with no new variables set, the deployment behaves as before and the new screens still work (email is simply off).

### New environment variables (all optional)

| Variable | Purpose | Default |
|---|---|---|
| `PUBLIC_URL` | Your public address, e.g. `https://your-app.onrender.com`. Used in emails and QR codes. Render supplies `RENDER_EXTERNAL_URL`, which is used if this is empty. | auto |
| `EMAIL_PROVIDER` | `brevo` or `resend` (HTTPS APIs; Render free blocks SMTP). | `none` |
| `BREVO_API_KEY` / `RESEND_API_KEY` | Key for the chosen provider. | empty |
| `EMAIL_FROM`, `EMAIL_FROM_NAME` | Sender. Must be a sender/domain you verified with the provider. | empty |
| `SLA_TICK_MINUTES` | How often deadlines are checked (also checked whenever someone opens the queue). | 5 |
| `GATE_RATE_PER_MIN`, `GATE_DAILY_CAP`, `GATE_MAX_CHARS` | Per-key limits for the extension / Gate API. | 30/min, 3000/day, 20000 chars |
| `SEMANTIC` | `off` disables the semantic layer. | on |
| `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL` | `auto` adds Gemini embeddings to retrieval when `GEMINI_API_KEY` is set and the AI assistant is on (never in Confidential Mode). | auto, gemini-embedding-001 |
| `CALIBRATION` | `off` disables learning from feedback globally. | on |

### Free email with Brevo (about 5 minutes)
1. Create a free Brevo account and go to *SMTP & API > API keys*, create a key.
2. In Brevo, add and verify a sender (a Gmail address works: Brevo emails a confirmation link).
3. In Render > Environment set `EMAIL_PROVIDER=brevo`, `BREVO_API_KEY=...`, `EMAIL_FROM=<the verified sender>`.
4. Open *Governance > Settings and privacy > Email notifications* and press **Send me a test email**.
If the sender is not verified Brevo rejects the message; the page shows the provider's error and the queue retries (1, 5, 30 minutes, 4 attempts). Users can turn email off in *Account*.

### Browser extension
1. Sign in, open **Account**, press **Download the extension**, unzip it.
2. Chrome > `chrome://extensions` > Developer mode > *Load unpacked* > choose the folder.
3. In *Account* create a key (shown once), then open the extension popup and paste the server address and the key.
Keys are per user, stored only as hashes, limited per minute and per day, and every check appears in the audit log. Revoke a key in *Account* and it stops at once.

### Approval workflows and certificates
* *Workflows* (admins edit; others view): choose channels, risk levels, claim types (e.g. health), then add steps with a role, optional group (e.g. `legal`), approvals needed, deadline and escalation. Put people in groups under *Workflows > Groups*. Content that matches no workflow uses the old risk-based approval unchanged.
* Overdue steps remind at 75 % of the time, escalate at the deadline, then notify admins. Nothing is ever auto-approved.
* Every approved item gets a public code (`BS-XXXX-XXXX-XXXX`) and a page at `/verify/<code>` that anyone can open without signing in. It shows authenticity, what was checked and the approval chain, never the content, names or internal ids. Admins and approvers can revoke a certificate.

### Learning from feedback
*Insights > What the system has learned here* shows, per rule and guideline, how often findings were accepted or dismissed. Noisy low-risk rules are lowered or demoted to advisory; claims, facts and AI-disclosure rules are protected and never hidden. Admins can switch learning off or reset it.

### Quality gates for Round 3
```
cd server && npm test                       # 84 tests
node eval/r3/run.js                         # baseline vs new, 60 legacy + 82 dev + 329 held-out samples
node eval/r3/calibration.js                 # simulated-feedback experiment
cd ../client && npm run build
cd ../ui-e2e && NODE_PATH=$(npm root -g) node run.js        # UI end-to-end, 20 checks
cd ../extension-e2e && npm install && node run.js           # extension on real editors, 60 checks
```
(`ui-e2e` and `extension-e2e` need Playwright with Chromium installed.)

### Honest limitations of the Round 3 additions
* Evaluation samples are written by the team, not customer data; the held-out set was scored after one preliminary look at errors, and no held-out phrase was added to the rules afterwards.
* Gemini embeddings and Brevo/Resend were tested against mock servers, not live accounts. Use the Test buttons after deploying.
* The extension was tested on real editor components (TinyMCE, Quill, Trix, plain fields, a webmail-style editor) served locally, not on hosted Gmail, WordPress.com, LinkedIn or X, whose pages change often.
* Per-key rate limits and the public-page limiter are in memory: correct for one Render instance, per-instance if you scale out.
* Known semantic misses: spaced-out multi-word phrases, claims phrased with no known paraphrase, and negation placed after the phrase ("an unbeatable price is something we cannot promise").

