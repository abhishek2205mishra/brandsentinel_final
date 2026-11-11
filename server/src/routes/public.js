// Public certificate verification: no login. Lets agencies and partners prove that content was approved.
// Returns authenticity and what was checked; never the content, author names or internal ids.
const express = require('express');
const QRCode = require('qrcode');
const config = require('../config');
const { wrap, httpError, limiter } = require('../middleware/auth');
const cert = require('../services/certificate');
const { sha256 } = require('../util/text');

const router = express.Router();
router.use(limiter(60 * 1000, 40, 'Too many verification requests. Please wait a minute.'));

router.get('/verify/:code', wrap(async (req, res) => {
  const v = await cert.publicView(req.params.code);
  if (!v) return res.status(404).json({ status: 'not_found', error: 'No certificate with that code. Check the code and try again.' });
  res.setHeader('Cache-Control', 'no-store');
  res.json(v);
}));

// Paste the text you are about to publish: does it match the approved wording?
router.post('/verify/:code/check', wrap(async (req, res) => {
  const text = (req.body || {}).text;
  if (typeof text !== 'string' || !text.trim()) throw httpError(400, 'Paste the text you want to check.');
  if (text.length > 200000) throw httpError(413, 'That text is too long.');
  const v = await cert.publicView(req.params.code);
  if (!v) throw httpError(404, 'No certificate with that code.');
  const exact = sha256(text) === v.content_hash;
  const snap = v.checks || {};
  const wording = !!(snap.content && snap.content.content_hash_norm && cert.normHash(text) === snap.content.content_hash_norm);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    status: v.status, match: v.status === 'valid' && (exact || wording), exact_match: exact, wording_match: wording && !exact,
    message: v.status !== 'valid' ? 'This certificate is not valid, so nothing can be confirmed.' : exact ? 'Exact match: this is the approved text.' : wording ? 'The wording matches the approved text; only spacing or line breaks differ.' : 'No match: this text differs from what was approved. It must be reviewed again.',
  });
}));

router.get('/verify/:code/qr.svg', wrap(async (req, res) => {
  const v = await cert.publicView(req.params.code);
  if (!v) throw httpError(404, 'No certificate with that code.');
  const base = config.publicUrl || `${req.protocol}://${req.get('host')}`;
  const svg = await QRCode.toString(`${base}/verify/${v.code}`, { type: 'svg', margin: 1, width: 220, errorCorrectionLevel: 'M' });
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(svg);
}));

module.exports = router;
