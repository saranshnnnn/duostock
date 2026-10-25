#!/usr/bin/env node
// DuoStock: watches Apple Canada in-store pickup for iPhone Duo and pings your phone via ntfy.sh.
// Zero dependencies. Needs Node 18+.  Run:  NTFY_TOPIC=your-secret-topic node duostock.mjs

import http from "node:http";
import fs from "node:fs";

const env = process.env;
const CFG = {
  topic: env.NTFY_TOPIC || "",                          // ntfy topic (acts like a password; make it long/random)
  ntfyServer: env.NTFY_SERVER || "https://ntfy.sh",
  appleBase: env.APPLE_BASE || "https://www.apple.com",
  location: env.LOCATION || "Surrey, BC",               // Apple returns the 5 nearest BC stores either way
  intervalSec: Number(env.INTERVAL_SEC || 45),
  maxRuntimeMin: Number(env.MAX_RUNTIME_MIN || 0),      // 0 = run forever (GitHub Actions sets this)
  port: Number(env.PORT || 0),                          // >0 starts a tiny status page (for hosts that want a port)
  failAlertAfter: Number(env.FAIL_ALERT_AFTER || 10),   // consecutive failures before "I'm blind" alert
  heartbeatHours: Number(env.HEARTBEAT_HOURS || 24),    // "still alive" ping; 0 = off
  quiet: env.QUIET === "1",
  digestEvery: Number(env.DIGEST_EVERY || 10),          // status report after every N checks with nothing in stock
  failExitAfter: Number(env.FAIL_EXIT_AFTER || 0),      // >0: after N failed checks in a row, exit so a fresh runner takes over (GitHub Actions)
  workerId: env.WORKER_ID || "",                        // hot standby: set A/B/C on each copy; empty = standalone
  hbTtlSec: Number(env.HB_TTL_SEC || 75),               // another worker counts as alive if its heartbeat is newer than this
  standbyPollSec: Number(env.STANDBY_POLL_SEC || 10),   // how often a standby looks for a dead/released active worker
  blockedStreak: Number(env.BLOCKED_STREAK || 0),       // how many runs in a row ended blocked before this one (passed in by the workflow)
};

// Canadian part numbers (apple.com/ca iPhone Duo). Edit to taste.
const PARTS = {
  "MK254VC/A": "iPhone Duo 256GB Night Sky",
  "MK274VC/A": "iPhone Duo 512GB Night Sky",
  // "MK244VC/A": "iPhone Duo 256GB Star White",
  // "MK264VC/A": "iPhone Duo 512GB Star White",
};
const BUY_URL = "https://www.apple.com/ca/shop/buy-iphone/iphone-duo";

// Optional: only these store numbers (R601 Guildford/Surrey, R488 Coquitlam, R460 Metrotown, R280 Pacific Centre/Vancouver, R421 Richmond)
const STORES = (env.STORES || "R601,R488,R460,R280,R421").split(",").map((s) => s.trim()).filter(Boolean);

const log = (...a) => !CFG.quiet && console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  seen: new Map(),        // "store|part" -> true when available last poll
  polls: 0, failures: 0, consecutiveFailures: 0,
  lastOk: null, lastError: null, lastSnapshot: [], startedAt: Date.now(),
  failAlerted: false, lastHeartbeat: Date.now(), noStockPolls: 0,
  successes: 0, exitBlocked: false, recoveredNotified: false,
};

