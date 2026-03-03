const { Telegraf } = require("telegraf");
const axios = require("axios");

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN env var.");
  process.exit(1);
}

const bot = new Telegraf(token);

async function fetchDex(query) {
  const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`;
  const { data } = await axios.get(url, { timeout: 15000 });
  return Array.isArray(data?.pairs) ? data.pairs : [];
}

function formatUSD(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "N/A";
  const num = Number(n);
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(2)}K`;
  return `$${num.toFixed(2)}`;
}

// Risk% (higher = riskier)
function riskPercent(pair) {
  let safety = 100;
  const liq = Number(pair?.liquidity?.usd ?? 0);
  const vol24 = Number(pair?.volume?.h24 ?? 0);
  const change5m = Number(pair?.priceChange?.m5 ?? 0);

  if (liq < 20000) safety -= 30;
  else if (liq < 50000) safety -= 15;

  if (vol24 < 10000) safety -= 20;
  if (Math.abs(change5m) > 30) safety -= 10;

  safety = Math.max(0, Math.min(100, safety));
  return Math.max(0, Math.min(100, 100 - safety));
}

bot.start((ctx) => {
  ctx.reply("✅ PRIME BOT RESET v1\nCommands:\n/scan <token>\n/score <token>");
});

bot.command("scan", async (ctx) => {
  try {
    const q = ctx.message.text.split(" ").slice(1).join(" ").trim();
    if (!q) return ctx.reply("Usage: /scan <token address | pair | symbol>");

    const pairs = await fetchDex(q);
    if (!pairs.length) return ctx.reply("No results found.");

    const p = pairs[0];
    const risk = riskPercent(p);

    return ctx.reply(
      `🔎 Scan\n` +
      `Pair: ${p.baseToken?.symbol ?? "?"}/${p.quoteToken?.symbol ?? "?"}\n` +
      `Risk: ${risk}%\n` +
      `Liquidity: ${formatUSD(p.liquidity?.usd)} | Vol24: ${formatUSD(p.volume?.h24)}\n` +
      `5m: ${p.priceChange?.m5 ?? "N/A"}% | 1h: ${p.priceChange?.h1 ?? "N/A"}% | 24h: ${p.priceChange?.h24 ?? "N/A"}%\n` +
      `Link: ${p.url ?? "N/A"}`
    );
  } catch (e) {
    console.error(e);
    return ctx.reply("Scan error. Try again.");
  }
});

bot.command("score", async (ctx) => {
  try {
    const q = ctx.message.text.split(" ").slice(1).join(" ").trim();
    if (!q) return ctx.reply("Usage: /score <token address | pair | symbol>");

    const pairs = await fetchDex(q);
    if (!pairs.length) return ctx.reply("No results found.");

    const p = pairs[0];
    const risk = riskPercent(p);

    return ctx.reply(`🧠 Risk Score\nToken: ${p.baseToken?.symbol ?? "?"}\nRisk: ${risk}%\nLink: ${p.url ?? "N/A"}`);
  } catch (e) {
    console.error(e);
    return ctx.reply("Score error. Try again.");
  }
});

bot.launch();
console.log("Prime Bot running (RESET v1)...");
