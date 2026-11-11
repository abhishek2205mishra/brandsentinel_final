// In-app notifications, plus an optional free Slack incoming webhook.
const db = require('../db');
const config = require('../config');
const email = require('./email');

async function notify(orgId, userIds, text, link) {
  const ids = [...new Set(userIds.filter(Boolean))];
  await db.insertMany('notifications', ids.map((uid) => ({ org_id: orgId, user_id: uid, text, link: link || null, read: 0, created_at: db.now() })));
  // Email copy (queued, retried, never blocks); users can opt out on their Account page.
  await email.enqueueForUsers(orgId, ids, text, link).catch(() => {});
  if (config.slackWebhook) {
    fetch(config.slackWebhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `BrandSentinel: ${text}` }), signal: AbortSignal.timeout(5000) }).catch(() => {});
  }
}

const usersWithRoles = async (orgId, roles) => (await db.find('users', { org_id: orgId, role: { $in: roles } }, { project: ['id'] })).map((u) => u.id);

module.exports = { notify, usersWithRoles };
