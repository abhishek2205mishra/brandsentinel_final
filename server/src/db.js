// Data layer. One small async API (find/findOne/insert/update/remove/count) with two interchangeable backends:
//   * MongoDB (MongoDB Atlas free tier in production)  -> DB_DRIVER=mongo, MONGODB_URI=...
//   * in-memory (tests and a zero-setup local try-out) -> DB_DRIVER=memory
// Documents keep a numeric `id` (from an atomic counter) so the API and the React app stay unchanged.
const config = require('./config');

const COLLECTIONS = ['orgs', 'users', 'guidelines', 'terms', 'facts', 'claims', 'assets', 'regs', 'items', 'versions', 'findings',
  'comments', 'decisions', 'certificates', 'audit_log', 'ai_ledger', 'finding_events', 'notifications', 'files',
  // Round 3
  'api_keys', 'workflows', 'item_workflows', 'email_outbox', 'embeddings'];

const UNIQUE = {
  orgs: [['api_key']], users: [['email']], guidelines: [['org_id', 'code']], regs: [['code']],
  versions: [['item_id', 'n']], audit_log: [['org_id', 'prev_hash']], api_keys: [['key_hash']],
};
const INDEXES = {
  users: [['org_id']], guidelines: [['org_id', 'active']], terms: [['org_id']], facts: [['org_id']], claims: [['org_id']], assets: [['org_id']],
  items: [['org_id', 'updated_at'], ['org_id', 'status']], findings: [['item_id', 'version_n'], ['org_id']], comments: [['item_id']],
  decisions: [['item_id', 'version_n'], ['user_id']], certificates: [['org_id', 'content_hash'], ['item_id'], ['verification_code']], audit_log: [['org_id', 'id']],
  ai_ledger: [['org_id', 'id']], finding_events: [['org_id']], notifications: [['user_id', 'id']], files: [['key']],
  api_keys: [['user_id'], ['org_id']], workflows: [['org_id', 'active']], item_workflows: [['item_id', 'version_n'], ['org_id', 'status']], email_outbox: [['status', 'next_try_at']], embeddings: [['org_id', 'key']],
};

const dupError = (coll) => Object.assign(new Error(`E11000 duplicate key error in ${coll}`), { code: 11000 });

// ---------------------------------------------------------------- in-memory backend
class MemoryAdapter {
  constructor() { this.data = new Map(); this.seq = new Map(); this.sift = (require('sift').default || require('sift')); }
  rows(c) { if (!this.data.has(c)) this.data.set(c, []); return this.data.get(c); }
  async connect() {}
  async close() {}
  async ping() { return true; }
  async nextIds(c, n = 1) { const first = (this.seq.get(c) || 0) + 1; this.seq.set(c, first + n - 1); return first; }
  async find(c, filter = {}, { sort, limit, skip, project } = {}) {
    let out = this.rows(c).filter(this.sift(filter));
    if (sort) {
      const keys = Object.entries(sort);
      out = [...out].sort((a, b) => {
        for (const [k, dir] of keys) {
          const x = a[k], y = b[k];
          if (x === y) continue;
          if (x == null) return -dir; if (y == null) return dir;
          return (x < y ? -1 : 1) * dir;
        }
        return 0;
      });
    }
    if (skip) out = out.slice(skip);
    if (limit) out = out.slice(0, limit);
    return out.map((d) => {
      if (!project) return { ...d };
      const o = {}; for (const k of project) o[k] = d[k]; return o;
    });
  }
  violates(c, doc, ignore) {
    for (const keys of UNIQUE[c] || []) {
      if (keys.some((k) => doc[k] === undefined || doc[k] === null)) continue;
      if (this.rows(c).some((r) => r !== ignore && keys.every((k) => r[k] === doc[k]))) return true;
    }
    return false;
  }
  async insertOne(c, doc) {
    if (this.violates(c, doc)) throw dupError(c);
    this.rows(c).push({ ...doc });
  }
  async updateMany(c, filter, patch) {
    const hit = this.rows(c).filter(this.sift(filter));
    for (const r of hit) { const next = { ...r, ...patch }; if (this.violates(c, next, r)) throw dupError(c); Object.assign(r, patch); }
    return hit.length;
  }
  async deleteMany(c, filter) {
    const keep = [], gone = [];
    const m = this.sift(filter);
    for (const r of this.rows(c)) (m(r) ? gone : keep).push(r);
    this.data.set(c, keep);
    return gone.length;
  }
  async count(c, filter = {}) { return this.rows(c).filter(this.sift(filter)).length; }
  async clearAll() { this.data = new Map(); this.seq = new Map(); }
}

