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
      if (request.method === 'GET' && url.pathname === '/admin') {
        return new Response(ADMIN_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', ...cors() } });
      }
      if (request.method === 'POST' && url.pathname === '/api/verify-admin') {
        return request.headers.get('X-Auth-Token') === env.ADMIN_SECRET
          ? json({ ok: true }, 200)
          : json({ ok: false }, 401);
      }
      if (request.method === 'GET' && url.pathname === '/api/photos') {
        return await handlePhotos(request, env, ctx);
      }
      if (request.method === 'POST' && url.pathname === '/api/delete') {
        return await handleDelete(request, env, ctx);
      }
      if (request.method === 'POST' && url.pathname === '/api/expiry') {
        return await handleExpiry(request, env);
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: 'internal: ' + e.message }, 500);
    }
  },
  // 定时任务：每小时检查过期清单，到点自动删图（默认无过期 = 不进清单）
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkExpired(env, ctx).catch(function() {}));
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

async function handlePhotos(request, env, ctx) {
  if (request.headers.get('X-Auth-Token') !== env.ADMIN_SECRET) {
    return json({ error: '密钥不对' }, 401);
  }
  // 后台访问顺带清理已过期图片（后台进行，不阻塞列表响应）
  if (ctx && ctx.waitUntil) { ctx.waitUntil(checkExpired(env, ctx).catch(function() {})); }
  const man = await readManifest(env);
  const expMap = (man && man.expires) || {};
  // GitHub git trees API 一次拿全分支文件树（含每个 blob 的 size）
  const r = await fetch('https://api.github.com/repos/' + GH_USER + '/' + GH_REPO + '/git/trees/' + GH_BRANCH + '?recursive=1', {
    headers: { Authorization: 'Bearer ' + env.GH_TOKEN, 'User-Agent': 'img-bed', Accept: 'application/vnd.github+json' },
  });
  if (!r.ok) {
    return json({ error: 'GitHub 拉取失败 (' + r.status + ')' }, 502);
  }
  const d = await r.json();
  const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i;
  const TS_NAME = /^\d{8}[_-]?\d{6}/; // 只认上传命名（时间戳开头），排除 rice-paper.png 等资产文件
  const photos = (d.tree || [])
    .filter((t) => t.type === 'blob' && IMG_EXT.test(t.path) && TS_NAME.test(t.path))
    .map((t) => {
      const name = t.path.split('/').pop();
      const url = 'https://testingcf.jsdelivr.net/gh/' + GH_USER + '/' + GH_REPO + '@' + GH_BRANCH + '/' + encodeURIComponent(name);
      return { name, size: t.size, date: parseTs(name), url, md: '![' + name + '](' + url + ')', expires: expMap[name] || null };
    })
    .sort((a, b) => b.name.localeCompare(a.name)); // 时间戳命名，倒序 = 最新在前
  const totalBytes = photos.reduce((s, p) => s + p.size, 0);
  return json({ count: photos.length, totalBytes, photos }, 200);
}

// 文件名 → 上传时间，兼容 20260812_123456_abcd.jpg 与 20260810095517_x4dm.jpg
async function handleDelete(request, env, ctx) {
  if (request.headers.get('X-Auth-Token') !== env.ADMIN_SECRET) {
    return json({ error: '密钥不对' }, 401);
  }
  let body = {};
  try { body = await request.json(); } catch (e) { return json({ error: '参数错误' }, 400); }
  const name = String(body.name || '').trim();
  if (!safeName(name)) return json({ error: '非法文件名' }, 400);
  const r = await deleteFile(env, name);
  if (!r.ok) return json({ error: r.error }, r.status);
  purgeCache(ctx, name);
  // 若该图在过期清单里，同步移除条目（后台执行）
  if (ctx && ctx.waitUntil) { ctx.waitUntil((async function() {
    const man = await readManifest(env);
    if (man && man.expires[name]) {
      delete man.expires[name];
      await writeManifest(env, man, 'delete ' + name);
    }
  })().catch(function() {})); }
  return json({ ok: true, name }, 200);
}

