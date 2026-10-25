import http from 'node:http';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { getConfig, inBirthdayWindow, readRawConfig, writeRawConfig } from './config.js';
import { getState } from './state.js';
import { logout, status } from './bot.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function authorized(req, password) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const [, pass = ''] = Buffer.from(header.slice(6), 'base64').toString().split(/:(.*)/s);
  const a = crypto.createHash('sha256').update(pass).digest();
  const b = crypto.createHash('sha256').update(password).digest();
  return crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function page(flash) {
  const cfg = getConfig();
  const st = getState();
  let link = '';
  if (status.connection === 'open') {
    link = `<p class="ok">● Linked as <b>${esc(status.me?.name)}</b> (+${esc(status.me?.id?.split('@')[0])})</p>
      <form method="post" action="/logout" onsubmit="return confirm('Unlink this bot from WhatsApp?')"><button class="danger">Unlink device</button></form>`;
  } else if (status.pairingCode) {
    link = `<p>Open WhatsApp on your phone → <b>Settings → Linked Devices → Link a Device → Link with phone number instead</b>, and enter:</p>
      <p class="code">${esc(status.pairingCode)}</p>`;
  } else if (status.qr) {
    const img = await QRCode.toDataURL(status.qr, { margin: 1, width: 280 });
    link = `<p>Open WhatsApp on your phone → <b>Settings → Linked Devices → Link a Device</b> and scan:</p>
      <img src="${img}" alt="QR code" width="280" height="280"><p class="muted">The code refreshes automatically.</p>`;
  } else {
    link = `<p class="muted">Connecting… (${esc(status.connection)}) ${esc(status.lastError || '')}</p>`;
  }

  const rows = st.log.slice(0, 50).map((e) => `<tr><td>${esc(new Date(e.at).toLocaleString())}</td><td>${esc(e.name)}${e.isGroup ? ' <span class="muted">(group)</span>' : ''}</td><td>${esc(e.text)}</td><td>${esc(e.reply)}</td></tr>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Birthday Bot</title>
${status.connection === 'open' ? '' : '<meta http-equiv="refresh" content="10">'}
<style>
body{font:15px/1.5 system-ui,sans-serif;max-width:900px;margin:0 auto;padding:16px;background:#f6f7f9;color:#1c1e21}
section{background:#fff;border-radius:10px;padding:16px;margin:12px 0;box-shadow:0 1px 2px #0001}
h1{font-size:22px}h2{font-size:17px;margin-top:0}
textarea{width:100%;box-sizing:border-box;min-height:420px;font:13px ui-monospace,monospace}
button{padding:8px 14px;border:0;border-radius:6px;background:#128c7e;color:#fff;cursor:pointer}
.danger{background:#c0392b}.ok{color:#128c7e}.muted{color:#777}.code{font:bold 28px ui-monospace,monospace;letter-spacing:3px}
.flash{padding:8px 12px;border-radius:6px;background:#e8f5e9}.flash.err{background:#fdecea}
table{width:100%;border-collapse:collapse;font-size:13px}td{border-top:1px solid #eee;padding:6px;vertical-align:top}
.table{overflow-x:auto}
</style></head><body>
<h1>🎂 WhatsApp Birthday Bot</h1>
${flash ? `<p class="flash ${flash.err ? 'err' : ''}">${esc(flash.msg)}</p>` : ''}
<section><h2>WhatsApp link</h2>${link}</section>
<section><h2>Status</h2>
<p>Bot ${cfg.enabled ? '<b class="ok">enabled</b>' : '<b>disabled</b>'} ·
${cfg.birthday ? `birthday ${esc(cfg.birthday)} ±${cfg.activeWindowDays}d (${inBirthdayWindow(cfg) ? '<b class="ok">active now</b>' : 'not active now'})` : 'replies any day'} ·
${st.totalReplies} replies sent</p></section>
<section><h2>Configuration</h2>
<form method="post" action="/config"><textarea name="config" spellcheck="false">${esc(readRawConfig())}</textarea>
<p><button>Save</button> <span class="muted">Changes apply immediately, no restart needed.</span></p></form></section>
<section><h2>Recent replies</h2><div class="table"><table><tr><th>When</th><th>From</th><th>Message</th><th>Reply</th></tr>${rows || '<tr><td colspan="4" class="muted">None yet</td></tr>'}</table></div></section>
</body></html>`;
}

export function startWeb() {
  const { web } = getConfig();
  if (!web.enabled) return;
  if (!web.password) {
    console.warn('[web] dashboard disabled: set web.password in config.json to enable it');
    return;
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!authorized(req, getConfig().web.password)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Birthday Bot"' });
        return res.end('Authentication required');
      }
      let flash = null;
      if (req.method === 'POST' && req.url === '/config') {
        const body = new URLSearchParams(await readBody(req));
        try {
          writeRawConfig(body.get('config') || '');
          flash = { msg: 'Configuration saved.' };
        } catch (err) {
          flash = { msg: `Not saved: ${err.message}`, err: true };
        }
      } else if (req.method === 'POST' && req.url === '/logout') {
        await logout();
        flash = { msg: 'Unlinked. A new QR code will appear shortly.' };
      } else if (req.url === '/healthz') {
        res.writeHead(status.connection === 'open' ? 200 : 503, { 'Content-Type': 'text/plain' });
        return res.end(status.connection);
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(await page(flash));
    } catch (err) {
      console.error('[web] error:', err);
      res.writeHead(500);
      res.end('Internal error');
    }
  });
  server.listen(web.port, web.host, () => console.log(`[web] dashboard on http://${web.host}:${web.port}`));
}
