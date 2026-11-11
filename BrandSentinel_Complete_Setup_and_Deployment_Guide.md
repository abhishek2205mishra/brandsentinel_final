# BrandSentinel v3: Complete Setup and Deployment Guide

**From an empty computer to a live link for the final judges, in one document.**
Everything here uses free tiers only: GitHub, MongoDB Atlas, Render, Google AI Studio (Gemini), Brevo (email) and UptimeRobot (keep-awake).

> **Golden rule:** never paste your Atlas password, Gemini key, Brevo key, `JWT_SECRET` or `CERT_SECRET` into chat, screenshots, the PDF or Git. They live only in `server/.env` (on your PC) and in the Render dashboard.

---

## Contents

1. [What you are deploying](#1-what-you-are-deploying)
2. [Accounts and tools to install](#2-accounts-and-tools-to-install)
3. [Unzip and open the project](#3-unzip-and-open-the-project)
4. [MongoDB Atlas (database)](#4-mongodb-atlas-database)
5. [Gemini API key (AI assistant, optional)](#5-gemini-api-key-ai-assistant-optional)
6. [Brevo email key (optional)](#6-brevo-email-key-optional)
7. [Create your local `.env` file](#7-create-your-local-env-file)
8. [Run it on your PC](#8-run-it-on-your-pc)
9. [Run all tests and the evaluation](#9-run-all-tests-and-the-evaluation)
10. [Put the code on GitHub](#10-put-the-code-on-github)
11. [Deploy on Render](#11-deploy-on-render)
12. [Set the environment variables on Render](#12-set-the-environment-variables-on-render)
13. [Verify the live deployment (checklist)](#13-verify-the-live-deployment-checklist)
14. [Keep the free server awake](#14-keep-the-free-server-awake)
15. [Install the Chrome extension](#15-install-the-chrome-extension)
16. [Using the three Round 3 features](#16-using-the-three-round-3-features)
17. [Preparing for the judges (demo script)](#17-preparing-for-the-judges-demo-script)
18. [Updating the live site later](#18-updating-the-live-site-later)
19. [All environment variables (reference)](#19-all-environment-variables-reference)
20. [Troubleshooting](#20-troubleshooting)
21. [Honest limitations (say these before the judges ask)](#21-honest-limitations)
22. [Final pre-submission checklist](#22-final-pre-submission-checklist)

---

## 1. What you are deploying

BrandSentinel is one Node.js service that serves both the API and the built React website.

| Part | Technology | Where it runs |
|---|---|---|
| Web app and API | Express 4 + React (Vite) | Render (free web service) |
| Database | MongoDB Atlas free M0 | Atlas |
| AI assistant (optional) | Gemini or Groq, redacted text only | Their free APIs |
| Email (optional) | Brevo or Resend over HTTPS | Their free APIs |
| Browser extension | Chrome Manifest V3, loaded unpacked | Judges' / your Chrome |

**Round 3 additions in this version**

1. **Accuracy that learns:** semantic detection (paraphrases, Hinglish, Hindi, evasion tricks), search by meaning, and per-organisation learning from accept / dismiss / override decisions.
2. **Review at the source:** Chrome extension, per-user API keys, rate limits, audit log entries.
3. **Approval at scale:** admin-designed approval chains with groups, delegation, deadlines, escalation, email, and a public certificate verification page.

Nothing is mandatory except the database and two secrets. The AI key and email key are optional: without them the project still works fully (rules engine and in-app notifications).

---

## 2. Accounts and tools to install

### 2.1 Tools on your PC

| Tool | Version | Download | Check it works |
|---|---|---|---|
| Node.js | **22 LTS** (20+ works) | https://nodejs.org | `node -v` |
| Git | any recent | https://git-scm.com | `git --version` |
| VS Code | any | https://code.visualstudio.com | open it |
| Google Chrome | any recent | https://google.com/chrome | for the extension |

Open a new terminal after installing (VS Code: **Terminal → New Terminal**) and run `node -v` and `git --version`. Both must print a version.

### 2.2 Free accounts (create all of these now)

| Service | Why | Link |
|---|---|---|
| GitHub | Holds the code; Render deploys from it | https://github.com |
| MongoDB Atlas | Database | https://cloud.mongodb.com |
| Render | Hosting | https://render.com (sign up with GitHub) |
| Google AI Studio | Gemini key (optional) | https://aistudio.google.com |
| Brevo | Email key (optional) | https://www.brevo.com |
| UptimeRobot | Keeps the free server awake | https://uptimerobot.com |

---

## 3. Unzip and open the project

1. Unzip `brandsentinel-v3.zip`. You get a folder (this guide calls it **the project root**) containing `client/`, `server/`, `extension/`, `extension-e2e/`, `ui-e2e/`, `render.yaml`, `Dockerfile`, `DEPLOYMENT_GUIDE.md`.
2. VS Code → **File → Open Folder** → choose the project root.
3. Open a terminal in VS Code. All commands below start from the project root unless stated.

Folder map:

```
project-root/
  client/          React website (src/pages: Dashboard, Review, Workflows, Verify, Account ...)
  server/          Express API
    src/engine/    rules engine + semantic.js (Round 3)
    src/services/  workflow, sla, email, certificate, calibration, apikeys
    src/routes/    API routes
    eval/          accuracy evaluation (eval/r3 = Round 3 before/after)
    test/          automated tests
    .env.example   template for your secrets
  extension/       Chrome extension (also downloadable from the Account page)
  extension-e2e/   real-browser test of the extension
  ui-e2e/          real-browser test of the new screens
  render.yaml      Render blueprint
```

---

## 4. MongoDB Atlas (database)

You need one free cluster, one database user, network access, and a connection string.

1. Sign in at https://cloud.mongodb.com. If you have no cluster: **Create → M0 Free → provider AWS → region close to you (Mumbai `ap-south-1` is good) → name it `brandsentinel` → Create**.
2. **Database Access → Add New Database User**
   - Authentication: **Password**
   - Username: for example `bsadmin`
   - Password: click **Autogenerate** or use letters and digits only (avoids encoding problems). **Copy it somewhere safe now.**
   - Role: **Read and write to any database**
   - **Add User**.
3. **Network Access → Add IP Address → Allow Access From Anywhere (`0.0.0.0/0`) → Confirm.** Render's free tier has no fixed IP, so this is required. Security still comes from the password and TLS.
4. **Database → Connect → Drivers** (Node.js). Copy the string. It looks like:

   ```
   mongodb+srv://<db_username>:<db_password>@brandsentinel.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
5. Replace `<db_username>` and `<db_password>` with your values and **remove the `<` and `>`**. If the password contains special characters, URL-encode them: `@`→`%40`, `#`→`%23`, `/`→`%2F`, `:`→`%3A`, `%`→`%25`.
6. You do **not** create collections. The app creates all collections and indexes itself on first start.

Keep this finished string; it is your `MONGODB_URI`.

---

## 5. Gemini API key (AI assistant, optional)

The AI assistant adds nuance checks and rewrite suggestions. Every call is redacted, logged in the AI ledger, verified (quotes must exist, clauses must exist) and blocked entirely by Confidential Mode. Without a key the rules engine and the whole semantic layer still work offline.

1. Open https://aistudio.google.com and sign in with a Google account.
2. **Get API key → Create API key** (choose or create a project).
3. Copy the key. This is `GEMINI_API_KEY`.
4. With the same key, Round 3 can also use **Gemini embeddings** (`gemini-embedding-001`) to improve clause retrieval. This happens automatically only when the AI assistant is switched on in Governance and Confidential Mode is off.

**Alternative: Groq** (https://console.groq.com → API Keys → Create). Use it as `GROQ_API_KEY`. Groq is used for the assistant only (not embeddings).

Free tiers have rate limits. The app retries once, then pauses the AI for a minute and carries on with the rules engine, so reviews never fail because of the AI.

If a later test says **HTTP 404**, the model name changed: look up a current free model in the provider's docs and set `GEMINI_MODEL` (or `GROQ_MODEL`).

---

## 6. Brevo email key (optional)

Email is used for approval requests, reminders, escalations and decisions. Render's free plan blocks SMTP, so the app uses Brevo's (or Resend's) **HTTPS API**.

### Brevo (recommended, free 300 emails/day)

1. Create an account at https://www.brevo.com and finish the sign-up questions.
2. Open your name (top right) → **SMTP & API → API Keys → Generate a new API key**. Name it `brandsentinel`, copy the key (starts with `xkeysib-`). This is `BREVO_API_KEY`.
3. **Add a sender:** **Senders, Domains & Dedicated IPs → Senders → Add a sender.** Use your own email (a Gmail address works). Brevo emails you a confirmation link: **click it**. Until the sender is verified, Brevo rejects every message.
4. The verified address is your `EMAIL_FROM`.

### Resend (alternative)
Create an account at https://resend.com, make an API key (`RESEND_API_KEY`). Free accounts can send only from `onboarding@resend.dev` to your own email unless you verify a domain. Set `EMAIL_PROVIDER=resend`.

Skip this section if you do not want email. In-app notifications (the bell) work without it.

---

## 7. Create your local `.env` file

1. Generate two secrets (run the command **twice**, use a different output for each):

   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```
   First output → `JWT_SECRET`. Second output → `CERT_SECRET`.

   > **Never change `CERT_SECRET` after approvals exist.** Old certificates would stop verifying.

2. Create the file:

   ```bash
   cd server
   cp .env.example .env          # Windows PowerShell: copy .env.example .env
   ```
3. Open `server/.env` and fill it in:

   ```env
   NODE_ENV=development
   MONGODB_URI=mongodb+srv://bsadmin:YourPassword@brandsentinel.xxxxx.mongodb.net/?retryWrites=true&w=majority
   MONGODB_DB=brandsentinel
   JWT_SECRET=<first 96-character secret>
   CERT_SECRET=<second 96-character secret>

   # AI (optional)
   LLM_PROVIDER=gemini
   GEMINI_API_KEY=<your Gemini key>

   # Email (optional)
   EMAIL_PROVIDER=brevo
   BREVO_API_KEY=<your Brevo key>
   EMAIL_FROM=<your verified sender address>
   EMAIL_FROM_NAME=BrandSentinel

   # Local address, used in email links and QR codes
   PUBLIC_URL=http://localhost:4000
   ```
   Leave every other line as it is. `.env` is already in `.gitignore`, so it will not be uploaded.

No Atlas yet? Leave `MONGODB_URI` empty and the server uses an in-memory database (everything is lost on restart). That is fine for a quick look, not for the final submission.

---

## 8. Run it on your PC

### 8.1 Install and check the database

```bash
cd server
npm install
npm run db:check          # must end with "All good"
```
`db:check` tests your Atlas string. If it fails, see [Troubleshooting](#20-troubleshooting).

### 8.2 Load the demo data (optional but recommended)

```bash
npm run seed              # about 1 to 2 minutes; creates the NovaBrew demo organisation
```
(If you skip this, the server loads the demo automatically on first start when the database is empty and `SEED_DEMO=true`.)

### 8.3 Build the website and start

```bash
cd ../client
npm install
npm run build
cd ../server
npm start
```
Open **http://localhost:4000**. You should see the sign-in page. "BrandSentinel running on port 4000" appears in the terminal.

### 8.4 Demo sign-ins

Password for all: `Demo@1234`

| Email | Role | Use it to |
|---|---|---|
| `admin@novabrew.test` | Admin | everything: workflows, settings, keys, learning reset |
| `creator@novabrew.test` | Creator | submit content |
| `kabir@novabrew.test` | Creator | second author |
| `reviewer@novabrew.test` | Reviewer (group `legal`) | first step of the health workflow |
| `approver@novabrew.test` | Approver (group `legal`) | final sign-off, revoke certificates |
| `agency@novabrew.test` | Agency | restricted view (no confidential clauses) |
| `auditor@novabrew.test` | Auditor | read-only audit view |

### 8.5 Live-reload development (optional)

Two terminals: `cd server && npm run dev` and `cd client && npm run dev` (open http://localhost:5173).

---

## 9. Run all tests and the evaluation

Run these once before submitting. Everything should pass.

```bash
cd server
npm test                          # 84 server tests (in-memory database)
npm run eval                      # original 60-sample precision/recall (expect 1.0 / 1.0)
node eval/r3/run.js               # Round 3 before-and-after table (baseline vs new)
node eval/r3/run.js --verbose     # also lists the remaining mistakes
node eval/r3/calibration.js       # simulated-feedback learning experiment
```

Expected Round 3 result (held-out set of 329 samples):

| | Precision | Recall |
|---|---|---|
| Before (v2.1 rules) | 73.9% | 24.8% |
| After (semantic layer) | 95.3% | 84.4% |

The sample set is in `server/eval/r3/gold-r3.json` and is rebuilt with `node eval/r3/build.js`. Saved output: `server/eval/r3/RESULTS.txt`.

Optional real-browser tests (they need Playwright with Chromium):

```bash
cd client && npm run build
cd ../ui-e2e && NODE_PATH=$(npm root -g) node run.js          # 20 UI checks
cd ../extension-e2e && npm install && node run.js              # 60 extension checks on real editors
```
On Windows PowerShell set the variable first: `$env:NODE_PATH = (npm root -g)`.
If Playwright says the browser is missing: `npx playwright install chromium`.

Against a real MongoDB (throwaway database; the name **must** end in `_test`):
```bash
MONGODB_DB=brandsentinel_test npm run test:mongo
```

---

## 10. Put the code on GitHub

1. On https://github.com create a **new empty repository** (name `brandsentinel`; no README, no .gitignore). Private or public both work with Render.
2. In the terminal at the **project root**:

   ```bash
   git init
   git add .
   git commit -m "BrandSentinel v3"
   git branch -M main
   git remote add origin https://github.com/<your-username>/brandsentinel.git
   git push -u origin main
   ```
   (GitHub may ask you to sign in or use a personal access token the first time.)
3. **Check that `server/.env` is NOT in the repository** (open the repo on GitHub → `server/` folder). It must not be there. If it is, delete it from the repo, reset your Atlas password and API keys, then push again.

---

## 11. Deploy on Render

### Option A: Blueprint (easiest)

1. Go to https://dashboard.render.com → **New → Blueprint**.
2. Connect GitHub and choose your `brandsentinel` repository. Render reads `render.yaml` and shows one service called `brandsentinel`.
3. Render lists the variables that need values (marked "sync: false"). Fill them using [Section 12](#12-set-the-environment-variables-on-render). `JWT_SECRET` and `CERT_SECRET` are generated for you.
4. Click **Apply** / **Deploy**.

### Option B: Manual web service

1. **New → Web Service** → pick the repository.
2. Settings:

   | Field | Value |
   |---|---|
   | Runtime | Node |
   | Branch | `main` |
   | Root Directory | (leave empty) |
   | Build Command | `npm --prefix client ci && npm --prefix client run build && npm --prefix server ci --omit=dev` |
   | Start Command | `npm --prefix server start` |
   | Instance type | **Free** |
   | Health Check Path | `/api/health` |
   | Auto-Deploy | Yes |
3. Add the environment variables from Section 12 (**Environment** tab), then **Create Web Service**.

### What happens next

The first build takes 3 to 6 minutes. Watch the **Logs** tab. These lines mean success:

```
Database connected (mongo).
BrandSentinel running on port 10000
```
Your URL is `https://<service-name>.onrender.com`. On the very first start the demo organisation loads in the background (1 to 2 minutes); the sign-in works after `/api/health` shows `"seeding":false`.

---

## 12. Set the environment variables on Render

Render → your service → **Environment** → **Add Environment Variable**. After any change Render redeploys.

### Required

| Key | Value |
|---|---|
| `NODE_ENV` | `production` (the blueprint sets it) |
| `MONGODB_URI` | your Atlas string from Section 4 |
| `MONGODB_DB` | `brandsentinel` |
| `JWT_SECRET` | generated by the blueprint, or your own 32+ characters |
| `CERT_SECRET` | generated by the blueprint, or your own 32+ characters |

In production the server **refuses to start** with missing or weak secrets. This is intentional.

### Recommended (AI)

| Key | Value |
|---|---|
| `LLM_PROVIDER` | `gemini` |
| `GEMINI_API_KEY` | your key from Section 5 |

### Recommended (public link and email)

| Key | Value |
|---|---|
| `PUBLIC_URL` | `https://<service-name>.onrender.com` (no trailing slash). Used in emails and QR codes. If left empty, Render's own address is detected automatically |
| `EMAIL_PROVIDER` | `brevo` |
| `BREVO_API_KEY` | your Brevo key |
| `EMAIL_FROM` | your **verified** Brevo sender |
| `EMAIL_FROM_NAME` | `BrandSentinel` |

> The blueprint sets `EMAIL_PROVIDER` to `none`. **Change it to `brevo`** or email stays off.

### Before sharing the link publicly

| Key | Value | Why |
|---|---|---|
| `ALLOW_REGISTRATION` | `true` for judges to create their own organisation, `false` to lock it | |
| `SEED_DEMO` | `true` keeps the NovaBrew demo for judges | |

For the final submission we recommend leaving both `true` (judges can try the demo roles or create their own organisation) and **changing the demo passwords** if the link is public (Account page, once per demo user), or telling judges the demo password on purpose.

Everything else (limits, semantic search, learning, deadline timer) has working defaults. See [Section 19](#19-all-environment-variables-reference).

---

## 13. Verify the live deployment (checklist)

Open `https://<service-name>.onrender.com` and go through this list in about 10 minutes. Tick each item.

| # | Check | Expected |
|---|---|---|
| 1 | `/api/health` | `{"ok":true,"db":"up",...}` |
| 2 | Sign in as `admin@novabrew.test` / `Demo@1234` | Dashboard loads |
| 3 | **Governance → Settings and privacy → System status** | Database `mongo · connected`; Semantic search on; Public address shown |
| 4 | Same page: tick **Use the AI assistant** → **Test connection** | "working · N ms" |
| 5 | **Email notifications** card → **Send me a test email** | "Test email sent", and the mail arrives (check spam) |
| 6 | **New review**, paste: `Our new roast is India's #1 coffee, now 30% off this festive offer!!! Visit Novabrw today.` | Claims, facts, tone and misspelling findings, each with a cited source |
| 7 | New review: `Try our sabse behtareen coffee, nothing beats it.` | Semantic claim finding (Hinglish paraphrase), cited clause |
| 8 | **Knowledge base** search: `we promise it heals the body` | Top hit is the claims clause |
| 9 | Sign in as `creator@`, create content `Our blend boosts immunity every day.` → **Submit for review** | Item shows an approval chain "Health claims: legal review, then brand approver" |
| 10 | Sign in as `reviewer@` → Dashboard shows "your turn" → open item → **Approval** tab → Approve (fill the override reason if asked) | Chain moves to step 2 |
| 11 | Sign in as `approver@` → approve | Item approved; **Public verification** box with a code like `BS-XXXX-XXXX-XXXX` |
| 12 | Open `https://<service-name>.onrender.com/verify/<code>` in a private window (not signed in) | "Genuine and current", what was checked, no content or names |
| 13 | On that page paste the approved text → Compare | "Exact match"; other text → "No match" |
| 14 | As approver: **Revoke certificate** with a reason, reload the public page | Shows "Revoked" |
| 15 | **Account → Create key**, then **Download the extension** | Key shown once; zip downloads |
| 16 | **Insights → What the system has learned here** | Table visible (admin can switch learning off or reset) |
| 17 | **Governance → Audit log** | Entries for key creation, checks, decisions, certificate events |

If a step fails, see [Troubleshooting](#20-troubleshooting).

---

## 14. Keep the free server awake

Render free web services **sleep after about 15 minutes without traffic** and take up to a minute to wake. For judging this is risky, so add a free monitor.

1. Go to https://uptimerobot.com → sign up → **Add New Monitor**.
2. Monitor type: **HTTP(s)**. Name: `BrandSentinel`.
3. URL: `https://<service-name>.onrender.com/api/health`
4. Monitoring interval: **5 minutes**. Save.

This pings the health check every 5 minutes so the service stays awake. The health endpoint is rate-limit free by design.

Also: **open the site yourself 5 minutes before the judges do**, and keep one signed-in tab open.

Render's free tier gives about 750 instance-hours a month, enough for one always-awake service.

---

## 15. Install the Chrome extension

Judges (and you) install it once. No Chrome Web Store account is needed.

1. Sign in to your deployed site → **Account** → **Download the extension (.zip)**.
2. Unzip it into a permanent folder (do not delete the folder afterwards).
3. In Chrome open `chrome://extensions` (Edge: `edge://extensions`).
4. Turn on **Developer mode** (top right).
5. Click **Load unpacked** and choose the `brandsentinel-extension` folder. Pin the shield icon.
6. Back on the **Account** page: enter a key name (for example `Chrome laptop`) → **Create key** → **copy it immediately** (shown only once).
7. Click the extension icon. Paste:
   - **Server address:** `https://<service-name>.onrender.com` (no trailing slash)
   - **API key:** the `bsk_...` key
8. **Save and test connection** → "Connected to NovaBrew Coffee as ...". Chrome may ask permission to reach your server; allow it.

### Using it

* Click into any text box on a web page. A small **BrandSentinel** pill appears at the bottom right.
* Click it, or stop typing if **Check automatically** is on. Findings appear with severity, the flagged text and the **cited guideline**.
* **Use "..."** applies the suggested replacement; **Show in text** selects the words; **Dismiss** hides one for this page.
* **Save to BrandSentinel** stores the text as a review item for the approval workflow.
* **Deep check** also asks the AI assistant (only if enabled and Confidential Mode is off).
* Limits: 30 checks per minute and 3,000 per day per key, 20,000 characters per check.

Tested on TinyMCE, Quill, Trix, plain text fields and a webmail-style editor. Password and card fields and text under 8 characters are never read. Lost a key? **Account → Revoke**; it stops instantly.

**Demo tip:** open the extension test pages from the project (`extension-e2e/pages/`) or any web editor such as a blog admin, to show it live.

---

## 16. Using the three Round 3 features

### 16.1 Accuracy that learns

* **Semantic detection** runs automatically on every review. Try these in a new review:
  * `Nothing beats our blend.` (paraphrase)
  * `हमारी कॉफी सबसे बेहतरीन है।` (Hindi)
  * `Our unb3atable roast` or `u n m a t c h e d` (evasion tricks)
  * `We never claim to be the best.` and `Best wishes from the team!` (correctly **not** flagged)
* Every finding cites the guideline clause it relied on. If your organisation has no claims clause to cite, nothing is flagged (Evidence-or-Silence).
* Phrases approved in the **Claim Ledger** (Knowledge base → Claims) are never flagged.
* **Learning:** every accept, edit, dismiss and override changes how confident each rule is for your organisation. Open **Insights → What the system has learned here**. Rules that creators keep dismissing are lowered or demoted to advisory. Claims, facts and AI-disclosure rules are **protected** (marked with a lock): confidence is shown but they are never hidden. Admins can switch learning off or press **Reset**.
* **Knowledge base search** now works by meaning (hybrid keyword + concept vectors, plus Gemini embeddings when the AI assistant is on).
* Measurement: Section 9 (`node eval/r3/run.js`).

### 16.2 Review at the source

See Section 15. Every extension check is recorded in **Governance → Audit log** as `ext.check` (a hash of the text, not the text).

### 16.3 Approval at scale

1. **Workflows** (top menu; admins edit, others view).
2. **+ New workflow** or **Templates → Use template**. Choose:
   * **When it applies:** channels, risk levels, claim types (for example `health`), AI-generated only, priority.
   * **Steps** (up to 6): name, minimum role, optional **group** (for example `legal`), approvals needed, deadline in hours, who it escalates to.
3. **Groups tab:** type group names for people (comma-separated). The demo has `legal` for the reviewer and approver.
4. **Test tool:** pick a channel, risk and claim types to see which workflow would apply.
5. **Deadlines tab:** everything waiting, who is overdue, average time per step.
6. On an item: **Approval** tab shows the chain timeline, deadline countdown, **Delegate this step**, and **Send a reminder**.
7. **Away cover:** Account → "Going away?" → choose who covers you and the return date.
8. **Rules that always hold:** authors never approve their own content; one person cannot approve two steps of the same chain; overdue steps remind at 75 % of the time, escalate at the deadline, then alert admins; **nothing is ever auto-approved**.
9. **Content that matches no workflow** follows the original risk-based approval, unchanged.
10. **Public verification:** each approved item gets a code and a link `https://<your-site>/verify/<code>` with a QR image. Anyone can open it without signing in. It confirms authenticity, shows what was checked and the approval chain, and never shows the content, names or internal ids. Approvers and admins can **Revoke certificate** (with a reason); the public page then says "Revoked".
11. **Email:** approval requests, reminders, escalations and decisions are emailed (if Brevo or Resend is configured). Users can opt out under Account. Failed sends retry after 1, 5 and 30 minutes.

---

## 17. Preparing for the judges (demo script)

Suggested 6 to 8 minute flow:

1. **Open the live link** (already awake). Sign in as `admin@`.
2. **Dashboard / Governance:** show System status (Mongo connected, semantic search on) and the AI notice strip (privacy, Confidential Mode).
3. **Improvement 1:** New review with a paraphrased claim, a Hinglish claim and an evasion trick. Show the cited clause. Show **Insights → learning table** and say the before/after numbers (precision 73.9 → 95.3 %, recall 24.8 → 84.4 % on 329 held-out samples).
4. **Improvement 2:** Account → create key → extension popup → type text into a rich editor → pill → finding with citation → **Save to BrandSentinel**. Point at the audit log entry.
5. **Improvement 3:** Workflows page → the health template → creator submits health content → reviewer (legal) approves → approver approves → **public verification page** in a private window → paste text → revoke → "Revoked".
6. **Close with limitations** (Section 21) and the free-of-cost stack.

Prepare before the demo:

* Create fresh demo items the day before so the dashboard looks lively.
* Test the extension on the judges' machine style: Chrome with Developer mode.
* Have a second browser window in private mode ready for the public page.
* Print or save the verification code QR from an approved item for the slides.

---

## 18. Updating the live site later

```bash
git add .
git commit -m "describe your change"
git push
```
Render redeploys automatically (2 to 5 minutes). Watch **Logs** until you see "running on port".

Changing environment variables in the Render dashboard also triggers a redeploy.

---

## 19. All environment variables (reference)

Set in `server/.env` locally and in the Render **Environment** tab.

| Variable | Req. | Default | What it does |
|---|---|---|---|
| `NODE_ENV` | prod | `development` | `production` on Render |
| `PORT` | no | 4000 | Render sets it itself |
| `MONGODB_URI` | **yes** | empty (memory DB) | Atlas connection string |
| `MONGODB_DB` | no | `brandsentinel` | Database name |
| `JWT_SECRET` | **yes (prod)** | | 32+ chars; signs logins |
| `CERT_SECRET` | **yes (prod)** | | 32+ chars; signs certificates; never change after approvals exist |
| `LLM_PROVIDER` | no | auto | `gemini` or `groq` |
| `GEMINI_API_KEY` | AI | | Google AI Studio key |
| `GEMINI_MODEL` | no | `gemini-2.5-flash` | change if the test says HTTP 404 |
| `GROQ_API_KEY` | AI alt. | | Groq key |
| `GROQ_MODEL` | no | `llama-3.3-70b-versatile` | |
| `PUBLIC_URL` | rec. | auto from Render | Public address for emails/QR |
| `EMAIL_PROVIDER` | email | `none` (auto-picks if only one key set) | `brevo`, `resend`, `none` |
| `BREVO_API_KEY` | email | | Brevo API key |
| `RESEND_API_KEY` | email alt. | | Resend API key |
| `EMAIL_FROM` | email | | Verified sender address |
| `EMAIL_FROM_NAME` | no | `BrandSentinel` | Sender display name |
| `SLA_TICK_MINUTES` | no | 5 | How often deadlines are checked (also checked when people open the queue) |
| `GATE_RATE_PER_MIN` | no | 30 | Extension checks per key per minute |
| `GATE_DAILY_CAP` | no | 3000 | Extension checks per key per day |
| `GATE_MAX_CHARS` | no | 20000 | Max characters per check |
| `SEMANTIC` | no | on | `off` disables the semantic layer |
| `CALIBRATION` | no | on | `off` disables learning from feedback |
| `EMBEDDING_PROVIDER` | no | `auto` | `off` disables Gemini embeddings |
| `EMBEDDING_MODEL` | no | `gemini-embedding-001` | |
| `CLIENT_ORIGIN` | split hosting | | Vercel URL(s), comma-separated |
| `SEED_DEMO` | no | `true` | Load NovaBrew demo when DB is empty |
| `ALLOW_REGISTRATION` | no | `true` | Anyone can create an organisation |
| `MAX_UPLOAD_MB` | no | 10 | Upload limit |
| `SLACK_WEBHOOK_URL` | no | | Slack notifications |
| `OCR_ENABLED` | no | `false` | Image text extraction (heavy; leave off on free Render) |

---

## 20. Troubleshooting

### Setup and deployment

| Symptom | Likely cause and fix |
|---|---|
| `node` / `git` not recognised | Reinstall and open a **new** terminal |
| `npm install` fails | Check Node version (`node -v`, use 20 or 22); delete `node_modules` and retry; check internet |
| `db:check`: authentication failed | Wrong username/password, or special characters not URL-encoded |
| `db:check` times out | Atlas **Network Access** must contain `0.0.0.0/0` |
| `Configuration error: JWT_SECRET must be...` | Set both secrets (32+ characters) |
| Render build fails on `npm ci` | Make sure `package-lock.json` files were committed in both `client/` and `server/` |
| Render deploy "failed health check" | Open Logs. Usually `MONGODB_URI` is wrong, or Atlas blocks Render (Network Access) |
| Blank page after deploy | Build did not finish; check Logs for the client build step |
| Sign-in says wrong password right after first deploy | Demo data is still loading; wait until `/api/health` shows `"seeding":false` |
| Page loads then API calls fail (split hosting) | `VITE_API_URL` missing at build time, or `CLIENT_ORIGIN` does not match exactly |
| Very slow first load | Render free tier waking up; see Section 14 |

### Round 3 features

| Symptom | Fix |
|---|---|
| AI test: HTTP 404 | Outdated model name: set `GEMINI_MODEL` to a current free model |
| AI test: HTTP 429 | Free-tier rate limit; wait a minute (reviews still work, rules-only) |
| Test email fails: "rejected" or sender error | Brevo sender not verified (click the confirmation link in Brevo); `EMAIL_FROM` must equal that sender |
| Test email says provider not configured | `EMAIL_PROVIDER` is still `none`, or key missing |
| No email arrives | Check spam; check Governance → Email card for failures (retries run automatically) |
| Extension says "cannot reach server" | Wrong address (no trailing slash, `https://`), or the free server is asleep: open the site once |
| Extension: "Invalid key" | Key was revoked or mistyped; create a new one on Account |
| Extension pill shows "Paused" | Rate limit reached (30/min or 3000/day); wait |
| Extension does nothing on a page | Reload the page after installing; the field must hold at least 8 characters and not be a password field |
| Download extension fails | The `extension/` folder must be in the repo root (it is included in the zip and Dockerfile) |
| Workflow does not start for content | Check the workflow is **active** and its match fits (channel / risk / claim types); use the Test tool |
| Step shows "nobody matches" warning | Put people in the required group under Workflows → Groups |
| Public verify page shows "No certificate" | Code mistyped; codes look like `BS-ABCD-EFGH-JKLM` |
| Public verify page 429 | Too many requests (40 per minute per address); wait a minute |
| Old approvals no longer verify | `CERT_SECRET` was changed; restore the old value |
| Learning table empty | No accept/dismiss decisions yet; use the review screen |

### Useful checks

* Health: `https://<service-name>.onrender.com/api/health`
* Logs: Render → service → **Logs** (JSON lines with request ids)
* Locally: `cd server && npm run db:check`

---

## 21. Honest limitations

Say these openly; judges value it and it is accurate.

* **Evaluation data:** the 329 held-out samples (and 82 development samples) are written by the team, not customer data. The held-out errors were looked at once before tuning, and no held-out phrase was added to the rules afterwards. Numbers show improvement on this set, not guaranteed real-world accuracy.
* **Not verified live from the build environment:** Gemini embeddings, Brevo and Resend were tested against mock servers following their documented formats. **You verify them once after deploying** with the Test buttons (Section 13, steps 4 and 5).
* **Extension coverage:** tested on real editor components (TinyMCE, Quill, Trix, plain fields, webmail-style editor) served locally. Not tested on hosted Gmail, WordPress.com, LinkedIn or X, whose pages change often. Findings are underlined only in rich (contenteditable) editors; in plain text areas use "Show in text".
* **Semantic detection** is an offline paraphrase engine plus retrieval, not a large model. Known misses: spaced-out multi-word phrases, claims with no known paraphrase, negation placed after the phrase.
* **Learning** adjusts confidence and demotes noisy low-risk rules only; claims, facts and AI-disclosure rules are protected on purpose.
* **Free-tier realities:** Render sleeps without traffic (use UptimeRobot); Atlas M0 has 512 MB; Gemini and Brevo have daily quotas. Rate limits are in memory, so they are per instance if you ever scale beyond one.
* **Email** depends on a verified sender; if email is off, everything still works with in-app notifications.
* Regulation packs are plain-language summaries, not legal advice.

---

## 22. Final pre-submission checklist

**Security**
- [ ] `server/.env` is not on GitHub
- [ ] Atlas password, Gemini key, Brevo key never pasted into chat or documents
- [ ] Demo passwords changed, or you deliberately share the demo password
- [ ] Render shows `NODE_ENV=production`

**Deployment**
- [ ] `/api/health` returns `"db":"up"`
- [ ] Section 13 checklist passed (17 items)
- [ ] UptimeRobot monitor is green
- [ ] `PUBLIC_URL` set and the QR/verify link opens

**Round 3 proof**
- [ ] `npm test` shows 84 passing
- [ ] `node eval/r3/run.js` table saved (screenshot or `RESULTS.txt`)
- [ ] Extension installed and tested on a real editor
- [ ] One approved item with a public verification code, plus a revoked one to show

**Submission**
- [ ] Live URL and demo logins ready for the judges
- [ ] GitHub repository link ready
- [ ] Limitations slide ready (Section 21)
- [ ] You opened the site 5 minutes before judging so it is awake

Good luck with the final round.
