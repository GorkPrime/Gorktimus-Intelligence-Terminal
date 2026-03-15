const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");

// ================= ENV =================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";
const COMMUNITY_X_URL = process.env.COMMUNITY_X_URL || "https://x.com/gorktimusprime";
const COMMUNITY_TELEGRAM_URL =
  process.env.COMMUNITY_TELEGRAM_URL || "https://t.me/GorktimusPrime";
const REQUIRED_CHANNEL = process.env.REQUIRED_CHANNEL || "@GorktimusPrime";

if (!BOT_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN not set");
  process.exit(1);
}

// ================= CONFIG =================
const TERMINAL_IMG = path.join(__dirname, "assets", "gorktimus_terminal.png");
const DB_PATH = path.join(__dirname, "gorktimus.db");

const SUPPORTED_CHAINS = ["solana", "base", "ethereum"];
const PRIME_MIN_LIQ_USD = 30000;
const PRIME_MIN_VOL_USD = 20000;
const PRIME_MIN_AGE_MIN = 30;

const LAUNCH_MIN_LIQ_USD = 5000;
const LAUNCH_MIN_VOL_USD = 1000;

const WALLET_SCAN_INTERVAL_MS = 20000;
const DEX_TIMEOUT_MS = 15000;
const HELIUS_TIMEOUT_MS = 20000;
const TELEGRAM_SEND_RETRY_MS = 900;

const ETHERSCAN_V2_URL = "https://api.etherscan.io/v2/api";
const HONEYPOT_API_BASE = "https://api.honeypot.is";

const EVM_CHAIN_IDS = {
  ethereum: 1,
  base: 8453
};

