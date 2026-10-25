// Decides whether a message text is a birthday wish.

const PATTERNS = [
  /\bhap+y+\s*b(?:irth)?'?\s*day\b/, // happy birthday, happy bday, happy b'day, hapy bday
  /\bhap+i+est\s*b(?:irth)?'?\s*day\b/, // happiest birthday
  /\bh+a*p*y*\s*b+d+a*y+\b/, // hbday, hpy bday
  /\bh+b+d+\b/, // hbd, hbdd
  /\bhappy\s*born\s*day\b/,
  /\bmany\s+(?:many\s+)?happy\s+returns\b/,
  /\bhappy\s+returns\s+of\s+the\s+day\b/,
  /\b(?:b'?day|birthday)\s+(?:wishes|greetings)\b/,
  /\bwish(?:ing)?\s+you\s+(?:a\s+)?(?:very\s+)?(?:happy|wonderful|great|fantastic|amazing|blessed)\s+(?:b'?day|birthday)\b/,
  /\bhappy\s+(?:\w+\s+)?(?:b'?day|birthday)\b/, // happy 30th birthday, happy belated birthday
  /\bjanam\s*din\s+(?:ki\s+)?(?:bahut\s+)?(?:mubarak|shubhkamnaye|shubhkamnayen|badhai)/,
  /\bjanmdin\s+(?:ki\s+)?(?:mubarak|shubhkamnaye|shubhkamnayen|badhai)/,
  /\bsaal\s*girah\s+mubarak/,
  /\bfeliz\s+(?:cumplea[nñ]os|aniversario)\b/,
  /\bjoyeux\s+anniversaire\b/,
  /\balles\s+gute\s+zum\s+geburtstag\b/,
  /\bbuon\s+compleanno\b/,
  /\bparab[eé]ns\b/,
  /जन्मदिन/,
  /सालगिरह/,
  /பிறந்தநாள்/,
  /పుట్టినరోజు/,
  /ಹುಟ್ಟುಹಬ್ಬ/,
  /ജന്മദിന/,
  /জন্মদিন/,
  /જન્મદિવસ/,
  /वाढदिवस/,
];

// Phrases that contain birthday words but are not wishes to us.
const NEGATIVE_PATTERNS = [
  /\bwhen\s+is\s+(?:your|ur)\s+b(?:irth)?'?day\b/,
  /\bwhat\s+do\s+you\s+want\s+for\s+(?:your|ur)\s+b(?:irth)?'?day\b/,
];

const PARTY_EMOJI = /^[\s🎂🍰🧁🎉🎊🥳🎈🎁✨💐🌹❤️♥️💖💕🙌🏻🏼🏽🏾🏿‍️]+$/u;
const CAKE_OR_PARTY = /[🎂🍰🧁🥳]/u;

export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/(.)\1{2,}/gu, '$1'); // "happyyyy birthdayyy" -> "happy birthday"
}

/**
 * @param {string} text
 * @param {{ extraKeywords?: string[], emojiOnlyCounts?: boolean }} [opts]
 */
export function isBirthdayWish(text, opts = {}) {
  const t = normalize(text);
  if (!t.trim()) return false;
  if (NEGATIVE_PATTERNS.some((re) => re.test(t))) return false;
  if (PATTERNS.some((re) => re.test(t))) return true;
  for (const kw of opts.extraKeywords || []) {
    if (kw && t.includes(normalize(kw))) return true;
  }
  if (opts.emojiOnlyCounts && PARTY_EMOJI.test(t) && CAKE_OR_PARTY.test(t)) return true;
  return false;
}

/** True if the text mentions any of the given names as a whole word. */
export function mentionsName(text, names = []) {
  const t = normalize(text);
  return names.some((n) => {
    if (!n) return false;
    const escaped = normalize(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(t);
  });
}
