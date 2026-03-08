const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN not set");
  process.exit(1);
}

const INTRO_IMG = path.join(__dirname, "assets", "gorktimus_intro_1280.png");
const DB_PATH = "./gorktimus.db";

const SCAN_INTERVAL_MS = 15000;
const DEFAULT_ALERT_PCT = 1;
const DEFAULT_LIQ_ALERT_PCT = 5;
const DEFAULT_TXN_DELTA = 2;
const DEFAULT_COOLDOWN_SEC = 60;

const db = new sqlite3.Database(DB_PATH);
const pendingAction = new Map();

let bot = null;
let scanInterval = null;
let scanRunning = false;
let shuttingDown = false;

// ================= DB HELPERS =================
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, function (err, row) {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, function (err, rows) {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS watches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      query TEXT NOT NULL,
      chain_id TEXT NOT NULL,
      pair_address TEXT NOT NULL,
      base_symbol TEXT,
      base_name TEXT,
      base_address TEXT,
      dex_id TEXT,
      pair_url TEXT,
      alert_pct REAL DEFAULT 1,
      liq_alert_pct REAL DEFAULT 5,
      txn_delta INTEGER DEFAULT 2,
      cooldown_sec INTEGER DEFAULT 60,
      active INTEGER DEFAULT 1,
      last_price REAL,
      last_liquidity REAL,
      last_buys_m5 INTEGER,
      last_sells_m5 INTEGER,
      last_alert_at INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE(chat_id, chain_id, pair_address)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS user_settings (
      chat_id TEXT PRIMARY KEY,
      global_alerts INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

// ================= HELPERS =================
function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pctChange(oldVal, newVal) {
  if (!oldVal || oldVal <= 0 || !newVal || newVal <= 0) return 0;
  return ((newVal - oldVal) / oldVal) * 100;
}

function shortUsd(n) {
  const x = num(n);
  if (x >= 1_000_000_000) return `$${(x / 1_000_000_000).toFixed(2)}B`;
  if (x >= 1_000_000) return `$${(x / 1_000_000).toFixed(2)}M`;
  if (x >= 1_000) return `$${(x / 1_000).toFixed(2)}K`;
  if (x >= 1) return `$${x.toFixed(4)}`;
  return `$${x.toFixed(8)}`;
}

function clip(text, len = 24) {
  const s = String(text || "");
  return s.length <= len ? s : `${s.slice(0, len - 1)}…`;
}

function isAddressLike(text) {
  const t = String(text || "").trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t) || /^0x[a-fA-F0-9]{40}$/.test(t);
}

function mainMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "➕ Add Watch", callback_data: "add_watch" },
          { text: "📋 Watchlist", callback_data: "watchlist" }
        ],
        [
          { text: "🌍 Global Alerts", callback_data: "global_alerts" },
          { text: "📡 Status", callback_data: "status" }
        ],
        [
          { text: "⚡ Scan Now", callback_data: "scan_now" },
          { text: "🔄 Refresh", callback_data: "refresh_menu" }
        ]
      ]
    }
  };
}

function watchlistMenu(rows) {
  const buttons = rows.map((row) => ([
    { text: `❌ Remove ${row.base_symbol || row.query}`, callback_data: `remove_watch:${row.id}` }
  ]));

  buttons.push([{ text: "⬅️ Main Menu", callback_data: "main_menu" }]);

  return {
    reply_markup: {
      inline_keyboard: buttons
    }
  };
}

async function ensureUserSettings(chatId) {
  const row = await get(`SELECT * FROM user_settings WHERE chat_id = ?`, [String(chatId)]);
  if (row) return row;

  const ts = nowTs();
  await run(
    `INSERT INTO user_settings (chat_id, global_alerts, created_at, updated_at)
     VALUES (?, 1, ?, ?)`,
    [String(chatId), ts, ts]
  );

  return get(`SELECT * FROM user_settings WHERE chat_id = ?`, [String(chatId)]);
}

async function sendTerminal(chatId, caption, keyboard) {
  try {
    if (!fs.existsSync(INTRO_IMG)) {
      await bot.sendMessage(chatId, caption, keyboard);
      return;
    }

    await bot.sendPhoto(
      chatId,
      fs.createReadStream(INTRO_IMG),
      {
        caption,
        ...keyboard
      },
      {
        filename: "gorktimus_intro_1280.png",
        contentType: "image/png"
      }
    );
  } catch (err) {
    console.log("sendTerminal fallback:", err.message);
    await bot.sendMessage(chatId, caption, keyboard);
  }
}

