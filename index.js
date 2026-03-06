const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const db = new sqlite3.Database("./gorktimus.db");

// ===================== ASSETS =====================
const INTRO_IMG = path.join(__dirname, "assets", "gorktimus_intro_1280.png");

// ===================== MEMORY =====================
const watchlist = new Map();

// ===================== DATABASE =====================
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS watchlist (
      chatId TEXT,
      token TEXT
    )
  `);
});

// ===================== MENU =====================
function mainMenu() {
  return {
    inline_keyboard: [
      [
        { text: "➕ Add Watch", callback_data: "add_watch" },
        { text: "📋 Watchlist", callback_data: "watchlist" }
      ],
      [
        { text: "🌍 Global Alerts", callback_data: "global_alerts" },
        { text: "📡 Status", callback_data: "status" }
      ]
    ]
  };
}

// ===================== TERMINAL =====================
async function sendTerminal(chatId, caption, reply_markup) {
  const payload = {};
  if (reply_markup) payload.reply_markup = reply_markup;

  try {
    await bot.sendPhoto(chatId, INTRO_IMG, {
      caption,
      ...payload,
    });
  } catch (e) {
    await bot.sendMessage(chatId, caption, payload);
  }
}

// ===================== START =====================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  await sendTerminal(
    chatId,
    "🛡️ GORKTIMUS PRIME TERMINAL\nSelect an option below.",
    mainMenu()
  );
});

// ===================== BUTTON HANDLER =====================
bot.on("callback_query", async (query) => {

  const chatId = query.message.chat.id;
  const data = query.data;

  if (data === "add_watch") {
    await bot.sendMessage(chatId, "Enter token symbol or address:");
    pendingAdd.set(chatId, true);
  }

  if (data === "watchlist") {

    const tokens = [];

    for (const [key, value] of watchlist.entries()) {
      if (value.chatId === chatId) tokens.push(value.token);
    }

    if (!tokens.length) {
      return sendTerminal(chatId, "📭 Watchlist empty.", mainMenu());
    }

    await sendTerminal(
      chatId,
      "📋 Your Watchlist:\n\n" + tokens.join("\n"),
      mainMenu()
    );
  }

  if (data === "status") {
    await sendTerminal(
      chatId,
      "🟢 System Online\nScanner Active",
      mainMenu()
    );
  }

  bot.answerCallbackQuery(query.id);

});

// ===================== ADD TOKEN =====================
const pendingAdd = new Map();

bot.on("message", async (msg) => {

  const chatId = msg.chat.id;
  const text = msg.text;

  if (!pendingAdd.get(chatId)) return;

  pendingAdd.delete(chatId);

  const token = text.trim();

  const key = `${chatId}_${token}`;

  watchlist.set(key, {
    chatId,
    token,
    lastPrice: 0
  });

  db.run(
    "INSERT INTO watchlist (chatId, token) VALUES (?, ?)",
    [chatId, token]
  );

  await bot.sendMessage(chatId, `✅ Added ${token} to watchlist`);

});

// ===================== FETCH TOKEN =====================
async function fetchToken(token) {

  try {

    const url = `https://api.dexscreener.com/latest/dex/search/?q=${token}`;

    const res = await axios.get(url);

    if (!res.data.pairs || !res.data.pairs.length) return null;

    const pair = res.data.pairs[0];

    return {
      symbol: pair.baseToken.symbol,
      price: Number(pair.priceUsd)
    };

  } catch (err) {
    return null;
  }

}

// ===================== SCANNER =====================
async function scanWatchlist() {

  console.log("Scanning watchlist...");

  for (const [key, item] of watchlist.entries()) {

    const data = await fetchToken(item.token);

    if (!data) continue;

    if (item.lastPrice === 0) {
      item.lastPrice = data.price;
      continue;
    }

    const change = ((data.price - item.lastPrice) / item.lastPrice) * 100;

    if (Math.abs(change) >= 3) {

      await bot.sendMessage(
        item.chatId,
        `🚨 ${data.symbol} moved ${change.toFixed(2)}%\nPrice: $${data.price}`
      );

    }

    item.lastPrice = data.price;

  }

}

// ===================== SCANNER LOOP =====================
setInterval(scanWatchlist, 60000);

console.log("🧠 Gorktimus Prime Bot Running...");
