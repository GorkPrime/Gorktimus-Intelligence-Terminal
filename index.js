console.log("🚨 NEW BUILD DEPLOYED 🚨");
process.exit(1);const { Telegraf, Markup } = require("telegraf");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN env var.");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

const STORAGE_PATH = path.join(__dirname, "storage.json");
const POLL_MS = 30 * 1000;

// -------------------- Storage --------------------
function defaultStorage() {
  return {
    watch: [],
    priceAlerts: [],
    mod: {
      enabledChats: [],
      blockLinks: true,
      blockForwarded: false,
      blockInviteLinks: true,
      blockWords: ["airdrop", "claim", "seed phrase", "connect wallet"],
      maxMsgsPerWindow: 6,
      windowSeconds: 8,
      muteSeconds: 600,

      // NEW: verification gate
      verifyNewMembers: true,
      verifyTimeoutSeconds: 1800,
      welcomeText: "👋 Welcome to Prime Zone, {name}.\nTap Verify to unlock chat."
    },
    pendingVerifications: [] // {chatId, userId, createdAt}
  };
}

function loadStorage() {
  try {
    const raw = fs.readFileSync(STORAGE_PATH, "utf8");
    const data = JSON.parse(raw);

    data.watch = Array.isArray(data.watch) ? data.watch : [];
    data.priceAlerts = Array.isArray(data.priceAlerts) ? data.priceAlerts : [];
    data.mod = data.mod || defaultStorage().mod;
    data.mod.enabledChats = Array.isArray(data.mod.enabledChats) ? data.mod.enabledChats : [];
    data.pendingVerifications = Array.isArray(data.pendingVerifications) ? data.pendingVerifications : [];

    // Ensure new keys exist
    if (typeof data.mod.verifyNewMembers !== "boolean") data.mod.verifyNewMembers = true;
    if (!Number.isFinite(Number(data.mod.verifyTimeoutSeconds))) data.mod.verifyTimeoutSeconds = 1800;
    if (typeof data.mod.welcomeText !== "string") data.mod.welcomeText = defaultStorage().mod.welcomeText;

    return data;
  } catch {
    return defaultStorage();
  }
}

function saveStorage(data) {
  fs.writeFileSync(STORAGE_PATH, JSON.stringify(data, null, 2));
}

function formatUSD(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "N/A";
  const num = Number(n);
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(2)}K`;
  return `$${num.toFixed(2)}`;
}

// -------------------- DexScreener --------------------
async function fetchDex(query) {
  const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`;
  const { data } = await axios.get(url, { timeout: 15000 });
  return Array.isArray(data?.pairs) ? data.pairs : [];
}

// -------------------- Risk scoring --------------------
// riskPercent: higher = more risk
function computeRisk(pair) {
  let safetyScore = 100;

  const liq = Number(pair?.liquidity?.usd ?? 0);
  const vol24 = Number(pair?.volume?.h24 ?? 0);
  const change5m = Number(pair?.priceChange?.m5 ?? 0);
  const ageMs = Date.now() - Number(pair?.pairCreatedAt ?? Date.now());
  const ageHours = ageMs / (1000 * 60 * 60);

  if (liq < 20000) safetyScore -= 30;
  else if (liq < 50000) safetyScore -= 15;

  if (vol24 < 10000) safetyScore -= 20;

  if (Math.abs(change5m) > 30) safetyScore -= 10;

  if (ageHours < 24) safetyScore -= 10;

  safetyScore = Math.max(0, Math.min(100, safetyScore));
  const riskPercent = Math.max(0, Math.min(100, 100 - safetyScore));

  let label = "✅ Lower (relative)";
  if (riskPercent >= 40) label = "⚠️ Medium";
  if (riskPercent >= 60) label = "🚨 High";

  return { riskPercent, label, ageHours };
}

// -------------------- CoinGecko (simple majors) --------------------
const CG_IDS = { SOL: "solana", BTC: "bitcoin", ETH: "ethereum", XRP: "ripple" };

