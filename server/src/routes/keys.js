// Per-user API keys (browser extension and integrations) + the extension download.
const express = require('express');
const path = require('path');
const fs = require('fs');
const JSZip = require('jszip');
const { wrap, auth, httpError, num } = require('../middleware/auth');
const keys = require('../services/apikeys');
const audit = require('../services/audit');

const router = express.Router();
router.use(auth);

router.get('/', wrap(async (req, res) => res.json({ keys: await keys.list(req.user, { all: req.query.all === '1' }), allowed: keys.ALLOWED_ROLES.includes(req.user.role) })));

router.post('/', wrap(async (req, res) => {
  const k = await keys.create(req.user, (req.body || {}).name);
  await audit.log(req.user.org_id, req.user.id, 'apikey.create', 'api_key', k.id, { name: k.name, prefix: k.prefix });
  res.status(201).json(k); // the only time the full key is returned
}));

router.delete('/:id', wrap(async (req, res) => {
  const k = await keys.revoke(req.user, num(req.params.id));
  await audit.log(req.user.org_id, req.user.id, 'apikey.revoke', 'api_key', k.id, { name: k.name, prefix: k.prefix });
  res.json({ ok: true });
}));

// The unpacked Chrome extension as a zip (built on the fly from /extension).
const EXT_DIR = path.join(__dirname, '..', '..', '..', 'extension');
router.get('/extension.zip', wrap(async (req, res) => {
  if (!fs.existsSync(EXT_DIR)) throw httpError(404, 'The extension files are not part of this deployment.');
  const zip = new JSZip();
  const walk = (dir, rel = '') => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (f.name === 'node_modules' || f.name.startsWith('.')) continue;
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p, rel + f.name + '/');
      else zip.file('brandsentinel-extension/' + rel + f.name, fs.readFileSync(p));
    }
  };
  walk(EXT_DIR);
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="brandsentinel-extension.zip"');
  res.send(buf);
}));

module.exports = router;
