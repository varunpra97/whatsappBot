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
  isLidUser,
  jidNormalizedUser,
  normalizeMessageContent,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { AUTH_DIR, ROOT, getConfig, inBirthdayWindow, todayIn } from './config.js';
import { isBirthdayWish, mentionsName } from './detector.js';
import { alreadyRepliedToday, lastOutgoing, recentIncoming, recordOutgoing, recordReply, rememberIncoming } from './state.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });
// The WhatsApp library logs routine decryption retries and timeouts as errors; hide them unless debugging.
const libLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'fatal' });

/** Live connection status, read by the web dashboard. */
export const status = {
  connection: 'starting', // starting | waiting_for_link | open | closed
  qr: null,
  pairingCode: null,
  me: null,
  lastError: null,
};

let sock = null;
let linkedThisRun = false; // history sync only happens on a fresh link
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

const isPnUser = (jid) => typeof jid === 'string' && jid.endsWith('@s.whatsapp.net');

/** Phone-number JID for the sender when WhatsApp provides one (chats may be addressed by @lid). */
function senderJidOf(msg) {
  const { remoteJid, participant, participantAlt, participantPn, remoteJidAlt, senderPn } = msg.key;
  if (isJidGroup(remoteJid)) return [participantAlt, participantPn, participant].find(isPnUser) || participant;
  return [remoteJidAlt, senderPn, remoteJid].find(isPnUser) || remoteJid;
}

function senderOf(msg) {
  return digits(senderJidOf(msg));
}

// WhatsApp can address the same person by phone number or by an anonymous @lid id.
// Known pairs are linked here so a reply recorded under one id also counts for the other.
const aliases = new Map(); // jid -> Set of jids for the same person

function linkAliases(a, b) {
  if (!a || !b || a === b) return;
  const merged = new Set([a, b, ...(aliases.get(a) || []), ...(aliases.get(b) || [])]);
  for (const jid of merged) aliases.set(jid, merged);
}

/** Looks up the other id for a 1:1 chat in WhatsApp's lid/phone mapping. */
async function resolveAliases(msg) {
  const { remoteJid, remoteJidAlt } = msg.key;
  if (!remoteJid || isJidGroup(remoteJid)) return;
  linkAliases(remoteJid, remoteJidAlt);
  const store = sock?.signalRepository?.lidMapping;
  if (!store) return;
  for (const jid of [remoteJid, remoteJidAlt]) {
    if (!jid) continue;
    const user = jidNormalizedUser(jid);
    try {
      if (isLidUser(user)) {
        const pn = await store.getPNForLID(user);
        if (pn) linkAliases(user, jidNormalizedUser(pn));
      } else if (isPnUser(user)) {
        const lid = await store.getLIDForPN(user);
        if (lid) linkAliases(user, jidNormalizedUser(lid));
      }
    } catch (err) {
      logger.debug({ jid, err: err.message }, 'lid mapping lookup failed');
    }
  }
}

/** Every id a 1:1 chat is known under (@lid and phone number). */
function chatJidsOf(msg) {
  const ids = new Set();
  for (const jid of [msg.key.remoteJid, msg.key.remoteJidAlt]) {
    if (!jid) continue;
    ids.add(jid);
    ids.add(jidNormalizedUser(jid));
    for (const alias of aliases.get(jid) || aliases.get(jidNormalizedUser(jid)) || []) ids.add(alias);
  }
  return [...ids];
}

