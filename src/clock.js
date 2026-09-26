// ─────────────────────────────────────────────────────────────────────────
// Tehran clock rendered in the business account NAME.
//
// On a cron trigger (every minute) instead of an always-on process — this is one
// of the things a long-polling bot gets for free and a Worker has to schedule.
//
// Time is ALWAYS computed from UTC. Adding +03:30 to a local clock double-counts
// on a device already set to Tehran time and puts the clock 3h30m out.
// ─────────────────────────────────────────────────────────────────────────

const TEHRAN_OFFSET_MIN = 210; // +03:30, fixed — Iran has no DST

/** Tehran wall-clock as {y,m,d,H,M} derived from the epoch. */
export function tehranParts(ms = Date.now()) {
  const t = new Date(ms + TEHRAN_OFFSET_MIN * 60_000);
  return {
    y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(),
    H: t.getUTCHours(), M: t.getUTCMinutes(),
  };
}

export function tehranISO(ms = Date.now()) {
  const p = tehranParts(ms);
  const z = (n) => String(n).padStart(2, "0");
  return `${p.y}-${z(p.m)}-${z(p.d)} ${z(p.H)}:${z(p.M)}`;
}

// 11 digit fonts, all valid Unicode that Telegram renders.
const FONTS = {
  mono:    "𝟎𝟏𝟐𝟑𝟒𝟓𝟔𝟕𝟖𝟗",
  sans:    "⓪➊➋➌➍➎➏➐➑",
  serif:   "⁰¹²³⁴⁵⁶⁷⁸⁹",
  double:  "⓪①②③④⑤⑥⑦⑧⑨",
  circled: "⓪①②③④⑤⑥⑦⑧⑨",
  bold:    "❶❷❸❹❺❻❼❽❾❿",
  hex:     "０１２３４５６７８９",
  boxed:   "⓪⑪⑫⑬⑭⑮⑯⑰⑱⑲",    // ⓪ is the 0 glyph; ⑪-⑲ are the circled tens
  dots:    "٠١٢٣٤٥٦٧٨٩",
  persian: "۰۱۲۳۴۵۶۷۸۹",
  fancy:   "ⓐⓑⓒⓓⓔⓕⓖⓗⓘⓙ",    // letters, for looks — 10+ renders ASCII
};
export const FONT_NAMES = Object.keys(FONTS);

export function styleDigits(text, font) {
  const raw = FONTS[font];
  if (!raw) return String(text);
  // Array.from iterates CODE POINTS. A plain string index would split surrogate
  // pairs (𝟎, ①, 𝟚 are two UTF-16 units each) and emit garbage.
  const table = Array.from(raw);
  let out = "";
  for (const ch of Array.from(String(text))) {
    if (ch >= "0" && ch <= "9") {
      const d = Number(ch);
      if (d < table.length) out += table[d];
      else out += ch;                     // never drop a digit
    } else {
      out += ch;
    }
  }
  return out;
}

/** 24-hour clock, e.g. "20:37" (no AM/PM). */
export function clockPreview(font, ms = Date.now()) {
  const { H, M } = tehranParts(ms);
  const z = (n) => String(n).padStart(2, "0");
  return `${styleDigits(z(H), font)}:${styleDigits(z(M), font)}`;
}

// A clock tail is "<sep><hour>:<min>" at the end. Matching on SHAPE, not on \d,
// is essential: the sans (➋➊) and superscript (²¹) fonts contain no ASCII digits,
// so a digit-based pattern silently fails and the clock gets stuck on the name.
//
// The bounds are in UTF-16 code units: astral glyphs (𝟐, ①) are 2 units each, so
// a 2-glyph hour needs up to 4 and a 2-glyph minute up to 4.
// (no regex width guessing — see stripClock below)

export function stripClock(name) {
  let s = String(name ?? "").trim();
  // Loops so several stacked clocks are fully removed. The tail after the last
  // separator must look like a clock (1-3 glyphs, colon, 2 glyphs) — checked by
  // CODE POINT, so astral digits (𝟐, ①) count as one character each.
  for (let i = 0; i < 4; i++) {
    const sep = Math.max(s.lastIndexOf("·"), s.lastIndexOf("|"));
    if (sep < 0) break;
    const tail = s.slice(sep + 1).trim();
    const parts = Array.from(tail);
    const colon = parts.indexOf(":");
    if (colon < 1 || parts.length - colon - 1 !== 2) break;   // not a clock
    s = s.slice(0, sep).replace(/[·|\s]+$/, "");
  }
  return s;
}

export const CLOCK_MAX_NAME = 64;

export function buildClockName(baseFirst, font) {
  const clock = clockPreview(font);
  const clean = stripClock(baseFirst);
  return `${clean ? clean + " · " + clock : clock}`.slice(0, CLOCK_MAX_NAME);
}
