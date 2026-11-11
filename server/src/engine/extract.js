// Turns uploaded files into reviewable text + metadata. All parsers are free, open-source and run locally.
const path = require('path');
const mammoth = require('mammoth');
const JSZip = require('jszip');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');
const { toHex, luminance, contrastRatio } = require('../util/color');
const config = require('../config');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg']);

async function extractPdf(buf) {
  // Mozilla pdf.js (free, open source). ESM-only, so it is loaded with a dynamic import.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false, verbosity: 0 }).promise;
  } catch (e) {
    const err = new Error('This PDF could not be read. It may be damaged or password-protected.');
    err.status = 400;
    throw err;
  }
  let body = '';
  const ranges = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let t = '', lastY;
    for (const it of tc.items) {
      if (lastY !== undefined && Math.abs(lastY - it.transform[5]) > 2) t += '\n';
      t += it.str;
      lastY = it.transform[5];
    }
    const start = body.length;
    body += t + (i < doc.numPages ? '\n\n' : '');
    ranges.push({ page: i, start, end: body.length });
  }
  await doc.destroy();
  return { body, meta: { pages: ranges } };
}

async function extractPptx(buf) {
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
  let body = '';
  const ranges = [];
  for (let i = 0; i < names.length; i++) {
    const xml = await zip.files[names[i]].async('string');
    const paras = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((p) => [...p[1].matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)].map((t) => t[1]).join('')).filter(Boolean);
    const start = body.length;
    body += paras.join('\n').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') + '\n\n';
    ranges.push({ page: i + 1, start, end: body.length, label: 'Slide' });
  }
  return { body: body.trim(), meta: { pages: ranges } };
}

function analyseImage(buf, ext) {
  let img;
  if (ext === '.png') { const p = PNG.sync.read(buf); img = { w: p.width, h: p.height, data: p.data }; }
  else { const j = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 256 }); img = { w: j.width, h: j.height, data: j.data }; }
  const step = Math.max(1, Math.floor(Math.sqrt((img.w * img.h) / 40000)));
  const buckets = new Map();
  const lums = [];
  let n = 0;
  for (let y = 0; y < img.h; y += step) {
    for (let x = 0; x < img.w; x += step) {
      const i = (y * img.w + x) * 4;
      if (img.data[i + 3] < 200) continue;
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const cur = buckets.get(key) || { c: 0, r: 0, g: 0, b: 0 };
      cur.c++; cur.r += r; cur.g += g; cur.b += b;
      buckets.set(key, cur);
      lums.push(luminance([r, g, b]));
      n++;
    }
  }
  const palette = [...buckets.values()].sort((a, b) => b.c - a.c).slice(0, 6)
    .map((k) => ({ hex: toHex([k.r / k.c, k.g / k.c, k.b / k.c]), share: Math.round((k.c / n) * 1000) / 1000 }));
  lums.sort((a, b) => a - b);
  const lo = lums[Math.floor(lums.length * 0.05)] ?? 0;
  const hi = lums[Math.floor(lums.length * 0.95)] ?? 1;
  const contrast = Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  return { w: img.w, h: img.h, palette, contrast };
}

async function ocr(buf) {
  if (!config.ocrEnabled) return '';
  try {
    const { createWorker } = require('tesseract.js'); // optional: npm install tesseract.js
    const worker = await createWorker('eng');
    const { data } = await worker.recognize(buf);
    await worker.terminate();
    return data.text || '';
  } catch { return ''; }
}

// file: { buffer, originalname }
async function extractFile(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  const buf = file.buffer;
  if (ext === '.docx') {
    const r = await mammoth.extractRawText({ buffer: buf });
    return { kind: 'document', body: r.value.trim(), meta: {} };
  }
  if (ext === '.pdf') { const r = await extractPdf(buf); return { kind: 'document', ...r }; }
  if (ext === '.pptx') { const r = await extractPptx(buf); return { kind: 'document', ...r }; }
  if (IMAGE_EXT.has(ext)) {
    const image = analyseImage(buf, ext === '.jpeg' ? '.jpg' : ext);
    const text = await ocr(buf);
    return { kind: 'image', body: text.trim(), meta: { image, ocr: !!text } };
  }
  if (['.html', '.htm'].includes(ext)) return { kind: 'html', body: buf.toString('utf8'), meta: {} };
  if (['.md', '.markdown'].includes(ext)) return { kind: 'markdown', body: buf.toString('utf8'), meta: {} };
  if (['.txt', '.csv', ''].includes(ext)) return { kind: 'text', body: buf.toString('utf8'), meta: {} };
  const err = new Error(`Unsupported file type "${ext}". Supported: txt, md, html, docx, pdf, pptx, png, jpg.`);
  err.status = 400;
  throw err;
}

module.exports = { extractFile, analyseImage };
