const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const env = process.env;
const isProd = env.NODE_ENV === 'production';
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

const config = {
  isProd,
  isTest: env.NODE_ENV === 'test',
  port: Number(env.PORT) || 4000,
  jwtSecret: env.JWT_SECRET || 'dev-only-jwt-secret-change-me',
  certSecret: env.CERT_SECRET || 'dev-only-certificate-secret-change-me',

  // Database: "mongo" (MongoDB Atlas, production) or "memory" (tests / quick local try-out, data is lost on restart).
  dbDriver: env.DB_DRIVER || (env.MONGODB_URI ? 'mongo' : 'memory'),
  mongoUri: env.MONGODB_URI || '',
  mongoDb: env.MONGODB_DB || 'brandsentinel',

  // Hosted LLM (free tiers): "gemini", "groq" or "none".
  llmProvider: (env.LLM_PROVIDER || (env.GEMINI_API_KEY ? 'gemini' : env.GROQ_API_KEY ? 'groq' : 'none')).toLowerCase(),
  geminiKey: env.GEMINI_API_KEY || '',
  geminiModel: env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
  groqKey: env.GROQ_API_KEY || '',
  groqModel: env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  // Test hook: point the provider at a mock server.
  llmBaseUrl: env.LLM_BASE_URL || '',

  ocrEnabled: env.OCR_ENABLED === 'true',
  slackWebhook: env.SLACK_WEBHOOK_URL || '',
  // Comma-separated list of browser origins allowed to call the API from another domain (e.g. a Vercel frontend).
  corsOrigins: list(env.CLIENT_ORIGIN || (isProd ? '' : 'http://localhost:5173,http://127.0.0.1:5173')),
  allowRegistration: env.ALLOW_REGISTRATION !== 'false',
  seedDemo: env.SEED_DEMO !== 'false',
  maxUploadMb: Number(env.MAX_UPLOAD_MB) || 10,

  // ---- Round 3 ----
  // Public base URL used in emails, certificate links and QR codes. Render sets RENDER_EXTERNAL_URL automatically.
  publicUrl: (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, ''),
  // Gate API (browser extension / integrations): per-key limits.
  gateRatePerMin: Number(env.GATE_RATE_PER_MIN) || 30,
  gateDailyCap: Number(env.GATE_DAILY_CAP) || 3000,
  gateMaxChars: Number(env.GATE_MAX_CHARS) || 20000,
  // Email: free HTTPS-API providers only (Render's free plan blocks SMTP ports). "brevo", "resend" or "none".
  emailProvider: (env.EMAIL_PROVIDER || (env.BREVO_API_KEY ? 'brevo' : env.RESEND_API_KEY ? 'resend' : 'none')).toLowerCase(),
  brevoKey: env.BREVO_API_KEY || '',
  resendKey: env.RESEND_API_KEY || '',
  emailFrom: env.EMAIL_FROM || '',
  emailFromName: env.EMAIL_FROM_NAME || 'BrandSentinel',
  emailBaseUrl: env.EMAIL_BASE_URL || '', // test hook: mock email API
  // Approval SLA scheduler (minutes between checks; 0 disables the timer, requests still trigger a lazy check).
  slaTickMinutes: env.SLA_TICK_MINUTES === undefined ? 5 : Number(env.SLA_TICK_MINUTES),
  // Semantic retrieval: "auto" uses Gemini embeddings when GEMINI_API_KEY exists, otherwise the built-in offline vectors.
  embeddingProvider: (env.EMBEDDING_PROVIDER || 'auto').toLowerCase(),
  embeddingModel: env.EMBEDDING_MODEL || 'gemini-embedding-001',
  semanticEnabled: env.SEMANTIC !== 'off',
  calibrationEnabled: env.CALIBRATION !== 'off',
};

// Fail fast in production with a clear message instead of running insecurely.
config.validate = () => {
  const problems = [];
  if (isProd) {
    if (config.dbDriver !== 'mongo' || !config.mongoUri) problems.push('MONGODB_URI is required in production.');
    if (config.jwtSecret.length < 32 || config.jwtSecret.startsWith('dev-only')) problems.push('JWT_SECRET must be set to a random string of at least 32 characters.');
    if (config.certSecret.length < 32 || config.certSecret.startsWith('dev-only')) problems.push('CERT_SECRET must be set to a random string of at least 32 characters.');
  }
  if (config.dbDriver === 'mongo' && !config.mongoUri) problems.push('DB_DRIVER=mongo needs MONGODB_URI.');
  if (problems.length) throw new Error('Configuration error:\n - ' + problems.join('\n - '));
};

module.exports = config;
