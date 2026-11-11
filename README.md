# BrandSentinel v2
Evidence-backed brand governance: every finding cites an approved guideline, fact, claim, asset or regulation, or it is not shown as a finding.

Stack: Node + Express, **MongoDB Atlas**, React + Vite, optional hosted AI (Gemini or Groq free tiers).

Quick start and full deployment steps: see **DEPLOYMENT_GUIDE.md**.

    cd server && npm install && cp .env.example .env   # fill MONGODB_URI and secrets
    npm run db:check && npm run seed
    cd ../client && npm install && npm run build
    cd ../server && npm start                          # http://localhost:4000

Demo login: admin@novabrew.test / Demo@1234
