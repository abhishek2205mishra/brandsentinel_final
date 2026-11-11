const test = require('node:test');
const assert = require('node:assert');
const { evaluate } = require('../eval/run');
const { applyReplacement } = require('../src/engine/intent');
const { contrastRatio, parseColor } = require('../src/util/color');
const { redact } = require('../src/util/redact');
const { fleschKincaid } = require('../src/util/readability');

test('gold-set quality gate (precision >= 0.85, recall >= 0.80)', async () => {
  const r = await evaluate({ verbose: false });
  assert.ok(r.precision >= 0.85, `precision ${r.precision}: ${r.misses.join('; ')}`);
  assert.ok(r.recall >= 0.8, `recall ${r.recall}: ${r.misses.join('; ')}`);
});
test('replacement tidies spacing and capitalisation', () => {
  assert.equal(applyReplacement('Buy now, hurry up.', 9, 14, ''), 'Buy now, up.');
  assert.equal(applyReplacement('Hurry up and sip.', 0, 5, ''), 'Up and sip.');
});
test('WCAG contrast maths', () => {
  assert.equal(contrastRatio(parseColor('#000'), parseColor('#fff')), 21);
  assert.ok(contrastRatio(parseColor('#bbb'), parseColor('#fff')) < 2);
});
test('redaction masks personal data and confidential terms', () => {
  const r = redact('Mail a@b.com about Project Aurora, key sk-abcdefghijklmnopqrstuv', ['Project Aurora']);
  assert.ok(!/a@b\.com|Aurora|sk-abc/.test(r.text));
  assert.equal(r.count, 3);
});
test('readability returns null for very short text', () => {
  assert.equal(fleschKincaid('Short text.'), null);
});
