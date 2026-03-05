"use strict";

const TelegramBot = require("node-telegram-bot-api");
const sqlite3 = require("sqlite3").verbose();
const axios = require("axios");

const token =
  process.env.TELEGRAM_BOT_TOKEN ||
  process.env.BOT_TOKEN ||
  process.env.TOKEN;

if (!token) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN (or BOT_TOKEN/TOKEN)");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const db = new sqlite3.Database("./gorktimus.db");

// ---------- Simple state ----------
const pendingAdd = new Map();        // chatId -> true
const pendingCandidate = new Map();  // chatId -> best pair object

// ---------- DB ----------
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      chat_id INTEGER PRIMARY KEY,
      trending INTEGER DEFAULT 0,
      alerts_on INTEGER DEFAULT 1,
      alert_threshold REAL DEFAULT 3.0,      -- % move needed to alert
      alert_cooldown_sec INTEGER DEFAULT 120  -- seconds between alerts per token
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      chain_id TEXT NOT NULL,
      pair_address TEXT NOT NULL,
      symbol TEXT,
      url TEXT,
      last_price REAL,
      last_buys INTEGER,
      last_sells INTEGER,
      last_alert_ts INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(chat_id, chain_id, pair_address)
    )
  `);

  // If you started earlier with fewer columns, these are safe no-ops
  db.run(`ALTER TABLE users ADD COLUMN alerts_on INTEGER DEFAULT 1`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN alert_threshold REAL DEFAULT 3.0`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN alert_cooldown_sec INTEGER DEFAULT 120`, () => {});
  db.run(`ALTER TABLE watchlist ADD COLUMN last_buys INTEGER`, () => {});
  db.run(`ALTER TABLE watchlist ADD COLUMN last_sells INTEGER`, () => {});
  db.run(`ALTER TABLE watchlist ADD COLUMN last_alert_ts INTEGER DEFAULT 0`, () => {});
});

// ---------- UI ----------
function menu() {
  return {
    inline_keyboard: [
      [{ text: "👁 Add Watch", callback_data: "WATCH" }],
      [{ text: "📋 Watchlist", callback_data: "LIST" }],
      [{ text: "🚨 Alerts", callback_data: "ALERTS_MENU" }],
      [{ text: "ℹ️ Status", callback_data: "STATUS" }],
    ],
  };
}

function confirmKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "✅ Add Watch", callback_data: "CONFIRM_ADD" }],
      [{ text: "❌ Cancel", callback_data: "CANCEL_ADD" }],
    ],
  };
}

async function alertsMenu(chatId) {
  return new Promise((resolve) => {
    db.get(
      "SELECT alerts_on, alert_threshold, alert_cooldown_sec FROM users WHERE chat_id = ?",
      [chatId],
      async (err, row) => {
        const on = row?.alerts_on ?? 1;
        const th = row?.alert_threshold ?? 3.0;
        const cd = row?.alert_cooldown_sec ?? 120;

        const kb = {
          inline_keyboard: [
            [{ text: on ? "🚨 Alerts: ON" : "🚨 Alerts: OFF", callback_data: "ALERTS_TOGGLE" }],
            [
              { text: `🎯 Threshold: ${th}%`, callback_data: "ALERTS_SET_THRESHOLD" },
              { text: `⏱ Cooldown: ${cd}s`, callback_data: "ALERTS_SET_COOLDOWN" },
            ],
            [{ text: "🏠 Home", callback_data: "HOME" }],
          ],
        };

        await bot.sendMessage(
          chatId,
          `🚨 Alert Settings\n\n• Threshold = % move needed\n• Cooldown = min seconds between pings per token`,
          { reply_markup: kb }
        );

        resolve();
      }
    );
  });
}

// ---------- Helpers ----------
function looksLikeSolAddress(s) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

function parseDexLink(text) {
  const m = text.match(/dexscreener\.com\/([a-z0-9_-]+)\/([a-zA-Z0-9]+)/i);
  if (!m) return null;
  return { chainId: m[1].toLowerCase(), pairAddress: m[2] };
}

async function dexscreenerSearch(q) {
  const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`;
  const { data } = await axios.get(url, { timeout: 12000 });
  return Array.isArray(data?.pairs) ? data.pairs : [];
}

