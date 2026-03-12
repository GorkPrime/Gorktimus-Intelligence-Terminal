"use strict";

/**
 * Gorktimus Prime Intelligence Terminal
 * Full bug-fixed index.js
 *
 * Required packages:
 * npm i node-telegram-bot-api axios sqlite3
 *
 * Recommended env vars:
 * TELEGRAM_BOT_TOKEN=...
 * MENU_IMAGE_PATH=./assets/gorktimus.png
 * PUBLIC_TELEGRAM_URL=https://t.me/GorktimusPrime
 * PUBLIC_X_URL=https://x.com/gorktimusPrime
 * PUBLIC_BOT_URL=https://t.me/GorktimusPrime_bot
 * ALERT_POLL_MS=45000
 * NEW_PAIR_MAX_AGE_MIN=20
 * TRENDING_MIN_LIQUIDITY=15000
 * WATCHLIST_ALERT_COOLDOWN_MS=900000
 * ADMIN_CHAT_ID=
 * CHAIN_DEFAULT=solana
 */

const fs = require("fs");
const axios = require("axios");
const sqlite3 = require("sqlite3").verbose();
const TelegramBot = require("node-telegram-bot-api");

// ==============================
// ENV
// ==============================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MENU_IMAGE_PATH = process.env.MENU_IMAGE_PATH || "./assets/gorktimus.png";
const PUBLIC_TELEGRAM_URL = process.env.PUBLIC_TELEGRAM_URL || "https://t.me/GorktimusPrime";
const PUBLIC_X_URL = process.env.PUBLIC_X_URL || "https://x.com/gorktimusPrime";
const PUBLIC_BOT_URL = process.env.PUBLIC_BOT_URL || "https://t.me/GorktimusPrime_bot";
const ALERT_POLL_MS = Number(process.env.ALERT_POLL_MS || 45000);
const NEW_PAIR_MAX_AGE_MIN = Number(process.env.NEW_PAIR_MAX_AGE_MIN || 20);
const TRENDING_MIN_LIQUIDITY = Number(process.env.TRENDING_MIN_LIQUIDITY || 15000);
const WATCHLIST_ALERT_COOLDOWN_MS = Number(process.env.WATCHLIST_ALERT_COOLDOWN_MS || 15 * 60 * 1000);
const CHAIN_DEFAULT = process.env.CHAIN_DEFAULT || "solana";
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? Number(process.env.ADMIN_CHAT_ID) : null;

if (!BOT_TOKEN) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

// ==============================
// BOT
// ==============================
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

(async () => {
  try {
    await bot.deleteWebHook();
    console.log("✅ Webhook cleared");
  } catch (err) {
    console.warn("⚠ Could not clear webhook:", err.message);
  }
})();

// ==============================
// DB
// ==============================
const db = new sqlite3.Database("./gorktimus.db");

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      chat_id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      alerts_enabled INTEGER DEFAULT 1,
      trending_enabled INTEGER DEFAULT 1,
      newcoins_enabled INTEGER DEFAULT 1,
      whale_enabled INTEGER DEFAULT 0,
      menu_image_enabled INTEGER DEFAULT 1,
      created_at INTEGER,
      updated_at INTEGER
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      chain_id TEXT NOT NULL,
      token_address TEXT NOT NULL DEFAULT '',
      pair_address TEXT NOT NULL DEFAULT '',
      symbol TEXT,
      token_name TEXT,
      last_price_usd REAL,
      last_market_cap REAL,
      last_liquidity REAL,
      last_buys INTEGER,
      last_sells INTEGER,
      last_alert_at INTEGER DEFAULT 0,
      created_at INTEGER,
      UNIQUE(chat_id, chain_id, token_address, pair_address)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS seen_pairs (
      pair_address TEXT PRIMARY KEY,
      chain_id TEXT,
      token_address TEXT,
      symbol TEXT,
      token_name TEXT,
      first_seen_at INTEGER
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS seen_trending (
      token_address TEXT PRIMARY KEY,
      chain_id TEXT,
      symbol TEXT,
      token_name TEXT,
      first_seen_at INTEGER
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS whale_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      wallet_address TEXT NOT NULL,
      label TEXT,
      enabled INTEGER DEFAULT 1,
      created_at INTEGER,
      UNIQUE(chat_id, wallet_address)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS state (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  console.log("✅ SQLite ready");
}

// ==============================
// HELPERS
// ==============================
function now() {
  return Date.now();
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function shortNum(n) {
  const num = Number(n || 0);
  if (!Number.isFinite(num)) return "N/A";
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  if (num >= 1) return `${num.toFixed(2)}`;
  return `${num}`;
}

function usd(n) {
  const num = Number(n || 0);
  if (!Number.isFinite(num)) return "N/A";
  return `$${shortNum(num)}`;
}

function pct(n) {
  const num = Number(n || 0);
  if (!Number.isFinite(num)) return "N/A";
  const sign = num > 0 ? "+" : "";
  return `${sign}${num.toFixed(2)}%`;
}

function ageMinutesFromTs(ts) {
  if (!ts) return null;
  return Math.floor((now() - Number(ts)) / 60000);
}

function riskScoreFromPair(pair) {
  let score = 5.0;

  const liquidity = Number(pair?.liquidity?.usd || 0);
  const mc = Number(pair?.marketCap || pair?.fdv || 0);
  const buys5m = Number(pair?.txns?.m5?.buys || 0);
  const sells5m = Number(pair?.txns?.m5?.sells || 0);
  const priceChange5m = Number(pair?.priceChange?.m5 || 0);
  const boosts = Number(pair?.boosts?.active || 0);

  if (liquidity >= 100000) score += 1.5;
  else if (liquidity >= 50000) score += 1.0;
  else if (liquidity < 15000) score -= 1.25;

  if (mc > 0 && liquidity > 0) {
    const ratio = liquidity / mc;
    if (ratio >= 0.12) score += 1.0;
    else if (ratio < 0.03) score -= 1.0;
  }

  if (buys5m > sells5m * 1.8 && buys5m >= 10) score += 1.0;
  if (sells5m > buys5m * 1.8 && sells5m >= 10) score -= 1.0;

  if (priceChange5m > 8) score += 0.5;
  if (priceChange5m < -8) score -= 0.75;

  if (boosts > 0) score += 0.25;

  if (score < 0) score = 0;
  if (score > 10) score = 10;

  return score.toFixed(1);
}

function signalLabelFromPair(pair) {
  const buys5m = Number(pair?.txns?.m5?.buys || 0);
  const sells5m = Number(pair?.txns?.m5?.sells || 0);
  const change5m = Number(pair?.priceChange?.m5 || 0);

  if (buys5m >= 12 && buys5m > sells5m * 1.6 && change5m > 3) {
    return "Momentum Buy Pressure";
  }
  if (sells5m >= 12 && sells5m > buys5m * 1.6 && change5m < -3) {
    return "Heavy Sell Pressure";
  }
  if (change5m > 10) {
    return "Breakout Acceleration";
  }
  return "Market Activity Detected";
}

function getTokenDisplay(pair) {
  return {
    tokenName: pair?.baseToken?.name || "Unknown",
    symbol: pair?.baseToken?.symbol || "UNKNOWN",
    tokenAddress: pair?.baseToken?.address || "",
    pairAddress: pair?.pairAddress || "",
    chainId: pair?.chainId || CHAIN_DEFAULT,
  };
}

function buildDexUrl(pair) {
  if (pair?.url) return pair.url;
  if (pair?.chainId && pair?.pairAddress) {
    return `https://dexscreener.com/${pair.chainId}/${pair.pairAddress}`;
  }
  return "";
}

function buildBirdeyeUrl(pair) {
  const tokenAddress = pair?.baseToken?.address;
  const chain = pair?.chainId || CHAIN_DEFAULT;
  if (!tokenAddress) return "";
  if (chain === "solana") {
    return `https://birdeye.so/token/${tokenAddress}?chain=solana`;
  }
  return "";
}

function baseMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📈 Trending", callback_data: "menu:trending" },
        { text: "🆕 New Launches", callback_data: "menu:newcoins" }
      ],
      [
        { text: "🔍 Search Token", callback_data: "menu:search" },
        { text: "👀 My Watchlist", callback_data: "menu:watchlist" }
      ],
      [
        { text: "🐋 Whale Tracker", callback_data: "menu:whales" },
        { text: "⚙️ Settings", callback_data: "menu:settings" }
      ],
      [
        { text: "🤖 Open Terminal", url: PUBLIC_BOT_URL },
        { text: "📣 Community", url: PUBLIC_TELEGRAM_URL }
      ],
      [
        { text: "𝕏 X Page", url: PUBLIC_X_URL }
      ]
    ]
  };
}