// ================= DEX =================
async function resolveWatchTarget(query) {
  const q = String(query || "").trim();
  if (!q) return null;

  let pair = null;

  if (isAddressLike(q)) {
    const chainGuess = q.startsWith("0x") ? "base" : "solana";
    try {
      const byToken = await axios.get(
        `https://api.dexscreener.com/token-pairs/v1/${chainGuess}/${encodeURIComponent(q)}`,
        { timeout: 15000 }
      );

      if (Array.isArray(byToken.data) && byToken.data.length) {
        pair = [...byToken.data].sort((a, b) => {
          const scoreA = num(a.liquidity?.usd) + num(a.volume?.h24);
          const scoreB = num(b.liquidity?.usd) + num(b.volume?.h24);
          return scoreB - scoreA;
        })[0];
      }
    } catch (err) {
      console.log("token-pairs lookup fallback:", err.message);
    }
  }

  if (!pair) {
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
      { timeout: 15000 }
    );

    const pairs = Array.isArray(res.data?.pairs) ? res.data.pairs : [];
    if (!pairs.length) return null;

    pair = [...pairs].sort((a, b) => {
      const exactA = String(a.baseToken?.symbol || "").toLowerCase() === q.toLowerCase();
      const exactB = String(b.baseToken?.symbol || "").toLowerCase() === q.toLowerCase();

      if (exactA !== exactB) return exactB - exactA;

      const scoreA = num(a.liquidity?.usd) * 4 + num(a.volume?.h24) * 2 + num(a.marketCap);
      const scoreB = num(b.liquidity?.usd) * 4 + num(b.volume?.h24) * 2 + num(b.marketCap);
      return scoreB - scoreA;
    })[0];
  }

  if (!pair?.chainId || !pair?.pairAddress) return null;

  return {
    chainId: String(pair.chainId),
    pairAddress: String(pair.pairAddress),
    baseSymbol: String(pair.baseToken?.symbol || q),
    baseName: String(pair.baseToken?.name || q),
    baseAddress: String(pair.baseToken?.address || ""),
    dexId: String(pair.dexId || ""),
    pairUrl: String(pair.url || ""),
    priceUsd: num(pair.priceUsd),
    liquidityUsd: num(pair.liquidity?.usd),
    buysM5: num(pair.txns?.m5?.buys),
    sellsM5: num(pair.txns?.m5?.sells)
  };
}

