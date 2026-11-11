// Visual consistency: brand palette, fonts and logo usage, from the approved Asset Library.
const { parseColor, toHex, deltaE, chroma } = require('../../util/color');
const { finding } = require('../helpers');

const GENERIC_FONTS = new Set(['sans-serif', 'serif', 'monospace', 'system-ui', 'inherit', 'initial', 'cursive', 'fantasy', 'ui-sans-serif', 'ui-serif', '-apple-system', 'blinkmacsystemfont']);
const assetSource = (a, quote) => ({ type: 'asset', code: `ASSET-${a.id}`, quote });

function nearest(rgb, colors) {
  let best = null;
  for (const c of colors) {
    const p = parseColor(c.hex);
    if (!p) continue;
    const d = deltaE(rgb, p);
    if (!best || d < best.d) best = { d, ...c };
  }
  return best;
}

module.exports = function visual(ctx) {
  const out = [];
  const palette = ctx.assets.find((a) => a.kind === 'palette');
  const fonts = ctx.assets.find((a) => a.kind === 'fonts');
  const logo = ctx.assets.find((a) => a.kind === 'logo');
  const raw = ctx.text;

  const palText = palette ? `Approved palette: ${palette.data.colors.map((c) => `${c.name} ${c.hex}`).join(', ')}` : '';
  const tol = palette ? palette.data.tolerance ?? 20 : 20;

  if (ctx.isHtml) {
    // Gather style regions (inline style attributes + <style> blocks) with absolute offsets.
    const regions = [];
    let m;
    const attr = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    while ((m = attr.exec(raw))) { const inner = m[1] ?? m[2] ?? ''; regions.push({ start: m.index + m[0].length - inner.length - 1, text: inner }); }
    const blk = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
    while ((m = blk.exec(raw))) regions.push({ start: m.index + m[0].indexOf('>') + 1, text: m[1] });

    const reported = new Set();
    for (const r of regions) {
      if (palette) {
        const colRe = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgba?\([^)]*\)/g;
        let c;
        while ((c = colRe.exec(r.text))) {
          const rgb = parseColor(c[0]);
          if (!rgb || chroma(rgb) < 10 || reported.has(c[0].toLowerCase())) continue;
          const near = nearest(rgb, palette.data.colors);
          if (near && near.d > tol) {
            reported.add(c[0].toLowerCase());
            out.push(finding({
              rule: 'visual.palette', category: 'visual', severity: 'medium', confidence: 0.9,
              start: r.start + c.index, end: r.start + c.index + c[0].length, matched: c[0],
              message: `Colour ${c[0]} is not in the brand palette (nearest approved: ${near.name} ${near.hex}).`,
              source: assetSource(palette, palText), fix: { minimal: near.hex.toLowerCase() },
            }));
          }
        }
      }
      if (fonts) {
        const fRe = /font-family\s*:\s*([^;}"]+)/gi;
        let f;
        while ((f = fRe.exec(r.text))) {
          const first = f[1].split(',')[0].trim().replace(/^["']|["']$/g, '');
          const allowed = fonts.data.allowed.map((x) => x.toLowerCase());
          if (!first || GENERIC_FONTS.has(first.toLowerCase()) || allowed.includes(first.toLowerCase())) continue;
          const s = r.start + f.index + (f[0].length - f[1].length);
          const rawFirst = f[1].split(',')[0].trim();
          const lead = f[1].indexOf(rawFirst);
          out.push(finding({
            rule: 'visual.font', category: 'visual', severity: 'low', confidence: 0.9,
            start: s + lead, end: s + lead + rawFirst.length, matched: rawFirst,
            message: `Font "${first}" is not an approved brand font (approved: ${fonts.data.allowed.join(', ')}).`,
            source: assetSource(fonts, `Approved fonts: ${fonts.data.allowed.join(', ')}`),
            fix: { minimal: fonts.data.allowed[0].includes(' ') ? `'${fonts.data.allowed[0]}'` : fonts.data.allowed[0] },
          }));
        }
      }
    }

    if (logo) {
      const imgRe = /<img\b[^>]*>/gi;
      while ((m = imgRe.exec(raw))) {
        if (!/logo/i.test(m[0])) continue;
        const w = parseFloat((m[0].match(/\bwidth\s*=\s*["']?(\d+(?:\.\d+)?)/i) || [])[1]);
        const h = parseFloat((m[0].match(/\bheight\s*=\s*["']?(\d+(?:\.\d+)?)/i) || [])[1]);
        const src = assetSource(logo, `Logo rules: aspect ratio ${logo.data.aspect}:1 (never stretch), minimum width ${logo.data.minWidth}px. ${logo.data.clearSpace || ''}`);
        const span = { start: m.index, end: m.index + m[0].length, matched: m[0] };
        if (w && h && Math.abs(w / h - logo.data.aspect) / logo.data.aspect > (logo.data.tolerance ?? 0.03)) {
          out.push(finding({ ...span, rule: 'visual.logo_distorted', category: 'visual', severity: 'high', confidence: 0.95, message: `Logo is stretched: displayed at ${(w / h).toFixed(2)}:1 but the approved ratio is ${logo.data.aspect}:1.`, source: src }));
        }
        if (w && w < logo.data.minWidth) {
          out.push(finding({ ...span, rule: 'visual.logo_small', category: 'visual', severity: 'medium', confidence: 0.95, message: `Logo is ${w}px wide; the minimum is ${logo.data.minWidth}px.`, source: src }));
        }
      }
    }
  }

  if (ctx.kind === 'image' && ctx.meta.image) {
    const img = ctx.meta.image;
    if (palette) {
      let n = 0;
      for (const c of img.palette || []) {
        if (n >= 3 || c.share < 0.08) continue;
        const rgb = parseColor(c.hex);
        if (!rgb || chroma(rgb) < 10) continue;
        const near = nearest(rgb, palette.data.colors);
        if (near && near.d > tol) {
          n++;
          out.push(finding({
            rule: 'visual.palette_image', category: 'visual', severity: 'medium', confidence: 0.75, matched: c.hex,
            message: `About ${Math.round(c.share * 100)}% of the image is ${c.hex}, which is not in the brand palette (nearest approved: ${near.name} ${near.hex}).`,
            source: assetSource(palette, palText),
          }));
        }
      }
      if (palette.data.minImageWidth && img.w < palette.data.minImageWidth) {
        out.push(finding({
          rule: 'visual.image_size', category: 'visual', severity: 'low', confidence: 0.95,
          message: `Image is ${img.w}px wide; brand guidelines ask for at least ${palette.data.minImageWidth}px for crisp display.`,
          source: assetSource(palette, `Minimum image width: ${palette.data.minImageWidth}px`),
        }));
      }
    }
    if (logo && ctx.meta.declaredLogo) {
      const ratio = img.w / img.h;
      const src = assetSource(logo, `Logo rules: aspect ratio ${logo.data.aspect}:1 (never stretch), minimum width ${logo.data.minWidth}px.`);
      if (Math.abs(ratio - logo.data.aspect) / logo.data.aspect > (logo.data.tolerance ?? 0.03)) {
        out.push(finding({ rule: 'visual.logo_distorted', category: 'visual', severity: 'high', confidence: 0.9, message: `This logo file is ${ratio.toFixed(2)}:1 but the approved ratio is ${logo.data.aspect}:1, so it looks stretched or cropped.`, source: src }));
      }
      if (img.w < logo.data.minWidth) {
        out.push(finding({ rule: 'visual.logo_small', category: 'visual', severity: 'medium', confidence: 0.95, message: `Logo is ${img.w}px wide; the minimum is ${logo.data.minWidth}px.`, source: src }));
      }
    }
  }
  return out;
};
