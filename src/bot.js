import fs from 'node:fs';
import pino from 'pino';
import qrcodeTerminal from 'qrcode-terminal';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  areJidsSameUser,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  jidNormalizedUser,
  normalizeMessageContent,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { AUTH_DIR, getConfig, inBirthdayWindow, todayIn } from './config.js';
import { isBirthdayWish, mentionsName } from './detector.js';
import { alreadyRepliedToday, recordReply } from './state.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

/** Live connection status, read by the web dashboard. */
export const status = {
  connection: 'starting', // starting | waiting_for_link | open | closed
  qr: null,
  pairingCode: null,
  me: null,
  lastError: null,
};

let sock = null;
let reconnectAttempts = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const digits = (jid) => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');

export function messageText(message) {
  const m = normalizeMessageContent(message);
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  );
}

function contextInfo(message) {
  const m = normalizeMessageContent(message);
  return m?.extendedTextMessage?.contextInfo || m?.imageMessage?.contextInfo || m?.videoMessage?.contextInfo || null;
}

function isMe(jid) {
  const u = sock?.user;
  return !!jid && !!u && (areJidsSameUser(jid, u.id) || (u.lid && areJidsSameUser(jid, u.lid)));
}

function firstName(pushName) {
  const n = String(pushName || '').trim().split(/\s+/)[0];
  return n || 'friend';
}

export function fillTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (all, key) => (key in vars ? vars[key] : all));
}

/** Returns a reason string when the message should be skipped, otherwise null. */
function skipReason(msg, cfg, text) {
  const jid = msg.key.remoteJid;
  if (!cfg.enabled) return 'bot disabled';
  if (msg.key.fromMe) return 'own message';
  if (!jid || isJidStatusBroadcast(jid) || isJidBroadcast(jid) || isJidNewsletter(jid)) return 'broadcast/status';
  const group = isJidGroup(jid);
  if (group && !cfg.replyInGroups) return 'groups disabled';
  if (!group && !cfg.replyInPrivate) return 'private disabled';

  const ts = Number(msg.messageTimestamp || 0) * 1000;
  if (ts && Date.now() - ts > cfg.maxMessageAgeHours * 3600000) return 'too old';
  if (!inBirthdayWindow(cfg)) return 'outside birthday window';

  const senderJid = group ? msg.key.participantPn || msg.key.participant : msg.key.senderPn || jid;
  const sender = digits(senderJid);
  const normalize = (list) => list.map((n) => String(n).replace(/\D/g, ''));
  if (normalize(cfg.ignoreNumbers).includes(sender)) return 'ignored number';
  if (cfg.onlyNumbers.length && !normalize(cfg.onlyNumbers).includes(sender)) return 'not in onlyNumbers';

  if (!isBirthdayWish(text, cfg)) return 'not a birthday wish';

  if (group && cfg.groupRequireMention) {
    const ctx = contextInfo(msg.message);
    const mentioned = (ctx?.mentionedJid || []).some(isMe);
    const quotedMe = isMe(ctx?.participant);
    if (!mentioned && !quotedMe && !mentionsName(text, cfg.myNames)) return 'group wish not addressed to me';
  }

  if (cfg.oncePerChatPerDay && alreadyRepliedToday(group ? `${jid}/${sender}` : jid, todayIn(cfg.timezone))) {
    return 'already replied today';
  }
  return null;
}