async function fetchPair(chainId, pairAddress) {
  try {
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/pairs/${encodeURIComponent(chainId)}/${encodeURIComponent(pairAddress)}`,
      { timeout: 15000 }
    );

    const pair = Array.isArray(res.data?.pairs) ? res.data.pairs[0] : null;
    if (!pair) return null;

    return {
      chainId: String(pair.chainId || chainId),
      pairAddress: String(pair.pairAddress || pairAddress),
      baseSymbol: String(pair.baseToken?.symbol || ""),
      baseName: String(pair.baseToken?.name || ""),
      priceUsd: num(pair.priceUsd),
      liquidityUsd: num(pair.liquidity?.usd),
      volumeH24: num(pair.volume?.h24),
      buysM5: num(pair.txns?.m5?.buys),
      sellsM5: num(pair.txns?.m5?.sells),
      url: String(pair.url || "")
    };
  } catch (err) {
    console.log("fetchPair error:", err.message);
    return null;
  }
}

async function fetchTopBoosted() {
  try {
    const res = await axios.get("https://api.dexscreener.com/token-boosts/top/v1", {
      timeout: 15000
    });
    return Array.isArray(res.data) ? res.data.slice(0, 5) : [];
  } catch (err) {
    console.log("fetchTopBoosted error:", err.message);
    return [];
  }
}

// ================= WATCHES =================
async function addWatch(chatId, query) {
  const resolved = await resolveWatchTarget(query);

  if (!resolved) {
    await bot.sendMessage(chatId, `❌ Could not find a solid pair for: ${query}`);
    return;
  }

  const ts = nowTs();

  try {
    await run(
      `INSERT INTO watches (
        chat_id, query, chain_id, pair_address, base_symbol, base_name, base_address, dex_id, pair_url,
        alert_pct, liq_alert_pct, txn_delta, cooldown_sec, active,
        last_price, last_liquidity, last_buys_m5, last_sells_m5, last_alert_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 0, ?)`,
      [
        String(chatId),
        String(query).trim(),
        resolved.chainId,
        resolved.pairAddress,
        resolved.baseSymbol,
        resolved.baseName,
        resolved.baseAddress,
        resolved.dexId,
        resolved.pairUrl,
        DEFAULT_ALERT_PCT,
        DEFAULT_LIQ_ALERT_PCT,
        DEFAULT_TXN_DELTA,
        DEFAULT_COOLDOWN_SEC,
        resolved.priceUsd,
        resolved.liquidityUsd,
        resolved.buysM5,
        resolved.sellsM5,
        ts
      ]
    );

    await sendTerminal(
      chatId,
      `✅ Watch added

${resolved.baseSymbol} (${resolved.baseName})
Chain: ${resolved.chainId}
Price: ${shortUsd(resolved.priceUsd)}
Liquidity: ${shortUsd(resolved.liquidityUsd)}
Buys m5: ${resolved.buysM5}
Sells m5: ${resolved.sellsM5}`,
      mainMenu()
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      await bot.sendMessage(chatId, "⚠️ That pair is already in your watchlist.");
      return;
    }
    throw err;
  }
}

async function showWatchlist(chatId) {
  const rows = await all(
    `SELECT id, query, base_symbol, chain_id, alert_pct, cooldown_sec
     FROM watches
     WHERE chat_id = ? AND active = 1
     ORDER BY created_at DESC`,
    [String(chatId)]
  );

  if (!rows.length) {
    await sendTerminal(chatId, "📭 Watchlist empty.", mainMenu());
    return;
  }

  const lines = rows.map((r, i) =>
    `${i + 1}. ${r.base_symbol || r.query} | ${r.chain_id} | ${r.alert_pct}% | ${r.cooldown_sec}s`
  );

  await sendTerminal(
    chatId,
    `📋 Your Watchlist

${lines.join("\n")}`,
    watchlistMenu(rows)
  );
}

async function removeWatch(chatId, id) {
  await run(`UPDATE watches SET active = 0 WHERE id = ? AND chat_id = ?`, [id, String(chatId)]);
  await showWatchlist(chatId);
}

async function showStatus(chatId) {
  const total = await get(`SELECT COUNT(*) AS c FROM watches WHERE active = 1`);
  const mine = await get(`SELECT COUNT(*) AS c FROM watches WHERE chat_id = ? AND active = 1`, [String(chatId)]);
  const settings = await ensureUserSettings(chatId);

  await sendTerminal(
    chatId,
    `📡 STATUS

Your active watches: ${mine?.c || 0}
Total active watches: ${total?.c || 0}
Scan interval: ${SCAN_INTERVAL_MS / 1000}s
Global alerts: ${settings.global_alerts ? "ON" : "OFF"}
Image: ${fs.existsSync(INTRO_IMG) ? "OK" : "MISSING"}`,
    mainMenu()
  );
}

async function toggleGlobalAlerts(chatId) {
  const settings = await ensureUserSettings(chatId);
  const next = settings.global_alerts ? 0 : 1;

  await run(
    `UPDATE user_settings SET global_alerts = ?, updated_at = ? WHERE chat_id = ?`,
    [next, nowTs(), String(chatId)]
  );

  let caption = `🌍 Global Alerts: ${next ? "ON" : "OFF"}`;

  if (next) {
    const boosted = await fetchTopBoosted();
    if (boosted.length) {
      const lines = boosted.map((x, i) =>
        `${i + 1}. ${x.chainId || "?"} | ${clip(x.tokenAddress || "", 14)} | boost ${num(x.totalAmount)}`
      );
      caption += `

Top boosted snapshot:
${lines.join("\n")}`;
    }
  }

  await sendTerminal(chatId, caption, mainMenu());
}

async function maybeAlert(row, fresh, manualMode = false) {
  const pMove = pctChange(row.last_price, fresh.priceUsd);
  const lMove = pctChange(row.last_liquidity, fresh.liquidityUsd);
  const buyDelta = num(fresh.buysM5) - num(row.last_buys_m5);
  const sellDelta = num(fresh.sellsM5) - num(row.last_sells_m5);

  const reasons = [];

  if (Math.abs(pMove) >= num(row.alert_pct, DEFAULT_ALERT_PCT)) {
    reasons.push(`💰 Price ${pMove >= 0 ? "up" : "down"} ${Math.abs(pMove).toFixed(2)}%`);
  }

  if (Math.abs(lMove) >= num(row.liq_alert_pct, DEFAULT_LIQ_ALERT_PCT)) {
    reasons.push(`🏦 Liquidity ${lMove >= 0 ? "up" : "down"} ${Math.abs(lMove).toFixed(2)}%`);
  }

  if (Math.abs(buyDelta) >= num(row.txn_delta, DEFAULT_TXN_DELTA)) {
    reasons.push(`🟢 Buys m5 ${buyDelta >= 0 ? "+" : ""}${buyDelta}`);
  }

  if (Math.abs(sellDelta) >= num(row.txn_delta, DEFAULT_TXN_DELTA)) {
    reasons.push(`🔴 Sells m5 ${sellDelta >= 0 ? "+" : ""}${sellDelta}`);
  }

  const currentTs = nowTs();
  const cooldownSec = num(row.cooldown_sec, DEFAULT_COOLDOWN_SEC);
  const cooldownOk = currentTs - num(row.last_alert_at, 0) >= cooldownSec;

  if (reasons.length && cooldownOk && !manualMode) {
    await bot.sendMessage(
      row.chat_id,
      `🚨 ${fresh.baseSymbol || row.base_symbol || row.query}
${reasons.join("\n")}

Price: ${shortUsd(fresh.priceUsd)}
Liquidity: ${shortUsd(fresh.liquidityUsd)}
24h Volume: ${shortUsd(fresh.volumeH24)}
M5: B ${fresh.buysM5} | S ${fresh.sellsM5}`
    );

    await run(`UPDATE watches SET last_alert_at = ? WHERE id = ?`, [currentTs, row.id]);
  }

  await run(
    `UPDATE watches
     SET last_price = ?, last_liquidity = ?, last_buys_m5 = ?, last_sells_m5 = ?, pair_url = ?
     WHERE id = ?`,
    [
      fresh.priceUsd,
      fresh.liquidityUsd,
      fresh.buysM5,
      fresh.sellsM5,
      fresh.url || row.pair_url,
      row.id
    ]
  );

  return {
    symbol: fresh.baseSymbol || row.base_symbol || row.query,
    price: fresh.priceUsd,
    liquidity: fresh.liquidityUsd,
    buysM5: fresh.buysM5,
    sellsM5: fresh.sellsM5,
    triggered: reasons
  };
}

async function scanWatches(manualMode = false, targetChatId = null) {
  if (scanRunning && !manualMode) return { scanned: 0, results: [] };
  scanRunning = true;

  try {
    const rows = await all(
      `SELECT * FROM watches WHERE active = 1 ${targetChatId ? "AND chat_id = ?" : ""} ORDER BY created_at ASC`,
      targetChatId ? [String(targetChatId)] : []
    );

    const results = [];

    for (const row of rows) {
      const fresh = await fetchPair(row.chain_id, row.pair_address);
      if (!fresh) continue;
      if (!fresh.priceUsd || fresh.priceUsd <= 0) continue;

      const result = await maybeAlert(row, fresh, manualMode);
      results.push(result);
    }

    return { scanned: rows.length, results };
  } catch (err) {
    console.log("scanWatches error:", err.message);
    return { scanned: 0, results: [] };
  } finally {
    scanRunning = false;
  }
}

async function forceScan(chatId) {
  await bot.sendMessage(chatId, "⚡ Running scan now...");

  const out = await scanWatches(true, chatId);

  if (!out.results.length) {
    await bot.sendMessage(chatId, "✅ Scan complete.\nNo active watch data found yet.");
    return;
  }

  const lines = out.results.slice(0, 10).map((r) => {
    const parts = [
      `${r.symbol} | ${shortUsd(r.price)}`,
      `liq ${shortUsd(r.liquidity)}`,
      `m5 B ${r.buysM5} / S ${r.sellsM5}`
    ];

    if (r.triggered.length) {
      parts.push(`alerts: ${r.triggered.join(" | ")}`);
    } else {
      parts.push("alerts: none");
    }

    return parts.join("\n");
  });

  await bot.sendMessage(
    chatId,
    `✅ Scan complete.

Watches scanned: ${out.scanned}

${lines.join("\n\n")}`
  );
}

// ================= BOT HANDLERS =================
async function registerHandlers() {
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await ensureUserSettings(chatId);
    await sendTerminal(chatId, "🛡️ GORKTIMUS PRIME TERMINAL\nSelect an option below.", mainMenu());
  });

  bot.onText(/\/scan/, async (msg) => {
    await forceScan(msg.chat.id);
  });

  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data || "";

    try {
      if (data === "add_watch") {
        pendingAction.set(chatId, { type: "ADD_WATCH" });
        await bot.sendMessage(chatId, "Send ticker, token address, or pair search. Example: SOL");
      } else if (data === "watchlist") {
        await showWatchlist(chatId);
      } else if (data === "global_alerts") {
        await toggleGlobalAlerts(chatId);
      } else if (data === "status") {
        await showStatus(chatId);
      } else if (data === "scan_now") {
        await forceScan(chatId);
      } else if (data === "refresh_menu") {
        await sendTerminal(chatId, "🛡️ GORKTIMUS PRIME TERMINAL\nRefreshed.", mainMenu());
      } else if (data === "main_menu") {
        await sendTerminal(chatId, "🛡️ GORKTIMUS PRIME TERMINAL\nSelect an option below.", mainMenu());
      } else if (data.startsWith("remove_watch:")) {
        const id = Number(data.split(":")[1]);
        if (Number.isFinite(id)) {
          await removeWatch(chatId, id);
        }
      }

      await bot.answerCallbackQuery(query.id);
    } catch (err) {
      console.log("callback error:", err.message);
      try {
        await bot.answerCallbackQuery(query.id, { text: "Something glitched." });
      } catch (_) {}
    }
  });

  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text) return;
    if (text.startsWith("/start") || text.startsWith("/scan")) return;

    const pending = pendingAction.get(chatId);
    if (!pending) return;

    try {
      if (pending.type === "ADD_WATCH") {
        pendingAction.delete(chatId);
        await addWatch(chatId, text.trim());
      }
    } catch (err) {
      pendingAction.delete(chatId);
      console.log("message handler error:", err.message);
      await bot.sendMessage(chatId, "❌ Could not process that request.");
    }
  });

  bot.on("polling_error", (err) => {
    console.log("Polling error:", err.code, err.message);
  });

  bot.on("error", (err) => {
    console.log("Bot error:", err.message);
  });
}

// ================= CLEAN SHUTDOWN =================
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`🛑 Shutdown signal received: ${signal}`);

  try {
    if (scanInterval) {
      clearInterval(scanInterval);
      scanInterval = null;
    }

    if (bot) {
      try {
        await bot.stopPolling();
        console.log("✅ Polling stopped cleanly");
      } catch (err) {
        console.log("stopPolling error:", err.message);
      }
    }

    db.close(() => {
      console.log("✅ DB closed");
      process.exit(0);
    });

    setTimeout(() => process.exit(0), 3000);
  } catch (err) {
    console.log("shutdown error:", err.message);
    process.exit(0);
  }
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

// ================= BOOT =================
(async () => {
  await initDb();

  bot = new TelegramBot(BOT_TOKEN, {
    polling: {
      autoStart: false,
      interval: 1000,
      params: { timeout: 10 }
    }
  });

  try {
    await bot.deleteWebHook({ drop_pending_updates: false });
    console.log("✅ Webhook cleared");
  } catch (err) {
    console.log("deleteWebHook warning:", err.message);
  }

  await registerHandlers();
  await bot.startPolling();

  console.log("🧠 Gorktimus Prime Bot Running...");
  console.log("📁 Image exists on boot:", fs.existsSync(INTRO_IMG));

  scanInterval = setInterval(() => {
    scanWatches(false, null);
  }, SCAN_INTERVAL_MS);
})();