function settingsKeyboard(user) {
  const onOff = (v) => (Number(v) ? "ON ✅" : "OFF ❌");
  return {
    inline_keyboard: [
      [
        { text: `Alerts ${onOff(user.alerts_enabled)}`, callback_data: "toggle:alerts_enabled" }
      ],
      [
        { text: `Trending ${onOff(user.trending_enabled)}`, callback_data: "toggle:trending_enabled" },
        { text: `New Coins ${onOff(user.newcoins_enabled)}`, callback_data: "toggle:newcoins_enabled" }
      ],
      [
        { text: `Whale Mode ${onOff(user.whale_enabled)}`, callback_data: "toggle:whale_enabled" },
        { text: `Menu Image ${onOff(user.menu_image_enabled)}`, callback_data: "toggle:menu_image_enabled" }
      ],
      [
        { text: "⬅️ Back", callback_data: "menu:home" }
      ]
    ]
  };
}

async function ensureUser(msgOrQuery) {
  const user = msgOrQuery.from || {};
  const chatId = msgOrQuery.message ? msgOrQuery.message.chat.id : msgOrQuery.chat.id;
  const ts = now();

  await run(`
    INSERT INTO users (
      chat_id, username, first_name, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      username=excluded.username,
      first_name=excluded.first_name,
      updated_at=excluded.updated_at
  `, [chatId, user.username || "", user.first_name || "", ts, ts]);

  return get(`SELECT * FROM users WHERE chat_id = ?`, [chatId]);
}

async function answerCallbackSafe(queryId, text = "") {
  try {
    await bot.answerCallbackQuery(queryId, text ? { text } : {});
  } catch (err) {
    console.warn("callback answer failed:", err.message);
  }
}

async function sendMenu(chatId, caption = null) {
  const text =
    caption ||
    [
      `🧠 <b>GORKTIMUS PRIME INTELLIGENCE TERMINAL</b>`,
      ``,
      `Real-time signal style alerts.`,
      `Cleaner alpha. Better presentation.`,
      ``,
      `Choose a mode below.`
    ].join("\n");

  const hasImage = fs.existsSync(MENU_IMAGE_PATH);

  if (hasImage) {
    return bot.sendPhoto(chatId, MENU_IMAGE_PATH, {
      caption: text,
      parse_mode: "HTML",
      reply_markup: baseMenuKeyboard()
    });
  }

  return bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: baseMenuKeyboard()
  });
}

