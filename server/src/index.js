const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const config = require('./config');
const db = require('./db');
const { seedRegs } = require('./seedData');
const { sanitize, limiter } = require('./middleware/auth');

// A bad upload or library bug must never take the server down.
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e && e.message));
process.on('uncaughtException', (e) => console.error('Uncaught exception:', e && e.message));

const state = { seeding: false, seeded: null, startedAt: Date.now() };
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind Render / Vercel / other proxies: real client IPs for rate limits

app.use(helmet({
  contentSecurityPolicy: { useDefaults: false, directives: { 'default-src': ["'self'"], 'img-src': ["'self'", 'data:', 'blob:'], 'style-src': ["'self'", "'unsafe-inline'"], 'script-src': ["'self'"], 'connect-src': ["'self'"], 'font-src': ["'self'", 'data:'], 'frame-ancestors': ["'none'"], 'base-uri': ["'self'"], 'form-action': ["'self'"], 'object-src': ["'none'"] } },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: config.isProd ? { maxAge: 15552000, includeSubDomains: true } : false,
}));
// The gate API is called with an API key (no cookies), so any origin may call it; everything else stays locked to CLIENT_ORIGIN.
app.use('/api/gate', cors({ origin: '*', allowedHeaders: ['x-api-key', 'content-type'], exposedHeaders: ['Retry-After', 'X-RateLimit-Remaining'], maxAge: 600 }));
app.use(cors({ origin: config.corsOrigins.length ? config.corsOrigins : false }));
app.use(express.json({ limit: '2mb' }));
app.use(sanitize);

// Structured request log (one JSON line per request) with a request id for support.
app.use((req, res, next) => {
  req.id = crypto.randomBytes(6).toString('hex');
  res.setHeader('X-Request-Id', req.id);
  if (config.isTest || req.path === '/api/health') return next();
  const t0 = Date.now();
  res.on('finish', () => { if (req.path.startsWith('/api')) console.log(JSON.stringify({ t: new Date().toISOString(), id: req.id, m: req.method, p: req.path, s: res.statusCode, ms: Date.now() - t0 })); });
  next();
});

app.get('/api/health', async (req, res) => {
  let dbOk = false;
  try { dbOk = await db.ping(); } catch { /* reported below */ }
  res.status(dbOk ? 200 : 503).json({ ok: dbOk, db: dbOk ? 'up' : 'down', seeding: state.seeding, time: db.now() });
});

app.use('/api', limiter(60 * 1000, 300, 'Too many requests. Please slow down.'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/kb', require('./routes/kb'));
app.use('/api/items', require('./routes/items'));
app.use('/api/insights', require('./routes/insights'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/gate', require('./routes/gate'));
app.use('/api/keys', require('./routes/keys'));
app.use('/api/workflows', require('./routes/workflows'));
app.use('/api/public', require('./routes/public'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// Serve the built React app when it exists (npm run build in /client), so one server runs everything.
const dist = path.join(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { maxAge: config.isProd ? '1h' : 0, index: false }));
  app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  let status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (err.type === 'entity.parse.failed') status = 400;
  if (status >= 500) console.error(JSON.stringify({ id: req.id, error: err.message, stack: config.isProd ? undefined : err.stack }));
  const message = err.type === 'entity.parse.failed' ? 'The request body is not valid JSON.' : err.code === 'LIMIT_FILE_SIZE' ? `File too large (max ${config.maxUploadMb} MB).` : status >= 500 ? 'Something went wrong on the server.' : err.message;
  res.status(status).json({ error: message, request_id: req.id, ...(err.open_high ? { open_high: err.open_high } : {}) });
});

// Load the demo organisation in the background so the server accepts traffic immediately.
async function bootstrap() {
  await seedRegs();
  require('./services/certificate').backfill().then((n) => n && console.log(`Public verification codes added to ${n} existing certificate(s).`)).catch((e) => console.error('Certificate backfill failed:', e.message));
  if (config.seedDemo && (await db.count('orgs')) === 0) {
    state.seeding = true;
    try {
      const { seedDemo, PASSWORD } = require('./seed');
      const r = await seedDemo();
      console.log(`Demo data loaded. Sign in as ${r.users[0]} / ${PASSWORD}`);
    } catch (e) { console.error('Demo seeding failed:', e.message); }
    state.seeding = false;
  }
}

let server;
async function start() {
  config.validate();
  await db.connect();
  console.log(`Database connected (${config.dbDriver}${config.dbDriver === 'mongo' ? `, db "${config.mongoDb}"` : ''}).`);
  server = app.listen(config.port, () => console.log(`BrandSentinel running on port ${config.port} (${config.isProd ? 'production' : 'development'}).`));
  bootstrap().catch((e) => console.error('Bootstrap failed:', e.message));
  require('./services/sla').startTimer();
  const stop = async (sig) => {
    console.log(`${sig} received, shutting down.`);
    require('./services/sla').stopTimer();
    server.close(async () => { await db.close().catch(() => {}); process.exit(0); });
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  return server;
}

if (require.main === module) start().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { app, start, bootstrap };
