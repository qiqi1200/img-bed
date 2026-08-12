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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors() });
    }
    try {
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
        return new Response(UI_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', ...cors() } });
      }
      if (request.method === 'POST' && url.pathname === '/api/upload') {
        return await handleUpload(request, env, ctx);
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

async function handleUpload(request, env, ctx) {
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
    // 分批转 base64（...buf 整体展开超过 V8 调用栈上限，大图会抛 "Maximum call stack size exceeded"）
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) {
      bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    }
    const b64 = btoa(bin);
    const body = JSON.stringify({ message: 'upload ' + name, content: b64, branch: GH_BRANCH });
    const r = await fetch('https://api.github.com/repos/' + GH_USER + '/' + GH_REPO + '/contents/' + name, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + env.GH_TOKEN, 'Content-Type': 'application/json', 'User-Agent': 'img-bed' },
      body,
    });
    if (!r.ok) {
      const msg = (await r.text()).slice(0, 200);
      results.push({ name: f.name, error: 'GitHub 提交失败 (' + r.status + '): ' + msg });
      continue;
    }
    const url = 'https://testingcf.jsdelivr.net/gh/' + GH_USER + '/' + GH_REPO + '@' + GH_BRANCH + '/' + name;
    // 预热 CDN 缓存（后台进行，不影响上传响应）：浏览器随后加载这张刚传的图直接走热缓存，不再等几秒冷缓存
    if (ctx && ctx.waitUntil) { ctx.waitUntil(fetch(url, { headers: { 'User-Agent': 'img-bed-warm' } }).catch(function() {})); }
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
'<link rel="icon" href="https://testingcf.jsdelivr.net/gh/qiqi1200/img-bed@main/20260810095517_x4dm.jpg">',
'<link rel="preload" as="image" href="https://testingcf.jsdelivr.net/gh/qiqi1200/img-bed@main/rice-paper.png">',
'<link rel="preconnect" href="https://fonts.googleapis.cn">',
'<link rel="preconnect" href="https://fonts.gstatic.cn" crossorigin>',
'<link href="https://fonts.googleapis.cn/css2?family=Noto+Serif+SC:wght@500;700&family=Inter:wght@400;500&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" media="print" onload="this.media=\'all\'">',
'<noscript><link href="https://fonts.googleapis.cn/css2?family=Noto+Serif+SC:wght@500;700&family=Inter:wght@400;500&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"></noscript>',
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
'    background-image: url("https://testingcf.jsdelivr.net/gh/qiqi1200/img-bed@main/rice-paper.png");',
'    background-repeat: repeat; background-size: 160px; background-attachment: fixed;',
'  }',
'  /* 晴天模式：树叶光影叠层（openhanako LeavesOverlay） */',
'  .leaves-bright { position: fixed; inset: 0; pointer-events: none; z-index: 0; background: rgba(255,253,247,.12); }',
'  .leaves { position: fixed; inset: 0; width: 100%; height: 100%; object-fit: cover; mix-blend-mode: multiply; opacity: 0; pointer-events: none; z-index: 0; transition: opacity 900ms ease; }',
'  .leaves.ready { opacity: .28; }',
'  .wrap { width: min(640px, 90vw); margin: 0 auto; padding: 48px 24px 0; flex: 1; display: flex; flex-direction: column; position: relative; z-index: 1; }',
'  header { display: flex; align-items: baseline; justify-content: space-between; padding-bottom: 16px; border-bottom: 1px solid var(--line); }',
'  .brand { font-family: "JetBrains Mono", Consolas, monospace; font-size: 11px; letter-spacing: .14em; color: var(--ink-3); text-transform: uppercase; display: flex; align-items: center; gap: 8px; }',
'  .brand .logo { width: 20px; height: 20px; border-radius: 5px; border: 1px solid var(--line); background: #fff; object-fit: cover; flex-shrink: 0; }',
'  .gate-logo { width: 56px; height: 56px; border-radius: 14px; border: 1px solid var(--line); background: #fff; object-fit: cover; margin-bottom: 16px; box-shadow: 0 2px 10px rgba(0,0,0,.08); }',
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
'    background-image: url("https://testingcf.jsdelivr.net/gh/qiqi1200/img-bed@main/rice-paper.png");',
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
'<video class="leaves" id="leaves" preload="none" loop muted playsinline aria-hidden="true"></video>',
'<div class="wrap">',
'  <header>',
'    <span class="brand"><img class="logo" src="https://testingcf.jsdelivr.net/gh/qiqi1200/img-bed@main/20260810095517_x4dm.jpg" alt="">Guancii · Imagebed</span>',
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
'    <img class="gate-logo" src="https://testingcf.jsdelivr.net/gh/qiqi1200/img-bed@main/20260810095517_x4dm.jpg" alt="">',
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
// 树影视频懒加载：页面就绪后先 play() 拉流，缓冲到可流畅播完（canplaythrough）才淡入显示
// 注意：play() 必须在事件外先调用——preload=none 下不 play() 就不会拉数据，canplaythrough 永不触发
'var leavesV = $("leaves");',
'function startLeaves() {',
'  if (!leavesV) return;',
'  leavesV.src = "https://testingcf.jsdelivr.net/gh/qiqi1200/img-bed@main/leaves-overlay-v2.mp4";',
'  leavesV.addEventListener("canplaythrough", function() { leavesV.classList.add("ready"); });',
'  leavesV.play().catch(function() {});',
'}',
'if (!reduced) {',
'  if (document.readyState === "complete") startLeaves();',
'  else window.addEventListener("load", startLeaves);',
'}',
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
'  progBar.style.width = "0%";',
'  progLabel.textContent = "上传 0%";',
'  var i = 0;',
'  function setProg(pct, label) { progBar.style.width = Math.min(100, Math.max(0, Math.round(pct))) + "%"; if (label) progLabel.textContent = label; }',
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
'    /* 真实上传进度：fetch 没有 upload 进度事件，改用 XHR 的 xhr.upload.onprogress */',
'    var xhr = new XMLHttpRequest();',
'    xhr.open("POST", "/api/upload");',
'    xhr.setRequestHeader("X-Auth-Token", key);',
'    xhr.upload.onprogress = function(e) {',
'      if (e.lengthComputable) {',
'        var pct = Math.round(e.loaded / e.total * 100);',
'        setProg((done + e.loaded / e.total) / total * 100, "[" + (done + 1) + "/" + total + "] 上传 " + pct + "%");',
'      }',
'    };',
'    xhr.upload.onload = function() { setProg((done + 1) / total * 100, "归档中…"); };',
'    xhr.onload = function() {',
'      var ok = xhr.status >= 200 && xhr.status < 300;',
'      var d = null; try { d = JSON.parse(xhr.responseText); } catch (e) {}',
'      if (!ok) { renderErr(f.name, (d && d.error) || "上传失败"); }',
'      else if (d && d.results && d.results[0] && d.results[0].ok) { renderCard(f, d.results[0]); uploaded++; }',
'      else if (d && d.results && d.results[0]) { renderErr(f.name, d.results[0].error || "上传失败"); }',
'      else { renderErr(f.name, "响应异常"); }',
'      done++;',
'      next();',
'    };',
'    xhr.onerror = function() { renderErr(f.name, "网络错误"); done++; next(); };',
'    xhr.onabort = function() { renderErr(f.name, "上传中断"); done++; next(); };',
'    xhr.send(fd);',
'  }',
'  next();',
'}',
'function renderCard(f, it) {',
'  var div = document.createElement("div");',
'  div.className = "card";',
'  div.innerHTML = \'<div class="info"><div class="no">FILE No. \' + esc(it.key) + \'</div><div class="url-row"><span class="url" title="\' + esc(it.url) + \'"></span><button class="act" data-copy="\' + esc(it.url) + \'">复制</button><button class="act" data-copy="\' + esc(it.md) + \'">MD</button></div></div>\';',
'  /* 先用本地 blob 秒出预览，CDN 真图后台加载好再替换——不等 jsDelivr 冷缓存，也不占上传时的带宽 */',
'  var imgEl = document.createElement("img");',
'  imgEl.alt = "";',
'  div.insertBefore(imgEl, div.firstChild);',
'  var blobUrl = URL.createObjectURL(f);',
'  imgEl.src = blobUrl;',
'  var cdnImg = new Image();',
'  cdnImg.onload = function() { imgEl.src = cdnImg.src; try { URL.revokeObjectURL(blobUrl); } catch (e) {} };',
'  cdnImg.onerror = function() { try { URL.revokeObjectURL(blobUrl); } catch (e) {} };',
'  cdnImg.src = it.url;',
'  list.prepend(div);',
'  var urlEl = div.querySelector(".url");',
'  typeUrl(urlEl, it.url);',
'  var acts = div.querySelectorAll(".act");',
'  acts.forEach(function(b) {',
'    b.addEventListener("click", function() {',
'      var copyDone = function() {',
'        var old = b.textContent;',
'        b.textContent = old === "MD" ? "已复制 MD" : "已复制";',
'        b.classList.add("done");',
'        setTimeout(function() { b.textContent = old; b.classList.remove("done"); }, 1200);',
'      };',
'      // 剪贴板兜底：部分环境（手机内嵌浏览器/非安全上下文）clipboard API 不可用或静默失败',
'      var fallbackCopy = function() {',
'        var ta = document.createElement("textarea");',
'        ta.value = b.dataset.copy;',
'        ta.style.cssText = "position:fixed;opacity:0;left:-9999px;top:0";',
'        document.body.appendChild(ta);',
'        ta.focus(); ta.select();',
'        var ok = false;',
'        try { ok = document.execCommand("copy"); } catch (e) { ok = false; }',
'        document.body.removeChild(ta);',
'        if (ok) { copyDone(); } else { b.textContent = "复制失败，请手动选中"; }',
'      };',
'      if (navigator.clipboard && window.isSecureContext) {',
'        navigator.clipboard.writeText(b.dataset.copy).then(copyDone, fallbackCopy);',
'      } else { fallbackCopy(); }',
'    });',
'  });',
'}',
'function esc(s) {',
'  var d = document.createElement("div");',
'  d.textContent = s; return d.innerHTML;',
'}',
'function renderErr(name, msg) {',
'  var div = document.createElement("div");',
'  div.className = "card err";',
'  div.setAttribute("role", "alert");',
'  div.innerHTML = \'<div class="info"><div class="no">\' + esc(name) + \'</div><div class="msg">\' + esc(msg) + \'</div></div>\';',
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
