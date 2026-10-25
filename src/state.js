import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const STATE_PATH = path.join(DATA_DIR, 'state.json');
const MAX_LOG = 200;

let state = { replied: {}, log: [], totalReplies: 0 };

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

export function recordReply({ chatJid, today, name, text, reply, isGroup }) {
  state.replied[chatJid] = today;
  state.totalReplies += 1;
  state.log.unshift({ at: new Date().toISOString(), chat: chatJid, name, text, reply, isGroup });
  state.log.length = Math.min(state.log.length, MAX_LOG);
  // Drop dedupe entries from previous days so the file stays small.
  for (const [jid, day] of Object.entries(state.replied)) if (day !== today) delete state.replied[jid];
  save();
}

export function getState() {
  return state;
}
