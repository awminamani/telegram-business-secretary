// ─────────────────────────────────────────────────────────────────────────
// Telegram Bot API client + the webhook security layer.
//
// SECURITY MODEL (defence in depth — any single layer alone is weak):
//   1. secret_token   — Telegram sends X-Telegram-Bot-Api-Secret-Token on every
//                       request. Constant-time compare. Without it, anyone who
//                       learns your Worker URL can inject fake updates.
//   2. method allowlist— only POST is accepted for updates, so a crafted GET
//                       can't be used as a probe.
//   3. body size cap  — reject absurd payloads before parsing.
//   4. rate limiting  — per-actor, D1-backed, so it holds across isolates.
//   5. idempotency    — Telegram re-delivers on slow/non-2xx replies; the
//                       processed_updates table makes handling exactly-once.
// ─────────────────────────────────────────────────────────────────────────

const API = "https://api.telegram.org";

// Telegram's allowed alphabet for secret_token: A-Z a-z 0-9 _ -
const SECRET_RE = /^[A-Za-z0-9_-]{1,256}$/;

export function makeTelegram(token) {
  const base = `${API}/bot${token}`;

  async function call(method, payload = {}, { retries = 2, timeoutMs = 12000 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(`${base}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (data.ok) return data.result;

        const desc = String(data.description || "");
        // 429: respect retry_after instead of hammering
        if (res.status === 429 && attempt < retries) {
          const wait = Math.min(Number(data.parameters?.retry_after || 2), 30) * 1000;
          await sleep(wait);
          continue;
        }
        // 5xx: worth one retry; 4xx will not fix itself
        if (res.status >= 500 && attempt < retries) {
          await sleep(400 * (attempt + 1));
          continue;
        }
        const err = new Error(desc || `Telegram ${method} failed (${res.status})`);
        err.status = res.status;
        err.description = desc;
        throw err;
      } catch (e) {
        if (e.name === "AbortError" && attempt < retries) {
          await sleep(400 * (attempt + 1));
          continue;
        }
        if (attempt < retries) {
          await sleep(400 * (attempt + 1));
          continue;
        }
        throw e;
      } finally {
        clearTimeout(t);
      }
    }
  }

  const api = {
    call,
    getMe: () => call("getMe"),

    // webhook registration — secret_token is what makes the endpoint private
    setWebhook: (url, secret, opts = {}) =>
      call("setWebhook", {
        url,
        secret_token: secret,
        allowed_updates: opts.allowedUpdates || [
          "message", "edited_message", "callback_query", "business_connection",
          "business_message", "edited_business_message", "deleted_business_messages",
        ],
        drop_pending_updates: !!opts.dropPending,
        max_connections: opts.maxConnections || 10,
      }),

    deleteWebhook: (dropPending = false) =>
      call("deleteWebhook", { drop_pending_updates: dropPending }),

    getWebhookInfo: () => call("getWebhookInfo"),

    sendMessage: (chat_id, text, extra = {}) => {
      const p = { chat_id, text, ...extra };
      // Rich text that would break on formatting must never lose a reply.
      if (p.parse_mode) {
        return call("sendMessage", p).catch(async (e) => {
          if (/can't parse entities|can't parse/.test(e.description || "")) {
            const q = { ...p };
            delete q.parse_mode;
            return call("sendMessage", q);
          }
          throw e;
        });
      }
      return call("sendMessage", p);
    },

    sendPhoto: (chat_id, photo, extra = {}) => call("sendPhoto", { chat_id, photo, ...extra }),
    sendVoice: (chat_id, voice, extra = {}) => call("sendVoice", { chat_id, voice, ...extra }),
    sendVideo: (chat_id, video, extra = {}) => call("sendVideo", { chat_id, video, ...extra }),
    sendDocument: (chat_id, document, extra = {}) => call("sendDocument", { chat_id, document, ...extra }),
    sendAudio: (chat_id, audio, extra = {}) => call("sendAudio", { chat_id, audio, ...extra }),
    sendSticker: (chat_id, sticker, extra = {}) => call("sendSticker", { chat_id, sticker, ...extra }),

    sendChatAction: (chat_id, action, business_connection_id) =>
      call("sendChatAction", { chat_id, action, business_connection_id }),

    answerCallback: (id, text, show_alert = false) =>
      call("answerCallbackQuery", { callback_query_id: id, text, show_alert }),

    editMessageText: (text, extra = {}) => call("editMessageText", { text, ...extra }),

    readBusinessMessage: (business_connection_id, chat_id, message_id) =>
      call("readBusinessMessage", { business_connection_id, chat_id, message_id }),

    deleteBusinessMessages: (business_connection_id, message_ids) =>
      call("deleteBusinessMessages", { business_connection_id, message_ids }),

    getBusinessConnection: (id) => call("getBusinessConnection", { business_connection_id: id }),

    setBusinessAccountName: (business_connection_id, first_name, last_name) =>
      call("setBusinessAccountName", {
        business_connection_id, first_name,
        ...(last_name ? { last_name } : {}),
      }),
    setBusinessAccountBio: (business_connection_id, bio) =>
      call("setBusinessAccountBio", { business_connection_id, bio }),
    setBusinessAccountUsername: (business_connection_id, username) =>
      call("setBusinessAccountUsername", { business_connection_id, username }),
    setBusinessAccountProfilePhoto: (business_connection_id, photo) =>
      call("setBusinessAccountProfilePhoto", { business_connection_id, photo }),
    removeBusinessAccountProfilePhoto: (business_connection_id) =>
      call("removeBusinessAccountProfilePhoto", { business_connection_id }),

    setMyCommands: (commands) => call("setMyCommands", { commands }),
  };

  return api;
}

// ── security helpers ───────────────────────────────────────────────────

/** Constant-time string compare. Never leak length/content via early exit. */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  // hash first so differing lengths don't return early
  let ha = 2166136261, hb = 2166136261;
  for (let i = 0; i < a.length; i++) ha = Math.imul(ha ^ a.charCodeAt(i), 16777619) >>> 0;
  for (let i = 0; i < b.length; i++) hb = Math.imul(hb ^ b.charCodeAt(i), 16777619) >>> 0;
  let diff = (ha ^ hb) >>> 0;
  // still walk both to keep the timing flat
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export function makeSecret(len = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export function validSecret(s) {
  return typeof s === "string" && SECRET_RE.test(s);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
