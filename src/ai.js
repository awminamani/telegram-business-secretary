// ─────────────────────────────────────────────────────────────────────────
// OpenRouter chat layer (optional — the bot is fully usable without a key).
//
// Hard rule from the field: a stray "_" or "*" in LLM output makes Telegram
// reject the WHOLE message, silently losing the reply. The caller must always
// route text through sendMessage()'s parse-error fallback, or send plain.
// ─────────────────────────────────────────────────────────────────────────

export function aiReady(env) {
  return Boolean(env.OPENROUTER_API_KEY && env.AI_MODEL);
}

const DEAD = new Set([400, 401, 402, 403, 404]);

export async function aiReply(env, { system, history = [], text }) {
  if (!aiReady(env)) return null;

  const messages = [
    { role: "system", content: system || env.PERSONA || "You are a helpful assistant." },
    ...history,
    { role: "user", content: text },
  ];
  const models = [env.AI_MODEL, env.FALLBACK_MODEL].filter(Boolean);

  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      // finish_reason "length" means truncation -> retry with a bigger budget
      const budget = Number(env.MAX_TOKENS || 600) * (attempt === 1 ? 2 : 1);
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 25000);
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          },
          body: JSON.stringify({ model: model, messages, max_tokens: budget, temperature: 0.7 }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);

        if (res.status === 429) {
          await sleep(600 * (attempt + 1));
          continue;
        }
        if (DEAD.has(res.status)) break;      // dead slug -> next model
        if (!res.ok) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        const data = await res.json();
        const choice = data?.choices?.[0];
        if (!choice || choice.finish_reason === "length") continue;
        const out = String(choice.message?.content || "").trim();
        if (!out) continue;                    // empty is a real free-tier failure
        return clean(out);
      } catch {
        await sleep(500 * (attempt + 1));
      }
    }
  }
  return null;
}

const THINK = /<think>[\s\S]*?<\/think>/gi;
const OPEN_THINK = /^\s*<think>[\s\S]*/i;
const SAFETY = /^\s*(user safety|response safety)\s*:\s*safe\s*/i;

export function clean(t) {
  if (!t) return "";
  return String(t)
    .replace(THINK, "")
    .replace(OPEN_THINK, "")
    .replace(SAFETY, "")
    .replace(/```text/g, "```")
    .trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
