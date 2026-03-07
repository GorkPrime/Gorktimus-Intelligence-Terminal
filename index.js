const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const path = require("path");
const fs = require("fs");

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
    console.log("Trying image path:", INTRO_IMG);

    if (!fs.existsSync(INTRO_IMG)) {
      console.log("❌ Image file does not exist at path:", INTRO_IMG);
      await bot.sendMessage(chatId, caption, keyboard);
      return;
    }

    const photoStream = fs.createReadStream(INTRO_IMG);

    await bot.sendPhoto(chatId, photoStream, {
      caption,
      ...keyboard
    });

    console.log("✅ Image sent successfully");
  } catch (err) {
    console.log("❌ Image failed, sending text instead");
    console.log("Image error:", err.message);

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

  try {
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
        await sendTerminal(chatId, "📭 Watchlist empty.", mainMenu());
      } else {
        await sendTerminal(
          chatId,
          "📋 Your Watchlist\n\n" + tokens.join("\n"),
          mainMenu()
        );
      }
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

    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    console.log("Callback error:", err.message);
    try {
      await bot.answerCallbackQuery(query.id);
    } catch (_) {}
  }
});

// ================= USER MESSAGE =================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text) return;
  if (text.startsWith("/start")) return;
  if (!pendingAdd.get(chatId)) return;

  pendingAdd.delete(chatId);

  const token = text.trim();
  const key = `${chatId}_${token.toLowerCase()}`;

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
    const url = `https://api.dexscreener.com/latest/dex/search/?q=${encodeURIComponent(token)}`;
    const res = await axios.get(url, { timeout: 15000 });

    if (!res.data.pairs || res.data.pairs.length === 0) return null;

    const pair = res.data.pairs[0];

    return {
      symbol: pair.baseToken?.symbol || token,
      price: Number(pair.priceUsd || 0)
    };
  } catch (err) {
    console.log("Dexscreener error:", err.message);
    return null;
  }
}

// ================= WATCH SCANNER =================
async function scanWatchlist() {
  console.log("🔍 scanning watchlist...");

  for (const item of watchlist.values()) {
    try {
      const data = await fetchToken(item.token);
      if (!data) continue;
      if (!data.price || data.price <= 0) continue;

      if (item.lastPrice === 0) {
        item.lastPrice = data.price;
        console.log(`Initialized ${item.token} at ${data.price}`);
        continue;
      }

      const change = ((data.price - item.lastPrice) / item.lastPrice) * 100;

      console.log(
        `Watching ${item.token} | old=${item.lastPrice} new=${data.price} change=${change.toFixed(2)}%`
      );

      if (Math.abs(change) >= 3) {
        await bot.sendMessage(
          item.chatId,
          `🚨 ${data.symbol} moved ${change.toFixed(2)}%\nPrice: $${data.price}`
        );
      }

      item.lastPrice = data.price;
    } catch (err) {
      console.log("scanWatchlist item error:", err.message);
    }
  }
}

// ================= SCANNER LOOP =================
setInterval(scanWatchlist, 60000);

console.log("🧠 Gorktimus Prime Bot Running...");
console.log("📁 Expected image path:", INTRO_IMG);
console.log("📁 Image exists on boot:", fs.existsSync(INTRO_IMG));