async function fetchPair(chainId, pairAddress) {
  const url = `https://api.dexscreener.com/latest/dex/pairs/${encodeURIComponent(chainId)}/${encodeURIComponent(pairAddress)}`;
  const { data } = await axios.get(url, { timeout: 12000 });
  return data?.pair || data?.pairs?.[0] || null;
}

function pickBestPair(pairs) {
  if (!pairs.length) return null;
  const sol = pairs.filter((p) => (p?.chainId || "").toLowerCase() === "solana");
  const list = sol.length ? sol : pairs;

  const scored = list
    .map((p) => ({
      chainId: (p.chainId || "").toLowerCase(),
      pairAddress: p.pairAddress,
      symbol: p?.baseToken?.symbol || "???",
      url: p.url,
      priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
      liqUsd: p?.liquidity?.usd ? Number(p.liquidity.usd) : 0,
      vol24h: p?.volume?.h24 ? Number(p.volume.h24) : 0,
    }))
    .filter((x) => x.chainId && x.pairAddress);

  scored.sort((a, b) => (b.liqUsd - a.liqUsd) || (b.vol24h - a.vol24h));
  return scored[0] || null;
}

function fmtMoney(n) {
  if (n === null || n === undefined) return "n/a";
  const num = Number(n);
  if (!Number.isFinite(num)) return "n/a";
  if (num >= 1_000_000_000) return `$${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${Math.round(num).toLocaleString()}`;
  return `$${num}`;
}

function pctChange(prev, curr) {
  if (!prev || !curr || prev === 0) return 0;
  return ((curr - prev) / prev) * 100;
}

function arrow(prev, curr) {
  if (curr > prev) return "⬆️";
  if (curr < prev) return "⬇️";
  return "➡️";
}

// ---------- Watch flow ----------
async function handleWatchQuery(chatId, input) {
  try {
    let q = input.trim();
    const dex = parseDexLink(q);
    if (dex) q = dex.pairAddress;

    const pairs = await dexscreenerSearch(q);
    const best = pickBestPair(pairs);

    if (!best) {
      pendingCandidate.delete(chatId);
      await bot.sendMessage(chatId, "Couldn’t find that. Try ticker, coin address, or DexScreener link.");
      return;
    }

    pendingCandidate.set(chatId, best);

    const msg =
      `Found:\n\n` +
      `🪙 ${best.symbol}\n` +
      `Price: ${best.priceUsd !== null ? `$${best.priceUsd}` : "n/a"}\n` +
      `Liquidity: ${fmtMoney(best.liqUsd)}\n` +
      `Vol 24h: ${fmtMoney(best.vol24h)}\n\n` +
      `${best.url || `${best.chainId}/${best.pairAddress}`}\n\n` +
      `Tap ✅ Add Watch to save.`;

    await bot.sendMessage(chatId, msg, { reply_markup: confirmKeyboard() });
  } catch (e) {
    pendingCandidate.delete(chatId);
    await bot.sendMessage(chatId, "Lookup failed (DexScreener/API). Try again in a sec.");
  }
}

// ---------- /start ----------
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;

  db.run("INSERT OR IGNORE INTO users(chat_id) VALUES (?)", [chatId]);

  bot.sendMessage(chatId, "🛡️ GORKTIMUS PRIME TERMINAL\nButtons only.", {
    reply_markup: menu(),
  });
});

