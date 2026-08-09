// Guancii 的图床 — Cloudflare Worker（UI + GitHub 仓库存储 + jsDelivr CDN）
// GET  /            → 图床网页（纸上档案馆风格 · 暖纸树影）
// POST /api/upload  → 上传（X-Auth-Token 鉴权）→ 提交 GitHub → 返回 jsDelivr URL
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
      if (request.method === 'POST' && url.pathname === '/api/verify') {
        return request.headers.get('X-Auth-Token') === env.BED_SECRET
          ? json({ ok: true }, 200)
          : json({ ok: false }, 401);
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: 'internal: ' + e.message }, 500);
    }
  },
};

async function handleUpload(request, env) {
  if (request.headers.get('X-Auth-Token') !== env.BED_SECRET) {
    return json({ error: '密钥不对' }, 401);
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
      results.push({ name: f.name, error: '超过 20MB 拒收' });
      continue;
    }
    const buf = new Uint8Array(await f.arrayBuffer());
    const name = tsName(f.name);
    const b64 = btoa(String.fromCharCode(...buf));
    const body = JSON.stringify({ message: 'upload ' + name, content: b64, branch: GH_BRANCH });
    const r = await fetch('https://api.github.com/repos/' + GH_USER + '/' + GH_REPO + '/contents/' + name, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + env.GH_TOKEN, 'Content-Type': 'application/json', 'User-Agent': 'img-bed' },
      body,
    });
    if (!r.ok) {
      const msg = (await r.text()).slice(0, 200);
      results.push({ name: f.name, error: 'GitHub 提交失败 (' + r.status + ')' });
      continue;
    }
    const url = 'https://cdn.jsdelivr.net/gh/' + GH_USER + '/' + GH_REPO + '@' + GH_BRANCH + '/' + name;
    results.push({ name: f.name, key: name, url: url, md: '![' + name + '](' + url + ')', ok: true });
  }
  return json({ results }, 200);
}

function tsName(orig) {
  const ts = new Date().toISOString().replace(/[-:TZ]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6);
  const m = String(orig || '').match(/\.([a-zA-Z0-9]+)$/);
  const ext = (m ? m[1] : 'png').toLowerCase();
  return ts + '_' + rand + '.' + ext;
}

function cors() {
  return { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'Content-Type, X-Auth-Token' };
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...cors() } });
}

