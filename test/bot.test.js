// Runs the reply pipeline against a fake WhatsApp socket.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wabot-'));
const cfgPath = path.join(dir, 'config.json');
process.env.BOT_CONFIG = cfgPath;
process.env.BOT_DATA_DIR = path.join(dir, 'data');
fs.writeFileSync(path.join(dir, 'thanks.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

let bot;
let sent = [];
const writeConfig = (extra = {}) => {
  fs.writeFileSync(cfgPath, JSON.stringify({ replyDelaySeconds: [0, 0], reaction: '', markAsRead: false, replies: ['Hi {name}'], ...extra }));
  // Config reload is keyed on mtime; make sure each write is seen as a change.
  const t = new Date(Date.now() + Math.random() * 1e6);
  fs.utimesSync(cfgPath, t, t);
};

const fakeSock = {
  user: { id: '15550000000:1@s.whatsapp.net' },
  sendMessage: async (jid, content) => sent.push({ jid, content }),
  readMessages: async () => {},
  presenceSubscribe: async () => {},
  sendPresenceUpdate: async () => {},
};

let n = 0;
const wish = (from, hoursAgo = 0, text = 'Happy birthday!') => ({
  key: { remoteJid: `${from}@s.whatsapp.net`, fromMe: false, id: `m${++n}` },
  message: { conversation: text },
  messageTimestamp: Math.floor((Date.now() - hoursAgo * 3600000) / 1000),
  pushName: 'Asha Rao',
});
const mine = (to, hoursAgo, text = 'thanks!') => ({
  key: { remoteJid: `${to}@s.whatsapp.net`, fromMe: true, id: `m${++n}` },
  message: { conversation: text },
  messageTimestamp: Math.floor((Date.now() - hoursAgo * 3600000) / 1000),
});

before(async () => {
  writeConfig();
  bot = await import('../src/bot.js');
  bot._test.useSocket(fakeSock);
});

test('replies to a live wish with text', async () => {
  sent = [];
  writeConfig();
  await bot._test.upsert([wish('911111111111')], 'notify');
  await bot._test.idle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content.text, 'Hi Asha');
});

test('sends the image with the reply as caption in 1:1 chats', async () => {
  sent = [];
  writeConfig({ replyImage: path.join(dir, 'thanks.jpg') });
  await bot._test.upsert([wish('912222222222')], 'notify');
  await bot._test.idle();
  assert.equal(sent.length, 1);
  assert.ok(Buffer.isBuffer(sent[0].content.image));
  assert.equal(sent[0].content.caption, 'Hi Asha');
});

test('falls back to text when the image file is missing', async () => {
  sent = [];
  writeConfig({ replyImage: path.join(dir, 'missing.jpg') });
  await bot._test.upsert([wish('913333333333')], 'notify');
  await bot._test.idle();
  assert.equal(sent[0].content.text, 'Hi Asha');
});

test('ignores old wishes from history unless catch-up is on', async () => {
  sent = [];
  writeConfig();
  await bot._test.history([wish('914444444444', 40)]);
  await bot._test.idle();
  assert.equal(sent.length, 0);

  writeConfig({ catchUp: { enabled: true, lookbackHours: 72 } });
  await bot._test.history([wish('914444444444', 40)]);
  await bot._test.idle();
  assert.equal(sent.length, 1);
});

test('catch-up skips wishes you already answered and ones outside the lookback', async () => {
  sent = [];
  writeConfig({ catchUp: { enabled: true, lookbackHours: 72 } });
  await bot._test.history([
    wish('915555555555', 30),
    mine('915555555555', 29), // answered by hand
    wish('916666666666', 100), // too old
    wish('917777777777', 10, 'see you tomorrow'), // not a wish
  ]);
  await bot._test.idle();
  assert.equal(sent.length, 0);
});

test('catch-up respects maxReplies', async () => {
  sent = [];
  writeConfig({ catchUp: { enabled: true, lookbackHours: 72, maxReplies: 0 } });
  await bot._test.history([wish('918888888888', 5)]);
  await bot._test.idle();
  assert.equal(sent.length, 0);
});

test('a burst of wishes from one person gets one reply', async () => {
  sent = [];
  writeConfig();
  await bot._test.upsert([wish('919999999999'), wish('919999999999', 0, 'HBD!!')], 'notify');
  await bot._test.idle();
  assert.equal(sent.length, 1);
});

test('onlyTodaysWishes skips wishes from yesterday', async () => {
  sent = [];
  writeConfig({ onlyTodaysWishes: true, timezone: 'UTC', catchUp: { enabled: true, lookbackHours: 72 } });
  const now = new Date();
  const hoursSinceMidnight = now.getUTCHours() + now.getUTCMinutes() / 60;
  await bot._test.history([wish('920000000001', hoursSinceMidnight + 1)]); // yesterday
  await bot._test.idle();
  assert.equal(sent.length, 0);
  await bot._test.history([wish('920000000002', hoursSinceMidnight / 2)]); // earlier today
  await bot._test.idle();
  assert.equal(sent.length, 1);
});

test('matches onlyNumbers for chats addressed by @lid', async () => {
  sent = [];
  writeConfig({ onlyNumbers: ['919000000001'] });
  const msg = wish('x');
  msg.key.remoteJid = '123456789012345@lid';
  msg.key.remoteJidAlt = '919000000001@s.whatsapp.net';
  await bot._test.upsert([msg], 'notify');
  await bot._test.idle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].jid, '123456789012345@lid');
});

test('a manual reply under the phone-number address counts for the @lid chat', async () => {
  sent = [];
  writeConfig({ catchUp: { enabled: true, lookbackHours: 72 } });
  const msg = wish('x', 3);
  msg.key.remoteJid = '223456789012345@lid';
  msg.key.remoteJidAlt = '919000000002@s.whatsapp.net';
  await bot._test.history([msg, mine('919000000002', 2)]);
  await bot._test.idle();
  assert.equal(sent.length, 0);
});

test('no second reply when the same person shows up under @lid and phone number', async () => {
  sent = [];
  writeConfig();
  const lid = '333456789012345@lid';
  const pn = '919000000003@s.whatsapp.net';
  fakeSock.signalRepository = {
    lidMapping: {
      getPNForLID: async (j) => (j === lid ? pn : null),
      getLIDForPN: async (j) => (j === pn ? lid : null),
    },
  };
  const first = wish('x', 0.5);
  first.key.remoteJid = lid; // e.g. from chat history
  await bot._test.upsert([first], 'notify');
  await bot._test.idle();
  assert.equal(sent.length, 1);

  const second = wish('919000000003', 0, 'Happy bday!'); // later, addressed by phone number
  await bot._test.upsert([second], 'notify');
  await bot._test.idle();
  assert.equal(sent.length, 1);
  delete fakeSock.signalRepository;
});
