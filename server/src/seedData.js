// Starter content: regulatory packs (shared), starter brand guidelines (per organisation) and the NovaBrew demo brand.
const db = require('./db');

const DISCLAIMER = ' (Plain-language summary for review support; not legal advice. Check the official text.)';

const REGS = [
  { code: 'ASCI-1', pack: 'asci', title: 'ASCI Code, Chapter I: Truthful and honest representation', text: 'Advertisements must be truthful and honest. Objective claims, including superlatives, comparisons and claims about performance, must be capable of substantiation, and the advertiser must hold the evidence.' + DISCLAIMER },
  { code: 'CPA-2.28', pack: 'cpa', title: 'Consumer Protection Act 2019, Section 2(28): Misleading advertisement', text: 'A misleading advertisement falsely describes a product or service, gives a false guarantee, or deliberately hides important information. The Central Consumer Protection Authority can order it to be discontinued or modified and can impose penalties.' + DISCLAIMER },
  { code: 'FSSAI-CLAIMS', pack: 'fssai', title: 'FSSAI Advertising and Claims Regulations, 2018', text: 'Food advertisements and claims (health, nutrition, natural, organic, fresh) must not mislead and must meet the conditions set for each type of claim.' + DISCLAIMER },
  { code: 'WCAG-1.1.1', pack: 'wcag', title: 'WCAG 2.2 SC 1.1.1 Non-text Content (Level A)', text: 'All non-text content that is presented to the user has a text alternative that serves the equivalent purpose.' },
  { code: 'WCAG-1.3.1', pack: 'wcag', title: 'WCAG 2.2 SC 1.3.1 Info and Relationships (Level A)', text: 'Information, structure and relationships conveyed through presentation (such as heading levels) can be programmatically determined.' },
  { code: 'WCAG-1.4.3', pack: 'wcag', title: 'WCAG 2.2 SC 1.4.3 Contrast (Minimum) (Level AA)', text: 'Text and images of text have a contrast ratio of at least 4.5:1 (3:1 for large text).' },
  { code: 'WCAG-2.4.4', pack: 'wcag', title: 'WCAG 2.2 SC 2.4.4 Link Purpose, In Context (Level A)', text: 'The purpose of each link can be determined from the link text alone or from its context.' },
  { code: 'WCAG-3.1.1', pack: 'wcag', title: 'WCAG 2.2 SC 3.1.1 Language of Page (Level A)', text: 'The default human language of each page can be programmatically determined.' },
  { code: 'WCAG-3.1.5', pack: 'wcag', title: 'WCAG 2.2 SC 3.1.5 Reading Level (Level AAA)', text: 'When text requires reading ability beyond lower secondary education level, supplemental content or a simpler version is available.' },
  { code: 'EUAI-50', pack: 'euai', title: 'EU AI Act, Article 50: Transparency obligations', text: 'Content that is generated or manipulated by AI, such as synthetic images, audio, video and some AI-generated text published to inform the public, must be disclosed as artificially generated. Check the applicability dates and scope for your market.' + DISCLAIMER },
];

