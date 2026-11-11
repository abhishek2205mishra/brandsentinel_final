process.env.NODE_ENV = 'test';
process.env.DB_DRIVER = 'memory';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');

test.before(() => db.connect());
test.after(() => db.close());

test('ids come from an atomic counter and documents round-trip', async () => {
  const ids = await Promise.all(Array.from({ length: 20 }, (_, i) => db.insert('items', { org_id: 1, n: i })));
  assert.equal(new Set(ids).size, 20);
  const doc = await db.get('items', ids[3]);
  assert.equal(doc.org_id, 1);
  assert.equal(await db.count('items', { org_id: 1 }), 20);
});

test('unique indexes reject duplicates and updates that collide', async () => {
  await db.insert('users', { email: 'a@x.test', org_id: 1 });
  const b = await db.insert('users', { email: 'b@x.test', org_id: 1 });
  await assert.rejects(() => db.insert('users', { email: 'a@x.test', org_id: 2 }), (e) => db.isDuplicate(e));
  await assert.rejects(() => db.update('users', b, { email: 'a@x.test' }), (e) => db.isDuplicate(e));
});

test('query operators, sort, limit and projection', async () => {
  for (const [n, s] of [[3, 'c'], [1, 'a'], [2, 'b']]) await db.insert('terms', { org_id: 9, banned: s, n });
  const rows = await db.find('terms', { org_id: 9, n: { $gte: 2 } }, { sort: { n: -1 }, limit: 1, project: ['banned'] });
  assert.deepEqual(rows, [{ banned: 'c' }]);
  assert.equal(await db.remove('terms', { org_id: 9 }), 3);
});
