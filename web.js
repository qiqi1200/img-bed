// 网页图床 Worker — UI + GitHub 仓库存储 + jsDelivr CDN
// GET  /            → 图床网页（拖拽/粘贴上传）
// POST /api/upload  → 上传（X-Auth-Token 鉴权）→ 提交到 GitHub → 返回 jsDelivr URL
// Secrets: GH_TOKEN（GitHub PAT, repo 权限）, BED_SECRET（图床访问密钥）
const GH_USER = 'qiqi1200';
const GH_REPO = 'img-bed';
const GH_BRANCH = 'main';
const MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml', 'image/bmp'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors() });
    }
    try {
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
        return new Response(UI_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', ...cors() } });
      }
      if (request.method === 'POST' && url.pathname === '/api/upload') {
        return await handleUpload(request, env);
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: 'internal: ' + e.message }, 500);
    }
  },
};

async function handleUpload(request, env) {
  if (request.headers.get('X-Auth-Token') !== env.BED_SECRET) {
    return json({ error: '密钥错误' }, 401);
  }
  const form = await request.formData();
  const files = form.getAll('file').filter((f) => f instanceof File && f.size > 0);
  if (!files.length) return json({ error: '没有收到文件' }, 400);

  const results = [];
  for (const f of files) {
    if (!ALLOWED.includes(f.type)) {
      results.push({ name: f.name, error: '不支持的类型: ' + (f.type || '未知') });
      continue;
    }
    if (f.size > MAX_BYTES) {
      results.push({ name: f.name, error: '超过 20MB 限制' });
      continue;
    }
    const buf = new Uint8Array(await f.arrayBuffer());
    const name = tsName(f.name);
    const b64 = btoa(String.fromCharCode(...buf));
    const body = JSON.stringify({ message: `upload ${name}`, content: b64, branch: GH_BRANCH });
    const r = await fetch(`https://api.github.com/repos/${GH_USER}/${GH_REPO}/contents/${name}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${env.GH_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'img-bed' },
      body,
    });
    if (!r.ok) {
      const msg = (await r.text()).slice(0, 200);
      results.push({ name: f.name, error: `GitHub 提交失败 (${r.status}): ${msg}` });
      continue;
    }
    const url = `https://cdn.jsdelivr.net/gh/${GH_USER}/${GH_REPO}@${GH_BRANCH}/${name}`;
    results.push({ name: f.name, url, md: `![${name}](${url})`, ok: true });
  }
  return json({ results }, 200);
}

function tsName(orig = '') {
  const ts = new Date().toISOString().replace(/[-:TZ]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6);
  const m = orig.match(/\.([a-zA-Z0-9]+)$/);
  const ext = (m ? m[1] : 'png').toLowerCase();
  return `${ts}_${rand}.${ext}`;
}

function cors() {
  return { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'Content-Type, X-Auth-Token' };
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...cors() } });
}

