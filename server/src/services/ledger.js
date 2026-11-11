// AI Disclosure Ledger: records every service that processed content, what was redacted, and whether data left the server.
const db = require('../db');

async function record(orgId, itemId, events) {
  for (const e of events || []) {
    await db.insert('ai_ledger', {
      org_id: orgId, ts: db.now(), item_id: itemId || null, service: e.service, model: e.model || null,
      purpose: e.purpose, redactions: e.redactions || 0, sent_external: e.sent_external ? 1 : 0, note: e.note || null,
    });
  }
}

module.exports = { record };
