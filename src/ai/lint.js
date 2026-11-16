// Deterministic content checks. These are pattern heuristics, not a spam-filter
// simulation: they flag wording known to correlate with filtering and low replies.
const SPAM_PHRASES = ['act now', 'limited time', 'risk-free', 'risk free', '100% free', 'guarantee', 'guaranteed', 'no obligation', 'click here', 'click below',
  'buy now', 'order now', 'special promotion', 'winner', 'congratulations', 'cash bonus', 'earn money', 'extra income', 'double your', 'million dollars',
  'no cost', 'free trial', 'free gift', 'lowest price', 'best price', 'urgent', 'once in a lifetime', 'apply now', 'call now', 'cheap', 'discount',
  'incredible deal', 'this is not spam', 'dear friend', 'increase sales', 'make money', 'no strings attached', 'while supplies last', 'exclusive deal'];
const GENERIC_PHRASES = ['i hope this email finds you well', 'hope you are doing well', 'hope this finds you well', 'my name is', 'i wanted to reach out',
  'i am reaching out', "i'm reaching out", 'just following up', 'just checking in', 'touching base', 'circle back', 'quick question', 'i came across your profile',
  'i came across your company', 'we are a leading', 'we are the leading', 'industry-leading', 'cutting-edge', 'best-in-class', 'world-class', 'synergy',
  'revolutionary', 'game-changing', 'game changer', 'i know you are busy', "i know you're busy", 'to whom it may concern', 'dear sir', 'bumping this'];
const CLAIM_PATTERNS = [
  [/\b\d{1,4}(\.\d+)?(%|\s?percent\b|x\b)/gi, 'numeric performance claim'],
  [/[$€£]\s?\d[\d,.]*\s?(k|m|bn|million|billion)?\b/gi, 'monetary figure'],
  [/\b(#1|number one|no\.? ?1|the best|the leading|the only|fastest|most trusted)\b/gi, 'superlative claim'],
  [/\b(we|i) (helped|worked with|work with|partnered with)\s+[A-Z][\w&]+/g, 'named customer claim'],
  [/\b(congrats|congratulations) on\b/gi, 'claim about the recipient'],
  [/\b(saw|noticed|read|loved) (that )?(you|your)\b/gi, 'claim about the recipient'],
];
export const VAR_RE = /\{\{\s*([a-zA-Z_][\w.]*)\s*(?:\|([^}]*))?\}\}/g;
const COND_RE = /\{\{\s*#if\s+([a-zA-Z_][\w.]*)\s*\}\}/g;

/** All variables referenced, with whether each use is guarded by a fallback or an #if block. */
export function extractVariables(template) {
  const guarded = new Set([...String(template).matchAll(COND_RE)].map((m) => m[1]));
  const out = new Map();
  for (const m of String(template).matchAll(VAR_RE)) {
    const hasFallback = m[2] !== undefined || guarded.has(m[1]);
    out.set(m[1], (out.get(m[1]) ?? true) && hasFallback);
  }
  for (const g of guarded) if (!out.has(g)) out.set(g, true);
  return [...out].map(([name, hasFallback]) => ({ name, hasFallback }));
}

export function lintEmail({ subject = '', body = '' }, knownVariables = null) {
  const issues = [];
  const add = (severity, code, message, evidence) => issues.push({ severity, code, message, evidence });
  const text = `${subject}\n${body}`;
  const lower = text.toLowerCase();
  const plain = body.replace(/\{\{[^}]*\}\}/g, 'x');
  const words = plain.trim().split(/\s+/).filter(Boolean).length;

  for (const p of SPAM_PHRASES) if (new RegExp(`(^|[^a-z])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i').test(lower)) add('warn', 'spam_phrase', `Spam-associated phrase "${p}"`, p);
  for (const p of GENERIC_PHRASES) if (lower.includes(p)) add('info', 'generic', `Generic opener/filler "${p}" reads as templated`, p);
  for (const [re, label] of CLAIM_PATTERNS) for (const m of text.matchAll(re)) add('warn', 'unsupported_claim', `Possible unsupported claim (${label}): confirm you can evidence this`, m[0]);
  if (/[A-Z]{2,}(\s+[A-Z]{2,}){2,}/.test(text.replace(/\{\{[^}]*\}\}/g, ''))) add('warn', 'caps', 'Several consecutive words in ALL CAPS');
  if ((text.match(/!/g) || []).length > 1) add('warn', 'exclamation', 'More than one exclamation mark');
  if (/[$€£]{2,}|\?{2,}|!{2,}/.test(text)) add('warn', 'punctuation', 'Repeated punctuation or currency symbols');
  const links = body.match(/https?:\/\/\S+/gi) || [];
  if (links.length > 1) add('warn', 'links', `${links.length} links: cold emails with more than one link are filtered more often`);
  if (links.some((l) => /bit\.ly|tinyurl|t\.co\/|goo\.gl|ow\.ly|rebrand\.ly/i.test(l))) add('error', 'shortener', 'URL shorteners are heavily associated with spam; use the full URL');
  if (/<\s*(img|table|style|script)\b/i.test(body)) add('warn', 'html', 'HTML markup detected: plain text performs better for cold outreach');
  if (subject.length > 60) add('info', 'subject_length', `Subject is ${subject.length} characters; under 60 avoids truncation`);
  if (subject && subject === subject.toUpperCase() && /[A-Z]{4}/.test(subject)) add('warn', 'subject_caps', 'Subject is all caps');
  if (/^\s*(re|fwd?):/i.test(subject)) add('error', 'fake_reply', 'Subject fakes a reply/forward thread ("Re:"/"Fwd:"), which is deceptive and violates CAN-SPAM');
  if (words > 150) add('info', 'length', `Body is ${words} words; cold emails under ~120 words get more replies`);
  if (words && words < 15) add('info', 'length', `Body is only ${words} words`);
  if (!/\?/.test(body) && words) add('info', 'no_question', 'No question or clear call to action found');

  const vars = extractVariables(text);
  for (const v of vars) {
    if (knownVariables && !knownVariables.includes(v.name)) add('error', 'unknown_variable', `Unknown variable {{${v.name}}}: no lead field or sender field has this name`, v.name);
  }
  if (/\{\{[^}]*$|\{[^{}]+\}(?!\})|\[\[?[A-Za-z _]+\]?\]|<[A-Z_ ]{3,}>/m.test(text.replace(/\{\{[^}]*\}\}/g, ''))) add('error', 'broken_placeholder', 'Unresolved or malformed placeholder (e.g. {name}, [First Name])');

  const score = Math.min(100, issues.reduce((s, i) => s + ({ error: 30, warn: 12, info: 3 }[i.severity]), 0));
  return { issues, score, words, variables: vars, verdict: issues.some((i) => i.severity === 'error') ? 'blocked' : score >= 40 ? 'needs_review' : 'ok',
    note: 'Heuristic pattern checks only. Passing them does not predict inbox placement.' };
}