async function notify({ title, message, priority = "default", tags = "iphone", click = BUY_URL }) {
  if (!CFG.topic) { log("[no NTFY_TOPIC set] would notify:", title, "-", message); return; }
  try {
    const r = await fetch(`${CFG.ntfyServer}/${encodeURIComponent(CFG.topic)}`, {
      method: "POST",
      // HTTP headers must be latin1, so title goes in a header only if ASCII-safe
      headers: { Title: title.replace(/[^\x20-\x7e]/g, ""), Priority: priority, Tags: tags, Click: click },
      body: message,
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) log("ntfy error", r.status, await r.text());
  } catch (e) { log("ntfy failed:", e.message); }
}

async function fetchPickup() {
  const q = new URLSearchParams({ pl: "true", location: CFG.location });
  Object.keys(PARTS).forEach((p, i) => q.set(`parts.${i}`, p));
  const url = `${CFG.appleBase}/ca/shop/retail/pickup-message?${q}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: {
        accept: "application/json, text/javascript, */*; q=0.01",
        "accept-language": "en-CA,en;q=0.9",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
        referer: BUY_URL,
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const stores = j?.body?.stores;
    if (!Array.isArray(stores)) throw new Error(j?.body?.errorMessage || "no stores in response");
    return stores;
  } finally { clearTimeout(t); }
}

// Flatten to [{store, storeNo, city, part, name, available}]
function flatten(stores) {
  const rows = [];
  for (const s of stores) {
    if (STORES.length && !STORES.includes(s.storeNumber)) continue;
    for (const [part, name] of Object.entries(PARTS)) {
      const pa = s.partsAvailability?.[part];
      if (!pa) continue;
      rows.push({
        store: s.storeName, storeNo: s.storeNumber, city: s.city, part, name,
        available: pa.pickupDisplay === "available",
        quote: pa.messageTypes?.regular?.storePickupQuote || pa.pickupSearchQuote || "",
      });
    }
  }
  return rows;
}

// Human-readable status of everything checked in one poll
function digest(rows) {
  const when = new Date().toLocaleString("en-CA", { timeZone: "America/Vancouver", hour12: true, dateStyle: "medium", timeStyle: "medium" });
  const byStore = new Map();
  for (const r of rows) {
    if (!byStore.has(r.storeNo)) byStore.set(r.storeNo, { name: `${r.store} (${r.city})`, items: [] });
    byStore.get(r.storeNo).items.push(`${r.name.replace("iPhone Duo ", "")}: ${r.available ? "AVAILABLE" : "not available"}`);
  }
  const lines = [...byStore.values()].map((s) => `${s.name}\n  ${s.items.join("\n  ")}`);
  return `Checked apple.com/ca pickup at ${when} PT\nNone in stock at any of ${byStore.size} stores (${rows.length} store/model checks):\n\n${lines.join("\n\n")}\n\nChecking every ${CFG.intervalSec}s.`;
}

// ---- Hot standby coordination (only when WORKER_ID is set) ----
// The active worker posts a heartbeat to a private ntfy topic ("<topic>-hb"; not your alert topic, so no phone noise).
// Standbys only read that topic, so Apple still gets exactly one check per interval overall.
const hbUrl = () => `${CFG.ntfyServer}/${encodeURIComponent(CFG.topic + "-hb")}`;
async function hbSend(kind) {
  try { await fetch(hbUrl(), { method: "POST", body: `${kind}:${CFG.workerId}`, signal: AbortSignal.timeout(8000) }); }
  catch (e) { log("hb send failed:", e.message); }
}
async function aliveOthers() {
  try {
    const r = await fetch(`${hbUrl()}/json?poll=1&since=3m`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    const last = new Map();
    const evs = (await r.text()).split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e && e.event === "message").sort((a, b) => a.time - b.time);
    for (const e of evs) { const [kind, id] = String(e.message).split(":"); last.set(id, { kind, time: e.time }); }
    const now = Date.now() / 1000;
    return [...last].filter(([id, v]) => id !== CFG.workerId && v.kind === "hb" && now - v.time <= CFG.hbTtlSec).map(([id]) => id);
  } catch (e) { log("hb read failed:", e.message); return []; }
}

async function poll() {
  state.polls++;
  try {
    const rows = flatten(await fetchPickup());
    state.lastOk = Date.now(); state.consecutiveFailures = 0; state.lastSnapshot = rows; state.successes++;
    if (CFG.blockedStreak >= 5 && !state.recoveredNotified) {
      state.recoveredNotified = true;
      await notify({ title: "DuoStock recovered", message: "Apple checks are working again on a fresh runner.", tags: "white_check_mark" });
    }
    if (state.failAlerted) { state.failAlerted = false; await notify({ title: "DuoStock recovered", message: "Apple checks are working again.", tags: "white_check_mark" }); }

    const nowAvail = rows.filter((r) => r.available);
    // Alert on every store/part that flipped unavailable -> available (or is available on first poll)
    const fresh = nowAvail.filter((r) => !state.seen.get(`${r.storeNo}|${r.part}`));
    for (const r of rows) state.seen.set(`${r.storeNo}|${r.part}`, r.available);

    if (nowAvail.length === 0) state.noStockPolls++;

    if (fresh.length) {
      const msg = fresh.map((r) => `${r.name}\n${r.store} (${r.city})`).join("\n\n");
      log("IN STOCK:", fresh.map((r) => `${r.name} @ ${r.store}`).join("; "));
      await notify({
        title: "iPhone Duo IN STOCK", message: `${msg}\n\nBuy / reserve: ${BUY_URL}`,
        priority: "urgent", tags: "rotating_light,iphone",
      });
    } else {
      log(`poll #${state.polls}: ${rows.length} combos checked, ${nowAvail.length} available`);
      // Status report on the first check of each run, then after every N checks where nothing was in stock
      if (nowAvail.length === 0 && (state.noStockPolls === 1 || state.noStockPolls % CFG.digestEvery === 0)) {
        await notify({ title: `Duo: not available (check #${state.polls})`, message: digest(rows), priority: "high", tags: "x" });
      }
    }
  } catch (e) {
    state.failures++; state.consecutiveFailures++; state.lastError = `${e.message} @ ${new Date().toISOString()}`;
    log(`poll #${state.polls} FAILED (${state.consecutiveFailures} in a row):`, e.message);
    if (CFG.failExitAfter && state.consecutiveFailures >= CFG.failExitAfter) { state.exitBlocked = true; return; }
    if (state.consecutiveFailures >= CFG.failAlertAfter && !state.failAlerted) {
      state.failAlerted = true;
      await notify({ title: "DuoStock is blind", message: `${state.consecutiveFailures} failed checks in a row. Last error: ${e.message}. Apple may be blocking this host.`, priority: "high", tags: "warning" });
    }
  }
  if (CFG.heartbeatHours > 0 && Date.now() - state.lastHeartbeat > CFG.heartbeatHours * 3600e3) {
    state.lastHeartbeat = Date.now();
    await notify({ title: "DuoStock heartbeat", message: `Still watching. ${state.polls} checks, ${state.failures} failures. Nothing in stock yet.`, priority: "min", tags: "zzz" });
  }
}

