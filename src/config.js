import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const CONFIG_PATH = process.env.BOT_CONFIG || path.join(ROOT, 'config.json');
export const DATA_DIR = process.env.BOT_DATA_DIR || path.join(ROOT, 'data');
export const AUTH_DIR = process.env.BOT_AUTH_DIR || path.join(ROOT, 'auth');

export const DEFAULTS = {
  enabled: true,
  myNames: [],
  birthday: '',
  activeWindowDays: 2,
  timezone: 'UTC',
  replyInPrivate: true,
  replyInGroups: true,
  groupRequireMention: true,
  oncePerChatPerDay: true,
  replyDelaySeconds: [5, 30],
  maxMessageAgeHours: 24,
  markAsRead: true,
  reaction: '❤️',
  emojiOnlyCounts: true,
  extraKeywords: [],
  ignoreNumbers: [],
  onlyNumbers: [],
  replies: [
    'Thank you so much {name}! 😊🎉',
    'Thanks a lot {name}! Means a lot 🙏❤️',
    'Thank you {name}! 🥳 Really appreciate the wishes!',
  ],
  groupReplies: ['Thank you {name}! 😊🎂'],
  pairingPhoneNumber: '',
  web: { enabled: true, host: '127.0.0.1', port: 3000, password: '' },
};

let cached = null;
let cachedMtime = 0;

function merge(raw) {
  return { ...DEFAULTS, ...raw, web: { ...DEFAULTS.web, ...(raw.web || {}) } };
}

export function validate(cfg) {
  const errors = [];
  if (cfg.birthday && !/^\d{2}-\d{2}$/.test(cfg.birthday)) errors.push('birthday must be "MM-DD" or empty');
  if (!Array.isArray(cfg.replies) || cfg.replies.length === 0) errors.push('replies must be a non-empty array');
  if (!Array.isArray(cfg.replyDelaySeconds) || cfg.replyDelaySeconds.length !== 2) {
    errors.push('replyDelaySeconds must be [min, max]');
  }
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone });
  } catch {
    errors.push(`unknown timezone "${cfg.timezone}"`);
  }
  return errors;
}

/** Returns the current config, re-reading config.json when it changes on disk. */
export function getConfig() {
  let mtime = 0;
  try {
    mtime = fs.statSync(CONFIG_PATH).mtimeMs;
  } catch {
    if (!cached) cached = merge({});
    return cached;
  }
  if (!cached || mtime !== cachedMtime) {
    try {
      const next = merge(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
      const errors = validate(next);
      if (errors.length) throw new Error(errors.join('; '));
      cached = next;
    } catch (err) {
      console.error(`[config] ignoring invalid ${CONFIG_PATH}: ${err.message}`);
      if (!cached) cached = merge({});
    }
    cachedMtime = mtime;
  }
  return cached;
}

export function readRawConfig() {
  try {
    return fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    return JSON.stringify(DEFAULTS, null, 2);
  }
}

/** Validates and writes new config JSON text. Throws on invalid input. */
export function writeRawConfig(text) {
  const parsed = JSON.parse(text);
  const errors = validate(merge(parsed));
  if (errors.length) throw new Error(errors.join('; '));
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(parsed, null, 2) + '\n');
}

/** Today's date as YYYY-MM-DD in the given timezone. */
export function todayIn(timezone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Whether `now` is within ±windowDays of the MM-DD birthday (in the timezone). Empty birthday = always. */
export function inBirthdayWindow(cfg, now = new Date()) {
  if (!cfg.birthday) return true;
  const [y, m, d] = todayIn(cfg.timezone, now).split('-').map(Number);
  const [bm, bd] = cfg.birthday.split('-').map(Number);
  const today = Date.UTC(y, m - 1, d);
  const DAY = 86400000;
  return [y - 1, y, y + 1].some((year) => {
    // Feb 29 birthdays fall back to Feb 28 in non-leap years.
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const day = bm === 2 && bd === 29 && !leap ? 28 : bd;
    return Math.abs(today - Date.UTC(year, bm - 1, day)) / DAY <= cfg.activeWindowDays;
  });
}