// ================= GLOBALS =================
const db = new sqlite3.Database(DB_PATH);
const pendingAction = new Map();
let bot = null;
let walletScanInterval = null;
let walletScanRunning = false;
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
    CREATE TABLE IF NOT EXISTS wallet_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      wallet TEXT NOT NULL,
      label_type TEXT NOT NULL, -- whale | dev
      nickname TEXT,
      chain_id TEXT DEFAULT 'solana',
      active INTEGER DEFAULT 1,
      alerts_enabled INTEGER DEFAULT 1,
      last_signature TEXT,
      last_seen_at INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(chat_id, wallet, label_type)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS app_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      is_subscribed INTEGER DEFAULT 0,
      subscribed_checked_at INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(chat_id, user_id)
    )
  `);

  await run(`CREATE INDEX IF NOT EXISTS idx_app_users_chat_id ON app_users(chat_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_app_users_user_id ON app_users(user_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_app_users_subscribed ON app_users(is_subscribed)`);
}

// ================= HELPERS =================
function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function shortUsd(n) {
  const x = num(n);
  if (x >= 1_000_000_000) return `$${(x / 1_000_000_000).toFixed(2)}B`;
  if (x >= 1_000_000) return `$${(x / 1_000_000).toFixed(2)}M`;
  if (x >= 1_000) return `$${(x / 1_000).toFixed(2)}K`;
  if (x >= 1) return `$${x.toFixed(4)}`;
  return `$${x.toFixed(8)}`;
}

function shortAddr(value, len = 6) {
  const s = String(value || "");
  if (s.length <= len * 2 + 3) return s;
  return `${s.slice(0, len)}...${s.slice(-len)}`;
}

function clip(value, len = 28) {
  const s = String(value || "");
  if (s.length <= len) return s;
  return `${s.slice(0, len - 1)}…`;
}

function toPct(value, digits = 2) {
  return `${num(value).toFixed(digits)}%`;
}

function sum(arr = []) {
  return arr.reduce((a, b) => a + num(b), 0);
}

function isAddressLike(text) {
  const t = String(text || "").trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t) || /^0x[a-fA-F0-9]{40}$/.test(t);
}

function isLikelySolanaWallet(text) {
  const t = String(text || "").trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t);
}

function hasHelius() {
  return !!HELIUS_API_KEY;
}

function hasEtherscanKey() {
  return !!ETHERSCAN_API_KEY;
}

function supportsChain(chainId) {
  return SUPPORTED_CHAINS.includes(String(chainId || "").toLowerCase());
}

function isEvmChain(chainId) {
  const c = String(chainId || "").toLowerCase();
  return c === "ethereum" || c === "base";
}

function humanChain(chainId) {
  const c = String(chainId || "").toLowerCase();
  if (c === "solana") return "Solana";
  if (c === "base") return "Base";
  if (c === "ethereum") return "Ethereum";
  return clip(c, 18) || "Unknown";
}

function buildGeneratedStamp() {
  return "Generated: just now";
}

function ageMinutesFromMs(createdAtMs) {
  const ms = num(createdAtMs, 0);
  if (!ms) return 0;
  return Math.max(0, Math.floor((Date.now() - ms) / 60000));
}

function formatLaunchDate(createdAtMs) {
  const ms = num(createdAtMs, 0);
  if (!ms) return "Unknown";
  const d = new Date(ms);
  return d.toLocaleString("en-US", {
    month: "short",
    year: "numeric"
  });
}

function ageFromMs(createdAtMs) {
  const ms = num(createdAtMs, 0);
  if (!ms) return "N/A";

  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  const diffMin = Math.floor(diffSec / 60);
  const diffHrs = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHrs / 24);

  if (diffMin < 60) return `${diffMin}m`;
  if (diffHrs < 24) return `${diffHrs}h`;
  if (diffDays < 30) return `${diffDays}d`;

  return formatLaunchDate(createdAtMs);
}

function makeDexUrl(chainId, pairAddress, fallbackUrl = "") {
  if (fallbackUrl) return fallbackUrl;
  if (!chainId || !pairAddress) return "";
  return `https://dexscreener.com/${encodeURIComponent(chainId)}/${encodeURIComponent(pairAddress)}`;
}

function makeBirdeyeUrl(chainId, tokenAddress) {
  const chain = String(chainId || "").toLowerCase();
  const token = String(tokenAddress || "").trim();
  if (!token) return "";
  if (chain === "solana") {
    return `https://birdeye.so/token/${encodeURIComponent(token)}?chain=solana`;
  }
  if (chain === "base") {
    return `https://birdeye.so/token/${encodeURIComponent(token)}?chain=base`;
  }
  if (chain === "ethereum") {
    return `https://birdeye.so/token/${encodeURIComponent(token)}?chain=ethereum`;
  }
  return "";
}

function makeGeckoUrl(chainId, pairAddress) {
  const chain = String(chainId || "").toLowerCase();
  const pair = String(pairAddress || "").trim();
  if (!pair) return "";
  if (chain === "solana") {
    return `https://www.geckoterminal.com/solana/pools/${encodeURIComponent(pair)}`;
  }
  if (chain === "base") {
    return `https://www.geckoterminal.com/base/pools/${encodeURIComponent(pair)}`;
  }
  if (chain === "ethereum") {
    return `https://www.geckoterminal.com/eth/pools/${encodeURIComponent(pair)}`;
  }
  return "";
}

// ================= SUBSCRIPTION HELPERS =================
async function upsertAppUser(msgOrQueryMessage) {
  try {
    const chat = msgOrQueryMessage?.chat;
    const from = msgOrQueryMessage?.from;
    if (!chat || !from) return;

    const ts = nowTs();

    await run(
      `
      INSERT INTO app_users
      (chat_id, user_id, username, first_name, last_name, is_subscribed, subscribed_checked_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
      ON CONFLICT(chat_id, user_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        updated_at = excluded.updated_at
      `,
      [
        String(chat.id),
        String(from.id),
        from.username || "",
        from.first_name || "",
        from.last_name || "",
        ts,
        ts
      ]
    );
  } catch (err) {
    console.log("upsertAppUser error:", err.message);
  }
}

async function markUserSubscription(chatId, userId, isSubscribed) {
  try {
    await run(
      `
      UPDATE app_users
      SET is_subscribed = ?, subscribed_checked_at = ?, updated_at = ?
      WHERE chat_id = ? AND user_id = ?
      `,
      [isSubscribed ? 1 : 0, nowTs(), nowTs(), String(chatId), String(userId)]
    );
  } catch (err) {
    console.log("markUserSubscription error:", err.message);
  }
}

async function getBotUserCount() {
  const row = await get(`SELECT COUNT(*) AS c FROM app_users`);
  return row?.c || 0;
}

async function getVerifiedSubscriberBotUserCount() {
  const row = await get(`SELECT COUNT(*) AS c FROM app_users WHERE is_subscribed = 1`);
  return row?.c || 0;
}

async function getRequiredChannelMemberCount() {
  try {
    return await bot.getChatMemberCount(REQUIRED_CHANNEL);
  } catch (err) {
    console.log("getRequiredChannelMemberCount error:", err.message);
    return null;
  }
}

async function isUserSubscribed(userId) {
  try {
    const member = await bot.getChatMember(REQUIRED_CHANNEL, userId);
    const status = String(member?.status || "").toLowerCase();

    const okStatuses = ["member", "administrator", "creator"];
    const subscribed = okStatuses.includes(status);

    return {
      subscribed,
      status
    };
  } catch (err) {
    console.log(`isUserSubscribed error for ${userId}:`, err.message);
    return {
      subscribed: false,
      status: "unknown"
    };
  }
}

function buildSubscriptionKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📢 Join Channel", url: COMMUNITY_TELEGRAM_URL }],
        [{ text: "✅ I Joined / Check Again", callback_data: "check_subscription" }]
      ]
    }
  };
}

