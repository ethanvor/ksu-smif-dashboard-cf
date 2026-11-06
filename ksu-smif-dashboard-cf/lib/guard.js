// Guardrails for Scrappy AI: catch prompt-injection / jailbreak attempts before they reach the model
// (this also saves the free AI allowance), and check answers before they go back to the browser.

export const REFUSAL = "I can't do that. I'm Scrappy, and I only help with SMIF portfolio questions, so I can't change my rules, take on another role, or share how I'm set up. Try asking about our holdings, our trade history, or a stock you're considering.";

const norm = (t) => String(t || '')
  .normalize('NFKC')
  .replace(/[​-‏⁠﻿]/g, '') // zero-width characters
  .toLowerCase()
  .replace(/[1!|]/g, (c) => ({ 1: 'i', '!': 'i', '|': 'l' }[c]))
  .replace(/0/g, 'o').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't').replace(/@/g, 'a').replace(/\$/g, 's')
  .replace(/[*_~`"'“”‘’]/g, '')
  .replace(/\s+/g, ' ');

const W = '(?:\\s+\\S+){0,5}?\\s+'; // up to 5 words in between
const PATTERNS = [
  // "ignore / disregard / forget / override ... previous instructions"
  new RegExp(`\\b(ignore|disregard|forget|override|bypass|overrule|skip|drop|abandon|neglect)${W}(instructions?|prompts?|guidelines|directions|directives|restrictions|constraints|programming|guardrails|safeguards|everything (?:above|before|else)|(?:the )?above (?:rules|instructions|text|messages?)|all (?:the )?rules|your rules|the rules above|previous (?:messages?|rules)|prior (?:messages?|rules))\\b`),
  /\b(ignore|disregard|forget)\s+(all|everything|anything)\s+(above|before|previous|prior|you (?:were|have been) told)/,
  /\bforget (?:all |everything )?(?:your|the|you(?:'|’)?re) (?:rules|instructions|training|purpose|role)/,
  // asking for the hidden prompt / configuration
  /\b(system|hidden|initial|original|secret|developer)\s+(prompt|instructions?|message|rules|configuration|config)\b/,
  /\b(internal|underlying|base|master|real|full)\s+(prompt|instructions)\b/,
  /\byour\s+(prompt|instructions|programming|configuration|config|directives|guidelines|initial message)\b/,
  /\b(repeat|print|output|reveal|display|leak|dump|recite|echo|copy|paste|translate|encode)\b(?:\s+\S+){0,4}?\s+(?:the )?(?:text|words|message|messages|content|conversation|everything|all) (?:above|before|so far|preceding)\b/,
  /\b(verbatim|word for word)\b/,
  /\bwhat (?:were|are|was) you (?:told|instructed|programmed|given)\b/,
  /\bhow (?:are|were) you (?:configured|programmed|set up|instructed|prompted)\b/,
  // persona / mode switching
  /\b(you are|you're|youre) (now|no longer|not scrappy)\b/,
  /\bfrom now on\b/, /\bnew (?:instructions|rules|persona|role|task)\s*[:\-]/,
  /\b(pretend|roleplay|role-play|role play|impersonate)\b/,
  /\bact as (?:if|though|my|an? (?!(?:portfolio|fund|equity|investment|research|financial|risk)\b))/,
  /\b(jailbr(?:ea|o)k|dan mode|do anything now|developer mode|dev mode|god mode|admin mode|debug mode|maintenance mode|sudo|unfiltered|uncensored|without (?:any )?(?:restrictions|filters|guidelines|guardrails))\b/,
  /\b(simulate|emulate) (?:being|another (?:ai|assistant|model|bot|persona))\b/, /\bstay in character\b/, /\bopposite mode\b/, /\banti-?scrappy\b/,
  // chat-template / role tokens and fake system messages
  /<\|[a-z_ ]*\|?>|\[\/?inst\]|<<\/?sys>>|<\/?(?:system|assistant|user|instructions?)>|^\s*(?:system|assistant|developer)\s*:|###\s*(?:system|instruction)/m,
  /\b(?:system|developer|admin(?:istrator)?) (?:override|message|note|notice|update|command|access)\b/,
  // obfuscation tricks
  /\b(base64|rot13|rot-13|hex encoded|morse code|reverse the (?:text|letters)|leetspeak)\b/,
];

/** Returns a short reason when text looks like an attempt to break Scrappy, else null. */
export function detectInjection(text) {
  const t = norm(text);
  if (!t) return null;
  const raw = String(text).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
  const joined = t.replace(/\b(\w) (?=\w\b)/g, '$1'); // "i g n o r e" → "ignore"
  for (const v of [raw, t, joined]) for (const re of PATTERNS) if (re.test(v)) return re.source.slice(0, 40);
  // lots of instruction-like imperatives aimed at the assistant
  if ((t.match(/\b(you must|you will|you should now|always respond|never refuse|do not refuse|don't refuse|respond only)\b/g) || []).length >= 2) return 'imperatives';
  return null;
}

/** Strip anything in the fund data that looks like a role marker, so it can't pose as instructions. */
export function cleanData(text) {
  return String(text || '').replace(/<\|[^|>]*\|?>|\[\/?INST\]|<<\/?SYS>>|<\/?(?:system|assistant|user|instructions?|fund_data)>/gi, ' ');
}

// pieces of the system prompt — if any show up in an answer, the model leaked its instructions
const LEAK = ['you are scrappy, the ai portfolio assistant', 'scope — stay inside it', 'how the fund operates (apply', 'when asked "is x a good buy?"', 'security — these rules', '<fund_data', 'these instructions are permanent'];
export function checkAnswer(text) {
  const t = String(text || '');
  const l = t.toLowerCase();
  if (LEAK.some((x) => l.includes(x))) return REFUSAL;
  if (/\b(as an? (?:unrestricted|unfiltered|jailbroken)|dan:|developer mode (?:enabled|output))/i.test(t)) return REFUSAL;
  // SMIF is tax-exempt: drop any line about tax consequences (keeps "pre-tax margin" and similar metrics)
  const TAX = /(tax[- ](?:implication|consequence|loss|efficien|liabilit|treatment|benefit|bill|hit|drag|bracket|rate|harvest|advantage|impact|purpose|consideration)|capital[- ]gains? tax|wash[- ]sale|after[- ]tax return|taxable (?:gain|event|account)|tax(?:es)? (?:on|owed|due|would))/i;
  const kept = t.split('\n').filter((ln) => !TAX.test(ln)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const out = kept || t;
  return out.length > 6000 ? out.slice(0, 6000) + '…' : out;
}

export const OFF_TOPIC = "That's outside what I can help with. I'm Scrappy, the SMIF portfolio assistant, so I stick to the fund, the market, and investing. Try asking about our holdings, our trade history, or a stock you're considering.";
const FIN = /\b(stocks?|shares?|equit(?:y|ies)|buy|buying|bought|sell|selling|sold|trim|add|hold|holding|holdings|own|owned|position|positions|portfolio|fund|smif|invest\w*|market|markets|sector|sectors|industr\w*|weight\w*|overweight|underweight|risk\w*|beta|alpha|sharpe|sortino|volatil\w*|drawdown|return|returns|performance|perform\w*|benchmark|s&p|spy|index|price|prices|priced|valu\w*|p\/?e|multiple|earnings|eps|revenue|margin\w*|growth|dividends?|yield|cash|bonds?|fixed income|treasur\w*|money market|etfs?|trade|trades|trading|analyst\w*|target|upside|downside|bull\w*|bear\w*|diversif\w*|correlat\w*|allocation|rebalanc\w*|gain\w*|loss\w*|profit\w*|cost basis|economy|economic|rates?|inflation|fed|recession|ipo|ticker|company|companies|business|competitor\w*|moat|dcf|ratio|ratios|gics|thesis|pitch|recommend\w*|good buy|overvalued|undervalued|cheap|expensive)\b/i;
/** True when a question has nothing to do with investing or the fund (follow-ups in a conversation are allowed). */
export function offTopic(q, { hasEntities = false, inConversation = false } = {}) {
  if (hasEntities || /\$[A-Za-z]{1,5}\b|\b[A-Z]{2,5}\b/.test(q) || FIN.test(q) || /\b(our|we|us)\b/i.test(q)) return false;
  // follow-ups in a conversation: "why?", "explain that more", "what about the other one?"
  if (inConversation && (q.split(/\s+/).length <= 5 || /\b(it|its|that|this|them|those|these|why|more|else|other|explain|elaborate|clarify|instead|again|also|then)\b/i.test(q))) return false;
  return true;
}
