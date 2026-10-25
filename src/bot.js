import fs from 'node:fs';
import path from 'node:path';
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
import { AUTH_DIR, ROOT, getConfig, inBirthdayWindow, todayIn } from './config.js';
import { isBirthdayWish, mentionsName } from './detector.js';
import { alreadyRepliedToday, lastOutgoing, recordOutgoing, recordReply } from './state.js';

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

function senderOf(msg) {
  const jid = msg.key.remoteJid;
  return digits(isJidGroup(jid) ? msg.key.participantPn || msg.key.participant : msg.key.senderPn || jid);
}

function dedupeKeyOf(msg) {
  const jid = msg.key.remoteJid;
  return isJidGroup(jid) ? `${jid}/${senderOf(msg)}` : jid;
}

const tsOf = (msg) => Number(msg.messageTimestamp || 0) * 1000;

/** Oldest message age (ms) we will still answer. */
function maxAgeMs(cfg) {
  const hours = cfg.catchUp.enabled ? Math.max(cfg.catchUp.lookbackHours, cfg.maxMessageAgeHours) : cfg.maxMessageAgeHours;
  return hours * 3600000;
}

/** Remembers when we last wrote in a chat, so wishes we already answered (by hand or by the bot) are skipped. */
function noteOutgoing(msg) {
  if (!msg.key.fromMe || !msg.key.remoteJid) return;
  const m = normalizeMessageContent(msg.message);
  // Reactions, receipts and other protocol messages don't count as a reply.
  if (!m || m.reactionMessage || m.protocolMessage || m.senderKeyDistributionMessage) return;
  if (!messageText(msg.message) && !m.imageMessage && !m.videoMessage && !m.audioMessage && !m.stickerMessage) return;
  recordOutgoing(msg.key.remoteJid, tsOf(msg));
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

  const ts = tsOf(msg);
  if (ts && Date.now() - ts > maxAgeMs(cfg)) return 'too old';
  if (!inBirthdayWindow(cfg, ts ? new Date(ts) : new Date())) return 'outside birthday window';

  const sender = senderOf(msg);
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

  if (!group && ts && lastOutgoing(jid) >= ts) return 'already answered in this chat';
  if (cfg.oncePerChatPerDay && alreadyRepliedToday(dedupeKeyOf(msg), todayIn(cfg.timezone))) {
    return 'already replied today';
  }
  return null;
}

let catchUpQueued = 0; // per process run, so a restart can't flood replies

// Replies are sent one at a time so a backlog of old wishes doesn't go out in a burst.
const queue = [];
const pending = new Set();
let draining = false;

/** Queues a reply if the message is a wish we should answer. Returns true when queued. */
function considerMessage(msg, source) {
  const cfg = getConfig();
  const text = messageText(msg.message);
  if (!msg.message) return false;
  const reason = skipReason(msg, cfg, text);
  if (reason) {
    if (reason !== 'not a birthday wish' && reason !== 'own message') {
      logger.info({ jid: msg.key.remoteJid, source, reason }, 'skipped');
    }
    return false;
  }
  const key = dedupeKeyOf(msg);
  if (pending.has(key)) return false; // a burst of wishes from one person gets one reply
  pending.add(key);
  queue.push({ msg, text, key, source });
  queue.sort((a, b) => (a.source === 'live' ? 0 : 1) - (b.source === 'live' ? 0 : 1));
  console.log(`[bot] birthday wish from ${msg.pushName || senderOf(msg)} (${source}); queued, ${queue.length} waiting`);
  drain();
  return true;
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const item = queue.shift();
      try {
        await sendReply(item);
      } catch (err) {
        console.error('[bot] failed to reply:', err.message);
      } finally {
        pending.delete(item.key);
      }
    }
  } finally {
    draining = false;
  }
}

function replyImagePath(cfg) {
  if (!cfg.replyImage) return null;
  const file = path.isAbsolute(cfg.replyImage) ? cfg.replyImage : path.join(ROOT, cfg.replyImage);
  if (!fs.existsSync(file)) {
    console.warn(`[bot] replyImage not found at ${file}; sending text only`);
    return null;
  }
  return file;
}

