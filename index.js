const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");

// ================= ENV =================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN not set");
  process.exit(1);
}

// ================= BOT =================
const bot = new TelegramBot(BOT_TOKEN, {
  polling: {
    autoStart: true,
    interval: 1000,
    params: { timeout: 10 }
  }
});

// ================= CONFIG =================
const INTRO_IMG = path.join(__dirname, "assets", "gorktimus_intro_1280.png");
const DB_PATH = "./gorktimus.db";
const SCAN_INTERVAL_MS = 15000; // practical public-API speed
const DEFAULT_ALERT_PCT = 3;
const DEFAULT_COOLDOWN_SEC = 120;
const DEFAULT_LIQ_ALERT_PCT = 10;
const DEFAULT_TXN_DELTA = 5;

// ================= DB =================
const db = new sqlite3.Database(DB_PATH);

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
      alert_pct REAL DEFAULT 3,
      liq_alert_pct REAL DEFAULT 10,
      txn_delta INTEGER DEFAULT 5,
      cooldown_sec INTEGER DEFAULT 120,
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

// ================= STATE =================
const pendingAction = new Map();
let scanRunning = false;

// ================= HELPERS =================
function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function isAddressLike(text) {
  const t = String(text || "").trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t) || /^0x[a-fA-F0-9]{40}$/.test(t);
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

function clip(text, len = 64) {
  const s = String(text || "");
  return s.length <= len ? s : `${s.slice(0, len - 1)}…`;
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
          { text: "🔄 Refresh", callback_data: "refresh_menu" },
          { text: "⚡ Scan Now", callback_data: "scan_now" }
        ]
      ]
    }
  };
}