async function sendSubscriptionGate(chatId) {
  const text = [
    `🧠 <b>Gorktimus Intelligence Terminal</b>`,
    ``,
    `🔒 <b>Subscription Required</b>`,
    ``,
    `You must join the Gorktimus channel before using the bot.`,
    ``,
    `1. Tap <b>Join Channel</b>`,
    `2. Join the channel`,
    `3. Tap <b>I Joined / Check Again</b>`,
    ``,
    `Required channel: ${escapeHtml(REQUIRED_CHANNEL)}`
  ].join("\n");

  await sendText(chatId, text, buildSubscriptionKeyboard());
}

async function enforceSubscription(messageLike) {
  const chatId = messageLike?.chat?.id;
  const userId = messageLike?.from?.id;

  if (!chatId || !userId) return false;

  await upsertAppUser(messageLike);

  const sub = await isUserSubscribed(userId);
  await markUserSubscription(chatId, userId, sub.subscribed);

  if (!sub.subscribed) {
    pendingAction.delete(chatId);
    await sendSubscriptionGate(chatId);
    return false;
  }

  return true;
}

// ================= UI BUILDERS =================
function buildMainMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🔎 Scan Token", callback_data: "scan_token" },
          { text: "📈 Trending", callback_data: "trending" }
        ],
        [
          { text: "📡 Launch Radar", callback_data: "launch_radar" },
          { text: "⭐ Prime Picks", callback_data: "prime_picks" }
        ],
        [
          { text: "🐋 Whale Tracker", callback_data: "whale_menu" },
          { text: "❓ Help", callback_data: "help_menu" }
        ]
      ]
    }
  };
}

function buildHelpMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📊 System Status", callback_data: "help_status" }],
        [{ text: "📖 How To Use", callback_data: "help_how" }],
        [{ text: "⚙️ Data Sources", callback_data: "help_sources" }],
        [{ text: "💬 Contact / Community", callback_data: "help_community" }],
        [{ text: "🏠 Main Menu", callback_data: "main_menu" }]
      ]
    }
  };
}

function buildWhaleMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "➕ Add Whale", callback_data: "add_whale" },
          { text: "📋 Whale List", callback_data: "whale_list" }
        ],
        [
          { text: "➕ Add Dev Wallet", callback_data: "add_dev" },
          { text: "📋 Dev List", callback_data: "dev_list" }
        ],
        [
          { text: "🔍 Check Wallet", callback_data: "check_wallet" },
          { text: "⚙️ Alert Settings", callback_data: "wallet_alert_settings" }
        ],
        [{ text: "🏠 Main Menu", callback_data: "main_menu" }]
      ]
    }
  };
}

function buildMainMenuOnlyButton() {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: "main_menu" }]]
    }
  };
}

function buildRefreshMainButtons(refreshCallback) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔄 Refresh", callback_data: refreshCallback }],
        [{ text: "🏠 Main Menu", callback_data: "main_menu" }]
      ]
    }
  };
}

function buildScanButtons() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔎 Scan Another", callback_data: "scan_token" }],
        [{ text: "🏠 Main Menu", callback_data: "main_menu" }]
      ]
    }
  };
}

function buildWalletListMenu(rows, type) {
  const buttons = rows.map((row) => [
    {
      text: `${type === "whale" ? "🐋" : "👤"} ${clip(row.nickname || shortAddr(row.wallet, 6), 28)}`,
      callback_data: `wallet_item:${row.id}`
    }
  ]);

  buttons.push([{ text: "🏠 Main Menu", callback_data: "main_menu" }]);

  return {
    reply_markup: {
      inline_keyboard: buttons
    }
  };
}

function buildWalletItemMenu(row) {
  const toggleText = row.alerts_enabled ? "⛔ Alerts Off" : "✅ Alerts On";
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: toggleText, callback_data: `wallet_toggle:${row.id}` }],
        [{ text: "🔍 Check Now", callback_data: `wallet_check:${row.id}` }],
        [{ text: "✏️ Rename", callback_data: `wallet_rename:${row.id}` }],
        [{ text: "❌ Remove", callback_data: `wallet_remove:${row.id}` }],
        [{ text: "🏠 Main Menu", callback_data: "main_menu" }]
      ]
    }
  };
}

