#!/usr/bin/env node
// DuoStock: watches Apple Canada in-store pickup for iPhone Duo and pings your phone via ntfy.sh.
// Zero dependencies. Needs Node 18+.  Run:  NTFY_TOPIC=your-secret-topic node duostock.mjs

import http from "node:http";

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
  failAlerted: false, lastHeartbeat: Date.now(),
};

async function notify({ title, message, priority = "default", tags = "iphone", click = BUY_URL }) {
  if (!CFG.topic) { log("[no NTFY_TOPIC set] would notify:", title, "-", message); return; }
  try {
    const r = await fetch(`${CFG.ntfyServer}/${encodeURIComponent(CFG.topic)}`, {
      method: "POST",
      // HTTP headers must be latin1, so title goes in a header only if ASCII-safe
      headers: { Title: title.replace(/[^\x20-\x7e]/g, ""), Priority: priority, Tags: tags, Click: click },
      body: message,
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

async function poll() {
  state.polls++;
  try {
    const rows = flatten(await fetchPickup());
    state.lastOk = Date.now(); state.consecutiveFailures = 0; state.lastSnapshot = rows;
    if (state.failAlerted) { state.failAlerted = false; await notify({ title: "DuoStock recovered", message: "Apple checks are working again.", tags: "white_check_mark" }); }

    const nowAvail = rows.filter((r) => r.available);
    // Alert on every store/part that flipped unavailable -> available (or is available on first poll)
    const fresh = nowAvail.filter((r) => !state.seen.get(`${r.storeNo}|${r.part}`));
    for (const r of rows) state.seen.set(`${r.storeNo}|${r.part}`, r.available);

    if (fresh.length) {
      const msg = fresh.map((r) => `${r.name}\n${r.store} (${r.city})`).join("\n\n");
      log("IN STOCK:", fresh.map((r) => `${r.name} @ ${r.store}`).join("; "));
      await notify({
        title: "iPhone Duo IN STOCK", message: msg + "\n\nTap to open Apple. Reserve fast.",
        priority: "urgent", tags: "rotating_light,iphone",
      });
    } else {
      log(`poll #${state.polls}: ${rows.length} combos checked, ${nowAvail.length} available`);
    }
  } catch (e) {
    state.failures++; state.consecutiveFailures++; state.lastError = `${e.message} @ ${new Date().toISOString()}`;
    log(`poll #${state.polls} FAILED (${state.consecutiveFailures} in a row):`, e.message);
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
  if (env.NOTIFY_ON_START !== "0") await notify({ title: "DuoStock started", message: `Watching ${Object.values(PARTS).join(" and ")} at ${STORES.length} BC stores, every ${CFG.intervalSec}s.`, priority: "low", tags: "eyes" });
  const deadline = CFG.maxRuntimeMin ? Date.now() + CFG.maxRuntimeMin * 60e3 : Infinity;
  while (Date.now() < deadline) {
    const t0 = Date.now();
    await poll();
    if (env.ONCE === "1") break;
    // small jitter so we are not a perfect metronome
    const wait = Math.max(1000, CFG.intervalSec * 1000 - (Date.now() - t0) + Math.floor(Math.random() * Number(env.JITTER_MS ?? 3000)));
    await sleep(wait);
  }
  log("exiting (runtime limit or ONCE)");
}

main();
