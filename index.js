const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const path = require("path");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN not set");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ================= IMAGE =================
const INTRO_IMG = path.join(__dirname, "assets", "gorktimus_intro_1280.png");

// ================= MEMORY =================
const watchlist = new Map();
const pendingAdd = new Map();

// ================= MENU =================
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
        ]
      ]
    }
  };
}

// ================= TERMINAL =================
async function sendTerminal(chatId, caption, keyboard) {

  try {

    await bot.sendPhoto(chatId, INTRO_IMG, {
      caption,
      ...keyboard
    });

  } catch (err) {

    console.log("Image failed, sending text instead");

    await bot.sendMessage(chatId, caption, keyboard);

  }

}

// ================= START =================
bot.onText(/\/start/, async (msg) => {

  const chatId = msg.chat.id;

  await sendTerminal(
    chatId,
    "🛡️ GORKTIMUS PRIME TERMINAL\nSelect an option below.",
    mainMenu()
  );

});

// ================= BUTTONS =================
bot.on("callback_query", async (query) => {

  const chatId = query.message.chat.id;
  const data = query.data;

  if (data === "add_watch") {

    pendingAdd.set(chatId, true);

    await bot.sendMessage(chatId, "Send a token symbol or contract address.");

  }

  if (data === "watchlist") {

    const tokens = [];

    for (const item of watchlist.values()) {

      if (item.chatId === chatId) tokens.push(item.token);

    }

    if (!tokens.length) {

      return sendTerminal(chatId, "📭 Watchlist empty.", mainMenu());

    }

    await sendTerminal(
      chatId,
      "📋 Your Watchlist\n\n" + tokens.join("\n"),
      mainMenu()
    );

  }

  if (data === "status") {

    await sendTerminal(
      chatId,
      "🟢 Gorktimus Online\nScanner running every 60 seconds.",
      mainMenu()
    );

  }

  if (data === "global_alerts") {

    await sendTerminal(
      chatId,
      "🌍 Global Alerts module coming soon.",
      mainMenu()
    );

  }

  bot.answerCallbackQuery(query.id);

});

// ================= USER MESSAGE =================
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

  await bot.sendMessage(chatId, `✅ Added ${token} to watchlist`);

});

// ================= TOKEN FETCH =================
async function fetchToken(token) {

  try {

    const url = `https://api.dexscreener.com/latest/dex/search/?q=${token}`;

    const res = await axios.get(url);

    if (!res.data.pairs || res.data.pairs.length === 0) return null;

    const pair = res.data.pairs[0];

    return {
      symbol: pair.baseToken.symbol,
      price: Number(pair.priceUsd)
    };

  } catch (err) {

    console.log("Dexscreener error");

    return null;

  }

}

// ================= WATCH SCANNER =================
async function scanWatchlist() {

  console.log("🔍 scanning watchlist...");

  for (const item of watchlist.values()) {

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

// ================= SCANNER LOOP =================
setInterval(scanWatchlist, 60000);

console.log("🧠 Gorktimus Prime Bot Running...");
