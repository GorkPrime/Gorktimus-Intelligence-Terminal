/**
 * Gorktimus Security Bot (MVP)
 * - Restrict new joins briefly
 * - Delete links from non-trusted users
 * - Rate-limit spam + repeated messages
 * - Anti-raid join spike detection
 * - Admin commands: /trust, /untrust, /lockdown, /unlock
 */

const TelegramBot = require("node-telegram-bot-api");

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN env var.");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

// ====== CONFIG ======
const NEW_MEMBER_RESTRICT_SECONDS = 180; // 3 min
const MAX_MSGS_PER_10S = 5;              // rate limit
const REPEAT_WINDOW_MS = 60_000;         // repeated text window
const REPEAT_MAX = 3;                    // same msg repeated
const RAID_JOIN_WINDOW_MS = 30_000;      // 30 seconds
const RAID_JOIN_THRESHOLD = 8;           // joins in window to trigger
const LOCKDOWN_SECONDS = 300;            // 5 min lockdown (restrict new + delete links)
const ALLOW_LINKS_FOR_ADMINS = true;

// Basic link patterns (keep simple for MVP)
const LINK_REGEX = /(https?:\/\/|t\.me\/|telegram\.me\/|www\.)/i;

// ====== IN-MEMORY STATE (simple MVP) ======
const trustedUsers = new Map(); // chatId -> Set(userId)
const recentMsgs = new Map();   // chatId -> Map(userId -> array of timestamps)
const repeatMsgs = new Map();   // chatId -> Map(userId -> Map(text -> count+ts))
const joinEvents = new Map();   // chatId -> array of join timestamps
const lockdowns = new Map();    // chatId -> { until: number }

// Helpers
function now() { return Date.now(); }

function getTrustedSet(chatId) {
  if (!trustedUsers.has(chatId)) trustedUsers.set(chatId, new Set());
  return trustedUsers.get(chatId);
}

function inLockdown(chatId) {
  const l = lockdowns.get(chatId);
  return l && l.until > now();
}

async function isAdmin(chatId, userId) {
  try {
    const member = await bot.getChatMember(chatId, userId);
    return member && (member.status === "administrator" || member.status === "creator");
  } catch {
    return false;
  }
}

async function restrictUser(chatId, userId, seconds) {
  const untilDate = Math.floor(now() / 1000) + seconds;
  // Restrict: can’t send messages
  return bot.restrictChatMember(chatId, userId, {
    permissions: {
      can_send_messages: false,
      can_send_audios: false,
      can_send_documents: false,
      can_send_photos: false,
      can_send_videos: false,
      can_send_video_notes: false,
      can_send_voice_notes: false,
      can_send_polls: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false,
      can_change_info: false,
      can_invite_users: false,
      can_pin_messages: false
    },
    until_date: untilDate
  });
}

async function unrestrictUser(chatId, userId) {
  // Allow normal messaging again
  return bot.restrictChatMember(chatId, userId, {
    permissions: {
      can_send_messages: true,
      can_send_audios: true,
      can_send_documents: true,
      can_send_photos: true,
      can_send_videos: true,
      can_send_video_notes: true,
      can_send_voice_notes: true,
      can_send_polls: true,
      can_send_other_messages: true,
      can_add_web_page_previews: true,
      can_change_info: false,
      can_invite_users: true,
      can_pin_messages: false
    }
  });
}

async function setSlowMode(chatId, seconds) {
  // Telegram supports slow mode in supergroups; may fail if not supported.
  try {
    await bot.setChatPermissions(chatId, {
      can_send_messages: true,
      can_send_media_messages: true,
      can_send_polls: true,
      can_send_other_messages: true,
      can_add_web_page_previews: true,
      can_change_info: false,
      can_invite_users: true,
      can_pin_messages: false
    });
    // NOTE: node-telegram-bot-api doesn't have a direct slowmode setter in older versions.
    // We'll just “lockdown” via restricting new users + deleting links/spam.
    // If you want true slow mode, we can switch to Telegraf or direct API call.
  } catch {}
}

// ====== ANTI-RAID JOIN TRACKING ======
function recordJoin(chatId) {
  if (!joinEvents.has(chatId)) joinEvents.set(chatId, []);
  const arr = joinEvents.get(chatId);
  arr.push(now());
  // prune old
  const cutoff = now() - RAID_JOIN_WINDOW_MS;
  while (arr.length && arr[0] < cutoff) arr.shift();
  return arr.length;
}

function startLockdown(chatId, reason = "raid") {
  lockdowns.set(chatId, { until: now() + LOCKDOWN_SECONDS * 1000, reason });
}

