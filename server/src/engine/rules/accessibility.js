// Accessibility checks mapped to WCAG success criteria (cited from the regulatory pack).
const { parseColor, contrastRatio } = require('../../util/color');
const { finding, citeReg, clause, citeClause, alsoCites } = require('../helpers');

const GENERIC_LINK = /^(click here|here|read more|more|learn more|link|this|details)$/i;

module.exports = function accessibility(ctx) {
  const out = [];
  const raw = ctx.text;

  const c111 = citeReg(ctx, 'WCAG-1.1.1');
  const c131 = citeReg(ctx, 'WCAG-1.3.1');
  const c143 = citeReg(ctx, 'WCAG-1.4.3');
  const c244 = citeReg(ctx, 'WCAG-2.4.4');
  const c311 = citeReg(ctx, 'WCAG-3.1.1');

  if (ctx.isHtml) {
    let m;
    if (c111) {
      const imgRe = /<img\b[^>]*>/gi;
      while ((m = imgRe.exec(raw))) {
        const tag = m[0];
        const altM = tag.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
        const span = { start: m.index, end: m.index + tag.length, matched: tag };
        if (!altM) {
          out.push(finding({
            ...span, rule: 'a11y.alt_missing', category: 'accessibility', severity: 'high', confidence: 0.99,
            message: 'This image has no alt attribute, so screen-reader users get no description (or hear the file name).',
            source: c111, fix: { minimal: tag.replace(/<img/i, '<img alt="[describe this image]"') },
          }));
        } else {
          const alt = (altM[1] ?? altM[2] ?? '').trim();
          if (/\[describe/i.test(alt)) {
            out.push(finding({ ...span, rule: 'a11y.alt_quality', category: 'accessibility', severity: 'medium', confidence: 0.99, message: 'Placeholder alt text must be replaced with a real description before publishing.', source: c111 }));
          } else if (/\.(png|jpe?g|gif|svg|webp)$/i.test(alt) || /^(img|image|dsc|photo|screenshot)[_\- ]?\d*$/i.test(alt)) {
            out.push(finding({ ...span, rule: 'a11y.alt_quality', category: 'accessibility', severity: 'medium', confidence: 0.9, message: `Alt text "${alt}" looks like a file name, not a description.`, source: c111 }));
          } else if (/^(image|picture|photo|graphic) of\b/i.test(alt)) {
            out.push(finding({ ...span, rule: 'a11y.alt_quality', category: 'accessibility', severity: 'low', confidence: 0.8, message: 'Alt text should not start with "image of" or "picture of"; screen readers already announce an image.', source: c111 }));
          }
        }
      }
    }

    if (c131) {
      const hRe = /<h([1-6])\b[^>]*>[\s\S]*?<\/h\1>/gi;
      let prev = 0;
      while ((m = hRe.exec(raw))) {
        const lvl = Number(m[1]);
        if (prev && lvl - prev > 1) {
          out.push(finding({
            rule: 'a11y.heading_order', category: 'accessibility', severity: 'medium', confidence: 0.95,
            start: m.index, end: m.index + m[0].length, matched: m[0],
            message: `Heading jumps from h${prev} to h${lvl}. Skipped levels break the page outline for assistive technology.`,
            source: c131,
          }));
        }
        prev = lvl;
      }
    }

    if (c244) {
      const aRe = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
      while ((m = aRe.exec(raw))) {
        const inner = m[1];
        if (!/</.test(inner) && GENERIC_LINK.test(inner.trim())) {
          const start = m.index + m[0].indexOf('>') + 1;
          out.push(finding({
            rule: 'a11y.link_text', category: 'accessibility', severity: 'medium', confidence: 0.95,
            start, end: start + inner.length, matched: inner,
            message: `Link text "${inner.trim()}" does not say where the link goes. Use descriptive text such as "View the festive menu".`,
            source: c244,
          }));
        }
      }
    }

    if (c311) {
      const lm = /<html\b(?![^>]*\blang\s*=)[^>]*>/i.exec(raw);
      if (lm) {
        out.push(finding({
          rule: 'a11y.lang', category: 'accessibility', severity: 'medium', confidence: 0.99,
          start: lm.index, end: lm.index + lm[0].length, matched: lm[0],
          message: 'The page does not declare its language, so screen readers may pronounce it incorrectly.',
          source: c311, fix: { minimal: lm[0].replace(/<html/i, '<html lang="en"') },
        }));
      }
    }

    if (c143) {
      const sRe = /<([a-z][a-z0-9]*)\b[^>]*?\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi;
      while ((m = sRe.exec(raw))) {
        const style = m[2] ?? m[3] ?? '';
        const fg = parseColor((style.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i) || [])[1]);
        if (!fg) continue;
        const bgRaw = (style.match(/background(?:-color)?\s*:\s*([^;]+)/i) || [])[1];
        const bg = parseColor(bgRaw) || [255, 255, 255];
        const size = parseFloat((style.match(/font-size\s*:\s*([\d.]+)px/i) || [])[1] || '16');
        const bold = /font-weight\s*:\s*(bold|[6-9]00)/i.test(style);
        const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
        const ratio = contrastRatio(fg, bg);
        if (ratio < need) {
          out.push(finding({
            rule: 'a11y.contrast', category: 'accessibility', severity: 'medium', confidence: bgRaw ? 0.95 : 0.65,
            start: m.index, end: m.index + m[0].length, matched: m[0],
            message: `Text contrast is ${ratio}:1 but WCAG AA needs at least ${need}:1${bgRaw ? '' : ' (checked against a white background)'}.`,
            source: c143,
          }));
        }
      }
    }
  } else if (ctx.kind !== 'image') {
    let m;
    const imgRe = /!\[([^\]]*)\]\(([^)]*)\)/g;
    while (c111 && (m = imgRe.exec(raw))) {
      if (!m[1].trim()) {
        out.push(finding({
          rule: 'a11y.alt_missing', category: 'accessibility', severity: 'high', confidence: 0.99,
          start: m.index, end: m.index + m[0].length, matched: m[0],
          message: 'This image has empty alt text, so screen-reader users get no description.',
          source: c111, fix: { minimal: `![[describe this image]](${m[2]})` },
        }));
      } else if (/\[describe/i.test(m[1])) {
        out.push(finding({ rule: 'a11y.alt_quality', category: 'accessibility', severity: 'medium', confidence: 0.99, start: m.index, end: m.index + m[0].length, matched: m[0], message: 'Placeholder alt text must be replaced with a real description before publishing.', source: c111 }));
      }
    }
    const linkRe = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;
    while (c244 && (m = linkRe.exec(raw))) {
      if (GENERIC_LINK.test(m[1].trim())) {
        out.push(finding({
          rule: 'a11y.link_text', category: 'accessibility', severity: 'medium', confidence: 0.95,
          start: m.index + 1, end: m.index + 1 + m[1].length, matched: m[1],
          message: `Link text "${m[1]}" does not say where the link goes. Use descriptive text.`, source: c244,
        }));
      }
    }
  }

  // Social hashtags written in all lowercase are read out letter by letter (org clause required).
  const hash = clause(ctx, 'a11y.hashtag');
  if (hash) {
    const re = /(?<![\p{L}\p{N}&])#[a-z]{10,}(?![\p{L}\p{N}])/gu;
    let m;
    while ((m = re.exec(ctx.view))) {
      out.push(finding({
        rule: 'a11y.hashtag', category: 'accessibility', severity: 'low', confidence: 0.85,
        start: m.index, end: m.index + m[0].length, matched: m[0],
        message: `${m[0]} is all lowercase. Capitalise each word (for example #NovaBrewFestive) so screen readers can pronounce it.`,
        source: citeClause(hash), also: alsoCites(ctx, ['WCAG-1.1.1']),
      }));
    }
  }

  // Uploaded image: alt text supplied by the creator, and overall contrast estimate.
  if (ctx.kind === 'image') {
    if (c111 && !(ctx.meta.alt || '').trim()) {
      out.push(finding({
        rule: 'a11y.alt_missing', category: 'accessibility', severity: 'high', confidence: 0.99,
        message: 'No alt text was provided for this image. Describe what it shows and any text inside it.', source: c111,
      }));
    }
    const contrast = ctx.meta.image && ctx.meta.image.contrast;
    if (c143 && contrast && contrast < 3) {
      out.push(finding({
        rule: 'a11y.image_contrast', category: 'accessibility', severity: 'low', confidence: 0.55,
        message: `The image has a low overall tonal contrast (${contrast}:1); any text on it may be hard to read. Check text contrast manually.`, source: c143,
      }));
    }
  }
  return out;
};