const UI_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>图床 · img.260607.best</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Microsoft YaHei", system-ui, sans-serif; background: #F7F3EB; color: #2B2B2B; min-height: 100vh; display: flex; flex-direction: column; align-items: center; }
  .wrap { width: min(720px, 92vw); margin: 40px auto 20px; }
  .top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
  h1 { font-size: 22px; font-weight: 700; letter-spacing: 1px; }
  h1 small { display: block; font-size: 12px; font-weight: 400; color: #8A8578; margin-top: 4px; letter-spacing: 0; }
  .key { font-size: 12px; color: #8A8578; display: flex; align-items: center; gap: 6px; }
  .key input { border: 1px solid #E5DCCB; border-radius: 8px; padding: 5px 10px; font-size: 13px; width: 120px; background: #fff; color: #2B2B2B; outline: none; }
  .key input:focus { border-color: #3A5CCC; }
  .drop { border: 2px dashed #C9BFA8; border-radius: 16px; background: rgba(255,255,255,0.55); padding: 56px 20px; text-align: center; cursor: pointer; transition: border-color .15s, background .15s; }
  .drop:hover, .drop.over { border-color: #3A5CCC; background: rgba(255,255,255,0.8); }
  .drop .big { font-size: 16px; color: #3A3A3A; }
  .drop .sub { font-size: 12px; color: #8A8578; margin-top: 8px; }
  .hint { font-size: 12px; color: #8A8578; text-align: center; margin-top: 10px; }
  .list { margin-top: 20px; display: flex; flex-direction: column; gap: 12px; }
  .item { background: rgba(255,255,255,0.7); border: 1px solid #E5DCCB; border-radius: 12px; padding: 12px; display: flex; gap: 14px; align-items: center; }
  .item img { width: 56px; height: 56px; object-fit: cover; border-radius: 8px; border: 1px solid #E5DCCB; flex-shrink: 0; }
  .item .info { flex: 1; min-width: 0; }
  .item .row { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
  .item input { flex: 1; min-width: 0; border: 1px solid #E5DCCB; border-radius: 8px; padding: 6px 10px; font-size: 12px; background: #fff; color: #2B2B2B; }
  .item .md { font-size: 11px; color: #8A8578; background: #F3EDE0; border-radius: 6px; padding: 4px 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  button { border: 1px solid #3A5CCC; background: #3A5CCC; color: #fff; border-radius: 8px; padding: 6px 14px; font-size: 13px; cursor: pointer; transition: background .15s; }
  button:hover { background: #2F4AA8; }
  button.ghost { background: transparent; color: #3A5CCC; }
  .item .err { font-size: 13px; color: #C0392B; }
  .ok { font-size: 12px; color: #2E7D32; margin-top: 8px; text-align: center; display: none; }
  .status { font-size: 12px; color: #3A5CCC; text-align: center; margin-top: 12px; min-height: 18px; }
  footer { margin: 24px 0 30px; font-size: 11px; color: #B4AC9A; }
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <h1>Yanler 图床<small>img.260607.best · GitHub + jsDelivr CDN</small></h1>
    <label class="key">密钥
      <input id="key" type="password" placeholder="访问密钥">
    </label>
  </div>

  <div class="drop" id="drop">
    <div class="big">拖拽图片到这里，或点击选择</div>
    <div class="sub">支持 PNG / JPG / GIF / WebP / AVIF / SVG，单张 ≤ 20MB</div>
  </div>
  <input id="file" type="file" multiple accept="image/*" style="display:none">
  <div class="hint">也可以直接 <b>Ctrl+V</b> 粘贴剪贴板里的截图</div>

  <div class="status" id="status"></div>
  <div class="list" id="list"></div>
</div>
<footer>专属图床 · qiqi1200/img-bed</footer>

<script>
const $ = (id) => document.getElementById(id);
const keyEl = $('key'), drop = $('drop'), fileEl = $('file'), list = $('list'), status = $('status');
keyEl.value = localStorage.getItem('bed_key') || '';
keyEl.addEventListener('input', () => localStorage.setItem('bed_key', keyEl.value.trim()));

drop.addEventListener('click', () => fileEl.click());
fileEl.addEventListener('change', () => { uploadFiles([...fileEl.files]); fileEl.value = ''; });
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => uploadFiles([...e.dataTransfer.files]));
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
  if (files.length) uploadFiles(files);
});

async function uploadFiles(files) {
  if (!files.length) return;
  const key = keyEl.value.trim();
  if (!key) { status.textContent = '请先在上方输入访问密钥'; return; }
  status.textContent = '上传中…';
  const fd = new FormData();
  files.forEach(f => fd.append('file', f));
  try {
    const r = await fetch('/api/upload', { method: 'POST', headers: { 'X-Auth-Token': key }, body: fd });
    const d = await r.json();
    status.textContent = '';
    if (!r.ok) { status.textContent = d.error || '上传失败'; return; }
    render(d.results);
  } catch (err) {
    status.textContent = '网络错误: ' + err.message;
  }
}

function render(results) {
  results.forEach((it) => {
    const div = document.createElement('div');
    div.className = 'item';
    if (it.ok) {
      div.innerHTML = '<img src="' + it.url + '">' +
        '<div class="info">' +
        '<div class="row"><input readonly value="' + it.url + '"><button class="ghost" data-copy="' + it.url + '">复制</button></div>' +
        '<div class="md">' + it.md + '</div></div>';
    } else {
      div.innerHTML = '<div class="err">' + it.name + '：' + (it.error || '失败') + '</div>';
    }
    list.prepend(div);
  });
  list.querySelectorAll('button[data-copy]').forEach(b => b.addEventListener('click', () => {
    navigator.clipboard.writeText(b.dataset.copy).then(() => { b.textContent = '已复制'; setTimeout(() => b.textContent = '复制', 1200); });
  }));
}
</script>
</body>
</html>`;
