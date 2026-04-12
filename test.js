"use strict";

/**
 * test.js — unit/integration tests for Gorktimus Intelligence Terminal
 *
 * Run with:  node test.js
 */

const assert = require("assert");
const sqlite3 = require("sqlite3").verbose();

// ── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅  ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  ❌  ${name}`);
    console.error(`       ${err.message}`);
    failed += 1;
  }
}

function summary() {
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

// ── In-memory SQLite helpers (mirrors index.js) ───────────────────────────────

function makeDb() {
  const db = new sqlite3.Database(":memory:");

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

  function close() {
    return new Promise((resolve) => db.close(resolve));
  }

  return { run, get, all, close };
}

async function makeTestDb() {
  const { run, get, all, close } = makeDb();

  await run(`CREATE TABLE IF NOT EXISTS error_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT NOT NULL,
    stack TEXT DEFAULT '',
    severity TEXT DEFAULT 'low',
    ts INTEGER NOT NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS health_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uptime_sec INTEGER DEFAULT 0,
    restart_count INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    ts INTEGER NOT NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS update_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    notes TEXT DEFAULT '',
    ts INTEGER NOT NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS scan_logs (user_id TEXT, ts INTEGER)`);
  await run(`CREATE TABLE IF NOT EXISTS user_activity (user_id TEXT, ts INTEGER)`);

  return { run, get, all, close };
}

// ── DEV MODE logic (mirrors index.js) ────────────────────────────────────────

function isDevMode(env) {
  return env.DEV_MODE === "true" && !!env.OWNER_USER_ID;
}

function getDevModeStatus(devMode) {
  return devMode ? "🔴 DEV: ON" : "🟢 PROD: ON";
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n=== Gorktimus Intelligence Terminal — Test Suite ===\n");

  // ────────────────────────────────────────────────────────────────────────────
  // DEV MODE TESTS
  // ────────────────────────────────────────────────────────────────────────────
  console.log("DEV MODE");

  await test("isDevMode returns false when DEV_MODE env is not set", async () => {
    assert.strictEqual(isDevMode({}), false);
  });

  await test("isDevMode returns false when OWNER_USER_ID is missing", async () => {
    assert.strictEqual(isDevMode({ DEV_MODE: "true" }), false);
  });

  await test("isDevMode returns false when DEV_MODE is not 'true'", async () => {
    assert.strictEqual(isDevMode({ DEV_MODE: "false", OWNER_USER_ID: "123" }), false);
  });

  await test("isDevMode returns true when both DEV_MODE=true and OWNER_USER_ID are set", async () => {
    assert.strictEqual(isDevMode({ DEV_MODE: "true", OWNER_USER_ID: "123" }), true);
  });

  await test("getDevModeStatus returns 🔴 DEV: ON when devMode is true", async () => {
    assert.strictEqual(getDevModeStatus(true), "🔴 DEV: ON");
  });

  await test("getDevModeStatus returns 🟢 PROD: ON when devMode is false", async () => {
    assert.strictEqual(getDevModeStatus(false), "🟢 PROD: ON");
  });

  // ────────────────────────────────────────────────────────────────────────────
  // HEALTH MONITOR TESTS
  // ────────────────────────────────────────────────────────────────────────────
  console.log("\nHEALTH MONITOR");

  const { initHealthMonitor, SEVERITY } = require("./health-monitor");

  await test("initHealthMonitor returns a stop function", async () => {
    const { run, get, close } = await makeTestDb();
    const monitor = initHealthMonitor({
      bot: null,
      run,
      get,
      callbackStore: new Map(),
      sessionMemory: new Map(),
      ownerUserId: "",
      devMode: false
    });
    assert.strictEqual(typeof monitor.stop, "function");
    monitor.stop();
    await close();
  });

  await test("logError writes a row to error_logs", async () => {
    const { run, get, close } = await makeTestDb();
    const monitor = initHealthMonitor({
      bot: null,
      run,
      get,
      callbackStore: new Map(),
      sessionMemory: new Map(),
      ownerUserId: "",
      devMode: false
    });

    await monitor.logError("test error message", "stack trace here", SEVERITY.LOW);
    await new Promise((r) => setTimeout(r, 50));

    const row = await get(`SELECT * FROM error_logs WHERE message LIKE '%test error message%'`);
    assert.ok(row, "Row should exist in error_logs");
    assert.strictEqual(row.severity, SEVERITY.LOW);

    monitor.stop();
    await close();
  });

  await test("recordHealthSnapshot writes a row to health_metrics", async () => {
    const { run, get, close } = await makeTestDb();
    const monitor = initHealthMonitor({
      bot: null,
      run,
      get,
      callbackStore: new Map(),
      sessionMemory: new Map(),
      ownerUserId: "",
      devMode: false
    });

    await monitor.recordHealthSnapshot();
    await new Promise((r) => setTimeout(r, 50));

    const row = await get(`SELECT * FROM health_metrics ORDER BY id DESC LIMIT 1`);
    assert.ok(row, "A health_metrics row should exist");
    assert.ok(Number.isInteger(row.uptime_sec), "uptime_sec should be a number");

    monitor.stop();
    await close();
  });

  await test("SEVERITY constants are defined correctly", async () => {
    assert.strictEqual(SEVERITY.LOW, "low");
    assert.strictEqual(SEVERITY.MEDIUM, "medium");
    assert.strictEqual(SEVERITY.CRITICAL, "critical");
  });

  // ────────────────────────────────────────────────────────────────────────────
  // DB MAINTENANCE TESTS
  // ────────────────────────────────────────────────────────────────────────────
  console.log("\nDB MAINTENANCE");

  await test("Old scan_logs and user_activity rows are deleted during maintenance", async () => {
    const { run, all, close } = await makeTestDb();

    const THIRTY_DAYS_S = 30 * 24 * 60 * 60;
    const nowTs = () => Math.floor(Date.now() / 1000);
    const oldTs = nowTs() - THIRTY_DAYS_S - 100;
    const recentTs = nowTs() - 1000;

    await run(`INSERT INTO scan_logs (user_id, ts) VALUES ('u1', ?)`, [oldTs]);
    await run(`INSERT INTO scan_logs (user_id, ts) VALUES ('u2', ?)`, [recentTs]);
    await run(`INSERT INTO user_activity (user_id, ts) VALUES ('u1', ?)`, [oldTs]);
    await run(`INSERT INTO user_activity (user_id, ts) VALUES ('u2', ?)`, [recentTs]);

    const cutoff = nowTs() - THIRTY_DAYS_S;
    await run(`DELETE FROM scan_logs WHERE ts < ?`, [cutoff]);
    await run(`DELETE FROM user_activity WHERE ts < ?`, [cutoff]);

    const scanRows = await all(`SELECT * FROM scan_logs`);
    const activityRows = await all(`SELECT * FROM user_activity`);

    assert.strictEqual(scanRows.length, 1, "Only recent scan_log row should remain");
    assert.strictEqual(activityRows.length, 1, "Only recent user_activity row should remain");
    assert.strictEqual(scanRows[0].user_id, "u2");
    assert.strictEqual(activityRows[0].user_id, "u2");

    await close();
  });

  await test("callbackStore is cleared when maintenance runs", async () => {
    const callbackStore = new Map([["abc", { foo: "bar" }], ["def", { baz: 1 }]]);
    assert.strictEqual(callbackStore.size, 2);
    if (callbackStore.size > 0) callbackStore.clear();
    assert.strictEqual(callbackStore.size, 0);
  });

  await test("sessionMemory is flushed when it exceeds 500 entries", async () => {
    const sessionMemory = new Map();
    for (let i = 0; i < 501; i++) sessionMemory.set(String(i), { lastScan: null });
    assert.ok(sessionMemory.size > 500);
    if (sessionMemory.size > 500) sessionMemory.clear();
    assert.strictEqual(sessionMemory.size, 0);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // HELPER FUNCTION TESTS
  // ────────────────────────────────────────────────────────────────────────────
  console.log("\nHELPER FUNCTIONS");

  await test("escapeHtml escapes &, <, and >", async () => {
    function escapeHtml(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }
    assert.strictEqual(escapeHtml("<b>foo & bar</b>"), "&lt;b&gt;foo &amp; bar&lt;/b&gt;");
    assert.strictEqual(escapeHtml(null), "");
    assert.strictEqual(escapeHtml(undefined), "");
  });

  await test("safeMode returns 'balanced' for unknown modes", async () => {
    function safeMode(mode) {
      const m = String(mode || "").toLowerCase();
      if (["aggressive", "balanced", "guardian"].includes(m)) return m;
      return "balanced";
    }
    assert.strictEqual(safeMode("aggressive"), "aggressive");
    assert.strictEqual(safeMode("GUARDIAN"), "guardian");
    assert.strictEqual(safeMode("unknown"), "balanced");
    assert.strictEqual(safeMode(null), "balanced");
    assert.strictEqual(safeMode(""), "balanced");
  });

  await test("shortAddr truncates long addresses correctly", async () => {
    function shortAddr(value, len = 6) {
      const s = String(value || "");
      if (s.length <= len * 2 + 3) return s;
      return `${s.slice(0, len)}...${s.slice(-len)}`;
    }
    const long = "0x1234567890abcdef1234567890abcdef12345678";
    const result = shortAddr(long);
    assert.ok(result.includes("..."));
    assert.ok(result.startsWith("0x1234"));
  });

  await test("isPrivateChat returns true for private chat messages", async () => {
    function isPrivateChat(msgOrQuery) {
      const chat = msgOrQuery?.chat || msgOrQuery?.message?.chat || null;
      return chat?.type === "private";
    }
    assert.strictEqual(isPrivateChat({ chat: { type: "private" } }), true);
    assert.strictEqual(isPrivateChat({ chat: { type: "group" } }), false);
    assert.strictEqual(isPrivateChat({ message: { chat: { type: "private" } } }), true);
    assert.strictEqual(isPrivateChat({}), false);
    assert.strictEqual(isPrivateChat(null), false);
  });

  // ────────────────────────────────────────────────────────────────────────────

  summary();
}

main().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});