async function handleMessage(msg) {
  const cfg = getConfig();
  const text = messageText(msg.message);
  if (!text && !msg.message) return;
  const reason = skipReason(msg, cfg, text);
  const jid = msg.key.remoteJid;
  if (reason) {
    if (reason !== 'not a birthday wish' && reason !== 'own message') {
      logger.info({ jid, reason }, 'skipped');
    }
    return;
  }

  const group = isJidGroup(jid);
  const sender = digits(group ? msg.key.participantPn || msg.key.participant : msg.key.senderPn || jid);
  const dedupeKey = group ? `${jid}/${sender}` : jid;
  const today = todayIn(cfg.timezone);
  // Reserve the slot before the delay so a burst of wishes gets one reply.
  const name = firstName(msg.pushName);
  const templates = group && cfg.groupReplies?.length ? cfg.groupReplies : cfg.replies;
  const reply = fillTemplate(pick(templates), { name, fullName: msg.pushName || name });
  recordReply({ chatJid: dedupeKey, today, name: msg.pushName || sender, text, reply, isGroup: !!group });

  const [min, max] = cfg.replyDelaySeconds;
  const delay = (min + Math.random() * Math.max(0, max - min)) * 1000;
  console.log(`[bot] birthday wish from ${msg.pushName || sender} in ${group ? 'group' : 'chat'}; replying in ${Math.round(delay / 1000)}s`);

  try {
    if (cfg.markAsRead) await sock.readMessages([msg.key]);
    if (cfg.reaction) await sock.sendMessage(jid, { react: { text: cfg.reaction, key: msg.key } });
    await sleep(delay);
    await sock.presenceSubscribe(jid).catch(() => {});
    await sock.sendPresenceUpdate('composing', jid);
    await sleep(Math.min(6000, 1000 + reply.length * 60));
    await sock.sendPresenceUpdate('paused', jid);
    await sock.sendMessage(jid, { text: reply }, group ? { quoted: msg } : undefined);
    console.log(`[bot] replied to ${msg.pushName || sender}: ${reply}`);
  } catch (err) {
    console.error('[bot] failed to reply:', err.message);
  }
}

export async function startBot() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  status.pairingCode = null;
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: Browsers.ubuntu('Birthday Bot'),
    markOnlineOnConnect: false, // keep phone notifications working
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  let pairingRequested = false;
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const cfg = getConfig();

    if (qr) {
      status.connection = 'waiting_for_link';
      const phone = String(cfg.pairingPhoneNumber || '').replace(/\D/g, '');
      if (phone && !state.creds.registered) {
        if (!pairingRequested) {
          pairingRequested = true;
          try {
            status.pairingCode = await sock.requestPairingCode(phone);
            console.log(`\n[link] Pairing code: ${status.pairingCode}`);
            console.log('[link] WhatsApp > Settings > Linked Devices > Link a Device > Link with phone number instead\n');
          } catch (err) {
            console.error('[link] pairing code request failed, falling back to QR:', err.message);
          }
        }
      }
      status.qr = qr;
      if (!status.pairingCode) {
        console.log('\n[link] Scan this QR in WhatsApp > Settings > Linked Devices > Link a Device:');
        qrcodeTerminal.generate(qr, { small: true });
      }
    }

    if (connection === 'open') {
      reconnectAttempts = 0;
      status.connection = 'open';
      status.qr = null;
      status.pairingCode = null;
      status.lastError = null;
      status.me = { id: jidNormalizedUser(sock.user.id), name: sock.user.name || '' };
      console.log(`[bot] connected as ${status.me.name} (${digits(status.me.id)})`);
    }

    if (connection === 'close') {
      status.connection = 'closed';
      const code = lastDisconnect?.error?.output?.statusCode;
      status.lastError = lastDisconnect?.error?.message || String(code);
      if (code === DisconnectReason.loggedOut) {
        console.log('[bot] logged out from phone; clearing session so you can link again');
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        reconnectAttempts = 0;
      } else {
        reconnectAttempts += 1;
        console.log(`[bot] connection closed (${status.lastError}); reconnecting`);
      }
      const wait = Math.min(60000, 2000 * 2 ** Math.min(reconnectAttempts, 5));
      setTimeout(() => startBot().catch((e) => console.error('[bot] restart failed:', e)), reconnectAttempts ? wait : 1000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      handleMessage(msg).catch((err) => console.error('[bot] handler error:', err));
    }
  });

  return sock;
}

/** Unlinks this device from WhatsApp and wipes the local session. */
export async function logout() {
  try {
    await sock?.logout();
  } catch {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    sock?.end(new Error('logout'));
  }
}