function watchlistMenu(rows) {
  const buttons = rows.map((row) => ([
    {
      text: `❌ Remove ${row.base_symbol || row.query}`,
      callback_data: `remove_watch:${row.id}`
    }
  ]));

  buttons.push([
    { text: "⬅️ Main Menu", callback_data: "main_menu" }
  ]);

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
    } catch (e) {
      // fall through to search
    }
  }

  if (!pair) {
    const searchRes = await axios.get(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
      { timeout: 15000 }
    );

    const pairs = Array.isArray(searchRes.data?.pairs) ? searchRes.data.pairs : [];
    if (!pairs.length) return null;

    pair = [...pairs]
      .sort((a, b) => {
        const exactA =
          String(a.baseToken?.symbol || "").toLowerCase() === q.toLowerCase() ||
          String(a.baseToken?.address || "").toLowerCase() === q.toLowerCase();
        const exactB =
          String(b.baseToken?.symbol || "").toLowerCase() === q.toLowerCase() ||
          String(b.baseToken?.address || "").toLowerCase() === q.toLowerCase();

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
      priceChangeM5: num(pair.priceChange?.m5),
      marketCap: num(pair.marketCap),
      fdv: num(pair.fdv),
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

async function showWatchlist(chatId) {
  const rows = await all(
    `SELECT id, query, base_symbol, chain_id, pair_address, alert_pct, cooldown_sec, active
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
    `${i + 1}. ${r.base_symbol || r.query} | ${r.chain_id} | alert ${r.alert_pct}% | cooldown ${r.cooldown_sec}s`
  );

  await sendTerminal(
    chatId,
    `📋 Your Watchlist\n\n${lines.join("\n")}`,
    watchlistMenu(rows)
  );
}

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
      `✅ Watch added\n\n${resolved.baseSymbol} (${resolved.baseName})\nChain: ${resolved.chainId}\nPrice: ${shortUsd(resolved.priceUsd)}\nLiquidity: ${shortUsd(resolved.liquidityUsd)}`,
      mainMenu()
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      await bot.sendMessage(chatId, `⚠️ That pair is already in your watchlist.`);
      return;
    }
    throw err;
  }
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
    `📡 STATUS\n\nYour active watches: ${mine?.c || 0}\nTotal active watches: ${total?.c || 0}\nScan interval: ${SCAN_INTERVAL_MS / 1000}s\nGlobal alerts: ${settings.global_alerts ? "ON" : "OFF"}\nImage: ${fs.existsSync(INTRO_IMG) ? "OK" : "MISSING"}`,
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
        `${i + 1}. ${x.chainId || "?"} | ${clip(x.tokenAddress || "", 12)} | boost ${num(x.totalAmount)}`
      );
      caption += `\n\nTop boosted snapshot:\n${lines.join("\n")}`;
    }
  }

  await sendTerminal(chatId, caption, mainMenu());
}

async function forceScan(chatId) {
  await bot.sendMessage(chatId, "⚡ Running scan now...");
  await scanWatches(true, chatId);
  await bot.sendMessage(chatId, "✅ Scan complete.");
}

async function maybeAlert(row, fresh, forceChatId = null) {
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

  if (reasons.length && (cooldownOk || forceChatId)) {
    const targetChat = forceChatId || row.chat_id;

    await bot.sendMessage(
      targetChat,
      `🚨 ${fresh.baseSymbol || row.base_symbol || row.query}\n${reasons.join("\n")}\n\nPrice: ${shortUsd(fresh.priceUsd)}\nLiquidity: ${shortUsd(fresh.liquidityUsd)}\n24h Volume: ${shortUsd(fresh.volumeH24)}\nM5: B ${fresh.buysM5} | S ${fresh.sellsM5}`
    );

    if (!forceChatId) {
      await run(`UPDATE watches SET last_alert_at = ? WHERE id = ?`, [currentTs, row.id]);
    }
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
}

async function scanWatches(manual = false, manualChatId = null) {
  if (scanRunning && !manual) return;
  scanRunning = true;

  try {
    const rows = await all(
      `SELECT * FROM watches WHERE active = 1 ORDER BY created_at ASC`
    );

    for (const row of rows) {
      const fresh = await fetchPair(row.chain_id, row.pair_address);
      if (!fresh) continue;
      if (!fresh.priceUsd || fresh.priceUsd <= 0) continue;

      await maybeAlert(row, fresh, manual ? manualChatId : null);
    }
  } catch (err) {
    console.log("scanWatches error:", err.message);
  } finally {
    scanRunning = false;
  }
}

// ================= START / COMMANDS =================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  await ensureUserSettings(chatId);
  await sendTerminal(
    chatId,
    "🛡️ GORKTIMUS PRIME TERMINAL\nSelect an option below.",
    mainMenu()
  );
});

bot.onText(/\/scan/, async (msg) => {
  await forceScan(msg.chat.id);
});

// ================= BUTTONS =================
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data || "";

  try {
    if (data === "add_watch") {
      pendingAction.set(chatId, { type: "ADD_WATCH" });
      await bot.sendMessage(chatId, "Send ticker, token address, or pair search. Example: SOL or contract address");
    } else if (data === "watchlist") {
      await showWatchlist(chatId);
    } else if (data === "global_alerts") {
      await toggleGlobalAlerts(chatId);
    } else if (data === "status") {
      await showStatus(chatId);
    } else if (data === "refresh_menu") {
      await sendTerminal(
        chatId,
        "🛡️ GORKTIMUS PRIME TERMINAL\nRefreshed.",
        mainMenu()
      );
    } else if (data === "scan_now") {
      await forceScan(chatId);
    } else if (data === "main_menu") {
      await sendTerminal(
        chatId,
        "🛡️ GORKTIMUS PRIME TERMINAL\nSelect an option below.",
        mainMenu()
      );
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

// ================= MESSAGE HANDLER =================
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

// ================= POLLING / ERROR =================
bot.on("polling_error", (err) => {
  console.log("Polling error:", err.code, err.message);
});

bot.on("error", (err) => {
  console.log("Bot error:", err.message);
});

// ================= BOOT =================
(async () => {
  await initDb();
  console.log("🧠 Gorktimus Prime Bot Running...");
  console.log("📁 Image exists on boot:", fs.existsSync(INTRO_IMG));
  setInterval(() => {
    scanWatches(false, null);
  }, SCAN_INTERVAL_MS);
})();