// ====== HANDLER: New Members ======
bot.on("message", async (msg) => {
  const chatId = msg.chat?.id;
  if (!chatId) return;

  // New members joined
  if (msg.new_chat_members && msg.new_chat_members.length) {
    const joinCount = recordJoin(chatId);

    // If raid-like join spike, trigger lockdown
    if (joinCount >= RAID_JOIN_THRESHOLD && !inLockdown(chatId)) {
      startLockdown(chatId, "join-spike");
      bot.sendMessage(
        chatId,
        `⚠️ Anti-raid enabled (join spike detected). New members restricted + links blocked for ${LOCKDOWN_SECONDS / 60} min.`
      ).catch(() => {});
    }

    for (const user of msg.new_chat_members) {
      // Restrict all new members briefly, more strict during lockdown
      const seconds = inLockdown(chatId) ? LOCKDOWN_SECONDS : NEW_MEMBER_RESTRICT_SECONDS;
      try {
        await restrictUser(chatId, user.id, seconds);
      } catch (e) {
        // If bot lacks permission, nothing we can do.
      }
    }
    return;
  }
});

// ====== HANDLER: Text Messages (Anti-spam / Anti-link) ======
bot.on("text", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || "").trim();

  // Ignore commands here; handled below
  if (text.startsWith("/")) return;

  const trusted = getTrustedSet(chatId).has(userId);
  const admin = await isAdmin(chatId, userId);

  // === 1) Link blocking ===
  const hasLink = LINK_REGEX.test(text);
  if (hasLink) {
    const allowed = trusted || (ALLOW_LINKS_FOR_ADMINS && admin);
    // If lockdown is active, block links even harder (still allow admins)
    const shouldBlock = !allowed || (inLockdown(chatId) && !admin);

    if (shouldBlock) {
      try {
        await bot.deleteMessage(chatId, msg.message_id);
      } catch {}
      return;
    }
  }

  // === 2) Rate limiting (msgs per 10s) ===
  if (!recentMsgs.has(chatId)) recentMsgs.set(chatId, new Map());
  const userMap = recentMsgs.get(chatId);
  if (!userMap.has(userId)) userMap.set(userId, []);
  const times = userMap.get(userId);

  const cutoff = now() - 10_000;
  times.push(now());
  while (times.length && times[0] < cutoff) times.shift();

  if (times.length > MAX_MSGS_PER_10S && !admin) {
    try {
      await restrictUser(chatId, userId, 60); // 1 min mute
      await bot.sendMessage(chatId, `⚠️ Slow down @${msg.from.username || msg.from.first_name}. (auto-mute 60s)`);
    } catch {}
    return;
  }

  // === 3) Repeated text spam ===
  if (!repeatMsgs.has(chatId)) repeatMsgs.set(chatId, new Map());
  const repChat = repeatMsgs.get(chatId);
  if (!repChat.has(userId)) repChat.set(userId, new Map());
  const repUser = repChat.get(userId);

  const key = text.toLowerCase();
  const entry = repUser.get(key) || { count: 0, ts: now() };
  // reset window if old
  if (now() - entry.ts > REPEAT_WINDOW_MS) {
    entry.count = 0;
    entry.ts = now();
  }
  entry.count += 1;
  repUser.set(key, entry);

  if (entry.count >= REPEAT_MAX && !admin) {
    try {
      await bot.deleteMessage(chatId, msg.message_id);
      await restrictUser(chatId, userId, 120); // 2 min mute
      await bot.sendMessage(chatId, `🚫 Repeated spam detected. Muted 2 min.`);
    } catch {}
    return;
  }
});

// ====== COMMANDS (Admin Only) ======
bot.onText(/^\/trust(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const senderId = msg.from.id;
  if (!(await isAdmin(chatId, senderId))) return;

  // Trust replied user or numeric ID passed
  let targetId = null;
  if (msg.reply_to_message?.from?.id) targetId = msg.reply_to_message.from.id;
  else if (match[1]) targetId = parseInt(match[1], 10);

  if (!targetId) {
    return bot.sendMessage(chatId, "Reply to a user with /trust or use /trust <userId>");
  }

  getTrustedSet(chatId).add(targetId);
  bot.sendMessage(chatId, `✅ Trusted user added: ${targetId}`);
});

bot.onText(/^\/untrust(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const senderId = msg.from.id;
  if (!(await isAdmin(chatId, senderId))) return;

  let targetId = null;
  if (msg.reply_to_message?.from?.id) targetId = msg.reply_to_message.from.id;
  else if (match[1]) targetId = parseInt(match[1], 10);

  if (!targetId) {
    return bot.sendMessage(chatId, "Reply to a user with /untrust or use /untrust <userId>");
  }

  getTrustedSet(chatId).delete(targetId);
  bot.sendMessage(chatId, `✅ Trusted user removed: ${targetId}`);
});

bot.onText(/^\/lockdown/, async (msg) => {
  const chatId = msg.chat.id;
  const senderId = msg.from.id;
  if (!(await isAdmin(chatId, senderId))) return;

  startLockdown(chatId, "manual");
  bot.sendMessage(chatId, `🛡️ Lockdown enabled for ${LOCKDOWN_SECONDS / 60} min. Links blocked + new members restricted.`);
});

bot.onText(/^\/unlock/, async (msg) => {
  const chatId = msg.chat.id;
  const senderId = msg.from.id;
  if (!(await isAdmin(chatId, senderId))) return;

  lockdowns.delete(chatId);
  bot.sendMessage(chatId, `✅ Lockdown disabled.`);
});

console.log("Gorktimus Security Bot is running…");
