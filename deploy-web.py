#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""网页图床部署 — Worker(img.260607.best) + GitHub 仓库存储
用法:
  GITHUB_TOKEN=<ghp_...> python deploy-web.py [--account Dianqiqi] [--secret <访问密钥>]
"""
import argparse, json, os, re, secrets, subprocess, sys, urllib.request, urllib.error

BASE = 'https://api.cloudflare.com/client/v4'
WORKER_NAME = 'img-bed'
DOMAIN = 'img.260607.best'
SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'web.js')

def load_cf_token():
    t = os.environ.get('CLOUDFLARE_API_TOKEN')
    if t: return t
    rc = os.path.expanduser('~/.bashrc')
    if os.path.exists(rc):
        for line in open(rc, encoding='utf-8', errors='ignore'):
            m = re.search(r'CLOUDFLARE_API_TOKEN="?([A-Za-z0-9_\-]+)"?', line)
            if m: return m.group(1)
    sys.exit('未找到 CLOUDFLARE_API_TOKEN')

def load_gh_token():
    t = os.environ.get('GITHUB_TOKEN')
    if t:
        return t.strip()
    try:
        r = subprocess.run(['gh', 'auth', 'token'], capture_output=True, text=True, timeout=30)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
    except Exception:
        pass
    sys.exit('未找到 GitHub token（环境变量 GITHUB_TOKEN 或 gh auth）')

def call(token, method, path, body=None, headers=None, timeout=40):
    req = urllib.request.Request(BASE + path, method=method,
                                 headers={'Authorization': f'Bearer {token}', **({} if headers is None else headers)})
    data = None
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
    try:
        r = urllib.request.urlopen(req, data=data, timeout=timeout)
        return r.status, json.loads(r.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode() or '{}')
        except Exception: return e.code, {}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--account', default='Dianqiqi')
    ap.add_argument('--secret', help='图床访问密钥（默认随机生成）')
    ap.add_argument('--domain', default=DOMAIN)
    args = ap.parse_args()

    cft = load_cf_token()
    # 账户级 token 直接验证 accounts
    s, d = call(cft, 'GET', '/accounts?per_page=5')
    if s != 200 or not d.get('result'):
        sys.exit(f'CF token 无效 ({s}): {d.get("errors")}')
    acc = next((a for a in d['result'] if args.account.lower() in a['name'].lower()), None)
    if not acc:
        sys.exit(f'账户未找到: {args.account}。可用: ' + ', '.join(a['name'] for a in d['result']))
    aid = acc['id']
    print(f'[i] 账户: {acc["name"]}')

    ght = load_gh_token()
    secret = args.secret or os.environ.get('BED_SECRET') or secrets.token_urlsafe(12)
    print(f'[i] 图床访问密钥: {secret}  （网页打开时输入这个）')
    admin_secret = os.environ.get('ADMIN_SECRET')
    if not admin_secret:
        sys.exit('未设置 ADMIN_SECRET 环境变量（后台专属密钥，Actions 里已配 secret）')
    print(f'[i] 后台专属密钥: {admin_secret}  （/admin 面板输入这个）')

    # 1. 部署 worker
    with open(SCRIPT, 'rb') as f:
        script = f.read()
    metadata = {
        'main_module': 'web.js',
        'compatibility_date': '2026-01-01',
        'triggers': [{'crons': ['0 * * * *']}],  # 每小时整点：检查过期图片并删除
        'bindings': [
            {'type': 'plain_text', 'name': 'GH_TOKEN', 'text': ght},
            {'type': 'plain_text', 'name': 'BED_SECRET', 'text': secret},
            {'type': 'plain_text', 'name': 'ADMIN_SECRET', 'text': admin_secret},
        ],
    }
    boundary = '----imgbed' + secrets.token_hex(8)
    def part(name, content, ctype, filename=None):
        disp = f'Content-Disposition: form-data; name="{name}"'
        if filename:
            disp += f'; filename="{filename}"'
        return (f'--{boundary}\r\n{disp}\r\nContent-Type: {ctype}\r\n\r\n').encode() + content + b'\r\n'
    body = part('metadata', json.dumps(metadata).encode(), 'application/json') + \
           part('web.js', script, 'application/javascript+module', filename='web.js') + f'--{boundary}--\r\n'.encode()
    s, d = call(cft, 'PUT', f'/accounts/{aid}/workers/scripts/{WORKER_NAME}',
                body=body, headers={'Content-Type': f'multipart/form-data; boundary={boundary}'}, timeout=90)
    if s != 200:
        sys.exit(f'部署失败 ({s}): {d.get("errors")}')
    print(f'[OK] Worker 已部署: {WORKER_NAME}')

    # 2. 绑定自定义域名（需要 zone 在账户）
    s, d = call(cft, 'GET', '/zones?per_page=50')
    apex = args.domain.split('.', 1)[1]
    zone = next((z for z in (d.get('result') or []) if z['name'] == apex and z['status'] == 'active'), None)
    if not zone:
        print(f'[!] 域名 {apex} 不在本账户，跳过域名绑定。手动到 dash.cloudflare.com 添加站点后重跑。')
        print(f'    备用访问: https://{WORKER_NAME}.workers.dev（校园网可能不通）')
        return
    s, d = call(cft, 'POST', f'/accounts/{aid}/workers/domains',
                {'hostname': args.domain, 'service': WORKER_NAME, 'zone_id': zone['id']})
    if s == 200:
        print(f'[OK] 域名已绑定: https://{args.domain}（DNS 生效需几分钟）')
        return
    print(f'[i] Custom Domains API 不可用 ({s})，尝试 Worker Routes 方式...')
    s, d = call(cft, 'POST', f'/zones/{zone["id"]}/workers/routes',
                {'pattern': f'{args.domain}/*', 'script': WORKER_NAME})
    if s != 200:
        print(f'[!] Routes API 也不可用 ({s}): {d.get("errors")}')
        print('    手动步骤: 控制台 dash.cloudflare.com → Workers → img-bed → Settings → Domains & Routes')
        print(f'    添加路由: {args.domain}/* 指向 img-bed；再在 DNS 加 CNAME {args.domain} → img-bed.<workers.dev 子域>')
        return
    print('[OK] Worker Route 已添加，配置 CNAME 指向 workers.dev...')
    s, d = call(cft, 'GET', f'/accounts/{aid}/workers/subdomain')
    sub = (d.get('result') or {}).get('subdomain') if s == 200 else None
    if not sub:
        print('[!] 无法获取 workers.dev 子域，请手动在 DNS 加 CNAME（见控制台 worker 详情页的域名示例）')
        return
    target = f'{WORKER_NAME}.{sub}.workers.dev'
    s, d = call(cft, 'POST', f'/zones/{zone["id"]}/dns_records',
                {'type': 'CNAME', 'name': args.domain, 'content': target, 'proxied': True, 'ttl': 1})
    if s == 200:
        print(f'[OK] CNAME 已添加: {args.domain} → {target}（DNS 生效需几分钟）')
    else:
        print(f'[!] CNAME 添加失败 ({s}): {d.get("errors")}')
        print(f'    手动: DNS 加 CNAME {args.domain} → {target}')

    print()
    print('=' * 60)
    print('部署完成！')
    print(f'  网页: https://{args.domain}  （密钥: {secret}）')
    print(f'  或备用: https://{WORKER_NAME}.workers.dev')
    print('=' * 60)

if __name__ == '__main__':
    main()