const STARTER = [
  { code: 'VOICE-1', title: 'Exclamation marks', category: 'tone', severity: 'low', text: 'Keep our voice calm and warm. Use at most one exclamation mark in any piece of content.', rule: { type: 'tone.exclaim', max: 1 } },
  { code: 'VOICE-2', title: 'No shouting', category: 'tone', severity: 'low', text: 'Do not write words in ALL CAPITALS. Capitals read as shouting and are hard for screen readers.', rule: { type: 'tone.caps', allow: ['ASCI', 'FSSAI', 'NPOP', 'WCAG', 'INR'] } },
  { code: 'VOICE-3', title: 'No pushy or hype language', category: 'tone', severity: 'low', text: 'Avoid pressure tactics and hype. We invite people; we never rush or shout at them.', rule: { type: 'tone.hype', phrases: [{ phrase: "don't miss out", replacement: 'join us' }, { phrase: 'hurry', replacement: '' }, { phrase: 'mind-blowing', replacement: 'delightful' }, { phrase: 'once in a lifetime', replacement: '' }, { phrase: 'amazing deal', replacement: 'festive offer' }, { phrase: 'grab it now', replacement: 'enjoy it today' }, { phrase: 'last chance', replacement: '' }, { phrase: 'act now', replacement: 'join us' }, { phrase: 'only today', replacement: '' }, { phrase: 'while stocks last', replacement: '' }] } },
  { code: 'VOICE-4', title: 'Emoji budget', category: 'tone', severity: 'low', text: 'Use no more than two emoji in a single post or message.', rule: { type: 'tone.emoji', max: 2 } },
  { code: 'VOICE-5', title: 'Sentence length', category: 'tone', severity: 'low', text: 'Keep sentences to 28 words or fewer so they are easy to read on a phone.', rule: { type: 'tone.sentence', maxWords: 28 } },
  { code: 'VOICE-6', title: 'Reading level', category: 'tone', severity: 'low', text: 'Write for a reading level of about grade 10 or below so everyone can follow it.', rule: { type: 'tone.grade', maxGrade: 10 } },
  { code: 'VOICE-7', title: 'No unedited AI boilerplate', category: 'tone', severity: 'low', text: 'Edit AI drafts so they sound like us. Remove stock phrases that AI tools add.', rule: { type: 'tone.ai_boilerplate', phrases: ["in today's fast-paced world", 'delve into', 'unlock the power of', 'game-changer', 'as an ai language model', 'i hope this message finds you well', 'tapestry'] } },
  { code: 'CLAIM-1', title: 'Claims need approved evidence', category: 'claims', severity: 'high', text: 'Never publish a superlative, comparative, health, financial, environmental or "natural" claim unless it is approved in the Claim Ledger with evidence that is still valid.', rule: { type: 'claims.policy' } },
  { code: 'FACT-1', title: 'No expired offer dates', category: 'facts', severity: 'high', text: 'Never publish an offer or validity date that has already passed.', rule: { type: 'facts.dates' } },
  { code: 'ACC-1', title: 'CamelCase hashtags', category: 'accessibility', severity: 'low', text: 'Write multi-word hashtags in CamelCase (for example #NovaBrewFestive) so screen readers can read them.', rule: { type: 'a11y.hashtag' } },
  { code: 'AI-1', title: 'Disclose AI-generated content', category: 'provenance', severity: 'medium', text: 'Content created or substantially drafted with AI must carry a visible disclosure label.', rule: { type: 'ai.disclosure', label: 'Created with AI assistance.', phrases: ['ai-assisted', 'created with ai', 'generated with ai', 'made with ai', 'ai generated', 'ai-generated'] } },
  { code: 'MSG-1', title: 'Lead with the customer benefit', category: 'messaging', severity: 'low', text: 'Start with what the customer gains, then describe the product. Never name or criticise competitors.', rule: null },
  { code: 'MSG-2', title: 'Our name', category: 'messaging', severity: 'medium', text: 'Always write our name as one word with a capital N and B: NovaBrew.', rule: null },
  { code: 'MSG-3', title: 'Describe the craft honestly', category: 'messaging', severity: 'medium', text: 'We roast in small batches. Use "small-batch" and avoid "artisanal", which we cannot prove.', rule: null },
  { code: 'INC-1', title: 'Inclusive language', category: 'terminology', severity: 'medium', text: 'Use inclusive, respectful words. Prefer "workforce" to "manpower", "blocklist/allowlist" to "blacklist/whitelist", and person-first wording about disability.', rule: null },
  { code: 'VIS-1', title: 'Colours, fonts and logo', category: 'visual', severity: 'medium', text: 'Use only the approved palette and fonts from the Asset Library. Never stretch or recolour the logo, and keep its minimum width and clear space.', rule: null },
];

// Inclusive-language starter terms (cited from INC-1). Every new organisation gets them; admins can edit or delete them.
const STARTER_TERMS = [
  ['manpower', 'workforce'], ['blacklist', 'blocklist'], ['whitelist', 'allowlist'], ['chairman', 'chair'], ['mankind', 'humankind'],
  ['housewives', 'homemakers'], ['handicapped', 'disabled people'], ['wheelchair-bound', 'wheelchair user'],
].map(([banned, preferred]) => ({ banned, preferred, reason: 'Use inclusive language.', lang: 'en', guideline_code: 'INC-1' }));

const DEFAULT_SETTINGS = {
  packs: ['wcag', 'asci', 'cpa', 'fssai', 'euai'],
  llm: { enabled: false, nuance: true, rewrite: true },
  confidential_mode: false,
  confidential_terms: [],
  retention_days: 365,
};

async function seedRegs() {
  const have = new Set((await db.find('regs', {}, { project: ['code'] })).map((r) => r.code));
  for (const r of REGS) {
    if (have.has(r.code)) continue;
    try { await db.insert('regs', r); } catch (e) { if (!db.isDuplicate(e)) throw e; }
  }
}

async function seedStarter(orgId) {
  const have = new Set((await db.find('guidelines', { org_id: orgId }, { project: ['code'] })).map((g) => g.code));
  for (const g of STARTER) {
    if (have.has(g.code)) continue;
    await db.insert('guidelines', {
      org_id: orgId, code: g.code, title: g.title, category: g.category, text: g.text, rule: g.rule ? JSON.stringify(g.rule) : null,
      severity: g.severity, confidential: 0, active: 1, version: 1, source_doc: 'Starter pack', updated_at: db.now(),
    });
  }
  const haveTerms = new Set((await db.find('terms', { org_id: orgId }, { project: ['banned'] })).map((t) => t.banned.toLowerCase()));
  for (const t of STARTER_TERMS) if (!haveTerms.has(t.banned)) await db.insert('terms', { org_id: orgId, ...t, created_at: db.now() });
}