// ---------------------------------------------------------------- MongoDB backend
class MongoAdapter {
  async connect() {
    const { MongoClient } = require('mongodb');
    this.client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 15000, maxPoolSize: 10, appName: 'BrandSentinel' });
    await this.client.connect();
    this.db = this.client.db(config.mongoDb);
    await this.ensureIndexes();
  }
  async ensureIndexes() {
    const spec = (keys) => Object.fromEntries(keys.map((k) => [k, 1]));
    for (const [c, list] of Object.entries(UNIQUE)) for (const keys of list) await this.db.collection(c).createIndex(spec(keys), { unique: true });
    for (const [c, list] of Object.entries(INDEXES)) for (const keys of list) await this.db.collection(c).createIndex(spec(keys));
    for (const c of COLLECTIONS) await this.db.collection(c).createIndex({ id: 1 }, { unique: true });
  }
  async close() { if (this.client) await this.client.close(); }
  async ping() { await this.db.command({ ping: 1 }); return true; }
  async nextIds(c, n = 1) {
    const r = await this.db.collection('counters').findOneAndUpdate({ _id: c }, { $inc: { seq: n } }, { upsert: true, returnDocument: 'after' });
    const doc = r && r.value !== undefined ? r.value : r;
    return doc.seq - n + 1;
  }
  async find(c, filter = {}, { sort, limit, skip, project } = {}) {
    const projection = { _id: 0 };
    if (project) for (const k of project) projection[k] = 1;
    let cur = this.db.collection(c).find(filter, { projection });
    if (sort) cur = cur.sort(sort);
    if (skip) cur = cur.skip(skip);
    if (limit) cur = cur.limit(limit);
    return cur.toArray();
  }
  async insertOne(c, doc) { await this.db.collection(c).insertOne({ ...doc }); }
  async updateMany(c, filter, patch) { return (await this.db.collection(c).updateMany(filter, { $set: patch })).matchedCount; }
  async deleteMany(c, filter) { return (await this.db.collection(c).deleteMany(filter)).deletedCount; }
  async count(c, filter = {}) { return this.db.collection(c).countDocuments(filter); }
  async clearAll() { for (const c of [...COLLECTIONS, 'counters']) await this.db.collection(c).deleteMany({}); }
}

let adapter = null;
const A = () => { if (!adapter) throw new Error('Database is not connected. Call db.connect() first.'); return adapter; };

async function connect() {
  if (adapter) return;
  adapter = config.dbDriver === 'mongo' ? new MongoAdapter() : new MemoryAdapter();
  try { await adapter.connect(); } catch (e) { adapter = null; throw e; }
}
async function close() { if (adapter) { await adapter.close(); adapter = null; } }

const now = () => new Date().toISOString();
const json = (s, fallback = null) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };
const idFilter = (x) => (x !== null && typeof x === 'object' ? x : { id: Number(x) });

const find = (c, filter, opts) => A().find(c, filter || {}, opts);
const findOne = async (c, filter, opts) => (await A().find(c, filter || {}, { ...opts, limit: 1 }))[0] || null;
const get = (c, id) => findOne(c, { id: Number(id) });
async function insert(c, obj) {
  const id = await A().nextIds(c, 1);
  await A().insertOne(c, { id, ...obj });
  return id;
}
async function insertMany(c, list) {
  if (!list.length) return [];
  const first = await A().nextIds(c, list.length);
  const ids = [];
  for (let i = 0; i < list.length; i++) { await A().insertOne(c, { id: first + i, ...list[i] }); ids.push(first + i); }
  return ids;
}
const update = (c, idOrFilter, patch) => A().updateMany(c, idFilter(idOrFilter), patch);
const remove = (c, idOrFilter) => A().deleteMany(c, idFilter(idOrFilter));
const count = (c, filter) => A().count(c, filter || {});
const ping = () => A().ping();
const clearAll = () => A().clearAll();
// id -> document lookup for joins done in application code.
async function mapByIds(c, ids, project) {
  const uniq = [...new Set(ids.filter((x) => x !== null && x !== undefined))];
  const rows = uniq.length ? await find(c, { id: { $in: uniq } }, project ? { project: ['id', ...project] } : undefined) : [];
  return new Map(rows.map((r) => [r.id, r]));
}
const isDuplicate = (e) => !!e && (e.code === 11000 || /E11000/.test(e.message || ''));

module.exports = { connect, close, now, json, find, findOne, get, insert, insertMany, update, remove, count, ping, clearAll, mapByIds, isDuplicate, COLLECTIONS };