/** Keys used for once-per-day and in-queue de-duplication. */
function dedupeKeysOf(msg) {
  const jid = msg.key.remoteJid;
  return isJidGroup(jid) ? [`${jid}/${senderOf(msg)}`] : chatJidsOf(msg);
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
  for (const jid of chatJidsOf(msg)) recordOutgoing(jid, tsOf(msg));
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
  if (cfg.onlyTodaysWishes && ts && todayIn(cfg.timezone, new Date(ts)) !== todayIn(cfg.timezone)) return 'not from today';
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

  if (!group && ts && Math.max(...chatJidsOf(msg).map(lastOutgoing)) >= ts) return 'already answered in this chat';
  const today = todayIn(cfg.timezone);
  if (cfg.oncePerChatPerDay && dedupeKeysOf(msg).some((k) => alreadyRepliedToday(k, today))) {
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
  const keys = dedupeKeysOf(msg);
  if (keys.some((k) => pending.has(k))) return false; // a burst of wishes from one person gets one reply
  keys.forEach((k) => pending.add(k));
  queue.push({ msg, text, keys, source });
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
        item.keys.forEach((k) => pending.delete(k));
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

async function sendReply({ msg, text, source }) {
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

  recordReply({ chatJids: dedupeKeysOf(msg), today: todayIn(cfg.timezone), name: msg.pushName || senderOf(msg), text, reply: image ? `[image] ${reply}` : reply, isGroup: !!group });
  for (const j of chatJidsOf(msg)) recordOutgoing(j, Date.now());
  console.log(`[bot] replied to ${msg.pushName || senderOf(msg)}: ${image ? '[image] ' : ''}${reply}`);
}

/** Looks through chat history WhatsApp sends when the device links, for wishes that were never answered. */
async function scanHistory(messages, { quiet = false, label = 'chat history received' } = {}) {
  // Note every message we sent first, so wishes already answered in history are skipped.
  messages.forEach(noteOutgoing);
  const cfg = getConfig();
  const candidates = messages
    .filter((m) => !m.key.fromMe && m.message)
    .sort((a, b) => tsOf(a) - tsOf(b));
  const tally = {};
  const leftOut = [];
  const skipped = [];
  for (const msg of candidates) {
    const text = messageText(msg.message);
    if (!isJidGroup(msg.key.remoteJid)) rememberIncoming(msg, text);
    // Only birthday wishes are worth reporting; history also holds thousands of ordinary messages.
    if (!isBirthdayWish(text, cfg)) continue;
    await resolveAliases(msg);
    let outcome = skipReason(msg, cfg, text);
    if (!outcome && !cfg.catchUp.enabled) outcome = 'not answered because catchUp is off';
    if (!outcome) {
      if (catchUpQueued >= cfg.catchUp.maxReplies) {
        outcome = `over catchUp.maxReplies (${cfg.catchUp.maxReplies})`;
        leftOut.push(`${msg.pushName || 'unknown'} (+${senderOf(msg)})`);
      }
      else if (considerMessage(msg, 'history')) {
        catchUpQueued += 1;
        outcome = 'queued for reply';
      } else outcome = 'already queued';
    }
    if (outcome !== 'too old') tally[outcome] = (tally[outcome] || 0) + 1;
    if (!['too old', 'groups disabled', 'queued for reply'].includes(outcome) && !outcome.startsWith('over ')) {
      skipped.push(`  - ${msg.pushName || 'unknown'} (+${senderOf(msg)}): ${outcome} — "${text.slice(0, 60).replace(/\s+/g, ' ')}"`);
    }
  }
  if (leftOut.length) console.log(`[bot] not answered (over catchUp.maxReplies), reply by hand: ${leftOut.join(', ')}`);
  if (quiet) return;
  const details = Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ');
  console.log(`[bot] ${label}: ${messages.length} messages; birthday wishes in it: ${details || 'none to answer'}`);
  if (skipped.length) console.log(`[bot] wishes not answered:\n${skipped.join('\n')}`);
}

// 'notify' = arrived now (including messages queued while offline); 'append' = synced from your phone.
async function handleUpsert(messages, type) {
  for (const msg of messages) {
    noteOutgoing(msg);
    if (type === 'notify') {
      const text = messageText(msg.message);
      if (!msg.key.fromMe && !isJidGroup(msg.key.remoteJid)) rememberIncoming(msg, text);
      if (!msg.key.fromMe && isBirthdayWish(text, getConfig())) await resolveAliases(msg);
      considerMessage(msg, 'live');
    } else if (type === 'append' && !msg.key.fromMe) await scanHistory([msg], { quiet: true });
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
    logger: libLogger,
    // Don't decrypt chats the bot never answers; avoids session errors for groups and status updates.
    shouldIgnoreJid: (jid) =>
      isJidStatusBroadcast(jid) || isJidNewsletter(jid) || (isJidGroup(jid) && !getConfig().replyInGroups),
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
      linkedThisRun = true;
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
      if (cfg.catchUp.enabled && !linkedThisRun) {
        const saved = recentIncoming();
        if (saved.length) {
          scanHistory(saved, { label: 're-checked saved messages' }).catch((err) => console.error('[bot] re-check error:', err));
        } else {
          console.log('[bot] catch-up: WhatsApp only sends older chat history right after linking; re-link to scan earlier chats');
        }
      }
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

  sock.ev.on('messages.upsert', ({ messages, type }) =>
    handleUpsert(messages, type).catch((err) => console.error('[bot] message handler error:', err)),
  );
  sock.ev.on('lid-mapping.update', ({ lid, pn }) => linkAliases(jidNormalizedUser(lid), jidNormalizedUser(pn)));

  sock.ev.on('messaging-history.set', ({ messages }) => {
    if (messages?.length) scanHistory(messages).catch((err) => console.error('[bot] history scan error:', err));
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