const dayOffset = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

async function seedDemoBrand(orgId) {
  const t = db.now();
  const terms = [
    ['Nova Brew', 'NovaBrew', 'Our name is one word.', 'en', 'MSG-2'],
    ['Novabrew', 'NovaBrew', 'Our name is written NovaBrew, with a capital B.', 'en', 'MSG-2'],
    ['artisanal', 'small-batch', 'We cannot prove "artisanal"; we do roast in small batches.', 'en', 'MSG-3'],
    ['cheap', 'affordable', 'We never call our coffee cheap; it suggests low quality.', 'en', null],
    ['coffee addicts', 'coffee lovers', 'We do not joke about addiction.', 'en', null],
    ['सस्ता', 'किफायती', '"सस्ता" (cheap) suggests low quality; use "किफायती".', 'hi', null],
  ];
  for (const [banned, preferred, reason, lang, code] of terms) {
    await db.insert('terms', { org_id: orgId, banned, preferred, reason, lang, guideline_code: code, created_at: t });
  }
  await db.insert('facts', { org_id: orgId, subject: 'Festive offer', keywords: 'festive offer, festive discount, festive sale', statement: 'Festive offer: 20% off all whole-bean packs', value: '20%', valid_from: dayOffset(-5), valid_until: dayOffset(11), evidence: 'Campaign brief CB-2026-11', owner: 'Marketing head', confidential: 0, created_at: t });
  await db.insert('facts', { org_id: orgId, subject: '250g pack price', keywords: '250g pack, 250 g pack, 250g bag', statement: 'The 250g bag costs ₹349', value: '₹349', valid_from: dayOffset(-60), valid_until: dayOffset(120), evidence: 'Price list v4', owner: 'Finance', confidential: 0, created_at: t });
  await db.insert('facts', { org_id: orgId, subject: 'Free shipping threshold', keywords: 'free shipping, free delivery', statement: 'Free shipping on orders above ₹499', value: '₹499', valid_from: dayOffset(-200), valid_until: dayOffset(-35), evidence: 'Ops policy OP-12 (superseded)', owner: 'Operations', confidential: 0, created_at: t });
  await db.insert('facts', { org_id: orgId, subject: 'Q4 roastery expansion', keywords: 'new roastery, roastery expansion', statement: 'A second roastery opens in Pune in Q1 next year (unreleased)', value: 'Q1', valid_from: dayOffset(-10), valid_until: dayOffset(90), evidence: 'Board memo (confidential)', owner: 'CEO office', confidential: 1, created_at: t });
  const claims = [
    ['100% organic', 'natural', 'Certificate NPOP/NAB/0412, audit March 2026', dayOffset(200), 'Quality lead'],
    ['sustainably sourced', 'environmental', 'Supplier audit report SA-2026-03', dayOffset(150), 'Sourcing lead'],
    ['carbon neutral', 'environmental', 'Offset certificate CN-2025 (expired)', dayOffset(-12), 'Sustainability lead'],
  ];
  for (const [phrase, claim_type, evidence, valid_until, approved_by] of claims) {
    await db.insert('claims', { org_id: orgId, phrase, claim_type, evidence, valid_until, approved_by, created_at: t });
  }
  await db.insert('assets', { org_id: orgId, kind: 'palette', name: 'NovaBrew palette', created_at: t, data: JSON.stringify({ tolerance: 22, minImageWidth: 1080, colors: [{ name: 'Roast Brown', hex: '#5B3A29' }, { name: 'Crema', hex: '#F5E6D3' }, { name: 'Ember Orange', hex: '#E07A1F' }, { name: 'Leaf Green', hex: '#2F6B4F' }] }) });
  await db.insert('assets', { org_id: orgId, kind: 'fonts', name: 'NovaBrew fonts', created_at: t, data: JSON.stringify({ allowed: ['Inter', 'Georgia'] }) });
  await db.insert('assets', { org_id: orgId, kind: 'logo', name: 'NovaBrew logo', created_at: t, data: JSON.stringify({ aspect: 2.5, tolerance: 0.03, minWidth: 120, clearSpace: "Keep clear space equal to the height of the letter N on every side." }) });
}

module.exports = { REGS, STARTER, DEFAULT_SETTINGS, seedRegs, seedStarter, seedDemoBrand, dayOffset };
