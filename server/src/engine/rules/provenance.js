// AI-content provenance: content marked as AI-generated must carry a visible disclosure label.
const { finding, clause, citeClause, citeReg, alsoCites } = require('../helpers');

module.exports = function provenance(ctx) {
  if (!ctx.ai_generated) return [];
  const disc = clause(ctx, 'ai.disclosure');
  const eu = citeReg(ctx, 'EUAI-50');
  const source = disc ? citeClause(disc) : eu;
  if (!source) return [];

  const phrases = (disc && disc.rule.phrases) || ['ai-assisted', 'created with ai', 'generated with ai', 'made with ai', 'ai generated', 'ai-generated'];
  const lower = ctx.view.toLowerCase();
  if (phrases.some((p) => lower.includes(p.toLowerCase()))) return [];

  const label = (disc && disc.rule.label) || 'Created with AI assistance.';
  const insertion = ctx.isHtml ? `\n<p>${label}</p>` : `\n\n${label}`;
  const at = ctx.text.length;
  return [finding({
    rule: 'provenance.disclosure', category: 'provenance', severity: 'medium', confidence: 0.95,
    start: at, end: at, matched: '',
    message: `This content is marked as AI-generated${ctx.meta.aiTool ? ` (${ctx.meta.aiTool})` : ''} but has no visible AI disclosure label.`,
    source, also: disc ? alsoCites(ctx, ['EUAI-50']) : [],
    fix: { minimal: insertion, balanced: insertion },
  })];
};