// ---------- Buttons ----------
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const action = q.data;

  bot.answerCallbackQuery(q.id).catch(() => null);

  if (action === "HOME") {
    bot.sendMessage(chatId, "🛡️ GORKTIMUS PRIME TERMINAL", { reply_markup: menu() });
    return;
  }

  if (action === "WATCH") {
    pendingAdd.set(chatId, true);
    pendingCandidate.delete(chatId);
    await bot.sendMessage(
      chatId,
      "Send **ticker** (BONK), **coin address**, or **DexScreener link**.\n\nI’ll identify it and you tap ✅ Add Watch.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (action === "CANCEL_ADD") {
    pendingAdd.delete(chatId);
    pendingCandidate.delete(chatId);
    await bot.sendMessage(chatId, "Cancelled.");
    return;
  }

  if (action === "CONFIRM_ADD") {
    const cand = pendingCandidate.get(chatId);
    if (!cand) return bot.sendMessage(chatId, "Nothing to add. Tap 👁 Add Watch first.");

    // Prime last_buys/sells by fetching pair once
    let pair = null;
    try {
      pair = await fetchPair(cand.chainId, cand.pairAddress);
    } catch {}

    const buys = pair?.txns?.m5?.buys ?? null;
    const sells = pair?.txns?.m5?.sells ?? null;

    db.run(
      `INSERT OR IGNORE INTO watchlist(chat_id, chain_id, pair_address, symbol, url, last_price, last_buys, last_sells)
       VALUES(?,?,?,?,?,?,?,?)`,
      [chatId, cand.chainId, cand.pairAddress, cand.symbol, cand.url, cand.priceUsd, buys, sells],
      async (err) => {
        if (err) return bot.sendMessage(chatId, "DB error adding watch.");
        pendingAdd.delete(chatId);
        pendingCandidate.delete(chatId);
        await bot.sendMessage(chatId, `✅ Watching: ${cand.symbol}\n${cand.url || `${cand.chainId}/${cand.pairAddress}`}`);
      }
    );
    return;
  }

  if (action === "LIST") {
    db.all(
      `SELECT id, COALESCE(symbol,'???') AS symbol,
              COALESCE(url,'') AS url,
              chain_id, pair_address,
              last_price
       FROM watchlist
       WHERE chat_id = ?
       ORDER BY id DESC
       LIMIT 50`,
      [chatId],
      (err, rows) => {
        if (err) return bot.sendMessage(chatId, "DB error reading watchlist.");
        if (!rows || rows.length === 0) return bot.sendMessage(chatId, "Watchlist empty.");

        const text = rows
          .map((r, i) => {
            const ref = r.url || `${r.chain_id}/${r.pair_address}`;
            const price = r.last_price ? ` | $${r.last_price}` : "";
            return `${i + 1}) ${r.symbol}${price}\n${ref}`;
          })
          .join("\n\n");

        bot.sendMessage(chatId, "👁 Watchlist:\n\n" + text);
      }
    );
    return;
  }

  if (action === "ALERTS_MENU") {
    await alertsMenu(chatId);
    return;
  }

  if (action === "ALERTS_TOGGLE") {
    db.get("SELECT alerts_on FROM users WHERE chat_id = ?", [chatId], (err, row) => {
      const cur = row?.alerts_on ?? 1;
      const next = cur ? 0 : 1;
      db.run("UPDATE users SET alerts_on = ? WHERE chat_id = ?", [next, chatId], async () => {
        await bot.sendMessage(chatId, next ? "🚨 Alerts ON" : "🚨 Alerts OFF");
      });
    });
    return;
  }

  if (action === "ALERTS_SET_THRESHOLD") {
    await bot.sendMessage(chatId, "Reply with the threshold percent (example: 3 or 5).");
    // Set a one-shot pending state using pendingAdd map (reuse with marker)
    pendingAdd.set(chatId, "SET_THRESHOLD");
    return;
  }

  if (action === "ALERTS_SET_COOLDOWN") {
    await bot.sendMessage(chatId, "Reply with cooldown seconds (example: 60 or 180).");
    pendingAdd.set(chatId, "SET_COOLDOWN");
    return;
  }

  if (action === "STATUS") {
    await bot.sendMessage(chatId, "🟢 Online\n✅ Easy identify\n✅ Watch alerts engine running");
    return;
  }
});

// ---------- Message handler ----------
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text) return;
  if (text.startsWith("/")) return;

  // Settings replies
  const mode = pendingAdd.get(chatId);
  if (mode === "SET_THRESHOLD") {
    pendingAdd.delete(chatId);
    const v = Number(text);
    if (!Number.isFinite(v) || v <= 0 || v > 100) return bot.sendMessage(chatId, "Bad value. Use a number like 3 or 5.");
    db.run("UPDATE users SET alert_threshold = ? WHERE chat_id = ?", [v, chatId], () => {
      bot.sendMessage(chatId, `🎯 Threshold set to ${v}%`);
    });
    return;
  }

  if (mode === "SET_COOLDOWN") {
    pendingAdd.delete(chatId);
    const v = Number(text);
    if (!Number.isFinite(v) || v < 15 || v > 3600) return bot.sendMessage(chatId, "Bad value. Use seconds 15–3600.");
    db.run("UPDATE users SET alert_cooldown_sec = ? WHERE chat_id = ?", [Math.round(v), chatId], () => {
      bot.sendMessage(chatId, `⏱ Cooldown set to ${Math.round(v)}s`);
    });
    return;
  }

  // Watch add inputs
  const shouldHandle =
    pendingAdd.get(chatId) === true ||
    text.includes("dexscreener.com") ||
    looksLikeSolAddress(text);

  if (!shouldHandle) return;

  // one-shot flag
  if (pendingAdd.get(chatId) === true) pendingAdd.delete(chatId);

  await handleWatchQuery(chatId, text);
});