// ============ 纸上档案馆 UI（暖纸 + 树影） ============
const UI_HTML = [
'<!DOCTYPE html>',
'<html lang="zh-CN">',
'<head>',
'<meta charset="UTF-8">',
'<meta name="viewport" content="width=device-width, initial-scale=1">',
'<title>Guancii 的图床</title>',
'<link rel="preconnect" href="https://fonts.googleapis.com">',
'<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
'<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@500;700&family=Inter:wght@400;500&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">',
'<style>',
'  :root {',
'    --paper: #F2EADA; --ink: #1A1A1A; --ink-2: #6E6655; --ink-3: #A69B85;',
'    --line: #DED4C0; --line-strong: #C2B79E; --accent: #3A5CCC;',
'    --accent-soft: #E8ECF9; --danger: #B3402F; --card: rgba(255,255,255,.5);',
'  }',
'  * { box-sizing: border-box; margin: 0; padding: 0; }',
'  ::selection { background: var(--accent); color: var(--paper); }',
'  html { -webkit-text-size-adjust: 100%; }',
'  body {',
'    font-family: "Inter", "Microsoft YaHei", sans-serif;',
'    background: var(--paper); color: var(--ink);',
'    min-height: 100vh; display: flex; flex-direction: column; align-items: center;',
'    -webkit-font-smoothing: antialiased;',
'  }',
'  /* 模拟纸：rice-paper 宣纸纹理平铺（openhanako PaperTexture，160px 一块，fixed 固定） */',
'  body {',
'    background-image: url("https://cdn.jsdelivr.net/gh/qiqi1200/img-bed@main/rice-paper.png");',
'    background-repeat: repeat; background-size: 160px; background-attachment: fixed;',
'  }',
'  /* 晴天模式：树叶光影叠层（openhanako LeavesOverlay） */',
'  .leaves-bright { position: fixed; inset: 0; pointer-events: none; z-index: 0; background: rgba(255,253,247,.12); }',
'  .leaves { position: fixed; inset: 0; width: 100%; height: 100%; object-fit: cover; mix-blend-mode: multiply; opacity: .28; pointer-events: none; z-index: 0; }',
'  .wrap { width: min(640px, 90vw); margin: 0 auto; padding: 48px 24px 0; flex: 1; display: flex; flex-direction: column; position: relative; z-index: 1; }',
'  header { display: flex; align-items: baseline; justify-content: space-between; padding-bottom: 16px; border-bottom: 1px solid var(--line); }',
'  .brand { font-family: "JetBrains Mono", Consolas, monospace; font-size: 11px; letter-spacing: .14em; color: var(--ink-3); text-transform: uppercase; }',
'  /* 门禁遮罩：进入网站先输密钥（verify 走后端，key 不落前端） */',
'  .gate { position: fixed; inset: 0; z-index: 100; background: var(--paper); display: flex; align-items: center; justify-content: center; transition: opacity 300ms ease-out; }',
'  .gate.hide { opacity: 0; pointer-events: none; }',
'  .gate-card { width: min(320px, 86vw); text-align: center; }',
'  .gate-title { font-family: "Noto Serif SC", "Songti SC", SimSun, serif; font-size: 24px; font-weight: 700; }',
'  .gate-sub { font-family: "JetBrains Mono", Consolas, monospace; font-size: 11px; letter-spacing: .1em; color: var(--ink-3); margin: 10px 0 28px; }',
'  .gate input { border: none; border-bottom: 1px solid var(--line); background: transparent; width: 100%; padding: 6px 0; font: inherit; font-family: "JetBrains Mono", Consolas, monospace; font-size: 13px; color: var(--ink); text-align: center; outline: none; transition: border-color 150ms ease-out; }',
'  .gate input:focus { border-bottom-color: var(--accent); }',
'  .gate-btn { margin-top: 24px; border: none; background: var(--accent); color: #fff; border-radius: 8px; padding: 9px 0; width: 100%; font: inherit; font-size: 14px; cursor: pointer; transition: background 150ms ease-out; }',
'  .gate-btn:hover { background: #2F4AA8; }',
'  .gate-err { font-size: 12px; color: var(--danger); min-height: 16px; margin-top: 10px; }',
'  main { flex: 1; }',
'  h1 { font-family: "Noto Serif SC", "Songti SC", SimSun, serif; font-size: 28px; font-weight: 700; letter-spacing: -.01em; margin-top: 48px; }',
'  .sub { font-size: 12px; line-height: 1.8; color: var(--ink-2); margin-top: 8px; }',
'  .drop {',
'    margin-top: 32px; border: 1.5px dashed var(--line-strong); border-radius: 10px;',
'    padding: 56px 20px; text-align: center; cursor: pointer; background: transparent;',
'    transition: border-color 180ms ease-out, background 180ms ease-out;',
'    outline: none;',
'  }',
'  .drop:hover { border-color: var(--accent); background: var(--accent-soft); }',
'  .drop.over { border-style: solid; border-color: var(--accent); background: var(--accent-soft); }',
'  .drop .t { font-family: "Noto Serif SC", "Songti SC", SimSun, serif; font-size: 20px; font-weight: 500; color: var(--ink); transition: color 180ms ease-out; }',
'  .drop.over .t { color: var(--accent); }',
'  .drop .s { font-size: 12px; color: var(--ink-3); margin-top: 10px; }',
'  .drop:focus-visible { box-shadow: 0 0 0 2px var(--paper), 0 0 0 4px var(--accent); }',
'  .progress { display: none; margin-top: 16px; }',
'  .progress.show { display: block; }',
'  .progress .label { font-family: "JetBrains Mono", Consolas, monospace; font-size: 11px; letter-spacing: .06em; color: var(--ink-2); }',
'  .progress .track { margin-top: 8px; height: 2px; background: var(--line); border-radius: 1px; overflow: hidden; }',
'  .progress .bar { height: 100%; width: 0; background: var(--accent); transition: width 200ms linear; }',
'  .list { margin-top: 20px; display: flex; flex-direction: column; gap: 12px; padding-bottom: 8px; }',
'  .card {',
'    display: flex; gap: 14px; align-items: center; background: var(--card);',
'    border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px;',
'    animation: enter 220ms ease-out;',
'  }',
'  /* 卡片也铺宣纸纹理，normal 混合（openhanako Card 层同款） */',
'  .card {',
'    background-image: url("https://cdn.jsdelivr.net/gh/qiqi1200/img-bed@main/rice-paper.png");',
'    background-repeat: repeat; background-size: 160px; background-attachment: fixed;',
'    background-blend-mode: normal;',
'  }',
'  @keyframes enter { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }',
'  .card img { width: 56px; height: 56px; object-fit: cover; border-radius: 4px; border: 1px solid var(--line); flex-shrink: 0; }',
'  .card .info { flex: 1; min-width: 0; }',
'  .no { font-family: "JetBrains Mono", Consolas, monospace; font-size: 11px; letter-spacing: .06em; color: var(--ink-3); }',
'  .url-row { display: flex; align-items: center; gap: 10px; margin-top: 5px; }',
'  .url { font-family: "JetBrains Mono", Consolas, monospace; font-size: 13px; color: var(--ink); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: text; }',
'  .act { background: none; border: none; padding: 2px 0; font: inherit; font-size: 12px; color: var(--ink-2); cursor: pointer; transition: color 150ms ease-out; }',
'  .act:hover { color: var(--accent); }',
'  .act.done { color: var(--accent); }',
'  .card.err { border-left: 3px solid var(--danger); }',
'  .card.err .msg { font-size: 13px; color: var(--danger); }',
'  .status { font-size: 12px; color: var(--danger); text-align: center; margin-top: 14px; min-height: 0; }',
'  footer { margin-top: 40px; padding: 20px 0 32px; border-top: 1px solid var(--line); display: flex; justify-content: space-between; gap: 12px; font-size: 11px; color: var(--ink-3); font-family: "JetBrains Mono", Consolas, monospace; letter-spacing: .04em; }',
'  @media (max-width: 768px) {',
'    .wrap { padding: 32px 16px 0; }',
'    h1 { font-size: 24px; margin-top: 36px; }',
'    .drop { padding: 40px 16px; }',
'    .brand { letter-spacing: .1em; }',
'    footer { flex-direction: column; gap: 4px; }',
'  }',
'  @media (prefers-reduced-motion: reduce) {',
'    * { animation: none !important; transition: none !important; }',
'    .leaves, .leaves-bright { display: none !important; }',
'  }',
'</style>',
'</head>',
'<body>',
'<div class="leaves-bright" aria-hidden="true"></div>',
'<video class="leaves" autoplay loop muted playsinline aria-hidden="true"><source src="https://cdn.jsdelivr.net/gh/qiqi1200/img-bed@main/leaves-overlay.mp4" type="video/mp4"></video>',
'<div class="wrap">',
'  <header>',
'    <span class="brand">Guancii · Imagebed</span>',
'  </header>',
'  <main>',
'    <h1>存个图。</h1>',
'    <p class="sub">拖进来，或者 Ctrl+V。支持 PNG / JPG / GIF / WebP / AVIF / SVG，单张 20MB 以内。</p>',
'    <div class="drop" id="drop" role="button" tabindex="0" aria-label="选择或拖拽图片上传">',
'      <div class="t" id="drop-t">把图丢到这里</div>',
'      <div class="s">或点击选择文件</div>',
'    </div>',
'    <input id="file" type="file" multiple accept="image/*" style="display:none">',
'    <div class="progress" id="progress">',
'      <div class="label" id="progress-label"></div>',
'      <div class="track"><div class="bar" id="progress-bar"></div></div>',
'    </div>',
'    <div class="status" id="status"></div>',
'    <div class="list" id="list"></div>',
'  </main>',
'  <footer>',
'    <span>Guancii 的图床 · qiqi1200/img-bed · jsDelivr CDN</span>',
'    <span id="count"></span>',
'  </footer>',
'</div>',
'<div class="gate" id="gate">',
'  <div class="gate-card">',
'    <div class="gate-title">Guancii 的图床</div>',
'    <div class="gate-sub">IMAGEBED · 输入密钥进入</div>',
'    <input id="gate-key" type="password" placeholder="密钥" autocomplete="off">',
'    <button class="gate-btn" id="gate-btn">进入</button>',
'    <div class="gate-err" id="gate-err"></div>',
'  </div>',
'</div>',
'<script>',
'var $ = function(id) { return document.getElementById(id); };',
'var drop = $("drop"), fileEl = $("file"), list = $("list"), status = $("status");',
'var countEl = $("count"), progEl = $("progress"), progLabel = $("progress-label"), progBar = $("progress-bar");',
'var dropT = $("drop-t");',
'var uploaded = 0;',
'var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;',
/* 门禁：进入网站先输密钥，后端 verify */
'var gate = $("gate"), gateKey = $("gate-key"), gateBtn = $("gate-btn"), gateErr = $("gate-err");',
'function verifyKey(key, cb) {',
'  fetch("/api/verify", { method: "POST", headers: { "X-Auth-Token": key } })',
'    .then(function(r) { cb(r.ok); })',
'    .catch(function() { cb(false); });',
'}',
'function unlock() { gate.classList.add("hide"); }',
'function submitKey() {',
'  var k = gateKey.value.trim();',
'  if (!k) return;',
'  verifyKey(k, function(ok) {',
'    if (ok) { localStorage.setItem("bed_key", k); gateErr.textContent = ""; unlock(); gateKey.blur(); }',
'    else { gateErr.textContent = "密钥不对"; gateKey.value = ""; gateKey.focus(); }',
'  });',
'}',
'gateBtn.addEventListener("click", submitKey);',
'gateKey.addEventListener("keydown", function(e) { if (e.key === "Enter") submitKey(); });',
'var savedKey = localStorage.getItem("bed_key") || "";',
'if (savedKey) { verifyKey(savedKey, function(ok) { if (ok) unlock(); else gateKey.focus(); }); }',
'else { gateKey.focus(); }',
'drop.addEventListener("click", function() { fileEl.click(); });',
'drop.addEventListener("keydown", function(e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileEl.click(); } });',
'fileEl.addEventListener("change", function() { var files = Array.prototype.slice.call(fileEl.files); fileEl.value = ""; uploadFiles(files); });',
'["dragenter", "dragover"].forEach(function(ev) { drop.addEventListener(ev, function(e) { e.preventDefault(); drop.classList.add("over"); dropT.textContent = "松手"; }); });',
'["dragleave", "drop"].forEach(function(ev) { drop.addEventListener(ev, function(e) { e.preventDefault(); drop.classList.remove("over"); dropT.textContent = "把图丢到这里"; }); });',
'drop.addEventListener("drop", function(e) { var files = Array.prototype.slice.call(e.dataTransfer.files); uploadFiles(files); });',
'document.addEventListener("paste", function(e) {',
'  var files = Array.prototype.slice.call((e.clipboardData && e.clipboardData.files) || []).filter(function(f) { return f.type.indexOf("image/") === 0; });',
'  if (files.length) { e.preventDefault(); uploadFiles(files); }',
'});',
'function uploadFiles(files) {',
'  if (!files.length) return;',
'  var key = localStorage.getItem("bed_key") || "";',
'  if (!key) { status.textContent = "未解锁，请刷新重试"; return; }',
'  status.textContent = "";',
'  var total = files.length, done = 0;',
'  progEl.classList.add("show");',
'  progLabel.textContent = "ARCHIVING 0/" + total;',
'  progBar.style.width = "0%";',
'  var i = 0;',
'  function next() {',
'    if (i >= files.length) {',
'      progEl.classList.remove("show");',
'      if (uploaded > 0) countEl.textContent = "本会话已归档 " + uploaded + " 张";',
'      return;',
'    }',
'    var f = files[i]; i++;',
'    if (f.type.indexOf("image/") !== 0) { renderErr(f.name, "不是图片文件"); done++; next(); return; }',
'    if (f.size > 20 * 1024 * 1024) { renderErr(f.name, "超过 20MB 拒收"); done++; next(); return; }',
'    var fd = new FormData();',
'    fd.append("file", f);',
'    fetch("/api/upload", { method: "POST", headers: { "X-Auth-Token": key }, body: fd })',
'      .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })',
'      .then(function(res) {',
'        if (!res.ok) { renderErr(f.name, res.d.error || "上传失败"); }',
'        else if (res.d.results && res.d.results[0] && res.d.results[0].ok) { renderCard(f, res.d.results[0]); uploaded++; }',
'        else if (res.d.results && res.d.results[0]) { renderErr(f.name, res.d.results[0].error || "上传失败"); }',
'        else { renderErr(f.name, "响应异常"); }',
'      })',
'      .catch(function() { renderErr(f.name, "网络错误"); })',
'      .then(function() {',
'        done++;',
'        progLabel.textContent = "ARCHIVING " + done + "/" + total;',
'        progBar.style.width = Math.round(done / total * 100) + "%";',
'        next();',
'      });',
'  }',
'  next();',
'}',
'function renderCard(f, it) {',
'  var div = document.createElement("div");',
'  div.className = "card";',
'  div.innerHTML = \'<img alt="" src="\' + it.url + \'"><div class="info"><div class="no">FILE No. \' + it.key + \'</div><div class="url-row"><span class="url" title="\' + it.url + \'"></span><button class="act" data-copy="\' + it.url + \'">复制</button><button class="act" data-copy="\' + it.md + \'">MD</button></div></div>\';',
'  list.prepend(div);',
'  var urlEl = div.querySelector(".url");',
'  typeUrl(urlEl, it.url);',
'  var acts = div.querySelectorAll(".act");',
'  acts.forEach(function(b) {',
'    b.addEventListener("click", function() {',
'      navigator.clipboard.writeText(b.dataset.copy).then(function() {',
'        var old = b.textContent;',
'        b.textContent = old === "MD" ? "已复制 MD" : "已复制";',
'        b.classList.add("done");',
'        setTimeout(function() { b.textContent = old; b.classList.remove("done"); }, 1200);',
'      });',
'    });',
'  });',
'}',
'function renderErr(name, msg) {',
'  var div = document.createElement("div");',
'  div.className = "card err";',
'  div.setAttribute("role", "alert");',
'  div.innerHTML = \'<div class="info"><div class="no">\' + name + \'</div><div class="msg">\' + msg + \'</div></div>\';',
'  list.prepend(div);',
'}',
'function typeUrl(el, text) {',
'  if (reduced) { el.textContent = text; return; }',
'  var i = 0;',
'  var timer = setInterval(function() {',
'    i += 1;',
'    el.textContent = text.slice(0, i);',
'    if (i >= text.length) clearInterval(timer);',
'  }, 12);',
'}',
'</script>',
'</body>',
'</html>',
].join('\n');
