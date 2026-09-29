// Find identifiers that are CALLED but never declared — the class of bug where
// `log.info(...)` sits in a module that only has `console`, which passes
// --check and every unit test, then throws ReferenceError on the first real
// request. Only CODE is scanned: string and comment contents are stripped first.
import { readFileSync } from "node:fs";

const files = process.argv.slice(2);
const GLOBALS = new Set(`
console crypto fetch URL URLSearchParams TextEncoder TextDecoder AbortController
setTimeout clearTimeout setInterval clearInterval Response Request Headers
FormData Blob structuredClone performance Date Math JSON Object Array String
Number Boolean Error Promise Map Set RegExp isNaN parseInt Intl globalThis
process Buffer parseFloat parseInt isFinite isInteger encodeURIComponent
decodeURIComponent`.trim().split(/\s+/));

const KEYWORDS = new Set(`
function if for while switch catch return typeof await new delete void do else
try case throw yield import export from default async class extends super
constructor get set static of in instanceof`.trim().split(/\s+/));

let bad = 0;

for (const f of files) {
  let src = readFileSync(f, "utf8");
  // strip comments and string/template literals so prose can't trigger a hit
  src = src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/`(?:\\.|[^`\\])*`/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, '""');

  const declared = new Set();
  for (const m of src.matchAll(/(?:^|[\s;{(])(?:export\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    declared.add(m[1]);
  }
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(",")) {
      const n = part.split(":").pop().split("=")[0].trim();
      if (n) declared.add(n);
    }
  }
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(",")) {
      const n = part.split(/\s+as\s+/).pop().trim();
      if (n) declared.add(n);
    }
  }
  for (const m of src.matchAll(/(?:^|[\s;{(])(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) {
    declared.add(m[1]);
  }
  // named function params & arrow params, per function-ish scope (cheap: whole file)
  for (const m of src.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const part of m[1].split(",")) {
      const n = part.split(/[:=]/)[0].trim().replace(/^\.\.\./, "");
      if (/^[A-Za-z_$][\w$]*$/.test(n)) declared.add(n);
    }
  }
  for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function[^\n(]*|\([^\n)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)\s*\{/g)) {
    void m;
  }
  for (const m of src.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of src.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);

  for (const m of src.matchAll(/(?<![.\w$])([a-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (KEYWORDS.has(name) || declared.has(name) || GLOBALS.has(name)) continue;
    // object-literal / class method keys: preceded by `name(` inside a body,
    // not by an identifier — ignore when it is a known handler name
    if (["scheduled", "fetch", "then", "catch"].includes(name)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    console.log(`  ❌ ${f}:${line}  ${name}() is never defined`);
    bad++;
  }
}
console.log(bad ? `\n${bad} undefined reference(s)` : "\n✅ no undefined references");
process.exit(bad ? 1 : 0);
