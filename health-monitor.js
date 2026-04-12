"use strict";

// ================= HEALTH MONITOR =================
// Monitors for uncaught errors, runs 7-hour maintenance cycles,
// stores health metrics, and alerts the owner on critical failures.

const SEVEN_HOURS_MS = 7 * 60 * 60 * 1000;
const THIRTY_DAYS_S = 30 * 24 * 60 * 60;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_STACK_LENGTH = 4000;

// Severity levels used when logging errors
const SEVERITY = {
  LOW: "low",
  MEDIUM: "medium",
  CRITICAL: "critical"
};

/**
 * Create and start the health monitor.
 *
 * @param {object} opts
 * @param {import("node-telegram-bot-api")} opts.bot       - TelegramBot instance
 * @param {function} opts.run                              - DB run helper (sql, params) => Promise
 * @param {function} opts.get                              - DB get helper (sql, params) => Promise<row>
 * @param {Map}      opts.callbackStore                   - Short-callback payload map
 * @param {Map}      opts.sessionMemory                   - Per-chat session memory map
 * @param {string}   opts.ownerUserId                     - Telegram user ID of the bot owner
 * @param {boolean}  opts.devMode                         - Whether DEV_MODE is active
 * @returns {{ stop: function }} Object with a stop() method to cancel the interval
 */