function startStatusServer() {
  if (!CFG.port) return;
  http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ok: state.consecutiveFailures < CFG.failAlertAfter, polls: state.polls, failures: state.failures,
      lastOk: state.lastOk && new Date(state.lastOk).toISOString(), lastError: state.lastError,
      watching: Object.values(PARTS), stores: state.lastSnapshot.map((r) => `${r.store}: ${r.name} = ${r.available ? "AVAILABLE" : "no"}`),
    }, null, 2));
  }).listen(CFG.port, () => log("status page on :" + CFG.port));
}

async function main() {
  log(`DuoStock up. Watching ${Object.values(PARTS).join(", ")} at ${STORES.join(",")} every ${CFG.intervalSec}s. ntfy topic: ${CFG.topic ? "set" : "NOT SET (console only)"}`);
  startStatusServer();
  const deadline = CFG.maxRuntimeMin ? Date.now() + CFG.maxRuntimeMin * 60e3 : Infinity;
  const hot = !!(CFG.workerId && CFG.topic);
  let active = !hot;
  while (Date.now() < deadline) {
    if (!active) {
      const others = await aliveOthers();
      if (others.length === 0) { active = true; log(`worker ${CFG.workerId}: taking over as active checker`); }
      else { await sleep(CFG.standbyPollSec * 1000); continue; }
    }
    const t0 = Date.now();
    await poll();
    if (state.exitBlocked) break;
    if (hot) {
      await hbSend("hb");
      const others = await aliveOthers();
      if (others.some((id) => id < CFG.workerId)) { active = false; log(`worker ${CFG.workerId}: yielding to ${others.join(",")}`); }
    }
    if (env.ONCE === "1") break;
    // Exactly one check per interval: next check starts intervalSec after this one STARTED
    await sleep(Math.max(0, CFG.intervalSec * 1000 - (Date.now() - t0)));
  }
  if (hot && active) await hbSend("rel");   // runtime limit or blocked: tell standbys to take over now
  if (state.exitBlocked) {
    // Blocked: hand over to a fresh runner (workflow reads these outputs). A run that worked before it got blocked restarts the count at 1.
    const streak = state.successes > 0 ? 1 : CFG.blockedStreak + 1;
    log(`blocked (${state.lastError}); exiting so a fresh runner takes over. Blocked runs in a row: ${streak}`);
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `blocked=1\nstreak=${streak}\n`);
    if (streak === 5 || (streak > 5 && streak % 60 === 0)) {
      await notify({ title: "DuoStock is blind", message: `Apple keeps blocking the checker (${streak} runners in a row, last error: ${state.lastError}). Still retrying on fresh runners.`, priority: "high", tags: "warning" });
    }
    return;
  }
  log("exiting (runtime limit or ONCE)");
}

main();