// ---------- WATCH ALERT ENGINE ----------
async function runWatchAlertsTick() {
  // Get users that want alerts
  db.all(
    `SELECT chat_id, alerts_on, alert_threshold, alert_cooldown_sec
     FROM users
     WHERE alerts_on = 1`,
    [],
    async (err, users) => {
      if (err || !users || users.length === 0) return;

      for (const u of users) {
        const chatId = u.chat_id;
        const threshold = Number(u.alert_threshold ?? 3.0);
        const cooldownMs = Number(u.alert_cooldown_sec ?? 120) * 1000;

        // Pull watchlist for this user
        const rows = await new Promise((resolve) => {
          db.all(
            `SELECT id, chain_id, pair_address, symbol, url, last_price, last_buys, last_sells, last_alert_ts
             FROM watchlist
             WHERE chat_id = ?`,
            [chatId],
            (e, r) => resolve(r || [])
          );
        });

        if (!rows.length) continue;

        for (const w of rows) {
          let pair = null;
          try {
            pair = await fetchPair(w.chain_id, w.pair_address);
          } catch {
            continue;
          }
          if (!pair) continue;

          const price = pair?.priceUsd ? Number(pair.priceUsd) : null;
          if (!price) continue;

          const prev = w.last_price ? Number(w.last_price) : null;
          const pct = prev ? pctChange(prev, price) : 0;

          const now = Date.now();
          const lastTs = Number(w.last_alert_ts || 0);
          const canPing = now - lastTs >= cooldownMs;

          // pull txns (m5) when present
          const buys = pair?.txns?.m5?.buys ?? null;
          const sells = pair?.txns?.m5?.sells ?? null;

          const buyDelta =
            w.last_buys !== null && buys !== null ? Number(buys) - Number(w.last_buys) : null;
          const sellDelta =
            w.last_sells !== null && sells !== null ? Number(sells) - Number(w.last_sells) : null;

          // Alert condition: abs(pct) >= threshold
          if (prev && Math.abs(pct) >= threshold && canPing) {
            const sym = w.symbol || pair?.baseToken?.symbol || "???";
            const liqUsd = pair?.liquidity?.usd ?? null;
            const a = arrow(prev, price);

            const line1 = `👁 WATCH ALERT ${a}  ${sym}`;
            const line2 = `Move: ${pct.toFixed(2)}% | Price: $${price}`;
            const line3 =
              buyDelta !== null || sellDelta !== null
                ? `Tx (5m) since last: buys ${buyDelta ?? "?"} / sells ${sellDelta ?? "?"}`
                : `Tx (5m): n/a`;
            const line4 = liqUsd ? `Liquidity: ${fmtMoney(liqUsd)}` : "";
            const line5 = pair?.url || w.url || `${w.chain_id}/${w.pair_address}`;

            const out = [line1, line2, line3, line4, line5].filter(Boolean).join("\n");

            bot.sendMessage(chatId, out).catch(() => null);

            // update alert timestamp
            db.run(
              `UPDATE watchlist
               SET last_alert_ts = ?
               WHERE id = ?`,
              [now, w.id]
            );
          }

          // Always update stored stats (silent)
          db.run(
            `UPDATE watchlist
             SET last_price = ?, last_buys = COALESCE(?, last_buys), last_sells = COALESCE(?, last_sells),
                 symbol = COALESCE(?, symbol), url = COALESCE(?, url)
             WHERE id = ?`,
            [
              price,
              buys,
              sells,
              pair?.baseToken?.symbol || w.symbol,
              pair?.url || w.url,
              w.id,
            ]
          );
        }
      }
    }
  );
}

// run every 60 seconds
setInterval(() => {
  runWatchAlertsTick().catch(() => null);
}, 60 * 1000);

// ---------- errors ----------
bot.on("polling_error", (err) => {
  console.error("❌ polling_error:", err?.message || err);
});

console.log("🛡️ Gorktimus bot running (watch alerts enabled)");