async function sendStyledAlert(chatId, data = {}) {
  const {
    title = "GORKTIMUS PRIME SIGNAL",
    emoji = "🚨",
    tokenName = "Unknown",
    symbol = "",
    marketCap = 0,
    liquidity = 0,
    priceUsd = "",
    buys = "N/A",
    sells = "N/A",
    riskScore = "N/A",
    signal = "Signal detected",
    contractAddress = "",
    chainId = CHAIN_DEFAULT,
    dexUrl = "",
    birdeyeUrl = "",
    extraLine = "",
    pairAgeMin = null
  } = data;

  const safeName = escapeHtml(tokenName);
  const safeSymbol = escapeHtml(symbol);
  const safeSignal = escapeHtml(signal);
  const safeCa = escapeHtml(contractAddress);
  const safeExtra = escapeHtml(extraLine);
  const safePrice = priceUsd !== "" && priceUsd !== null && priceUsd !== undefined
    ? `$${Number(priceUsd).toFixed(Number(priceUsd) < 0.01 ? 8 : 6)}`
    : "N/A";

  const lines = [
    `${emoji} <b>${escapeHtml(title)}</b>`,
    ``,
    `<b>Token:</b> ${safeName}${safeSymbol ? ` (${safeSymbol})` : ""}`,
    `━━━━━━━━━━━━━━`,
    ``,
    `💲 <b>Price:</b> ${escapeHtml(safePrice)}`,
    `💰 <b>Market Cap:</b> ${usd(marketCap)}`,
    `💧 <b>Liquidity:</b> ${usd(liquidity)}`,
    `📊 <b>Buys/Sells (5m):</b> ${escapeHtml(String(buys))} / ${escapeHtml(String(sells))}`,
    `🧠 <b>Risk Score:</b> ${escapeHtml(String(riskScore))}/10`,
    `⛓️ <b>Chain:</b> ${escapeHtml(chainId)}`,
    safeSignal ? `🐋 <b>${safeSignal}</b>` : ""
  ].filter(Boolean);

  if (pairAgeMin !== null) {
    lines.push(`⏱️ <b>Pair Age:</b> ${escapeHtml(String(pairAgeMin))} min`);
  }

  if (safeExtra) {
    lines.push(`⚡ <b>Insight:</b> ${safeExtra}`);
  }

  if (safeCa) {
    lines.push(`📍 <b>CA:</b> <code>${safeCa}</code>`);
  }

  const keyboard = [];
  const row1 = [];
  const row2 = [];

  if (dexUrl) row1.push({ text: "DexScreener", url: dexUrl });
  if (birdeyeUrl) row1.push({ text: "Birdeye", url: birdeyeUrl });

  row2.push({ text: "👀 Watch", callback_data: `watchtoken:${chainId}:${contractAddress}` });
  row2.push({ text: "🔍 Refresh", callback_data: `inspect:${chainId}:${contractAddress}` });

  if (row1.length) keyboard.push(row1);
  keyboard.push(row2);

  return bot.sendMessage(chatId, lines.join("\n"), {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function sendSimple(chatId, html, replyMarkup = null) {
  return bot.sendMessage(chatId, html, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });
}

function normalizeSearchInput(input = "") {
  return String(input).trim();
}

// ==============================
// DEXSCREENER API
// ==============================
const api = axios.create({
  timeout: 15000,
  headers: {
    Accept: "application/json",
    "User-Agent": "GorktimusPrimeBot/1.0"
  }
});

async function dsSearchPairs(query) {
  const q = normalizeSearchInput(query);
  if (!q) return [];
  const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`;
  const { data } = await api.get(url);
  return Array.isArray(data?.pairs) ? data.pairs : [];
}

async function dsTokenPairs(chainId, tokenAddress) {
  const url = `https://api.dexscreener.com/token-pairs/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(tokenAddress)}`;
  const { data } = await api.get(url);
  return Array.isArray(data) ? data : [];
}

async function dsTokenBoostsTop() {
  const url = `https://api.dexscreener.com/token-boosts/top/v1`;
  const { data } = await api.get(url);
  return Array.isArray(data) ? data : [];
}

async function dsTokenProfilesLatest() {
  const url = `https://api.dexscreener.com/token-profiles/latest/v1`;
  const { data } = await api.get(url);
  return Array.isArray(data) ? data : [];
}

function bestPairFromPairs(pairs = [], preferredChain = CHAIN_DEFAULT) {
  if (!Array.isArray(pairs) || !pairs.length) return null;

  const filtered = pairs.filter(Boolean);
  const chainMatched = filtered.filter((p) => p.chainId === preferredChain);
  const pool = chainMatched.length ? chainMatched : filtered;

  pool.sort((a, b) => {
    const la = Number(a?.liquidity?.usd || 0);
    const lb = Number(b?.liquidity?.usd || 0);
    const va = Number(a?.volume?.h24 || 0);
    const vb = Number(b?.volume?.h24 || 0);
    return (lb + vb * 0.25) - (la + va * 0.25);
  });

  return pool[0] || null;
}

async function resolveToken(query, preferredChain = CHAIN_DEFAULT) {
  const pairs = await dsSearchPairs(query);
  const pair = bestPairFromPairs(pairs, preferredChain);
  return pair;
}

// ==============================
// WATCHLIST / STATE
// ==============================
async function addToWatchlist(chatId, chainId, tokenAddress, pairAddress, symbol, tokenName) {
  await run(`
    INSERT OR IGNORE INTO watchlist (
      chat_id, chain_id, token_address, pair_address, symbol, token_name, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    chatId,
    chainId || CHAIN_DEFAULT,
    tokenAddress || "",
    pairAddress || "",
    symbol || "",
    tokenName || "",
    now()
  ]);
}

async function removeFromWatchlist(chatId, tokenOrPair) {
  await run(`
    DELETE FROM watchlist
    WHERE chat_id = ?
      AND (token_address = ? OR pair_address = ? OR symbol = ?)
  `, [chatId, tokenOrPair, tokenOrPair, tokenOrPair]);
}

async function listWatchlist(chatId) {
  return all(`
    SELECT * FROM watchlist
    WHERE chat_id = ?
    ORDER BY created_at DESC
  `, [chatId]);
}

async function markSeenPair(pair) {
  const t = getTokenDisplay(pair);
  await run(`
    INSERT OR IGNORE INTO seen_pairs (
      pair_address, chain_id, token_address, symbol, token_name, first_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `, [t.pairAddress, t.chainId, t.tokenAddress, t.symbol, t.tokenName, now()]);
}

async function hasSeenPair(pairAddress) {
  const row = await get(`SELECT pair_address FROM seen_pairs WHERE pair_address = ?`, [pairAddress]);
  return !!row;
}

async function markSeenTrending(tokenAddress, chainId, symbol, tokenName) {
  await run(`
    INSERT OR IGNORE INTO seen_trending (
      token_address, chain_id, symbol, token_name, first_seen_at
    ) VALUES (?, ?, ?, ?, ?)
  `, [tokenAddress, chainId, symbol || "", tokenName || "", now()]);
}

async function hasSeenTrending(tokenAddress) {
  const row = await get(`SELECT token_address FROM seen_trending WHERE token_address = ?`, [tokenAddress]);
  return !!row;
}

async function getState(key) {
  const row = await get(`SELECT value FROM state WHERE key = ?`, [key]);
  return row?.value || null;
}

async function setState(key, value) {
  await run(`
    INSERT INTO state (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `, [key, String(value)]);
}

// ==============================
// RENDERERS
// ==============================
async function renderTokenDetails(chatId, pair, title = "TOKEN SNAPSHOT") {
  if (!pair) {
    return sendSimple(chatId, `❌ <b>No token found.</b>`);
  }

  const t = getTokenDisplay(pair);
  const liquidity = Number(pair?.liquidity?.usd || 0);
  const marketCap = Number(pair?.marketCap || pair?.fdv || 0);
  const buys = Number(pair?.txns?.m5?.buys || 0);
  const sells = Number(pair?.txns?.m5?.sells || 0);
  const pairAgeMin = ageMinutesFromTs(pair?.pairCreatedAt);
  const risk = riskScoreFromPair(pair);
  const signal = signalLabelFromPair(pair);

  return sendStyledAlert(chatId, {
    title,
    emoji: "📡",
    tokenName: t.tokenName,
    symbol: t.symbol,
    marketCap,
    liquidity,
    priceUsd: pair?.priceUsd,
    buys,
    sells,
    riskScore: risk,
    signal,
    contractAddress: t.tokenAddress,
    chainId: t.chainId,
    dexUrl: buildDexUrl(pair),
    birdeyeUrl: buildBirdeyeUrl(pair),
    extraLine: pair?.priceChange?.m5 !== undefined
      ? `5m change ${pct(pair.priceChange.m5)} | 1h change ${pct(pair?.priceChange?.h1 || 0)}`
      : "",
    pairAgeMin
  });
}

async function renderWatchlist(chatId) {
  const rows = await listWatchlist(chatId);

  if (!rows.length) {
    return sendSimple(
      chatId,
      `👀 <b>Your watchlist is empty.</b>\n\nUse <code>/watch tokenname</code> or press Watch from an alert.`,
      {
        inline_keyboard: [[{ text: "⬅️ Back", callback_data: "menu:home" }]]
      }
    );
  }

  const lines = [`👀 <b>MY WATCHLIST</b>`, ``];

  rows.slice(0, 25).forEach((row, i) => {
    lines.push(
      `${i + 1}. <b>${escapeHtml(row.token_name || row.symbol || "Unknown")}</b> (${escapeHtml(row.symbol || "N/A")})`,
      `   ⛓️ ${escapeHtml(row.chain_id)} | <code>${escapeHtml(row.token_address || row.pair_address || "")}</code>`,
      ``
    );
  });

  return sendSimple(chatId, lines.join("\n"), {
    inline_keyboard: [
      [{ text: "🧹 Clear One", callback_data: "menu:remove_watch_prompt" }],
      [{ text: "⬅️ Back", callback_data: "menu:home" }]
    ]
  });
}

async function renderTrending(chatId) {
  try {
    const boosts = await dsTokenBoostsTop();
    const solBoosts = boosts.filter((x) => x.chainId === CHAIN_DEFAULT).slice(0, 8);

    if (!solBoosts.length) {
      return sendSimple(chatId, `📈 <b>No trending/boosted tokens found right now.</b>`, {
        inline_keyboard: [[{ text: "⬅️ Back", callback_data: "menu:home" }]]
      });
    }

    const lines = [`📈 <b>TRENDING / BOOSTED</b>`, ``];
    const kb = [];

    let count = 0;
    for (const item of solBoosts) {
      const pairs = await dsTokenPairs(item.chainId, item.tokenAddress).catch(() => []);
      const pair = bestPairFromPairs(pairs, item.chainId);
      if (!pair) continue;

      const t = getTokenDisplay(pair);
      const liq = Number(pair?.liquidity?.usd || 0);
      if (liq < TRENDING_MIN_LIQUIDITY) continue;

      count += 1;
      lines.push(
        `${count}. <b>${escapeHtml(t.tokenName)}</b> (${escapeHtml(t.symbol)})`,
        `💰 MC ${usd(pair?.marketCap || pair?.fdv || 0)} | 💧 LQ ${usd(liq)} | 📊 5m ${pct(pair?.priceChange?.m5 || 0)}`,
        ``
      );

      kb.push([{ text: `${t.symbol} Snapshot`, callback_data: `inspect:${t.chainId}:${t.tokenAddress}` }]);
    }

    if (!count) {
      return sendSimple(chatId, `📈 <b>No trending tokens passed your liquidity floor right now.</b>`, {
        inline_keyboard: [[{ text: "⬅️ Back", callback_data: "menu:home" }]]
      });
    }

    kb.push([{ text: "⬅️ Back", callback_data: "menu:home" }]);

    return sendSimple(chatId, lines.join("\n"), { inline_keyboard: kb });
  } catch (err) {
    console.error("renderTrending error:", err.message);
    return sendSimple(chatId, `❌ <b>Trending fetch failed.</b>`);
  }
}

async function renderNewLaunches(chatId) {
  try {
    const profiles = await dsTokenProfilesLatest();
    const solProfiles = profiles.filter((x) => x.chainId === CHAIN_DEFAULT).slice(0, 12);

    if (!solProfiles.length) {
      return sendSimple(chatId, `🆕 <b>No new token profiles found right now.</b>`, {
        inline_keyboard: [[{ text: "⬅️ Back", callback_data: "menu:home" }]]
      });
    }

    const lines = [`🆕 <b>NEW LAUNCH SURFACE</b>`, ``];
    const kb = [];

    let count = 0;
    for (const profile of solProfiles) {
      const pairs = await dsTokenPairs(profile.chainId, profile.tokenAddress).catch(() => []);
      const pair = bestPairFromPairs(pairs, profile.chainId);
      if (!pair) continue;

      const ageMin = ageMinutesFromTs(pair?.pairCreatedAt);
      const t = getTokenDisplay(pair);

      count += 1;
      lines.push(
        `${count}. <b>${escapeHtml(t.tokenName)}</b> (${escapeHtml(t.symbol)})`,
        `⏱️ ${ageMin !== null ? `${ageMin} min` : "Age unknown"} | 💧 ${usd(pair?.liquidity?.usd || 0)} | 💰 ${usd(pair?.marketCap || pair?.fdv || 0)}`,
        ``
      );

      kb.push([{ text: `${t.symbol} Snapshot`, callback_data: `inspect:${t.chainId}:${t.tokenAddress}` }]);
    }

    kb.push([{ text: "⬅️ Back", callback_data: "menu:home" }]);

    return sendSimple(chatId, lines.join("\n"), { inline_keyboard: kb });
  } catch (err) {
    console.error("renderNewLaunches error:", err.message);
    return sendSimple(chatId, `❌ <b>New launches fetch failed.</b>`);
  }
}

async function renderWhaleMenu(chatId) {
  const rows = await all(`
    SELECT * FROM whale_targets
    WHERE chat_id = ?
    ORDER BY created_at DESC
    LIMIT 20
  `, [chatId]);

  const lines = [
    `🐋 <b>WHALE TRACKER</b>`,
    ``,
    `Wallet storage and UI are ready.`,
    `Live whale-activity provider can be plugged in next.`,
    ``
  ];

  if (!rows.length) {
    lines.push(`No whale wallets added yet.`);
  } else {
    rows.forEach((row, i) => {
      lines.push(`${i + 1}. <b>${escapeHtml(row.label || "Whale Wallet")}</b>`);
      lines.push(`<code>${escapeHtml(row.wallet_address)}</code>`);
      lines.push(`Status: ${row.enabled ? "ON ✅" : "OFF ❌"}`);
      lines.push(``);
    });
  }

  return sendSimple(chatId, lines.join("\n"), {
    inline_keyboard: [
      [{ text: "➕ Add Wallet", callback_data: "menu:add_whale_prompt" }],
      [{ text: "⬅️ Back", callback_data: "menu:home" }]
    ]
  });
}

async function renderSettings(chatId) {
  const user = await get(`SELECT * FROM users WHERE chat_id = ?`, [chatId]);
  const html = [
    `⚙️ <b>SETTINGS</b>`,
    ``,
    `Alerts: ${user.alerts_enabled ? "ON ✅" : "OFF ❌"}`,
    `Trending Scanner: ${user.trending_enabled ? "ON ✅" : "OFF ❌"}`,
    `New Coin Scanner: ${user.newcoins_enabled ? "ON ✅" : "OFF ❌"}`,
    `Whale Mode: ${user.whale_enabled ? "ON ✅" : "OFF ❌"}`,
    `Menu Image: ${user.menu_image_enabled ? "ON ✅" : "OFF ❌"}`
  ].join("\n");

  return sendSimple(chatId, html, settingsKeyboard(user));
}

// ==============================
// PROMPTS
// ==============================
const pendingReplies = new Map();

function setPending(chatId, mode) {
  pendingReplies.set(chatId, mode);
}

function clearPending(chatId) {
  pendingReplies.delete(chatId);
}

function getPending(chatId) {
  return pendingReplies.get(chatId) || null;
}

// ==============================
// COMMANDS
// ==============================
bot.onText(/^\/start$/, async (msg) => {
  try {
    const user = await ensureUser(msg);

    if (Number(user.menu_image_enabled) && fs.existsSync(MENU_IMAGE_PATH)) {
      await sendMenu(msg.chat.id);
    } else {
      await sendSimple(msg.chat.id, `🧠 <b>GORKTIMUS PRIME INTELLIGENCE TERMINAL</b>\n\nChoose a mode below.`, baseMenuKeyboard());
    }
  } catch (err) {
    console.error("/start error:", err.message);
  }
});

bot.onText(/^\/menu$/, async (msg) => {
  try {
    await ensureUser(msg);
    await sendMenu(msg.chat.id);
  } catch (err) {
    console.error("/menu error:", err.message);
  }
});

bot.onText(/^\/testalert$/, async (msg) => {
  try {
    await ensureUser(msg);
    await sendStyledAlert(msg.chat.id, {
      title: "GORKTIMUS PRIME SIGNAL",
      emoji: "🚨",
      tokenName: "CatFu",
      symbol: "CATFU",
      marketCap: 288000,
      liquidity: 45000,
      priceUsd: 0.002143,
      buys: 23,
      sells: 7,
      riskScore: "6.8",
      signal: "Smart Money Style Momentum",
      contractAddress: "8x7abc123xyz987catfu111222333",
      chainId: "solana",
      dexUrl: "https://dexscreener.com/solana",
      birdeyeUrl: "https://birdeye.so",
      extraLine: "Clean HTML formatting + premium CTA buttons"
    });
  } catch (err) {
    console.error("/testalert error:", err.message);
  }
});

bot.onText(/^\/search(?:\s+(.+))?$/i, async (msg, match) => {
  try {
    await ensureUser(msg);
    const query = match?.[1]?.trim();

    if (!query) {
      setPending(msg.chat.id, "search");
      return sendSimple(msg.chat.id, `🔍 <b>Reply with a token name, symbol, or contract address.</b>`);
    }

    const pair = await resolveToken(query, CHAIN_DEFAULT);
    return renderTokenDetails(msg.chat.id, pair, "SEARCH RESULT");
  } catch (err) {
    console.error("/search error:", err.message);
    return sendSimple(msg.chat.id, `❌ <b>Search failed.</b>`);
  }
});

bot.onText(/^\/watch(?:\s+(.+))?$/i, async (msg, match) => {
  try {
    await ensureUser(msg);
    const query = match?.[1]?.trim();

    if (!query) {
      setPending(msg.chat.id, "watch");
      return sendSimple(msg.chat.id, `👀 <b>Reply with the token name, symbol, or contract you want to watch.</b>`);
    }

    const pair = await resolveToken(query, CHAIN_DEFAULT);
    if (!pair) {
      return sendSimple(msg.chat.id, `❌ <b>Could not find that token.</b>`);
    }

    const t = getTokenDisplay(pair);
    await addToWatchlist(msg.chat.id, t.chainId, t.tokenAddress, t.pairAddress, t.symbol, t.tokenName);

    return sendSimple(
      msg.chat.id,
      `✅ <b>Added to watchlist:</b> ${escapeHtml(t.tokenName)} (${escapeHtml(t.symbol)})`,
      {
        inline_keyboard: [
          [{ text: "📡 View Snapshot", callback_data: `inspect:${t.chainId}:${t.tokenAddress}` }],
          [{ text: "👀 My Watchlist", callback_data: "menu:watchlist" }]
        ]
      }
    );
  } catch (err) {
    console.error("/watch error:", err.message);
    return sendSimple(msg.chat.id, `❌ <b>Watch command failed.</b>`);
  }
});

bot.onText(/^\/unwatch(?:\s+(.+))?$/i, async (msg, match) => {
  try {
    await ensureUser(msg);
    const query = match?.[1]?.trim();

    if (!query) {
      setPending(msg.chat.id, "unwatch");
      return sendSimple(msg.chat.id, `🧹 <b>Reply with the symbol, token address, or pair address to remove.</b>`);
    }

    await removeFromWatchlist(msg.chat.id, query);
    return sendSimple(msg.chat.id, `✅ <b>Removed if it existed:</b> <code>${escapeHtml(query)}</code>`);
  } catch (err) {
    console.error("/unwatch error:", err.message);
    return sendSimple(msg.chat.id, `❌ <b>Unwatch failed.</b>`);
  }
});

bot.onText(/^\/watchlist$/i, async (msg) => {
  try {
    await ensureUser(msg);
    return renderWatchlist(msg.chat.id);
  } catch (err) {
    console.error("/watchlist error:", err.message);
  }
});

bot.onText(/^\/trending$/i, async (msg) => {
  try {
    await ensureUser(msg);
    return renderTrending(msg.chat.id);
  } catch (err) {
    console.error("/trending error:", err.message);
  }
});

bot.onText(/^\/newcoins$/i, async (msg) => {
  try {
    await ensureUser(msg);
    return renderNewLaunches(msg.chat.id);
  } catch (err) {
    console.error("/newcoins error:", err.message);
  }
});

bot.onText(/^\/settings$/i, async (msg) => {
  try {
    await ensureUser(msg);
    return renderSettings(msg.chat.id);
  } catch (err) {
    console.error("/settings error:", err.message);
  }
});

// ==============================
// REPLY FLOW
// ==============================
bot.on("message", async (msg) => {
  try {
    if (!msg.text) return;
    if (msg.text.startsWith("/")) return;

    await ensureUser(msg);
    const pending = getPending(msg.chat.id);
    if (!pending) return;

    clearPending(msg.chat.id);

    if (pending === "search") {
      const pair = await resolveToken(msg.text, CHAIN_DEFAULT);
      return renderTokenDetails(msg.chat.id, pair, "SEARCH RESULT");
    }

    if (pending === "watch") {
      const pair = await resolveToken(msg.text, CHAIN_DEFAULT);
      if (!pair) return sendSimple(msg.chat.id, `❌ <b>Could not find that token.</b>`);

      const t = getTokenDisplay(pair);
      await addToWatchlist(msg.chat.id, t.chainId, t.tokenAddress, t.pairAddress, t.symbol, t.tokenName);
      return sendSimple(msg.chat.id, `✅ <b>Added to watchlist:</b> ${escapeHtml(t.tokenName)} (${escapeHtml(t.symbol)})`);
    }

    if (pending === "unwatch") {
      await removeFromWatchlist(msg.chat.id, msg.text.trim());
      return sendSimple(msg.chat.id, `✅ <b>Removed if it existed:</b> <code>${escapeHtml(msg.text.trim())}</code>`);
    }

    if (pending === "add_whale") {
      const wallet = msg.text.trim();
      await run(`
        INSERT OR IGNORE INTO whale_targets (chat_id, wallet_address, label, created_at)
        VALUES (?, ?, ?, ?)
      `, [msg.chat.id, wallet, "Tracked Whale", now()]);

      return sendSimple(msg.chat.id, `🐋 <b>Whale wallet added:</b>\n<code>${escapeHtml(wallet)}</code>`);
    }
  } catch (err) {
    console.error("message handler error:", err.message);
  }
});

// ==============================
// CALLBACKS
// ==============================
bot.on("callback_query", async (query) => {
  try {
    const chatId = query.message.chat.id;
    await ensureUser(query);

    const data = query.data || "";

    if (data === "menu:home") {
      await answerCallbackSafe(query.id);
      return sendMenu(chatId);
    }

    if (data === "menu:trending") {
      await answerCallbackSafe(query.id, "Loading trending");
      return renderTrending(chatId);
    }

    if (data === "menu:newcoins") {
      await answerCallbackSafe(query.id, "Loading new launches");
      return renderNewLaunches(chatId);
    }

    if (data === "menu:search") {
      await answerCallbackSafe(query.id);
      setPending(chatId, "search");
      return sendSimple(chatId, `🔍 <b>Reply with a token name, symbol, or contract address.</b>`);
    }

    if (data === "menu:watchlist") {
      await answerCallbackSafe(query.id);
      return renderWatchlist(chatId);
    }

    if (data === "menu:settings") {
      await answerCallbackSafe(query.id);
      return renderSettings(chatId);
    }

    if (data === "menu:whales") {
      await answerCallbackSafe(query.id);
      return renderWhaleMenu(chatId);
    }

    if (data === "menu:add_whale_prompt") {
      await answerCallbackSafe(query.id);
      setPending(chatId, "add_whale");
      return sendSimple(chatId, `🐋 <b>Reply with the wallet address you want to track.</b>`);
    }

    if (data === "menu:remove_watch_prompt") {
      await answerCallbackSafe(query.id);
      setPending(chatId, "unwatch");
      return sendSimple(chatId, `🧹 <b>Reply with the symbol, token address, or pair address to remove.</b>`);
    }

    if (data.startsWith("toggle:")) {
      const field = data.split(":")[1];
      const allowed = new Set([
        "alerts_enabled",
        "trending_enabled",
        "newcoins_enabled",
        "whale_enabled",
        "menu_image_enabled"
      ]);

      if (!allowed.has(field)) {
        await answerCallbackSafe(query.id, "Invalid setting");
        return;
      }

      const user = await get(`SELECT * FROM users WHERE chat_id = ?`, [chatId]);
      const nextValue = Number(user[field]) ? 0 : 1;

      await run(`UPDATE users SET ${field} = ?, updated_at = ? WHERE chat_id = ?`, [nextValue, now(), chatId]);
      await answerCallbackSafe(query.id, `${field} ${nextValue ? "ON" : "OFF"}`);
      return renderSettings(chatId);
    }

    if (data.startsWith("inspect:")) {
      await answerCallbackSafe(query.id, "Refreshing token");
      const [, chainId, tokenAddress] = data.split(":");
      const pairs = await dsTokenPairs(chainId, tokenAddress);
      const pair = bestPairFromPairs(pairs, chainId);
      return renderTokenDetails(chatId, pair, "LIVE SNAPSHOT");
    }

    if (data.startsWith("watchtoken:")) {
      const [, chainId, tokenAddress] = data.split(":");
      const pairs = await dsTokenPairs(chainId, tokenAddress);
      const pair = bestPairFromPairs(pairs, chainId);

      if (!pair) {
        await answerCallbackSafe(query.id, "Token not found");
        return;
      }

      const t = getTokenDisplay(pair);
      await addToWatchlist(chatId, t.chainId, t.tokenAddress, t.pairAddress, t.symbol, t.tokenName);
      await answerCallbackSafe(query.id, "Added to watchlist");
      return sendSimple(chatId, `✅ <b>Watching:</b> ${escapeHtml(t.tokenName)} (${escapeHtml(t.symbol)})`);
    }

    await answerCallbackSafe(query.id);
  } catch (err) {
    console.error("callback_query error:", err.message);
    await answerCallbackSafe(query.id, "Error");
  }
});

// ==============================
// SCANNERS
// ==============================
async function notifyUsersForTrending() {
  try {
    const users = await all(`
      SELECT * FROM users
      WHERE alerts_enabled = 1 AND trending_enabled = 1
    `);

    if (!users.length) return;

    const boosts = await dsTokenBoostsTop();
    const solBoosts = boosts.filter((x) => x.chainId === CHAIN_DEFAULT).slice(0, 5);

    for (const item of solBoosts) {
      const seen = await hasSeenTrending(item.tokenAddress);
      if (seen) continue;

      const pairs = await dsTokenPairs(item.chainId, item.tokenAddress).catch(() => []);
      const pair = bestPairFromPairs(pairs, item.chainId);
      if (!pair) continue;

      const liq = Number(pair?.liquidity?.usd || 0);
      if (liq < TRENDING_MIN_LIQUIDITY) continue;

      const t = getTokenDisplay(pair);

      for (const user of users) {
        await sendStyledAlert(user.chat_id, {
          title: "TRENDING SIGNAL",
          emoji: "📈",
          tokenName: t.tokenName,
          symbol: t.symbol,
          marketCap: pair?.marketCap || pair?.fdv || 0,
          liquidity: liq,
          priceUsd: pair?.priceUsd,
          buys: pair?.txns?.m5?.buys || 0,
          sells: pair?.txns?.m5?.sells || 0,
          riskScore: riskScoreFromPair(pair),
          signal: "Top Boost / Trending Surface",
          contractAddress: t.tokenAddress,
          chainId: t.chainId,
          dexUrl: buildDexUrl(pair),
          birdeyeUrl: buildBirdeyeUrl(pair),
          extraLine: `5m ${pct(pair?.priceChange?.m5 || 0)} | 1h ${pct(pair?.priceChange?.h1 || 0)}`
        }).catch((err) => console.warn("send trending alert failed:", err.message));
      }

      await markSeenTrending(item.tokenAddress, item.chainId, t.symbol, t.tokenName);
    }
  } catch (err) {
    console.error("notifyUsersForTrending error:", err.message);
  }
}

async function notifyUsersForNewPairs() {
  try {
    const users = await all(`
      SELECT * FROM users
      WHERE alerts_enabled = 1 AND newcoins_enabled = 1
    `);

    if (!users.length) return;

    const profiles = await dsTokenProfilesLatest();
    const solProfiles = profiles.filter((x) => x.chainId === CHAIN_DEFAULT).slice(0, 12);

    for (const profile of solProfiles) {
      const pairs = await dsTokenPairs(profile.chainId, profile.tokenAddress).catch(() => []);
      const pair = bestPairFromPairs(pairs, profile.chainId);
      if (!pair) continue;

      const pairAddress = pair?.pairAddress;
      if (!pairAddress) continue;

      const pairAgeMin = ageMinutesFromTs(pair?.pairCreatedAt);
      if (pairAgeMin === null || pairAgeMin > NEW_PAIR_MAX_AGE_MIN) {
        continue;
      }

      const seen = await hasSeenPair(pairAddress);
      if (seen) continue;

      const t = getTokenDisplay(pair);

      for (const user of users) {
        await sendStyledAlert(user.chat_id, {
          title: "NEW LAUNCH DETECTED",
          emoji: "🆕",
          tokenName: t.tokenName,
          symbol: t.symbol,
          marketCap: pair?.marketCap || pair?.fdv || 0,
          liquidity: pair?.liquidity?.usd || 0,
          priceUsd: pair?.priceUsd,
          buys: pair?.txns?.m5?.buys || 0,
          sells: pair?.txns?.m5?.sells || 0,
          riskScore: riskScoreFromPair(pair),
          signal: "Fresh Pair Surface",
          contractAddress: t.tokenAddress,
          chainId: t.chainId,
          dexUrl: buildDexUrl(pair),
          birdeyeUrl: buildBirdeyeUrl(pair),
          extraLine: `Fresh pair inside ${NEW_PAIR_MAX_AGE_MIN} minute detection window`,
          pairAgeMin
        }).catch((err) => console.warn("send new pair alert failed:", err.message));
      }

      await markSeenPair(pair);
    }
  } catch (err) {
    console.error("notifyUsersForNewPairs error:", err.message);
  }
}

async function notifyWatchlistMoves() {
  try {
    const items = await all(`SELECT * FROM watchlist ORDER BY created_at DESC LIMIT 100`);

    for (const item of items) {
      let pairs = [];
      if (item.token_address) {
        pairs = await dsTokenPairs(item.chain_id, item.token_address).catch(() => []);
      } else if (item.symbol) {
        pairs = await dsSearchPairs(item.symbol).catch(() => []);
      }

      const pair = bestPairFromPairs(pairs, item.chain_id || CHAIN_DEFAULT);
      if (!pair) continue;

      const price = Number(pair?.priceUsd || 0);
      const mc = Number(pair?.marketCap || pair?.fdv || 0);
      const liq = Number(pair?.liquidity?.usd || 0);
      const buys = Number(pair?.txns?.m5?.buys || 0);
      const sells = Number(pair?.txns?.m5?.sells || 0);

      let shouldAlert = false;
      let insight = "";

      if (item.last_market_cap && mc > 0) {
        const mcChange = ((mc - item.last_market_cap) / item.last_market_cap) * 100;
        if (Math.abs(mcChange) >= 12) {
          shouldAlert = true;
          insight = `Market cap moved ${pct(mcChange)} since last stored snapshot`;
        }
      }

      if (item.last_liquidity && liq > 0) {
        const liqChange = ((liq - item.last_liquidity) / item.last_liquidity) * 100;
        if (Math.abs(liqChange) >= 15 && !shouldAlert) {
          shouldAlert = true;
          insight = `Liquidity moved ${pct(liqChange)} since last stored snapshot`;
        }
      }

      if (item.last_alert_at && now() - Number(item.last_alert_at) < WATCHLIST_ALERT_COOLDOWN_MS) {
        shouldAlert = false;
      }

      if (shouldAlert) {
        const t = getTokenDisplay(pair);

        await sendStyledAlert(item.chat_id, {
          title: "WATCHLIST MOVE",
          emoji: "👀",
          tokenName: t.tokenName,
          symbol: t.symbol,
          marketCap: mc,
          liquidity: liq,
          priceUsd: price,
          buys,
          sells,
          riskScore: riskScoreFromPair(pair),
          signal: signalLabelFromPair(pair),
          contractAddress: t.tokenAddress,
          chainId: t.chainId,
          dexUrl: buildDexUrl(pair),
          birdeyeUrl: buildBirdeyeUrl(pair),
          extraLine: insight
        }).catch((err) => console.warn("watchlist alert failed:", err.message));

        await run(`
          UPDATE watchlist
          SET last_alert_at = ?
          WHERE id = ?
        `, [now(), item.id]);
      }

      await run(`
        UPDATE watchlist
        SET last_price_usd = ?,
            last_market_cap = ?,
            last_liquidity = ?,
            last_buys = ?,
            last_sells = ?
        WHERE id = ?
      `, [price, mc, liq, buys, sells, item.id]);
    }
  } catch (err) {
    console.error("notifyWatchlistMoves error:", err.message);
  }
}

async function whaleTrackerHeartbeat() {
  try {
    const enabledCount = await get(`
      SELECT COUNT(*) AS count
      FROM users
      WHERE whale_enabled = 1 AND alerts_enabled = 1
    `);

    if (!enabledCount?.count) return;

    // placeholder for future wallet feed integration
  } catch (err) {
    console.error("whaleTrackerHeartbeat error:", err.message);
  }
}

// ==============================
// BOOT + LOOPS
// ==============================
(async () => {
  try {
    await initDb();

    console.log("🧠 Gorktimus Intelligence Terminal Running...");
    console.log("🖼️ Menu image exists:", fs.existsSync(MENU_IMAGE_PATH));
    console.log("⏱️ Poll interval ms:", ALERT_POLL_MS);

    const booted = await getState("booted_once");
    if (!booted) {
      await setState("booted_once", "1");
    }

    setInterval(async () => {
      await notifyUsersForTrending();
    }, ALERT_POLL_MS);

    setInterval(async () => {
      await notifyUsersForNewPairs();
    }, ALERT_POLL_MS + 12000);

    setInterval(async () => {
      await notifyWatchlistMoves();
    }, ALERT_POLL_MS + 24000);

    setInterval(async () => {
      await whaleTrackerHeartbeat();
    }, ALERT_POLL_MS + 36000);

    if (ADMIN_CHAT_ID) {
      await sendSimple(
        ADMIN_CHAT_ID,
        `✅ <b>Gorktimus booted successfully.</b>\n\n` +
        `Trending scanner: live\n` +
        `New launch scanner: live\n` +
        `Watchlist engine: live\n` +
        `Whale tracker UX: ready`
      ).catch(() => {});
    }
  } catch (err) {
    console.error("❌ Boot error:", err);
    process.exit(1);
  }
})();