async function fetchCoinGeckoUSD(symbol) {
  const id = CG_IDS[String(symbol).toUpperCase()];
  if (!id) return null;
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd`;
  const { data } = await axios.get(url, { timeout: 15000 });
  const usd = data?.[id]?.usd;
  return typeof usd === "number" ? usd : null;
}

// -------------------- Moderator helpers --------------------
async function isAdmin(ctx) {
  try {
    const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    return member?.status === "administrator" || member?.status === "creator";
  } catch {
    return false;
  }
}

function modEnabledForChat(data, chatId) {
  return data.mod.enabledChats.includes(String(chatId));
}

function containsBlockedWord(text, blockedWords) {
  const t = String(text || "").toLowerCase();
  return (blockedWords || []).some((w) => t.includes(String(w).toLowerCase()));
}

function containsLink(text) {
  const t = String(text || "");
  return /(https?:\/\/|www\.|t\.me\/|telegram\.me\/)/i.test(t);
}

// Flood control memory (MVP)
const msgBuckets = new Map(); // chatId:userId -> {count, windowStart}

// -------------------- Commands --------------------
bot.start((ctx) => {
  ctx.reply(
    "🤖 Prime Bot online.\n\n" +
      "Token tools:\n/scan <token>\n/score <token>\n/watch <token>\n/unwatch <token>\n/watchlist\n\n" +
      "Price alerts:\n/alert <SYMBOL> <PRICE>  (ex: /alert SOL 85)\n/alerts\n/delalert <ID>\n\n" +
      "Moderator (groups):\n/mod_on\n/mod_off\n/mod_status\n/verify_on\n/verify_off\n/verify_status"
  );
});

// -------- scan + risk% included
bot.command("scan", async (ctx) => {
  try {
    const q = ctx.message.text.split(" ").slice(1).join(" ").trim();
    if (!q) return ctx.reply("Usage: /scan <token address | pair | symbol>");

    const pairs = await fetchDex(q);
    if (!pairs.length) return ctx.reply("No results found on DexScreener.");

    const p = pairs[0];
    const r = computeRisk(p);

    const msg =
      `🔎 Scan Result\n` +
      `Pair: ${p.baseToken?.symbol ?? "?"}/${p.quoteToken?.symbol ?? "?"}\n` +
      `Chain: ${p.chainId ?? "?"} | DEX: ${p.dexId ?? "?"}\n` +
      `Risk: ${r.riskPercent}% (${r.label})\n` +
      `Liquidity: ${formatUSD(p.liquidity?.usd)}\n` +
      `Vol (24h): ${formatUSD(p.volume?.h24)}\n` +
      `Price Change: 5m ${p.priceChange?.m5 ?? "N/A"}% | 1h ${p.priceChange?.h1 ?? "N/A"}% | 24h ${p.priceChange?.h24 ?? "N/A"}%\n` +
      `Age: ${r.ageHours.toFixed(1)} hours\n` +
      `Link: ${p.url ?? "N/A"}`;

    return ctx.reply(msg);
  } catch (e) {
    console.error(e);
    return ctx.reply("Error scanning right now. Try again in a minute.");
  }
});

bot.command("score", async (ctx) => {
  try {
    const q = ctx.message.text.split(" ").slice(1).join(" ").trim();
    if (!q) return ctx.reply("Usage: /score <token address | pair | symbol>");

    const pairs = await fetchDex(q);
    if (!pairs.length) return ctx.reply("No results found on DexScreener.");

    const p = pairs[0];
    const r = computeRisk(p);

    return ctx.reply(
      `🧠 Prime Risk\nToken: ${p.baseToken?.symbol ?? "?"}\nRisk: ${r.riskPercent}% (${r.label})\n` +
        `Liquidity: ${formatUSD(p.liquidity?.usd)} | Vol24: ${formatUSD(p.volume?.h24)}\n` +
        `Age: ${r.ageHours.toFixed(1)} hours\nLink: ${p.url ?? "N/A"}\n\n` +
        `Note: Risk indicator only — not financial advice.`
    );
  } catch (e) {
    console.error(e);
    return ctx.reply("Error scoring right now. Try again in a minute.");
  }
});

// -------- Dex watch
bot.command("watch", (ctx) => {
  const q = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!q) return ctx.reply("Usage: /watch <token address | pair | symbol>");

  const data = loadStorage();
  const chatId = ctx.chat.id;

  const exists = data.watch.find(
    (x) => String(x.chatId) === String(chatId) && x.query.toLowerCase() === q.toLowerCase()
  );
  if (exists) return ctx.reply("Already watching that token.");

  data.watch.push({ chatId, query: q.trim(), last: { liq: null, vol24: null, priceUsd: null } });
  saveStorage(data);
  return ctx.reply(`✅ Watching: ${q}\nI’ll alert you on big changes.`);
});

bot.command("unwatch", (ctx) => {
  const q = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!q) return ctx.reply("Usage: /unwatch <token>");

  const data = loadStorage();
  const chatId = ctx.chat.id;
  const before = data.watch.length;

  data.watch = data.watch.filter(
    (x) => !(String(x.chatId) === String(chatId) && x.query.toLowerCase() === q.toLowerCase())
  );
  saveStorage(data);

  if (data.watch.length === before) return ctx.reply("Not found.");
  return ctx.reply(`🗑️ Removed: ${q}`);
});

bot.command("watchlist", (ctx) => {
  const data = loadStorage();
  const chatId = ctx.chat.id;
  const mine = data.watch.filter((x) => String(x.chatId) === String(chatId));
  if (!mine.length) return ctx.reply("Empty. Use /watch <token>");

  return ctx.reply(`📌 Watchlist:\n${mine.map((x, i) => `${i + 1}. ${x.query}`).join("\n")}`);
});

// -------- Price alerts (SOL etc.)
bot.command("alert", async (ctx) => {
  try {
    const parts = ctx.message.text.split(" ").map((s) => s.trim()).filter(Boolean);
    if (parts.length < 3) return ctx.reply("Usage: /alert <SYMBOL> <PRICE>\nExample: /alert SOL 85");

    const symbol = parts[1].toUpperCase();
    const target = Number(parts[2]);

    if (!Number.isFinite(target) || target <= 0) return ctx.reply("Price must be a number > 0.");
    if (!CG_IDS[symbol]) return ctx.reply(`Supported symbols: ${Object.keys(CG_IDS).join(", ")}`);

    const current = await fetchCoinGeckoUSD(symbol);
    if (current === null) return ctx.reply("Could not fetch price right now.");

    const data = loadStorage();
    const chatId = ctx.chat.id;
    const id = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    data.priceAlerts.push({ id, chatId, symbol, target, createdAt: Date.now() });
    saveStorage(data);

    return ctx.reply(`✅ Alert set (#${id})\n${symbol} now: $${current}\nNotify when ${symbol} >= $${target}`);
  } catch (e) {
    console.error(e);
    return ctx.reply("Error setting alert.");
  }
});

