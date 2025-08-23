// index.js
// MiniApp + Monetag Ads + Full Slot (6x5 tumble-style, server-side) + Postgres (Railway ready)
// =========================================================================================

require("dotenv").config();
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { Pool } = require("pg");

// ===== env / config =====
const TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "change-me";
const PUBLIC_URL =
  process.env.PUBLIC_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : null);

if (!TOKEN || !PUBLIC_URL || !process.env.DATABASE_URL) {
  console.error(
    "❌ Wajib set BOT_TOKEN, DATABASE_URL, dan PUBLIC_URL/RAILWAY_PUBLIC_DOMAIN di Variables"
  );
  process.exit(1);
}

// ===== Postgres pool =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// DB init
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id    BIGINT PRIMARY KEY,
      points     BIGINT DEFAULT 0,
      last_daily TIMESTAMPTZ DEFAULT '1970-01-01'
    )
  `);
  console.log("✅ Table 'users' ready");
})().catch((err) => {
  console.error("❌ DB init error:", err);
  process.exit(1);
});

// ===== DB helpers =====
async function getUser(user_id) {
  const q = await pool.query("SELECT * FROM users WHERE user_id=$1", [user_id]);
  if (q.rowCount === 0) {
    await pool.query(
      "INSERT INTO users(user_id, points, last_daily) VALUES($1, 0, '1970-01-01')",
      [user_id]
    );
    return { user_id, points: 0, last_daily: new Date(0) };
  }
  return q.rows[0];
}
async function addPoints(user_id, amount) {
  await getUser(user_id);
  const q = await pool.query(
    "UPDATE users SET points = points + $2 WHERE user_id=$1 RETURNING *",
    [user_id, amount]
  );
  return q.rows[0];
}
async function setDaily(user_id) {
  const q = await pool.query(
    "UPDATE users SET last_daily = NOW(), points = points + 10 WHERE user_id=$1 RETURNING *",
    [user_id]
  );
  return q.rows[0];
}
async function topUsers(limit = 20) {
  const q = await pool.query(
    "SELECT user_id, points FROM users ORDER BY points DESC LIMIT $1",
    [limit]
  );
  return q.rows;
}

// ===== Telegram Bot (polling) =====
const bot = new TelegramBot(TOKEN, { polling: true });

bot
  .setChatMenuButton({
    menu_button: {
      type: "web_app",
      text: "Open",
      web_app: { url: `${PUBLIC_URL}/game` },
    },
  })
  .then(() => console.log("✅ Menu button diarahkan ke /game"))
  .catch((e) => console.warn("⚠️ setChatMenuButton:", e.message));

bot.onText(/\/start/, async (msg) => {
  const id = msg.chat.id;
  try {
    await getUser(id);
    bot.sendMessage(
      id,
      "👋 Selamat datang! Tekan tombol biru **Open** di bawah chat untuk membuka MiniApp."
    );
  } catch {
    bot.sendMessage(id, "⚠️ Server lagi sibuk, coba lagi ya.");
  }
});

bot.onText(/\/balance/, async (msg) => {
  try {
    const u = await getUser(msg.chat.id);
    bot.sendMessage(msg.chat.id, `💰 Balance: ${u.points}`);
  } catch {
    bot.sendMessage(msg.chat.id, "⚠️ Gagal ambil balance.");
  }
});

// ===== Express App & APIs =====
const app = express();
app.use(express.json());

// Top leaderboard
app.get("/api/top", async (_req, res) => {
  try {
    res.json(await topUsers());
  } catch (e) {
    console.error("api/top err", e);
    res.status(500).json({ ok: false });
  }
});

// Daily reward (1x24h)
app.post("/api/daily", async (req, res) => {
  try {
    const { user_id } = req.body || {};
    if (!user_id) return res.status(400).json({ ok: false, error: "no user_id" });
    const u = await getUser(user_id);
    const now = new Date();
    const last = new Date(u.last_daily);
    if (now - last < 24 * 60 * 60 * 1000) {
      return res.json({
        ok: false,
        next: new Date(last.getTime() + 86400000).toISOString(),
      });
    }
    const updated = await setDaily(user_id);
    res.json({ ok: true, reward: 10, balance: updated.points });
  } catch (e) {
    console.error("api/daily err", e);
    res.status(500).json({ ok: false });
  }
});

// Generic reward endpoint (ads, misc)
app.post("/api/reward", async (req, res) => {
  try {
    const { user_id, amount, source } = req.body || {};
    if (!user_id || typeof amount === "undefined")
      return res.status(400).json({ ok: false, error: "bad params" });
    const updated = await addPoints(user_id, parseInt(amount, 10));
    console.log(`🎯 Reward diberikan: user=${user_id}, amount=${amount}, source=${source}`);
    res.json({ ok: true, balance: updated.points });
  } catch (e) {
    console.error("api/reward err", e);
    res.status(500).json({ ok: false });
  }
});

// ===== Slot (server-side spin) =====
// Basic rules:
// - Grid 6 columns × 5 rows
// - Pay-anywhere counts (counts of same symbol across grid) using paytable steps
// - Random multiplier sometimes applied
// - Scatter triggers extra coin reward (demo) — can be extended to free-spins logic
app.post("/api/slot-spin", async (req, res) => {
  try {
    const { user_id, bet } = req.body || {};
    const betVal = parseInt(bet, 10) || 10;
    if (!user_id || !betVal) return res.status(400).json({ ok: false, error: "bad params" });

    // ensure user exists and has enough points
    const u = await getUser(user_id);
    if (u.points < betVal) return res.json({ ok: false, error: "Saldo kurang" });

    // debit bet
    await addPoints(user_id, -betVal);

    // RNG grid
    const SYMBOLS = ["💎","👑","⚱️","🪙","🔱"]; // regular symbols
    const SCATTER = "🗿";
    const weights = SYMBOLS.length + 1; // equal chance including scatter (simple)
    const randSymbol = () => {
      const idx = Math.floor(Math.random() * weights);
      return idx < SYMBOLS.length ? SYMBOLS[idx] : SCATTER;
    };

    const ROWS = 5, COLS = 6;
    const grid = [];
    for (let r = 0; r < ROWS; r++) {
      const row = [];
      for (let c = 0; c < COLS; c++) row.push(randSymbol());
      grid.push(row);
    }

    // count symbols
    const counts = {};
    let scatters = 0;
    for (const row of grid) {
      for (const s of row) {
        if (s === SCATTER) scatters++;
        else counts[s] = (counts[s] || 0) + 1;
      }
    }

    // paytable by counts (pay-anywhere)
    const steps = [
      { min: 21, mult: 50 },
      { min: 16, mult: 25 },
      { min: 14, mult: 10 },
      { min: 12, mult: 5 },
      { min: 10, mult: 2 },
      { min: 8, mult: 1 },
    ];

    let baseWin = 0;
    for (const sym in counts) {
      const n = counts[sym];
      for (const st of steps) {
        if (n >= st.min) {
          baseWin += st.mult * betVal;
          break;
        }
      }
    }

    // Random multipliers (chance)
    let multis = [];
    if (Math.random() < 0.30) {
      // maybe multiple chips
      const possible = [2,3,4,5,6,7,8,10,12,15,20];
      const count = Math.random() < 0.2 ? 2 : 1;
      for (let i = 0; i < count; i++) {
        multis.push(possible[Math.floor(Math.random() * possible.length)]);
      }
    }

    // apply multipliers as percent addition (sum then +1)
    let totalWin = baseWin;
    if (multis.length > 0) {
      const sumPerc = multis.reduce((s, x) => s + x, 0);
      totalWin = Math.floor(totalWin * (1 + sumPerc / 100));
    }

    // scatter reward (demo): add a small coin reward for scatter hits
    if (scatters >= 4) {
      // reward in terms of bet multiples
      totalWin += betVal * 5; // for demo: 5x bet
    }

    // credit win
    if (totalWin > 0) {
      await addPoints(user_id, totalWin);
    }

    const updated = await getUser(user_id);
    res.json({
      ok: true,
      grid,
      win: totalWin,
      balance: updated.points,
      multis,
      scatters
    });
  } catch (e) {
    console.error("❌ slot-spin error:", e);
    res.status(500).json({ ok: false });
  }
});

// ===== Admin helpers =====
app.get("/admin/add", async (req, res) => {
  const { user, amt, key } = req.query;
  if (key !== ADMIN_KEY) return res.status(403).send("❌ Unauthorized");
  if (!user || !amt) return res.send("⚠️ user & amt required");
  try {
    const u = await addPoints(user, parseInt(amt, 10));
    res.send(`✅ User ${user} +${amt}, balance = ${u.points}`);
  } catch (e) {
    console.error("admin/add err", e);
    res.status(500).send("❌ Error");
  }
});
app.get("/admin/top", async (req, res) => {
  const { key } = req.query;
  if (key !== ADMIN_KEY) return res.status(403).send("❌ Unauthorized");
  try {
    const rows = await topUsers(20);
    res.send(
      "<h2>🏆 Top Users</h2>" +
        rows.map((u, i) => `${i + 1}. ${u.user_id} — <b>${u.points}</b>`).join("<br>")
    );
  } catch (e) {
    console.error("admin/top err", e);
    res.status(500).send("❌ Error");
  }
});

// ===== MiniApp UI (merged) =====
// The /game HTML contains: Tasks (ads), Daily, Session stats, Leaders, All tasks, Games (slot 6x5)
app.get("/game", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>MiniApp — Tasks & Slot</title>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>

  <!-- Monetag SDK (3 zones) -->
  <script src='//libtl.com/sdk.js' data-zone='${process.env.MONETAG_REWARDED || ""}' data-sdk='show_${process.env.MONETAG_REWARDED || ""}'></script>
  <script src='//libtl.com/sdk.js' data-zone='${process.env.MONETAG_POPUP || ""}' data-sdk='show_${process.env.MONETAG_POPUP || ""}'></script>
  <script src='//libtl.com/sdk.js' data-zone='${process.env.MONETAG_INTER || ""}' data-sdk='show_${process.env.MONETAG_INTER || ""}'></script>

  <style>
    *{box-sizing:border-box}
    body{margin:0;background:#0c0c10;color:#fff;font-family:system-ui,Roboto,Segoe UI,sans-serif}
    .wrap{max-width:860px;margin:0 auto;padding:14px 14px 96px}
    .section{background:#141419;border:1px solid #23232b;border-radius:16px;padding:16px;margin:14px 0}
    .title{font-weight:800;font-size:22px;margin:0 0 8px}
    .sub{opacity:.75;font-size:14px;margin:0 0 10px}
    .task{display:flex;align-items:center;justify-content:space-between;background:#1a1a22;border:1px solid #262633;border-radius:14px;padding:12px;margin:10px 0}
    .left{display:flex;align-items:center;gap:12px}
    .emoji{font-size:30px}
    .claim{background:#fff;color:#111;font-weight:700;border:none;border-radius:999px;padding:9px 18px;cursor:pointer}
    .btn{background:#6c5ce7;border:none;color:#fff;padding:10px 16px;border-radius:12px;cursor:pointer}
    .center{text-align:center}
    .tabbar{position:fixed;left:0;right:0;bottom:0;background:#141419;border-top:1px solid #23232b;display:flex;justify-content:space-around;padding:10px 6px}
    .tab{display:flex;flex-direction:column;align-items:center;font-size:12px;opacity:.7}
    .tab.active{opacity:1}
    .page{display:none}
    .page.active{display:block}
    .slot-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;margin:12px 0}
    .cell{background:#0f0f14;border:1px solid #23232b;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:28px;height:58px}
    .controls{display:flex;gap:8px;justify-content:center;align-items:center;margin-top:8px}
    .pill{background:#1a1a22;border:1px solid #262633;border-radius:999px;padding:6px 10px;font-size:12px}
    .muted{opacity:.7;font-size:13px}
    .payinfo{font-size:13px;margin-top:8px;color:#bfc8d9}
  </style>
</head>
<body>
  <div class="wrap">
    <!-- HOME / TASKS -->
    <div id="page-home" class="page active">
      <div class="section">
        <div class="title">Tasks</div>
        <div class="sub">Get rewards for actions (ads integrated)</div>

        <div class="task">
          <div class="left">
            <div class="emoji">🤩</div>
            <div><b>Watch rewarded ad</b><div class="sub">Rewarded zone</div></div>
          </div>
          <button class="claim" id="btn-rewarded">Claim</button>
        </div>

        <div class="task">
          <div class="left">
            <div class="emoji">😎</div>
            <div><b>Popup reward</b><div class="sub">Popup zone</div></div>
          </div>
          <button class="claim" id="btn-popup">Claim</button>
        </div>

        <div class="task">
          <div class="left">
            <div class="emoji">👁️</div>
            <div><b>Interstitial</b><div class="sub">In-app video</div></div>
          </div>
          <button class="claim" id="btn-inter">Play</button>
        </div>
      </div>

      <div class="section">
        <div class="title">Daily</div>
        <div class="sub">Once every 24h</div>
        <div class="center"><button class="btn" id="btn-daily">Claim daily (+10)</button></div>
        <div class="sub" id="daily-status"></div>
      </div>

      <div class="section">
        <div class="title">Session stats</div>
        <div class="stat">
          <div class="pill">Rewarded: <b id="c-rewarded">0</b></div>
          <div class="pill">Popup: <b id="c-popup">0</b></div>
          <div class="pill">Interstitial: <b id="c-inter">0</b></div>
          <div class="pill">Slot wins: <b id="c-slot">0</b></div>
          <div class="pill">Balance: <b id="c-balance">?</b></div>
        </div>
      </div>
    </div>

    <!-- LEADERS -->
    <div id="page-leaders" class="page">
      <div class="section">
        <div class="title">Leaderboard</div>
        <div id="leaders" class="sub">Loading…</div>
      </div>
    </div>

    <!-- ALL TASKS -->
    <div id="page-all" class="page">
      <div class="section center">
        <div class="title">All tasks</div>
        <div class="sub">All available tasks collected here</div>
        <button class="claim" onclick="switchTab('home')">Go to tasks</button>
      </div>
    </div>

    <!-- GAMES (SLOT 6x5) -->
    <div id="page-games" class="page">
      <div class="section center">
        <div class="title">🎰 Temple Thunder — Demo Slot (6×5)</div>
        <div class="muted">Bet coins (not real money). Spin computed on server.</div>

        <div style="margin-top:12px">
          <div id="balance" class="sub">Balance: ?</div>

          <div class="slot-grid" id="slot-grid" aria-hidden="true">
            <!-- 6x5 cell placeholders will be injected -->
          </div>

          <div class="controls">
            <label class="muted">Bet</label>
            <select id="bet-select">
              <option value="5">5</option>
              <option value="10" selected>10</option>
              <option value="20">20</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </select>

            <button class="btn" id="spin-btn">SPIN</button>
            <button class="btn" id="auto-btn">Auto: OFF</button>
            <button class="btn" id="turbo-btn">Turbo: OFF</button>
          </div>

          <div id="slot-msg" class="sub" style="margin-top:10px"></div>

          <div class="payinfo">
            <div><b>Paytable (demo):</b> count same-symbol across grid → payouts by steps (8+:1× … 21+:50×). Scatter (🗿) 4+ gives bonus.</div>
            <div style="margin-top:6px">Multipliers may appear randomly and boost win.</div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="tabbar">
    <div class="tab active" id="tab-home" onclick="switchTab('home')">🏠<div>Home</div></div>
    <div class="tab" id="tab-leaders" onclick="switchTab('leaders')">❤️<div>Leaders</div></div>
    <div class="tab" id="tab-all" onclick="switchTab('all')">🎁<div>All</div></div>
    <div class="tab" id="tab-games" onclick="switchTab('games')">🎮<div>Games</div></div>
  </div>

<script>
  // Telegram init
  const tg = window.Telegram.WebApp;
  try { tg.expand(); } catch(e){}

  const userId = tg?.initDataUnsafe?.user?.id;
  const post = (u, d) => fetch(u, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(d) }).then(r=>r.json());

  // session counters
  const counters = { rewarded:0, popup:0, inter:0, slot:0, balance:null };
  const ids = {
    rewarded: "${process.env.MONETAG_REWARDED || ""}",
    popup: "${process.env.MONETAG_POPUP || ""}",
    inter: "${process.env.MONETAG_INTER || ""}"
  };

  const el = id => document.getElementById(id);
  function syncCounters(){
    el("c-rewarded").textContent = counters.rewarded;
    el("c-popup").textContent = counters.popup;
    el("c-inter").textContent = counters.inter;
    el("c-slot").textContent = counters.slot;
    el("c-balance").textContent = (counters.balance == null ? "?" : counters.balance);
    el("balance").textContent = "Balance: " + (counters.balance == null ? "?" : counters.balance);
  }

  // Tab switch
  function switchTab(key){
    ["home","leaders","all","games"].forEach(k=>{
      document.getElementById("page-"+k).classList.toggle("active", k===key);
      document.getElementById("tab-"+k).classList.toggle("active", k===key);
    });
    if(key==="leaders") loadLeaders();
  }

  async function loadLeaders(){
    const elL = el("leaders");
    elL.textContent = "Loading…";
    try {
      const r = await fetch("/api/top").then(r=>r.json());
      elL.innerHTML = (r||[]).map((u,i)=> (i+1) + ". " + u.user_id + " — <b>" + u.points + "</b>").join("<br>");
    } catch(e) { elL.textContent = "⚠️ Failed"; }
  }

  // Monetag wrapper safe fallback
  function callMonetag(zone, fallbackMs, onOk){
    if(!zone){ setTimeout(onOk, fallbackMs); return; }
    const fn = "show_" + zone;
    try {
      if(typeof window[fn] === "function"){
        const p = window[fn]();
        if(p && typeof p.then === "function"){ p.then(onOk).catch(()=>setTimeout(onOk, fallbackMs)); }
        else setTimeout(onOk, fallbackMs);
      } else setTimeout(onOk, fallbackMs);
    } catch(e){ setTimeout(onOk, fallbackMs); }
  }

  // Reward helpers
  async function reward(amount, source){
    if(!userId) { alert("Buka dari Telegram agar bisa simpan ke server"); return; }
    try {
      const r = await post("/api/reward", { user_id: userId, amount, source });
      if(r.ok) counters.balance = r.balance;
    } catch(e){}
    counters[source] = (counters[source]||0) + 1;
    syncCounters();
    try { tg.HapticFeedback?.notificationOccurred?.("success"); } catch(e){}
  }

  el("btn-rewarded").onclick = () => callMonetag(ids.rewarded, 4000, ()=>reward(5,"rewarded"));
  el("btn-popup").onclick = () => callMonetag(ids.popup, 3000, ()=>reward(5,"popup"));
  el("btn-inter").onclick = () => callMonetag(ids.inter, 3000, ()=>reward(3,"inter"));

  // Daily
  el("btn-daily").onclick = async () => {
    if(!userId) return alert("Open dari Telegram");
    const r = await post("/api/daily", { user_id: userId });
    if(r.ok){
      el("daily-status").textContent = "✅ Claimed!";
      counters.balance = r.balance; syncCounters();
      try { tg.HapticFeedback?.notificationOccurred?.("success"); } catch(e){}
    } else if(r.next){
      el("daily-status").textContent = "Next: " + new Date(r.next).toLocaleString();
    } else {
      el("daily-status").textContent = "⚠️ Try later";
    }
  };

  // ===== Slot UI + logic (client) =====
  const SLOT_ROWS = 5, SLOT_COLS = 6;
  const slotGridEl = el("slot-grid");
  const spinBtn = el("spin-btn");
  const betSelect = el("bet-select");
  const slotMsg = el("slot-msg");
  const autoBtn = el("auto-btn");
  const turboBtn = el("turbo-btn");

  let autoOn = false, turboOn = false, spinning = false;

  // build empty grid DOM
  function buildEmptyGrid(){
    slotGridEl.innerHTML = "";
    for(let r=0;r<SLOT_ROWS;r++){
      for(let c=0;c<SLOT_COLS;c++){
        const d = document.createElement("div");
        d.className = "cell";
        d.textContent = "❓";
        slotGridEl.appendChild(d);
      }
    }
  }
  buildEmptyGrid();

  // helper display grid from server
  function displayGrid(grid){
    slotGridEl.innerHTML = "";
    for(const row of grid){
      for(const sym of row){
        const d = document.createElement("div");
        d.className = "cell";
        d.textContent = sym;
        slotGridEl.appendChild(d);
      }
    }
  }

  // update balance from server periodically (light sync)
  async function refreshBalance(){
    if(!userId) return;
    try {
      // we can reuse /api/top? no. Instead call /api/reward with amount 0 to get balance (cheap hack)
      const r = await post("/api/reward", { user_id: userId, amount: 0, source: "sync" });
      if(r.ok) { counters.balance = r.balance; syncCounters(); }
    } catch(e){}
  }

  // spin action
  async function doSpin(bet){
    if(spinning) return;
    if(!userId) return alert("Open dari Telegram supaya saldo tersimpan");
    spinning = true;
    spinBtn.disabled = true;
    slotMsg.textContent = "Spinning…";
    // small animation: randomize quickly
    const cells = Array.from(document.querySelectorAll(".cell"));
    const animInterval = setInterval(()=>{
      cells.forEach(c => c.textContent = ["🍒","🍋","💎","⭐","7️⃣","⚓","🏴‍☠️"][Math.floor(Math.random()*7)]);
    }, turboOn ? 40 : 90);

    try {
      const r = await post("/api/slot-spin", { user_id: userId, bet: bet });
      clearInterval(animInterval);
      if(!r.ok){
        slotMsg.textContent = r.error || "Spin failed";
      } else {
        // show grid returned
        displayGrid(r.grid);
        slotMsg.textContent = "Win: " + r.win + (r.multis && r.multis.length ? (" | Multis: " + r.multis.join(",")) : "") + (r.scatters ? (" | Scatters: " + r.scatters) : "");
        if(r.win > 0) {
          counters.slot++; // increment slot win counter
        }
        counters.balance = r.balance;
        syncCounters();
      }
    } catch(e){
      clearInterval(animInterval);
      slotMsg.textContent = "⚠️ Error saat spin";
      console.error("spin err", e);
    } finally {
      spinning = false;
      spinBtn.disabled = false;
      if(autoOn) {
        // small delay between auto spins
        setTimeout(()=> doSpin(parseInt(betSelect.value,10)), turboOn ? 120 : 550);
      }
    }
  }

  spinBtn.onclick = () => doSpin(parseInt(betSelect.value,10));
  autoBtn.onclick = () => {
    autoOn = !autoOn;
    autoBtn.textContent = "Auto: " + (autoOn ? "ON" : "OFF");
    if(autoOn && !spinning) doSpin(parseInt(betSelect.value,10));
  };
  turboBtn.onclick = () => {
    turboOn = !turboOn;
    turboBtn.textContent = "Turbo: " + (turboOn ? "ON" : "OFF");
  };

  // quick sync on load
  (async function init(){
    syncCounters();
    // try to sync balance on open
    if(userId){
      try {
        await refreshBalance();
      } catch(e){}
    }
  })();

  // safe fallback: when reward endpoint called with amount=0 we'll receive balance (we used this minimal endpoint)
  // Alternative: you can add a dedicated /api/balance endpoint if preferred.

</script>
</body>
</html>`);
});

// root health
app.get("/", (_req, res) => res.send("🚀 MiniApp is running. Open via Telegram (tombol biru Open)."));

// start server
app.listen(PORT, () => console.log("✅ Server running on", PORT));