// 从 GitHub 删除单个文件（幂等：已不存在视为成功）
async function deleteFile(env, name) {
  const q = await fetch('https://api.github.com/repos/' + GH_USER + '/' + GH_REPO + '/contents/' + encodeURIComponent(name), {
    headers: { Authorization: 'Bearer ' + env.GH_TOKEN, 'User-Agent': 'img-bed', Accept: 'application/vnd.github+json' },
  });
  if (q.status === 404) return { ok: true, status: 404 };
  if (!q.ok) return { ok: false, status: 502, error: 'GitHub 查询失败 (' + q.status + ')' };
  const meta = await q.json();
  const d = await fetch('https://api.github.com/repos/' + GH_USER + '/' + GH_REPO + '/contents/' + encodeURIComponent(name), {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + env.GH_TOKEN, 'User-Agent': 'img-bed', Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'delete ' + name, sha: meta.sha, branch: GH_BRANCH }),
  });
  if (!d.ok) {
    const msg = (await d.text()).slice(0, 200);
    return { ok: false, status: 502, error: '删除失败 (' + d.status + '): ' + msg };
  }
  return { ok: true, status: 200 };
}

// 立即清 jsDelivr CDN 缓存，URL 马上 404（后台执行，不影响响应）
function purgeCache(ctx, name) {
  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(fetch('https://purge.jsdelivr.net/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: ['/gh/' + GH_USER + '/' + GH_REPO + '@' + GH_BRANCH + '/' + name] }),
    }).catch(function() {}));
  }
}

// 只允许时间戳命名的图片文件（与上传命名一致），顺带防路径穿越
function safeName(name) {
  return /^\d{8}[_-]?\d{6}[_-][a-zA-Z0-9]+\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i.test(name) && !name.includes('/') && !name.includes('..');
}

// ============ 过期清单（.imgbed.json：{version, expires:{文件名:ISO时间}}） ============
const MANIFEST = '.imgbed.json';

async function readManifest(env) {
  const r = await fetch('https://api.github.com/repos/' + GH_USER + '/' + GH_REPO + '/contents/' + MANIFEST, {
    headers: { Authorization: 'Bearer ' + env.GH_TOKEN, 'User-Agent': 'img-bed', Accept: 'application/vnd.github+json' },
  });
  if (r.status === 404) return { sha: null, expires: {} };
  if (!r.ok) return null;
  const d = await r.json();
  let data = {};
  try { data = JSON.parse(atob(d.content.replace(/\s/g, ''))); } catch (e) { data = {}; }
  return { sha: d.sha, expires: (data && data.expires) || {} };
}

async function writeManifest(env, man, msg) {
  const payload = { message: msg, content: btoa(JSON.stringify({ version: 1, expires: man.expires })), branch: GH_BRANCH };
  if (man.sha) payload.sha = man.sha;
  const r = await fetch('https://api.github.com/repos/' + GH_USER + '/' + GH_REPO + '/contents/' + MANIFEST, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + env.GH_TOKEN, 'User-Agent': 'img-bed', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const msg2 = (await r.text()).slice(0, 200);
    return { ok: false, status: r.status, error: '过期清单写入失败 (' + r.status + '): ' + msg2 };
  }
  return { ok: true, status: 200 };
}

// 检查并删除已到期的图片（cron 定时 + 后台打开时都会触发）
async function checkExpired(env, ctx) {
  const man = await readManifest(env);
  if (!man) return;
  const now = Date.now();
  const due = Object.entries(man.expires).filter(function(e) { return new Date(e[1]).getTime() <= now; });
  if (!due.length) return;
  let removed = false;
  for (const entry of due) {
    const r = await deleteFile(env, entry[0]);
    if (r.ok) { delete man.expires[entry[0]]; removed = true; purgeCache(ctx, entry[0]); }
  }
  if (removed) await writeManifest(env, man, 'expire cleanup');
}

// 设置/取消过期：body {name, days}，days=0/缺省 取消过期；days=N 从现在起 N 天后到期
async function handleExpiry(request, env) {
  if (request.headers.get('X-Auth-Token') !== env.ADMIN_SECRET) {
    return json({ error: '密钥不对' }, 401);
  }
  let body = {};
  try { body = await request.json(); } catch (e) { return json({ error: '参数错误' }, 400); }
  const name = String(body.name || '').trim();
  if (!safeName(name)) return json({ error: '非法文件名' }, 400);
  const days = body.days == null ? null : Number(body.days);
  const man = await readManifest(env);
  if (!man) return json({ error: '过期清单读取失败' }, 502);
  if (!days || days <= 0) {
    delete man.expires[name];
  } else {
    if (!Number.isInteger(days) || days > 3650) return json({ error: '天数需为 1-3650 的整数' }, 400);
    man.expires[name] = new Date(Date.now() + days * 86400000).toISOString();
  }
  const w = await writeManifest(env, man, 'set expiry ' + name);
  if (!w.ok) return json({ error: w.error }, w.status);
  return json({ ok: true, name, expires_at: man.expires[name] || null }, 200);
}