bot.command("alerts", (ctx) => {
  const data = loadStorage();
  const chatId = ctx.chat.id;
  const mine = data.priceAlerts.filter((x) => String(x.chatId) === String(chatId));
  if (!mine.length) return ctx.reply("No alerts. Use /alert SOL 85");

  return ctx.reply(`📣 Alerts:\n${mine.map((a) => `#${a.id} — ${a.symbol} >= $${a.target}`).join("\n")}\n\nRemove: /delalert <ID>`);
});

bot.command("delalert", (ctx) => {
  const parts = ctx.message.text.split(" ").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return ctx.reply("Usage: /delalert <ID>");

  const id = parts[1];
  const data = loadStorage();
  const chatId = ctx.chat.id;

  const before = data.priceAlerts.length;
  data.priceAlerts = data.priceAlerts.filter((a) => !(String(a.chatId) === String(chatId) && String(a.id) === String(id)));
  saveStorage(data);

  if (data.priceAlerts.length === before) return ctx.reply("Alert ID not found.");
  return ctx.reply(`🗑️ Removed alert #${id}`);
});

// -------- Moderator toggles
bot.command("mod_on", async (ctx) => {
  if (ctx.chat.type === "private") return ctx.reply("Moderator mode is for groups.");
  if (!(await isAdmin(ctx))) return ctx.reply("Admins only.");

  const data = loadStorage();
  const chatId = String(ctx.chat.id);
  if (!data.mod.enabledChats.includes(chatId)) data.mod.enabledChats.push(chatId);
  saveStorage(data);
  return ctx.reply("🛡️ Prime Moderator: ON");
});

bot.command("mod_off", async (ctx) => {
  if (ctx.chat.type === "private") return ctx.reply("Moderator mode is for groups.");
  if (!(await isAdmin(ctx))) return ctx.reply("Admins only.");

  const data = loadStorage();
  const chatId = String(ctx.chat.id);
  data.mod.enabledChats = data.mod.enabledChats.filter((x) => x !== chatId);
  saveStorage(data);
  return ctx.reply("🛡️ Prime Moderator: OFF");
});

bot.command("mod_status", (ctx) => {
  const data = loadStorage();
  return ctx.reply(`🛡️ Moderator is ${modEnabledForChat(data, String(ctx.chat.id)) ? "ON" : "OFF"} in this chat.`);
});

// -------- Verification toggles
bot.command("verify_on", async (ctx) => {
  if (ctx.chat.type === "private") return ctx.reply("Verification is for groups.");
  if (!(await isAdmin(ctx))) return ctx.reply("Admins only.");

  const data = loadStorage();
  data.mod.verifyNewMembers = true;
  saveStorage(data);
  return ctx.reply("✅ New member verification: ON");
});

bot.command("verify_off", async (ctx) => {
  if (ctx.chat.type === "private") return ctx.reply("Verification is for groups.");
  if (!(await isAdmin(ctx))) return ctx.reply("Admins only.");

  const data = loadStorage();
  data.mod.verifyNewMembers = false;
  saveStorage(data);
  return ctx.reply("✅ New member verification: OFF");
});

bot.command("verify_status", (ctx) => {
  const data = loadStorage();
  return ctx.reply(`✅ New member verification is ${data.mod.verifyNewMembers ? "ON" : "OFF"}.`);
});

// -------------------- Welcome + Verify (NEW) --------------------
async function muteUser(chatId, userId) {
  // mute: cannot send anything
  return bot.telegram.restrictChatMember(chatId, userId, {
    permissions: {
      can_send_messages: false,
      can_send_media_messages: false,
      can_send_polls: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false,
      can_change_info: false,
      can_invite_users: false,
      can_pin_messages: false
    }
  });
}

async function unmuteUser(chatId, userId) {
  // restore: allow sending messages (basic)
  return bot.telegram.restrictChatMember(chatId, userId, {
    permissions: {
      can_send_messages: true,
      can_send_media_messages: true,
      can_send_polls: true,
      can_send_other_messages: true,
      can_add_web_page_previews: true,
      can_invite_users: true
    }
  });
}

bot.on("new_chat_members", async (ctx) => {
  try {
    const data = loadStorage();
    const chatId = String(ctx.chat.id);

    // Only run verification when moderator is ON for this chat AND verifyNewMembers is true
    if (!modEnabledForChat(data, chatId)) return;
    if (!data.mod.verifyNewMembers) return;

    for (const member of ctx.message.new_chat_members) {
      // ignore bots
      if (member.is_bot) continue;

      // mute them until verified
      await muteUser(ctx.chat.id, member.id).catch(() => {});

      // store pending verification
      data.pendingVerifications.push({ chatId, userId: String(member.id), createdAt: Date.now() });
      saveStorage(data);

      const name = member.first_name || "friend";
      const welcome = String(data.mod.welcomeText || "Welcome to Prime Zone, {name}.")
        .replace("{name}", name);

      const payload = `${chatId}:${member.id}`;

      await ctx.reply(
        welcome,
        Markup.inlineKeyboard([
          Markup.button.callback("✅ Verify", `verify:${payload}`)
        ])
      );
    }
  } catch (e) {
    console.error("new member verify error", e?.message || e);
  }
});

bot.action(/^verify:(.+)$/i, async (ctx) => {
  try {
    const data = loadStorage();
    const payload = String(ctx.match[1] || "");
    const [chatId, userId] = payload.split(":");

    // must be the same user clicking their button
    if (String(ctx.from.id) !== String(userId)) {
      return ctx.answerCbQuery("This verify button isn’t for you.", { show_alert: true });
    }

    // check pending exists
    const exists = data.pendingVerifications.find(
      (v) => String(v.chatId) === String(chatId) && String(v.userId) === String(userId)
    );
    if (!exists) {
      return ctx.answerCbQuery("Verification expired or already completed.", { show_alert: true });
    }

    await unmuteUser(Number(chatId), Number(userId)).catch(() => {});
    data.pendingVerifications = data.pendingVerifications.filter(
      (v) => !(String(v.chatId) === String(chatId) && String(v.userId) === String(userId))
    );
    saveStorage(data);

    await ctx.answerCbQuery("Verified ✅");
    return ctx.editMessageText("✅ Verified. Welcome to Prime Zone.");
  } catch (e) {
    console.error("verify action error", e?.message || e);
    return ctx.answerCbQuery("Error verifying. Try again.", { show_alert: true });
  }
});

// -------------------- Moderation middleware --------------------
bot.on("message", async (ctx, next) => {
  try {
    const data = loadStorage();
    const chatId = String(ctx.chat.id);
    if (!modEnabledForChat(data, chatId)) return next();

    // skip admins
    const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    if (member?.status === "administrator" || member?.status === "creator") return next();

    const text = ctx.message?.text || ctx.message?.caption || "";
    const isForwarded = !!ctx.message?.forward_date;

    if (data.mod.blockForwarded && isForwarded) {
      await ctx.deleteMessage().catch(() => {});
      return;
    }

    if (text && containsBlockedWord(text, data.mod.blockWords || [])) {
      await ctx.deleteMessage().catch(() => {});
      return;
    }

    if (data.mod.blockLinks && text && containsLink(text)) {
      await ctx.deleteMessage().catch(() => {});
      return;
    }

    // Flood
    const key = `${chatId}:${ctx.from.id}`;
    const now = Date.now();
    const windowMs = (data.mod.windowSeconds || 8) * 1000;

    const bucket = msgBuckets.get(key) || { count: 0, windowStart: now };
    if (now - bucket.windowStart > windowMs) {
      bucket.count = 0;
      bucket.windowStart = now;
    }
    bucket.count += 1;
    msgBuckets.set(key, bucket);

    if (bucket.count > (data.mod.maxMsgsPerWindow || 6)) {
      const muteSeconds = data.mod.muteSeconds || 600;
      const untilDate = Math.floor(Date.now() / 1000) + muteSeconds;

      await ctx.telegram.restrictChatMember(ctx.chat.id, ctx.from.id, {
        permissions: {
          can_send_messages: false,
          can_send_media_messages: false,
          can_send_polls: false,
          can_send_other_messages: false,
          can_add_web_page_previews: false,
          can_change_info: false,
          can_invite_users: false,
          can_pin_messages: false
        },
        until_date: untilDate
      }).catch(() => {});

      await ctx.reply(`🚫 Muted for ${muteSeconds}s (spam/flood).`).catch(() => {});
      return;
    }

    return next();
  } catch (e) {
    console.error("moderation error", e?.message || e);
    return next();
  }
});

// -------------------- Alert loops --------------------
async function runDexWatchAlerts() {
  const data = loadStorage();
  if (!data.watch.length) return;

  for (const item of data.watch) {
    try {
      const pairs = await fetchDex(item.query);
      if (!pairs.length) continue;

      const p = pairs[0];
      const priceUsd = Number(p?.priceUsd ?? 0);
      const liq = Number(p?.liquidity?.usd ?? 0);
      const vol24 = Number(p?.volume?.h24 ?? 0);

      const last = item.last || { liq: null, vol24: null, priceUsd: null };
      const alerts = [];

      // price move since last poll: ±8%
      if (last.priceUsd && priceUsd) {
        const pct = ((priceUsd - last.priceUsd) / last.priceUsd) * 100;
        if (Math.abs(pct) >= 8) alerts.push(`⚡ Price moved ~${pct.toFixed(1)}% since last check`);
      }

      // liquidity drop 20%
      if (last.liq && liq) {
        const drop = ((last.liq - liq) / last.liq) * 100;
        if (drop >= 20) alerts.push(`💧 Liquidity dropped ~${drop.toFixed(1)}%`);
      }

      // volume spike 50%
      if (last.vol24 && vol24 && last.vol24 > 0) {
        const up = ((vol24 - last.vol24) / last.vol24) * 100;
        if (up >= 50) alerts.push(`📈 24h volume jumped ~${up.toFixed(1)}%`);
      }

      if (alerts.length) {
        const r = computeRisk(p);
        const msg =
          `🚨 Prime Watch Alert (${p.baseToken?.symbol ?? "?"})\n` +
          `${alerts.join("\n")}\n` +
          `Risk: ${r.riskPercent}% (${r.label})\n` +
          `Price: ${priceUsd ? `$${priceUsd}` : "N/A"} | Liq: ${formatUSD(liq)} | Vol24: ${formatUSD(vol24)}\n` +
          `Link: ${p.url ?? "N/A"}`;
        await bot.telegram.sendMessage(item.chatId, msg);
      }

      item.last = { liq, vol24, priceUsd };
    } catch (e) {
      console.error("dex watch error", item.query, e?.message || e);
    }
  }

  saveStorage(data);
}

async function runPriceAlerts() {
  const data = loadStorage();
  if (!data.priceAlerts.length) return;

  const bySymbol = {};
  for (const a of data.priceAlerts) {
    bySymbol[a.symbol] = bySymbol[a.symbol] || [];
    bySymbol[a.symbol].push(a);
  }

  const toRemove = new Set();

  for (const symbol of Object.keys(bySymbol)) {
    try {
      const current = await fetchCoinGeckoUSD(symbol);
      if (current === null) continue;

      for (const alert of bySymbol[symbol]) {
        if (current >= alert.target) {
          await bot.telegram.sendMessage(
            alert.chatId,
            `🎯 Price Alert HIT\n${symbol} is now ~$${current}\nTarget was: $${alert.target}\nAlert ID: #${alert.id}`
          );
          toRemove.add(alert.id);
        }
      }
    } catch (e) {
      console.error("price alert error", symbol, e?.message || e);
    }
  }

  if (toRemove.size) {
    data.priceAlerts = data.priceAlerts.filter((a) => !toRemove.has(a.id));
    saveStorage(data);
  }
}

// Cleanup expired verifications (optional)
function cleanupVerifications() {
  const data = loadStorage();
  const ttlMs = (data.mod.verifyTimeoutSeconds || 1800) * 1000;
  const now = Date.now();
  const before = data.pendingVerifications.length;

  data.pendingVerifications = data.pendingVerifications.filter((v) => (now - v.createdAt) <= ttlMs);

  if (data.pendingVerifications.length !== before) saveStorage(data);
}

setInterval(() => {
  runDexWatchAlerts().catch(() => {});
  runPriceAlerts().catch(() => {});
  cleanupVerifications();
}, POLL_MS);

// -------------------- Launch --------------------
bot.launch();
console.log("Prime Bot running...");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
