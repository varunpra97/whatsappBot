import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const STATE_PATH = path.join(DATA_DIR, 'state.json');
const MAX_LOG = 200;

let state = { replied: {}, lastOutgoing: {}, log: [], totalReplies: 0 };
let saveTimer = null;

export function loadState() {
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) };
  } catch {
    // first run
  }
  return state;
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}

export function alreadyRepliedToday(chatJid, today) {
  return state.replied[chatJid] === today;
}

export function recordReply({ chatJids, today, name, text, reply, isGroup }) {
  for (const jid of chatJids) state.replied[jid] = today;
  state.totalReplies += 1;
  state.log.unshift({ at: new Date().toISOString(), chat: chatJids[0], name, text, reply, isGroup });
  state.log.length = Math.min(state.log.length, MAX_LOG);
  // Drop dedupe entries from previous days so the file stays small.
  for (const [jid, day] of Object.entries(state.replied)) if (day !== today) delete state.replied[jid];
  save();
}

/** Timestamp (ms) of the last message you sent in a chat, or 0. */
export function lastOutgoing(chatJid) {
  return state.lastOutgoing[chatJid] || 0;
}

export function recordOutgoing(chatJid, ts) {
  if (!ts || ts <= lastOutgoing(chatJid)) return;
  state.lastOutgoing[chatJid] = ts;
  // History sync can report thousands of messages; batch the disk writes.
  if (!saveTimer) {
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const cutoff = Date.now() - 30 * 86400000;
      for (const [jid, t] of Object.entries(state.lastOutgoing)) if (t < cutoff) delete state.lastOutgoing[jid];
      save();
    }, 5000);
    saveTimer.unref?.();
  }
}

export function getState() {
  return state;
}