function initHealthMonitor({ bot, run, get, callbackStore, sessionMemory, ownerUserId, devMode }) {
  let errorCount = 0;
  let startedAt = Date.now();
  let restartCount = 0;

  // ── Helpers ────────────────────────────────────────────────────────────────

  function nowTs() {
    return Math.floor(Date.now() / 1000);
  }

  async function logError(message, stack, severity) {
    try {
      await run(
        `INSERT INTO error_logs (message, stack, severity, ts) VALUES (?, ?, ?, ?)`,
        [String(message || "").slice(0, MAX_MESSAGE_LENGTH), String(stack || "").slice(0, MAX_STACK_LENGTH), severity, nowTs()]
      );
    } catch (dbErr) {
      console.error("[health-monitor] failed to log error to DB:", dbErr.message);
    }
  }

  async function recordHealthSnapshot() {
    const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);
    try {
      await run(
        `INSERT INTO health_metrics (uptime_sec, restart_count, error_count, ts) VALUES (?, ?, ?, ?)`,
        [uptimeSec, restartCount, errorCount, nowTs()]
      );
    } catch (err) {
      console.error("[health-monitor] failed to record health snapshot:", err.message);
    }
  }

  async function alertOwner(text) {
    if (!ownerUserId || !bot) return;
    try {
      await bot.sendMessage(ownerUserId, text, { parse_mode: "HTML" });
    } catch (err) {
      console.error("[health-monitor] failed to alert owner:", err.message);
    }
  }

  // ── Error handlers ─────────────────────────────────────────────────────────

  async function handleCriticalError(type, err) {
    errorCount += 1;
    const message = err?.message || String(err);
    const stack = err?.stack || "";
    const severity = SEVERITY.CRITICAL;

    console.error(`[health-monitor] ${type}:`, message);

    await logError(`${type}: ${message}`, stack, severity);
    await recordHealthSnapshot();

    // Only alert the owner in DEV mode (avoids noise in production for transient errors)
    if (devMode) {
      const preview = message.slice(0, 300);
      await alertOwner(
        `⚠️ <b>Gorktimus Critical Error</b>\n\nType: <code>${type}</code>\nMessage: <code>${preview}</code>`
      );
    }
  }

  const uncaughtHandler = (err) => {
    handleCriticalError("uncaughtException", err).catch(() => {});
  };

  const rejectionHandler = (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    handleCriticalError("unhandledRejection", err).catch(() => {});
  };

  process.on("uncaughtException", uncaughtHandler);
  process.on("unhandledRejection", rejectionHandler);

  // ── Maintenance cycle ──────────────────────────────────────────────────────

  async function runMaintenance() {
    console.log("[health-monitor] Running 7-hour maintenance cycle…");
    const cutoff = nowTs() - THIRTY_DAYS_S;

    // 1. Clean up stale scan / activity logs
    try {
      await run(`DELETE FROM scan_logs WHERE ts < ?`, [cutoff]);
      await run(`DELETE FROM user_activity WHERE ts < ?`, [cutoff]);
      console.log("[health-monitor] Cleaned up old scan/activity logs");
    } catch (err) {
      console.error("[health-monitor] Cleanup error:", err.message);
      await logError("Maintenance cleanup failed: " + err.message, err.stack, SEVERITY.LOW);
    }

    // 2. Clean up old error_logs (keep last 30 days)
    try {
      await run(`DELETE FROM error_logs WHERE ts < ?`, [cutoff]);
    } catch (_) {}

    // 3. Clean up old health_metrics (keep last 30 days)
    try {
      await run(`DELETE FROM health_metrics WHERE ts < ?`, [cutoff]);
    } catch (_) {}

    // 4. Clear expired callbackStore entries (no TTL metadata exists, so we
    //    flush entries older than the Map's natural growth; a simple full flush
    //    every 7 h is safe because callbacks are only valid for a single interaction)
    if (callbackStore && callbackStore.size > 0) {
      callbackStore.clear();
      console.log("[health-monitor] Cleared callbackStore");
    }

    // 5. Flush session memory entries that haven't been touched in > 7 h
    //    (session objects don't carry a timestamp, so we just prune the map if
    //     it has grown very large — keeps memory bounded)
    if (sessionMemory && sessionMemory.size > 500) {
      sessionMemory.clear();
      console.log("[health-monitor] Flushed oversized sessionMemory");
    }

    // 6. Record a health snapshot
    await recordHealthSnapshot();

    // 7. Log the maintenance event in update_history
    try {
      await run(
        `INSERT INTO update_history (event_type, notes, ts) VALUES (?, ?, ?)`,
        ["maintenance", "7-hour maintenance cycle completed", nowTs()]
      );
    } catch (_) {}

    console.log("[health-monitor] Maintenance cycle complete");
  }

  // ── Interval ───────────────────────────────────────────────────────────────

  const intervalId = setInterval(() => {
    runMaintenance().catch((err) => {
      console.error("[health-monitor] Unexpected error in maintenance:", err.message);
    });
  }, SEVEN_HOURS_MS);

  // ── DB table initialisation ────────────────────────────────────────────────
  // Tables are created in initDb() inside index.js; this is just a guard.

  async function ensureTables() {
    await run(`
      CREATE TABLE IF NOT EXISTS error_logs (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        message   TEXT    NOT NULL,
        stack     TEXT    DEFAULT '',
        severity  TEXT    DEFAULT 'low',
        ts        INTEGER NOT NULL
      )
    `);

    await run(`
      CREATE TABLE IF NOT EXISTS health_metrics (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        uptime_sec    INTEGER DEFAULT 0,
        restart_count INTEGER DEFAULT 0,
        error_count   INTEGER DEFAULT 0,
        ts            INTEGER NOT NULL
      )
    `);

    await run(`
      CREATE TABLE IF NOT EXISTS update_history (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT    NOT NULL,
        notes      TEXT    DEFAULT '',
        ts         INTEGER NOT NULL
      )
    `);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  function stop() {
    clearInterval(intervalId);
    process.off("uncaughtException", uncaughtHandler);
    process.off("unhandledRejection", rejectionHandler);
  }

  // Boot: create tables then record initial snapshot
  ensureTables()
    .then(() => recordHealthSnapshot())
    .then(() =>
      run(
        `INSERT INTO update_history (event_type, notes, ts) VALUES (?, ?, ?)`,
        ["boot", "Bot started — health monitor active", nowTs()]
      )
    )
    .catch((err) => {
      // Ignore errors on a closed/missing DB (e.g. during tests).
      // SQLite reports SQLITE_MISUSE (error code 21) when the DB is already closed.
      if (err.errno !== 21 && !err.message.includes("SQLITE_MISUSE")) {
        console.error("[health-monitor] Boot error:", err.message);
      }
    });

  console.log(`[health-monitor] Started. Maintenance cycle every 7 hours.`);

  return { stop, logError, recordHealthSnapshot };
}

module.exports = { initHealthMonitor, SEVERITY };
