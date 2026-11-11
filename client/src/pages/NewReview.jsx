import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Field, useToast } from '../components/ui';

const SAMPLES = {
  caption: { title: 'Festive launch caption', channel: 'social', kind: 'text', intent: 'Announce the new roast and the festive offer', body: "Our new roast is India's #1 coffee, now 30% off this festive offer! Don't miss out!!! Visit Nova Brew today." },
  html: { title: 'Winter newsletter', channel: 'email', kind: 'html', intent: 'Invite subscribers to try the winter blend', body: '<html>\n<body style="font-family: \'Comic Sans MS\', cursive;">\n<h1>Winter at NovaBrew</h1>\n<h3 style="color:#E91E63">Warm up with our festive blend</h3>\n<p style="color:#bbbbbb">Our new roast is better than other brands.</p>\n<img src="hero.jpg">\n<p><a href="/winter">Click here</a> to see the menu.</p>\n</body>\n</html>' },
  ai: { title: 'Blog intro (AI draft)', channel: 'blog', kind: 'markdown', intent: 'Explain why small-batch roasting tastes better', ai: true, body: "In today's fast-paced world, coffee lovers want something real. Let's delve into why small-batch roasting is a game-changer.\n\n![](roaster.jpg)" },
  hindi: { title: 'Hindi festive caption', channel: 'social', kind: 'text', intent: 'Wish customers a happy festive season', body: 'इस त्योहार पर NovaBrew की सस्ता और स्वादिष्ट कॉफ़ी का आनंद लें।' },
};

export default function NewReview() {
  const nav = useNavigate();
  const toast = useToast();
  const [mode, setMode] = useState('write');
  const [f, setF] = useState({ title: '', channel: 'social', kind: 'text', intent: '', body: '', ai: false, aiTool: '', alt: '', declaredLogo: false });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const isImage = file && /\.(png|jpe?g)$/i.test(file.name);

  const load = (key) => { const s = SAMPLES[key]; setMode('write'); setF({ ...f, ...s, aiTool: s.ai ? 'ChatGPT' : '' }); };

  const submit = async (e) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      let r;
      if (mode === 'upload') {
        if (!file) throw new Error('Choose a file to upload.');
        const fd = new FormData();
        fd.append('file', file); fd.append('title', f.title); fd.append('channel', f.channel); fd.append('intent', f.intent);
        fd.append('ai_generated', f.ai); fd.append('ai_tool', f.aiTool);
        if (isImage) { fd.append('alt', f.alt); fd.append('declaredLogo', f.declaredLogo); }
        r = await api.form('/api/items', fd);
      } else {
        r = await api.post('/api/items', { title: f.title, channel: f.channel, kind: f.kind, intent: f.intent, body: f.body, ai_generated: f.ai, ai_tool: f.aiTool });
      }
      toast('Review complete. Findings are ready.');
      nav(`/items/${r.id}`);
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="page-head"><div><h1>New review</h1><p className="muted">Paste or upload your draft. BrandSentinel checks it against your approved guidelines, facts and assets, then explains every finding.</p></div></div>
      <form className="grid cols-2" onSubmit={submit} style={{ alignItems: 'start' }}>
        <div className="card stack">
          <Field label="Title"><input type="text" required maxLength={120} value={f.title} onChange={set('title')} placeholder="e.g. Diwali offer caption" /></Field>
          <div className="grid cols-2">
            <Field label="Channel" hint="Paid ads and press releases start at medium risk.">
              <select value={f.channel} onChange={set('channel')}>{['social', 'email', 'blog', 'web', 'paid-ad', 'press-release', 'internal'].map((c) => <option key={c}>{c}</option>)}</select>
            </Field>
            <Field label="Format">
              <select value={f.kind} onChange={set('kind')} disabled={mode === 'upload'}>{['text', 'markdown', 'html'].map((c) => <option key={c}>{c}</option>)}</select>
            </Field>
          </div>
          <Field label="What is this content meant to achieve? (purpose)" hint="Purpose Lock: suggested fixes are scored on how well they keep this purpose, and your numbers, names and key ideas stay intact.">
            <textarea required minLength={5} rows={3} value={f.intent} onChange={set('intent')} placeholder="e.g. Announce the festive offer and invite people to visit" />
          </Field>
          <label className="check"><input type="checkbox" checked={f.ai} onChange={set('ai')} /> This content was created or drafted with AI</label>
          {f.ai && <Field label="Which AI tool?"><input type="text" value={f.aiTool} onChange={set('aiTool')} placeholder="e.g. ChatGPT, Gemini, Copilot" /></Field>}
          <div>
            <p className="small muted" style={{ marginBottom: 6 }}>Try a sample:</p>
            <div className="chips">{[['caption', 'Social caption'], ['html', 'HTML email'], ['ai', 'AI-written blog'], ['hindi', 'Hindi caption']].map(([k, l]) => <button type="button" className="chip" key={k} onClick={() => load(k)}>{l}</button>)}</div>
          </div>
        </div>

        <div className="card stack">
          <div className="seg" role="group" aria-label="Input method">
            <button type="button" aria-pressed={mode === 'write'} onClick={() => setMode('write')}>Write or paste</button>
            <button type="button" aria-pressed={mode === 'upload'} onClick={() => setMode('upload')}>Upload a file</button>
          </div>
          {mode === 'write' ? (
            <Field label="Content"><textarea required rows={14} className={f.kind === 'html' ? 'code' : ''} value={f.body} onChange={set('body')} placeholder="Paste your caption, email, blog post or HTML here" /></Field>
          ) : (
            <>
              <Field label="File" hint="Supported: .txt .md .html .docx .pdf .pptx .png .jpg (up to 15 MB). Files stay on this server.">
                <input type="file" accept=".txt,.md,.html,.htm,.docx,.pdf,.pptx,.png,.jpg,.jpeg" onChange={(e) => setFile(e.target.files[0] || null)} />
              </Field>
              {isImage && (
                <>
                  <Field label="Alt text" hint="Describe what the image shows and any text in it. Leave empty to see how the accessibility check responds."><input type="text" value={f.alt} onChange={set('alt')} /></Field>
                  <label className="check"><input type="checkbox" checked={f.declaredLogo} onChange={set('declaredLogo')} /> This image is a logo file (check its proportions and size)</label>
                </>
              )}
            </>
          )}
          {err && <div className="notice err" role="alert">{err}</div>}
          <button className="btn primary" disabled={busy}>{busy ? 'Checking…' : 'Run brand check'}</button>
          <p className="small muted">Nothing is published and nothing is changed automatically. You decide which suggestions to accept.</p>
        </div>
      </form>
    </>
  );
}
