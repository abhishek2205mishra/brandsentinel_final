// Verifies your MongoDB connection string BEFORE you deploy:  npm run db:check
// Connects, creates the indexes, writes/reads/deletes one test document and reports clear fixes for the usual mistakes.
process.env.DB_DRIVER = process.env.DB_DRIVER || (process.env.MONGODB_URI ? 'mongo' : 'memory');
const config = require('../src/config');
const db = require('../src/db');

(async () => {
  console.log(`Driver: ${config.dbDriver}${config.dbDriver === 'mongo' ? `  Database: ${config.mongoDb}` : ''}`);
  if (config.dbDriver === 'mongo' && !config.mongoUri) { console.error('MONGODB_URI is not set. Put it in server/.env (see .env.example).'); process.exit(1); }
  try {
    await db.connect();
    console.log('1. Connected and indexes created.');
    await db.ping();
    console.log('2. Ping OK.');
    const id = await db.insert('healthcheck', { at: db.now(), note: 'db-check' });
    const doc = await db.get('healthcheck', id);
    if (!doc || doc.note !== 'db-check') throw new Error('Read-back failed');
    await db.update('healthcheck', id, { note: 'updated' });
    if ((await db.get('healthcheck', id)).note !== 'updated') throw new Error('Update failed');
    await db.remove('healthcheck', id);
    console.log('3. Insert, read, update and delete OK.');
    console.log('\nAll good. Your database is ready for BrandSentinel.');
    await db.close();
    process.exit(0);
  } catch (e) {
    const m = String(e.message || e);
    console.error('\nFAILED:', m.split('\n')[0]);
    if (/bad auth|Authentication failed/i.test(m)) console.error('Fix: the database username or password is wrong. In Atlas open Database Access, reset the password, and URL-encode special characters (@ becomes %40, # becomes %23).');
    else if (/ENOTFOUND|querySrv|ECONNREFUSED|getaddrinfo/i.test(m)) console.error('Fix: the cluster address is wrong or DNS is blocked. Copy the connection string again from Atlas (Connect > Drivers).');
    else if (/ReplicaSetNoPrimary|Server selection timed out|timed out|SSL|TLS/i.test(m)) console.error('Fix: Atlas is refusing this IP address. In Atlas open Network Access and add 0.0.0.0/0 (allow from anywhere), then wait a minute and retry.');
    else if (/not authorized|requires authentication|unauthorized/i.test(m)) console.error('Fix: give the database user "Read and write to any database" (Atlas > Database Access > Edit).');
    process.exit(1);
  }
})();