// ================= TELEGRAM SENDERS =================
async function sendMessageWithRetry(chatId, text, opts, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await bot.sendMessage(chatId, text, opts);
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || "");
      const retryable =
        msg.includes("504") ||
        msg.includes("Gateway Timeout") ||
        msg.includes("429") ||
        msg.includes("Too Many Requests") ||
        msg.includes("ECONNRESET") ||
        msg.includes("ETIMEDOUT");
      if (!retryable || i === attempts) throw err;
      await sleep(TELEGRAM_SEND_RETRY_MS * i);
    }
  }
  throw lastErr;
}

async function sendPhotoWithRetry(chatId, photo, opts, attempts = 2) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await bot.sendPhoto(chatId, photo, opts);
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || "");
      const retryable =
        msg.includes("504") ||
        msg.includes("Gateway Timeout") ||
        msg.includes("429") ||
        msg.includes("Too Many Requests") ||
        msg.includes("ECONNRESET") ||
        msg.includes("ETIMEDOUT");
      if (!retryable || i === attempts) throw err;
      await sleep(TELEGRAM_SEND_RETRY_MS * i);
    }
  }
  throw lastErr;
}

async function answerCallbackSafe(queryId, text = "") {
  try {
    await bot.answerCallbackQuery(queryId, text ? { text } : {});
  } catch (err) {
    const msg = String(err?.message || "");
    if (msg.includes("query is too old") || msg.includes("query ID is invalid")) return;
    console.log("callback answer failed:", msg);
  }
}

async function sendMenu(chatId, caption, keyboard) {
  const safeCaption =
    caption ||
    "🧠 <b>Gorktimus Intelligence Terminal</b>\n\nLive intelligence. Clean execution.";

  try {
    if (!fs.existsSync(TERMINAL_IMG)) {
      await sendMessageWithRetry(chatId, safeCaption, {
        ...keyboard,
        parse_mode: "HTML",
        disable_web_page_preview: true
      });
      return;
    }

    await sendPhotoWithRetry(chatId, fs.createReadStream(TERMINAL_IMG), {
      caption: safeCaption,
      ...keyboard,
      parse_mode: "HTML"
    });
  } catch (err) {
    console.log("sendMenu fallback:", err.message);
    await sendMessageWithRetry(chatId, safeCaption, {
      ...keyboard,
      parse_mode: "HTML",
      disable_web_page_preview: true
    });
  }
}

async function sendText(chatId, text, keyboard) {
  await sendMessageWithRetry(chatId, text, {
    ...keyboard,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

async function sendCard(chatId, text, keyboard = {}, imageUrl = "") {
  const safeText = text || "🧠 <b>Gorktimus Intelligence Terminal</b>";
  if (imageUrl) {
    try {
      await sendPhotoWithRetry(chatId, imageUrl, {
        caption: safeText,
        ...keyboard,
        parse_mode: "HTML"
      });
      return;
    } catch (err) {
      console.log("sendCard image fallback:", err.message);
    }
  }

  await sendText(chatId, safeText, keyboard);
}

// ================= DEX HELPERS =================
function rankPairQuality(pair) {
  return (
    num(pair.liquidity?.usd || pair.liquidityUsd) * 4 +
    num(pair.volume?.h24 || pair.volumeH24) * 2 +
    num(pair.marketCap) +
    num(pair.txns?.m5?.buys || pair.buysM5) * 250 -
    num(pair.txns?.m5?.sells || pair.sellsM5) * 100
  );
}

function normalizePair(pair) {
  if (!pair) return null;
  return {
    chainId: String(pair.chainId || ""),
    dexId: String(pair.dexId || ""),
    pairAddress: String(pair.pairAddress || ""),
    pairCreatedAt: num(pair.pairCreatedAt || 0),
    baseSymbol: String(pair.baseToken?.symbol || pair.baseSymbol || ""),
    baseName: String(pair.baseToken?.name || pair.baseName || ""),
    baseAddress: String(pair.baseToken?.address || pair.baseAddress || ""),
    quoteSymbol: String(pair.quoteToken?.symbol || ""),
    priceUsd: num(pair.priceUsd),
    liquidityUsd: num(pair.liquidity?.usd || pair.liquidityUsd),
    volumeH24: num(pair.volume?.h24 || pair.volumeH24),
    buysM5: num(pair.txns?.m5?.buys || pair.buysM5),
    sellsM5: num(pair.txns?.m5?.sells || pair.sellsM5),
    txnsM5:
      num(pair.txns?.m5?.buys || pair.buysM5) + num(pair.txns?.m5?.sells || pair.sellsM5),
    marketCap: num(pair.marketCap || pair.fdv ||