// 文件名 → 上传时间，兼容 20260812_123456_abcd.jpg 与 20260810095517_x4dm.jpg
function parseTs(name) {
  const m = String(name).match(/^(\d{8})[_-]?(\d{6})/);
  if (!m) return '';
  return m[1].slice(0, 4) + '-' + m[1].slice(4, 6) + '-' + m[1].slice(6, 8) + ' ' +
         m[2].slice(0, 2) + ':' + m[2].slice(2, 4) + ':' + m[2].slice(4, 6);
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
'  .admin-link { color: inherit; text-decoration: none; border-bottom: 1px solid var(--line-strong); transition: color 150ms ease-out, border-color 150ms ease-out; }',
'  .admin-link:hover { color: var(--accent); border-color: var(--accent); }',
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
'    <span>Guancii 的图床 · qiqi1200/img-bed · jsDelivr CDN · <a class="admin-link" href="/admin">ADMIN</a></span>',
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

// ============ 后台（管理员面板 · 专属密钥 ADMIN_SECRET） ============
const ADMIN_HTML = [
'<!DOCTYPE html>',
'<html lang="zh-CN">',
'<head>',
'<meta charset="UTF-8">',
'<meta name="viewport" content="width=device-width, initial-scale=1">',
'<title>Guancii 的图床 · 后台</title>',
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
'  /* 与主页一致的模拟纸纹理 */',
'  body {',
'    background-image: url("https://testingcf.jsdelivr.net/gh/qiqi1200/img-bed@main/rice-paper.png");',
'    background-repeat: repeat; background-size: 160px; background-attachment: fixed;',
'  }',
'  .wrap { width: min(960px, 92vw); margin: 0 auto; padding: 48px 24px 0; flex: 1; display: flex; flex-direction: column; position: relative; z-index: 1; }',
'  header { display: flex; align-items: baseline; justify-content: space-between; padding-bottom: 16px; border-bottom: 1px solid var(--line); }',
'  .brand { font-family: "JetBrains Mono", Consolas, monospace; font-size: 11px; letter-spacing: .14em; color: var(--ink-3); text-transform: uppercase; display: flex; align-items: center; gap: 8px; }',
'  .brand .logo { width: 20px; height: 20px; border-radius: 5px; border: 1px solid var(--line); background: #fff; object-fit: cover; flex-shrink: 0; }',
'  .back { font-family: "JetBrains Mono", Consolas, monospace; font-size: 11px; letter-spacing: .06em; color: var(--ink-2); text-decoration: none; transition: color 150ms ease-out; }',
'  .back:hover { color: var(--accent); }',
'  .gate { position: fixed; inset: 0; z-index: 100; background: var(--paper); display: flex; align-items: center; justify-content: center; transition: opacity 300ms ease-out; }',
'  .gate.hide { opacity: 0; pointer-events: none; }',
'  .gate-card { width: min(320px, 86vw); text-align: center; }',
'  .gate-logo { width: 56px; height: 56px; border-radius: 14px; border: 1px solid var(--line); background: #fff; object-fit: cover; margin-bottom: 16px; box-shadow: 0 2px 10px rgba(0,0,0,.08); }',
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
'  .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 24px; padding-bottom: 12px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }',
'  .stats { font-family: "JetBrains Mono", Consolas, monospace; font-size: 11px; letter-spacing: .06em; color: var(--ink-3); }',
'  .search { border: none; border-bottom: 1px solid var(--line); background: transparent; width: min(260px, 100%); padding: 6px 0; font: inherit; font-family: "JetBrains Mono", Consolas, monospace; font-size: 12px; color: var(--ink); outline: none; transition: border-color 150ms ease-out; }',
'  .search:focus { border-bottom-color: var(--accent); }',
'  .grid { margin-top: 20px; display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; padding-bottom: 8px; }',
'  .card {',
'    background: var(--card);',
'    background-image: url("https://testingcf.jsdelivr.net/gh/qiqi1200/img-bed@main/rice-paper.png");',
'    background-repeat: repeat; background-size: 160px; background-attachment: fixed;',
'    border: 1px solid var(--line); border-radius: 8px; padding: 10px;',
'    display: flex; flex-direction: column; gap: 8px;',
'    animation: enter 220ms ease-out;',
'  }',
'  @keyframes enter { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }',
'  .card a.thumb { display: block; }',
'  .card img { width: 100%; aspect-ratio: 4/3; object-fit: cover; border-radius: 4px; border: 1px solid var(--line); background: #fff; display: block; }',
'  .card .no { font-family: "JetBrains Mono", Consolas, monospace; font-size: 10px; letter-spacing: .04em; color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
'  .card .meta { font-family: "JetBrains Mono", Consolas, monospace; font-size: 10px; letter-spacing: .04em; color: var(--ink-2); }',
'  .exp { font-family: "JetBrains Mono", Consolas, monospace; font-size: 10px; letter-spacing: .04em; display: flex; align-items: center; justify-content: space-between; gap: 6px; }',
'  .exp .state { color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
'  .exp .state.hot { color: var(--danger); }',
'  .exp-opts { display: none; flex-wrap: wrap; gap: 8px; }',
'  .exp-opts.show { display: flex; }',
'  .card .acts { display: flex; gap: 12px; }',
'  .act { background: none; border: none; padding: 0; font: inherit; font-size: 11px; color: var(--ink-2); cursor: pointer; transition: color 150ms ease-out; }',
'  .act:hover { color: var(--accent); }',
'  .act.done { color: var(--accent); }',
'  .act.danger { color: var(--danger); }',
'  .act.danger:hover { color: #8F2F20; }',
'  .act:disabled { opacity: .5; cursor: default; }',
'  .card.gone { opacity: 0; transform: translateY(4px); transition: opacity 200ms ease-out, transform 200ms ease-out; }',
'  .empty { font-family: "JetBrains Mono", Consolas, monospace; font-size: 12px; letter-spacing: .06em; color: var(--ink-3); margin-top: 24px; text-align: center; }',
'  footer { margin-top: 40px; padding: 20px 0 32px; border-top: 1px solid var(--line); display: flex; justify-content: space-between; gap: 12px; font-size: 11px; color: var(--ink-3); font-family: "JetBrains Mono", Consolas, monospace; letter-spacing: .04em; }',
'  @media (max-width: 768px) {',
'    .wrap { padding: 32px 16px 0; }',
'    h1 { font-size: 24px; margin-top: 36px; }',
'    .grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }',
'    footer { flex-direction: column; gap: 4px; }',
'  }',
'  @media (prefers-reduced-motion: reduce) {',
'    * { animation: none !important; transition: none !important; }',
'  }',
'</style>',
'</head>',
'<body>',
'<div class="wrap">',
'  <header>',
'    <span class="brand"><img class="logo" src="https://testingcf.jsdelivr.net/gh/qiqi1200/img-bed@main/20260810095517_x4dm.jpg" alt="">Guancii · Imagebed · Admin</span>',
'    <a class="back" href="/">← 回上传页</a>',
'  </header>',
'  <main>',
'    <h1>照片档案。</h1>',
'    <p class="sub">全部已归档图片，按时间倒序。点图看原图；「设过期」可定时自动删除，默认永不过期。</p>',
'    <div class="toolbar">',
'      <span class="stats" id="stats">翻阅档案中…</span>',
'      <input class="search" id="search" type="text" placeholder="搜索 FILE No." autocomplete="off">',
'    </div>',
'    <div class="grid" id="grid"></div>',
'  </main>',
'  <footer>',
'    <span>Guancii 的图床 · ADMIN CONSOLE</span>',
'    <span id="count"></span>',
'  </footer>',
'</div>',
'<div class="gate" id="gate">',
'  <div class="gate-card">',
'    <img class="gate-logo" src="https://testingcf.jsdelivr.net/gh/qiqi1200/img-bed@main/20260810095517_x4dm.jpg" alt="">',
'    <div class="gate-title">图床后台</div>',
'    <div class="gate-sub">ADMIN · 输入专属密钥</div>',
'    <input id="gate-key" type="password" placeholder="管理员密钥" autocomplete="off">',
'    <button class="gate-btn" id="gate-btn">进入</button>',
'    <div class="gate-err" id="gate-err"></div>',
'  </div>',
'</div>',
'<script>',
'var $ = function(id) { return document.getElementById(id); };',
'var gate = $("gate"), gateKey = $("gate-key"), gateBtn = $("gate-btn"), gateErr = $("gate-err");',
'var grid = $("grid"), stats = $("stats");',
'var photos = [];',
'function verifyAdmin(key, cb) {',
'  fetch("/api/verify-admin", { method: "POST", headers: { "X-Auth-Token": key } })',
'    .then(function(r) { cb(r.ok); })',
'    .catch(function() { cb(false); });',
'}',
'function unlock() { gate.classList.add("hide"); load(); }',
'function submitKey() {',
'  var k = gateKey.value.trim();',
'  if (!k) return;',
'  verifyAdmin(k, function(ok) {',
'    if (ok) { localStorage.setItem("bed_admin_key", k); gateErr.textContent = ""; unlock(); gateKey.blur(); }',
'    else { gateErr.textContent = "密钥不对"; gateKey.value = ""; gateKey.focus(); }',
'  });',
'}',
'gateBtn.addEventListener("click", submitKey);',
'gateKey.addEventListener("keydown", function(e) { if (e.key === "Enter") submitKey(); });',
'var savedKey = localStorage.getItem("bed_admin_key") || "";',
'if (savedKey) { verifyAdmin(savedKey, function(ok) { if (ok) unlock(); else gateKey.focus(); }); }',
'else { gateKey.focus(); }',
'function fmtBytes(n) {',
'  if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";',
'  if (n >= 1024) return Math.round(n / 1024) + " KB";',
'  return n + " B";',
'}',
'function load() {',
'  var key = localStorage.getItem("bed_admin_key") || "";',
'  fetch("/api/photos", { headers: { "X-Auth-Token": key } })',
'    .then(function(r) { return r.json(); })',
'    .then(function(d) {',
'      if (!d || d.error) { stats.textContent = (d && d.error) || "响应异常"; return; }',
'      photos = d.photos || [];',
'      stats.textContent = "共 " + d.count + " 张 · " + fmtBytes(d.totalBytes);',
'      render();',
'    })',
'    .catch(function() { stats.textContent = "加载失败"; });',
'}',
'function esc(s) {',
'  var d = document.createElement("div");',
'  d.textContent = s; return d.innerHTML;',
'}',
'function render() {',
'  var kw = ($("search").value || "").trim().toLowerCase();',
'  var list = photos.filter(function(p) { return !kw || p.name.toLowerCase().indexOf(kw) !== -1; });',
'  grid.innerHTML = "";',
'  if (!list.length) { grid.innerHTML = \'<div class="empty">这里还没有照片。</div>\'; }',
'  else { list.forEach(function(p) { grid.appendChild(card(p)); }); }',
'  $("count").textContent = "显示 " + list.length + " / " + photos.length + " 张";',
'}',
'function fmtExp(iso) {',
'  var d = new Date(iso);',
'  function p(n) { return (n < 10 ? "0" : "") + n; }',
'  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + " 到期";',
'}',
'function card(p) {',
'  var div = document.createElement("div");',
'  div.className = "card";',
'  var expText = p.expires ? fmtExp(p.expires) : "永不过期";',
'  var expHot = p.expires ? " hot" : "";',
'  div.innerHTML =',
'    \'<a class="thumb" href="\' + esc(p.url) + \'" target="_blank" rel="noopener" title="\' + esc(p.url) + \'"><img loading="lazy" src="\' + esc(p.url) + \'" alt=""></a>\' +',
'    \'<div class="no">FILE No. \' + esc(p.name) + \'</div>\' +',
'    \'<div class="meta">\' + esc(p.date || "—") + \' · \' + esc(fmtBytes(p.size)) + \'</div>\' +',
'    \'<div class="exp"><span class="state\' + expHot + \'">\' + esc(expText) + \'</span><button class="act exp-btn">设过期</button></div>\' +',
'    \'<div class="exp-opts"><button class="act" data-days="1">1天</button><button class="act" data-days="3">3天</button><button class="act" data-days="7">7天</button><button class="act" data-days="30">30天</button><button class="act" data-days="0">取消</button></div>\' +',
'    \'<div class="acts"><button class="act" data-copy="\' + esc(p.url) + \'">复制 URL</button><button class="act" data-copy="\' + esc(p.md) + \'">复制 MD</button><button class="act danger del-btn">删除</button></div>\';',
'  div.querySelectorAll(".act[data-copy]").forEach(function(b) {',
'    b.addEventListener("click", function() {',
'      var copyDone = function() {',
'        var old = b.textContent;',
'        b.textContent = "已复制";',
'        b.classList.add("done");',
'        setTimeout(function() { b.textContent = old; b.classList.remove("done"); }, 1200);',
'      };',
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
'  var expBtn = div.querySelector(".exp-btn"), optsEl = div.querySelector(".exp-opts");',
'  expBtn.addEventListener("click", function() {',
'    var show = optsEl.classList.toggle("show");',
'    expBtn.textContent = show ? "收起" : "设过期";',
'  });',
'  optsEl.querySelectorAll(".act").forEach(function(b) {',
'    b.addEventListener("click", function() { setExpiry(p.name, Number(b.dataset.days), div, expBtn, optsEl); });',
'  });',
'  var delBtn = div.querySelector(".del-btn");',
'  delBtn.addEventListener("click", function() { doDelete(p.name, delBtn, div); });',
'  return div;',
'}',
'function setExpiry(name, days, cardEl, expBtn, optsEl) {',
'  var key = localStorage.getItem("bed_admin_key") || "";',
'  fetch("/api/expiry", {',
'    method: "POST",',
'    headers: { "Content-Type": "application/json", "X-Auth-Token": key },',
'    body: JSON.stringify({ name: name, days: days })',
'  })',
'  .then(function(r) { return r.json(); })',
'  .then(function(d) {',
'    if (d && d.ok) {',
'      var stateEl = cardEl.querySelector(".state");',
'      if (d.expires_at) { stateEl.textContent = fmtExp(d.expires_at); stateEl.classList.add("hot"); }',
'      else { stateEl.textContent = "永不过期"; stateEl.classList.remove("hot"); }',
'      optsEl.classList.remove("show"); expBtn.textContent = "设过期";',
'    } else {',
'      stats.textContent = (d && d.error) || "设置失败";',
'    }',
'  })',
'  .catch(function() { stats.textContent = "网络错误"; });',
'}',
'function doDelete(name, btn, cardEl) {',
'  if (btn.dataset.confirm !== "1") {',
'    btn.dataset.confirm = "1";',
'    btn.textContent = "确认删除？";',
'    setTimeout(function() { btn.dataset.confirm = "0"; btn.textContent = "删除"; }, 3000);',
'    return;',
'  }',
'  var key = localStorage.getItem("bed_admin_key") || "";',
'  btn.disabled = true; btn.textContent = "删除中…";',
'  fetch("/api/delete", {',
'    method: "POST",',
'    headers: { "Content-Type": "application/json", "X-Auth-Token": key },',
'    body: JSON.stringify({ name: name })',
'  })',
'  .then(function(r) { return r.json(); })',
'  .then(function(d) {',
'    if (d && d.ok) {',
'      cardEl.classList.add("gone");',
'      setTimeout(function() {',
'        cardEl.remove();',
'        photos = photos.filter(function(q) { return q.name !== name; });',
'        render();',
'        stats.textContent = "共 " + photos.length + " 张 · " + fmtBytes(photos.reduce(function(s, q) { return s + q.size; }, 0));',
'      }, 200);',
'    } else {',
'      btn.disabled = false; btn.dataset.confirm = "0"; btn.textContent = "删除";',
'      stats.textContent = (d && d.error) || "删除失败";',
'    }',
'  })',
'  .catch(function() { btn.disabled = false; btn.dataset.confirm = "0"; btn.textContent = "删除"; stats.textContent = "网络错误"; });',
'}',
'$("search").addEventListener("input", render);',
'</script>',
'</body>',
'</html>',
].join('\n');
