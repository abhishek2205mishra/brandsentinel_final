// Review engine orchestrator.
// Pipeline: load context -> run rule modules -> (optional) local LLM -> verify citations -> suggest -> risk tier.
const db = require('../db');
const { visibleText, sha256 } = require('../util/text');
const { SEVERITY_RANK } = require('./helpers');
const { buildSuggestions } = require('./suggest');
const llm = require('./llm');
const semantic = require('./semantic');
const calibration = require('../services/calibration');

const RULES = {
  terminology: require('./rules/terminology'),
  tone: require('./rules/tone'),
  claims: require('./rules/claims'),
  facts: require('./rules/facts'),
  accessibility: require('./rules/accessibility'),
  visual: require('./rules/visual'),
  provenance: require('./rules/provenance'),
};
const ENGINE_VERSION = '1.0.0';

async function loadContext(orgId, input) {
  const [org, guidelines, regRows, terms, facts, claims, assets] = await Promise.all([
    db.get('orgs', orgId),
    db.find('guidelines', { org_id: orgId, active: 1 }),
    db.find('regs'),
    db.find('terms', { org_id: orgId }, { sort: { id: 1 } }),
    db.find('facts', { org_id: orgId }, { sort: { id: 1 } }),
    db.find('claims', { org_id: orgId }, { sort: { id: 1 } }),
    db.find('assets', { org_id: orgId }, { sort: { id: 1 } }),
  ]);
  const settings = db.json(org.settings, {});
  const regs = {};
  regRows.forEach((r) => { regs[r.code] = r; });
  const kind = input.kind || 'text';
  const text = input.body || '';
  return {
    orgId, settings, guidelines: guidelines.sort((a, b) => a.id - b.id).map((g) => ({ ...g, rule: db.json(g.rule) })), regs,
    packs: new Set(settings.packs || ['wcag', 'asci', 'cpa', 'fssai', 'euai']),
    terms, facts, claims,
    assets: assets.map((a) => ({ ...a, data: db.json(a.data, {}) })),
    kind, isHtml: kind === 'html', text, view: visibleText(text, kind === 'html'),
    meta: input.meta || {}, intent: input.intent || '', channel: input.channel || 'social',
    ai_generated: !!input.ai_generated, orgName: org.name || '',
    useSemantic: input.useSemantic, useCalibration: input.useCalibration, useDense: input.useDense,
    today: input.today ? new Date(input.today) : new Date(),
  };
}

// Evidence-or-silence: a finding must cite a source that really exists, otherwise it is demoted to advisory.
function knownCodes(ctx) {
  const codes = new Set(ctx.guidelines.map((g) => g.code));
  Object.keys(ctx.regs).forEach((c) => codes.add(c));
  ctx.terms.forEach((t) => codes.add(`TERM-${t.id}`));
  ctx.facts.forEach((f) => codes.add(`FACT-${f.id}`));
  ctx.claims.forEach((c) => codes.add(`CLAIM-${c.id}`));
  ctx.assets.forEach((a) => codes.add(`ASSET-${a.id}`));
  return codes;
}

function riskOf(findings, ctx) {
  const live = findings.filter((f) => !f.advisory);
  if (live.some((f) => ['claims', 'facts'].includes(f.category) && f.severity === 'high')) return 'high';
  if (live.some((f) => SEVERITY_RANK[f.severity] >= 2) || ['paid-ad', 'press-release'].includes(ctx.channel)) return 'medium';
  return 'low';
}

async function analyze(ctx) {
  let findings = [];
  let supported = [];
  const errors = [];
  for (const [name, fn] of Object.entries(RULES)) {
    try {
      const r = fn(ctx);
      if (Array.isArray(r)) findings.push(...r);
      else { findings.push(...r.findings); supported = r.supported; }
    } catch (e) { errors.push(`${name}: ${e.message}`); }
  }

  const events = [{ service: 'local-rules', model: `rules-engine@${ENGINE_VERSION}`, purpose: 'brand-review', redactions: 0, sent_external: 0, note: 'Processed entirely inside this server' }];

  // Older claim rules are also made negation/idiom/third-party aware (same guards as the semantic layer).
  findings = findings.filter((f) => { try { return !semantic.shouldSuppress(ctx, f); } catch { return true; } });

  // Semantic layer: finds claims/terms by meaning and cites the retrieved clause. Never creates a finding without a citation.
  ctx.events = events;
  try {
    const sem = await semantic.analyzeSemantic(ctx, findings);
    findings.push(...sem.findings);
    events.push(...sem.events);
  } catch (e) { errors.push(`semantic: ${e.message}`); }

  // Optional local LLM nuance pass (verified, redacted, ledger-logged).
  try {
    const nuance = await llm.nuanceReview(ctx, findings);
    findings.push(...nuance.findings);
    events.push(...nuance.events);
  } catch (e) { errors.push(`llm: ${e.message}`); }

  // Verify citations.
  const codes = knownCodes(ctx);
  for (const f of findings) {
    f.advisory = !(f.source && f.source.code && codes.has(f.source.code));
    if (f.advisory) { f.severity = 'info'; f.message = `Advisory (no approved source found): ${f.message}`; }
    f.fingerprint = `${f.rule}:${(f.matched || '').toLowerCase().slice(0, 80)}`;
  }

  // De-duplicate identical spans from the same rule.
  const seen = new Set();
  findings = findings.filter((f) => { const k = `${f.rule}|${f.start}|${f.end}`; if (seen.has(k)) return false; seen.add(k); return true; });

  try { await calibration.apply(ctx, findings); } catch (e) { errors.push(`calibration: ${e.message}`); }

  try {
    const rw = await llm.rewriteSuggestions(ctx, findings);
    events.push(...rw.events);
  } catch (e) { errors.push(`llm-rewrite: ${e.message}`); }

  for (const f of findings) { f.suggestions = buildSuggestions(ctx, f); delete f.fix; }

  findings.sort((a, b) => (a.start < 0) - (b.start < 0) || a.start - b.start);
  const risk = riskOf(findings, ctx);
  const stats = { total: findings.length, by_severity: {}, by_category: {} };
  for (const f of findings) {
    stats.by_severity[f.severity] = (stats.by_severity[f.severity] || 0) + 1;
    stats.by_category[f.category] = (stats.by_category[f.category] || 0) + 1;
  }
  return { findings, supported_claims: supported, risk, stats, events, errors, engine: { version: ENGINE_VERSION, rules: [...Object.keys(RULES), 'semantic'], content_hash: sha256(ctx.text) } };
}

module.exports = { loadContext, analyze, ENGINE_VERSION, RULE_MODULES: Object.keys(RULES) };