async function sendReply({ msg, text, key, source }) {
  let cfg = getConfig();
  const jid = msg.key.remoteJid;
  const [min, max] = cfg.replyDelaySeconds;
  const delay = (min + Math.random() * Math.max(0, max - min)) * 1000;
  console.log(`[bot] replying to ${msg.pushName || senderOf(msg)} in ${Math.round(delay / 1000)}s`);
  await sleep(delay);

  // Re-check after waiting: config may have changed, or you may have replied by hand meanwhile.
  cfg = getConfig();
  const reason = skipReason(msg, cfg, text);
  if (reason) {
    console.log(`[bot] not replying to ${msg.pushName || senderOf(msg)}: ${reason}`);
    return;
  }

  const group = isJidGroup(jid);
  const name = firstName(msg.pushName);
  const templates = group && cfg.groupReplies?.length ? cfg.groupReplies : cfg.replies;
  const reply = fillTemplate(pick(templates), { name, fullName: msg.pushName || name });
  const image = group ? null : replyImagePath(cfg);

  if (cfg.markAsRead) await sock.readMessages([msg.key]).catch(() => {});
  if (cfg.reaction) await sock.sendMessage(jid, { react: { text: cfg.reaction, key: msg.key } });
  await sock.presenceSubscribe(jid).catch(() => {});
  await sock.sendPresenceUpdate('composing', jid);
  await sleep(Math.min(6000, 1000 + reply.length * 60));
  await sock.sendPresenceUpdate('paused', jid);
  const content = image ? { image: fs.readFileSync(image), caption: reply || undefined } : { text: reply };
  await sock.sendMessage(jid, content, group ? { quoted: msg } : undefined);

  recordReply({ chatJid: key, today: todayIn(cfg.timezone), name: msg.pushName || senderOf(msg), text, reply: image ? `[image] ${reply}` : reply, isGroup: !!group });
  recordOutgoing(jid, Date.now());
  console.log(`[bot] replied to ${msg.pushName || senderOf(msg)}: ${image ? '[image] ' : ''}${reply}`);
}

/** Looks through chat history WhatsApp sends when the device links, for wishes that were never answered. */
function scanHistory(messages) {
  // Note every message we sent first, so wishes already answered in history are skipped.
  messages.forEach(noteOutgoing);
  const cfg = getConfig();
  if (!cfg.catchUp.enabled) return;
  const candidates = messages
    .filter((m) => !m.key.fromMe && m.message)
    .sort((a, b) => tsOf(a) - tsOf(b));
  for (const msg of candidates) {
    if (catchUpQueued >= cfg.catchUp.maxReplies) {
      console.log(`[bot] catch-up limit (${cfg.catchUp.maxReplies}) reached; skipping remaining old wishes`);
      break;
    }
    if (considerMessage(msg, 'history')) catchUpQueued += 1;
  }
}

// 'notify' = arrived now (including messages queued while offline); 'append' = synced from your phone.
function handleUpsert(messages, type) {
  for (const msg of messages) {
    noteOutgoing(msg);
    if (type === 'notify') considerMessage(msg, 'live');
    else if (type === 'append' && !msg.key.fromMe) scanHistory([msg]);
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
    // Present as a standard WhatsApp Web session; unusual device names can be rejected when linking.
    browser: Browsers.appropriate('Chrome'),
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

  sock.ev.on('messages.upsert', ({ messages, type }) => handleUpsert(messages, type));

  sock.ev.on('messaging-history.set', ({ messages }) => {
    if (messages?.length) scanHistory(messages);
  });

  return sock;
}

/** Test hook: process messages against a fake socket without connecting to WhatsApp. */
export const _test = {
  useSocket: (fake) => (sock = fake),
  upsert: handleUpsert,
  history: scanHistory,
  idle: async () => {
    while (draining || queue.length) await sleep(20);
  },
};

/** Unlinks this device from WhatsApp and wipes the local session. */
export async function logout() {
  try {
    await sock?.logout();
  } catch {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    sock?.end(new Error('logout'));
  }
}
