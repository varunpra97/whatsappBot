import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBirthdayWish, mentionsName } from '../src/detector.js';
import { inBirthdayWindow, DEFAULTS } from '../src/config.js';
import { fillTemplate } from '../src/bot.js';

const wishes = [
  'Happy Birthday!',
  'happy bday bro 🎉',
  "Happy B'day Varun",
  'HBD',
  'hbd da',
  'Happyyyyyy birthdayyyy',
  'Many many happy returns of the day',
  'Wishing you a very happy birthday!',
  'Happy 30th birthday!!',
  'happiest birthday to you',
  'Janamdin ki bahut shubhkamnaye',
  'जन्मदिन की हार्दिक शुभकामनाएं',
  'Feliz cumpleaños!',
  'happy belated birthday',
];

const notWishes = [
  'hey, are we meeting today?',
  'When is your birthday?',
  'what do you want for your bday',
  'happy new year',
  'Thanks!',
  '',
];

for (const w of wishes) test(`detects: ${w}`, () => assert.equal(isBirthdayWish(w), true));
for (const w of notWishes) test(`ignores: ${JSON.stringify(w)}`, () => assert.equal(isBirthdayWish(w), false));

test('emoji-only wishes when enabled', () => {
  assert.equal(isBirthdayWish('🎂🎉', { emojiOnlyCounts: true }), true);
  assert.equal(isBirthdayWish('🎂🎉', { emojiOnlyCounts: false }), false);
  assert.equal(isBirthdayWish('🎉', { emojiOnlyCounts: true }), false);
});

test('extra keywords', () => {
  assert.equal(isBirthdayWish('pirandhanaal vazhthukkal', { extraKeywords: ['vazhthukkal'] }), true);
});

test('mentionsName matches whole words only', () => {
  assert.equal(mentionsName('Happy birthday Varun!', ['Varun']), true);
  assert.equal(mentionsName('Happy birthday varunika', ['Varun']), false);
});

test('birthday window', () => {
  const cfg = { ...DEFAULTS, birthday: '03-14', activeWindowDays: 1, timezone: 'UTC' };
  assert.equal(inBirthdayWindow(cfg, new Date('2026-03-14T12:00:00Z')), true);
  assert.equal(inBirthdayWindow(cfg, new Date('2026-03-15T12:00:00Z')), true);
  assert.equal(inBirthdayWindow(cfg, new Date('2026-03-17T12:00:00Z')), false);
  const nye = { ...cfg, birthday: '12-31' };
  assert.equal(inBirthdayWindow(nye, new Date('2027-01-01T12:00:00Z')), true);
  const leap = { ...cfg, birthday: '02-29', activeWindowDays: 0 };
  assert.equal(inBirthdayWindow(leap, new Date('2027-02-28T12:00:00Z')), true);
  assert.equal(inBirthdayWindow({ ...cfg, birthday: '' }, new Date()), true);
});

test('fillTemplate', () => {
  assert.equal(fillTemplate('Thanks {name}! {unknown}', { name: 'Asha' }), 'Thanks Asha! {unknown}');
});

const moreWishes = [
  'Janamdin ki hardik shubhkamnaye',
  'जन्मदिवस की हार्दिक शुभकामनाएं',
  'Heartiest congratulations on your birthday',
  'Best wishes on your birthday sir',
  'God bless you on your birthday',
  'Shubh janmdin',
  'Hardik shubhkamnaye',
  'Warm wishes on your special day',
  'Wishing you many more happy years',
];
const moreNonWishes = [
  'Diwali ki hardik shubhkamnaye',
  'hardik shubhkamnaye on your promotion',
  'my son birthday party is tomorrow',
  'Is it your birthday today?',
];
for (const w of moreWishes) test(`detects: ${w}`, () => assert.equal(isBirthdayWish(w), true));
for (const w of moreNonWishes) test(`ignores: ${w}`, () => assert.equal(isBirthdayWish(w), false));
