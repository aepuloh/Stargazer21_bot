// MiniApp Mining + Monetag + Postgres (all-in-one)
// by you & your friendly assistant :)

require("dotenv").config();
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { Pool } = require("pg");

// ===== ENV =====
const TOKEN = process.env.BOT_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL; // e.g. https://your-app.up.railway.app
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "change-me";

// Monetag zones (boleh sama semua)
const Z_REWARD = process.env.MONETAG_REWARDED || "9755147";
const Z_POPUP  = process.env.MONETAG_POPUP    || Z_REWARD;
const Z_INTER  = process.env.MONETAG_INTER    || Z_REWARD;

if (!TOKEN || !PUBLIC_URL || !process.env.DATABASE_URL) {
  console.error("❌ Wajib set BOT_TOKEN, PUBLIC_URL, DATABASE_URL di .env");
  process.exit(1);
}

// ===== DB (Postgres) =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Auto create table
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id    BIGINT PRIMARY KEY,
      points     BIGINT DEFAULT 0,
      last_daily TIMESTAMPTZ DEFAULT '1970-01-01'
    )
  `);
  console.log("✅ Table 'users' ready");
})().catch(err => {
  console.error("❌ DB init error:", err);
  process.exit(1);
});

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

// ===== Bot =====
const bot = new TelegramBot(TOKEN, { polling: true });

// tombol biru Open -> /game
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
      "👋 Welcome! Tekan tombol biru **Open** untuk masuk ke mini app."
    );
  } catch (e) {
    bot.sendMessage(id, "⚠️ Server lagi sibuk, coba lagi ya.");
  }
});

bot.onText(/\/balance/, async (msg) => {
  try {
    const u = await getUser(msg.chat.id);
    bot.sendMessage(msg.chat.id, `💰 Balance: ${u.points} PIR`);
  } catch {
    bot.sendMessage(msg.chat.id, "⚠️ Gagal ambil balance.");
  }
});

// ===== Web Server =====
const app = express();
app.use(express.json());

// --- API: leaderboard
app.get("/api/top", async (_req, res) => {
  try {
    res.json(await topUsers());
  } catch {
    res.status(500).json({ ok: false });
  }
});

// --- API: daily (1x/24h)
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
  } catch {
    res.status(500).json({ ok: false });
  }
});

// --- API: reward (dipanggil setelah iklan/game)
app.post("/api/reward", async (req, res) => {
  try {
    const { user_id, amount, source } = req.body || {};
    if (!user_id || !amount) return res.status(400).json({ ok: false });
    const updated = await addPoints(user_id, parseInt(amount, 10));
    res.json({ ok: true, balance: updated.points, source });
  } catch {
    res.status(500).json({ ok: false });
  }
});

// --- ADMIN ENDPOINTS (pakai ?key=ADMIN_KEY)
app.get("/admin/add", async (req, res) => {
  const { user, amt, key } = req.query;
  if (key !== ADMIN_KEY) return res.status(403).send("❌ Unauthorized");
  if (!user || !amt) return res.send("⚠️ user & amt required");
  try {
    const u = await addPoints(user, parseInt(amt, 10));
    res.send(`✅ User ${user} ditambah ${amt}, balance = ${u.points}`);
  } catch (e) {
    res.status(500).send("❌ Error");
  }
});

app.get("/admin/reset", async (req, res) => {
  const { user, key } = req.query;
  if (key !== ADMIN_KEY) return res.status(403).send("❌ Unauthorized");
  if (!user) return res.send("⚠️ user required");
  try {
    await pool.query("UPDATE users SET points=0 WHERE user_id=$1", [user]);
    res.send(`♻️ User ${user} balance direset ke 0`);
  } catch {
    res.status(500).send("❌ Error");
  }
});

app.get("/admin/top", async (req, res) => {
  const { key } = req.query;
  if (key !== ADMIN_KEY) return res.status(403).send("❌ Unauthorized");
  try {
    const rows = await topUsers(10);
    res.send(
      "<h2>🏆 Top Users</h2>" +
        rows.map((u, i) => `${i + 1}. ${u.user_id} — <b>${u.points}</b>`).join("<br>")
    );
  } catch {
    res.status(500).send("❌ Error");
  }
});

// --- MINI APP UI
app.get("/game", (req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Mining App</title>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>

  <!-- Monetag tags -->
  <script src='//libtl.com/sdk.js' data-zone='${Z_REWARD}' data-sdk='show_${Z_REWARD}'></script>
  <script src='//libtl.com/sdk.js' data-zone='${Z_POPUP}'  data-sdk='show_${Z_POPUP}' ></script>
  <script src='//libtl.com/sdk.js' data-zone='${Z_INTER}'  data-sdk='show_${Z_INTER}' ></script>

  <style>
    *{box-sizing:border-box}
    body{margin:0;background:#0f0f14;color:#fff;font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,sans-serif}
    .wrap{max-width:720px;margin:0 auto;padding:12px 12px 80px}
    .section{background:#15151b;border:1px solid #23232b;border-radius:14px;padding:16px;margin:14px 0}
    .title{font-weight:700;font-size:22px;margin:0 0 8px}
    .sub{opacity:.75;font-size:14px;margin:0 0 10px}
    .task{display:flex;align-items:center;justify-content:space-between;background:#1a1a22;border-radius:12px;padding:12px 14px;margin:8px 0}
    .left{display:flex;align-items:center;gap:12px}
    .emoji{font-size:28px}
    .claim{background:#fff;color:#111;font-weight:700;border:none;border-radius:999px;padding:8px 16px;cursor:pointer}
    .pill{display:inline-flex;align-items:center;gap:8px;background:#3b2f88;padding:10px 12px;border-radius:12px}
    .tabbar{position:fixed;left:0;right:0;bottom:0;background:#15151b;border-top:1px solid #23232b;display:flex;justify-content:space-around;padding:10px 6px}
    .tab{display:flex;flex-direction:column;align-items:center;font-size:12px;opacity:.7}
    .tab.active{opacity:1}
    .page{display:none}
    .page.active{display:block}
    .btn{background:#6c5ce7;border:none;color:#fff;padding:10px 16px;border-radius:10px;cursor:pointer}
    .center{text-align:center}
    .muted{opacity:.7}
    .slot{display:flex;gap:8px;justify-content:center;margin:12px 0}
    .reel{width:70px;height:70px;background:#0d0d12;border:1px solid #2a2a33;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:40px}
  </style>
</head>
<body>
  <div class="wrap">
    <div id="page-home" class="page active">
      <div class="section">
        <div class="title">Tasks</div>
        <div class="sub">Get rewards for actions</div>

        <div class="task">
          <div class="left">
            <div class="emoji">🤩</div>
            <div><b>Watch short ads</b><div class="muted">Rewarded Interstitial</div></div>
          </div>
          <button class="claim" id="btn-rewarded">Claim</button>
        </div>

        <div class="task">
          <div class="left">
            <div class="emoji">😎</div>
            <div><b>Click to get reward</b><div class="muted">Rewarded Popup</div></div>
          </div>
          <button class="claim" id="btn-popup">Claim</button>
        </div>
      </div>

      <div class="section">
        <div class="title">Daily</div>
        <div class="sub">After time actions</div>
        <div class="pill"><span id="daily-status">Ready</span></div>
        <div class="center" style="margin-top:12px"><button class="btn" id="btn-daily">Claim daily (+10)</button></div>
      </div>

      <div class="section" style="background:#3c2f92">
        <div class="title">👀 Watch video</div>
        <div class="sub">In-App Interstitial</div>
        <div class="center"><button class="claim" id="btn-inter">Play</button></div>
      </div>
    </div>

    <div id="page-leaders" class="page">
      <div class="section">
        <div class="title">Leaders</div>
        <div id="leaders" class="sub">Loading…</div>
      </div>
    </div>

    <div id="page-all" class="page">
      <div class="section">
        <div class="title">All tasks</div>
        <div class="sub">Same actions collected here</div>
        <div class="center"><button class="claim" onclick="switchTab('home')">Go to tasks</button></div>
      </div>
    </div>

    <div id="page-games" class="page">
      <div class="section center">
        <div class="title">Pirate Slot</div>
        <div class="sub">Spin & win</div>
        <div class="slot">
          <div class="reel" id="r1">❓</div>
          <div class="reel" id="r2">❓</div>
          <div class="reel" id="r3">❓</div>
        </div>
        <button class="btn" id="btn-spin">🎰 Spin (–1)</button>
        <div class="sub" id="slot-msg"></div>
      </div>
    </div>
  </div>

  <div class="tabbar">
    <div class="tab active" id="tab-home" onclick="switchTab('home')">🏠<div>Home</div></div>
    <div class="tab" id="tab-leaders" onclick="switchTab('leaders')">❤️<div>Leaders</div></div>
    <div class="tab" id="tab-all" onclick="switchTab('all')">🎁<div>All tasks</div></div>
    <div class="tab" id="tab-games" onclick="switchTab('games')">🎮<div>Games</div></div>
  </div>

  <script>
    const tg = window.Telegram.WebApp; tg.expand();
    const userId = tg.initDataUnsafe?.user?.id;

    const post = (u,d)=>fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)}).then(r=>r.json());
    const fmtLeft = (iso)=>{ const left = Math.max(0,(new Date(iso)-new Date())); const h=Math.floor(left/3600000), m=Math.floor((left%3600000)/60000); return h+"h "+m+"m"; };

    function switchTab(key){
      ["home","leaders","all","games"].forEach(k=>{
        document.getElementById("page-"+k).classList.toggle("active", k===key);
        document.getElementById("tab-"+k).classList.toggle("active", k===key);
      });
      if(key==="leaders") loadLeaders();
    }

    async function loadLeaders(){
      const el = document.getElementById("leaders");
      el.textContent = "Loading…";
      const r = await fetch("/api/top").then(r=>r.json());
      el.innerHTML = r.map((u,i)=> (i+1)+". "+u.user_id+" — <b>"+u.points+" PIR</b>").join("<br>");
    }

    // Daily
    document.getElementById("btn-daily").onclick = async ()=>{
      if(!userId) return alert("Open from Telegram");
      const r = await post("/api/daily",{ user_id:userId });
      const el = document.getElementById("daily-status");
      if(r.ok){ el.textContent="Claimed! Come back in 24h"; }
      else if(r.next){ el.textContent="Next in "+fmtLeft(r.next); }
      else { el.textContent="Try later"; }
    };

    // Reward helper
    async function reward(amount, source){
      if(!userId) return alert("Open from Telegram");
      await post("/api/reward", { user_id:userId, amount, source });
      tg.HapticFeedback?.notificationOccurred?.("success");
    }
    function callMonetag(zone, fbMs, onOk){
      const fn = "show_"+zone;
      if (typeof window[fn] === "function"){
        return window[fn]().then(onOk).catch(()=>setTimeout(onOk, fbMs));
      } else {
        setTimeout(onOk, fbMs);
      }
    }

    // Monetag buttons
    document.getElementById("btn-rewarded").onclick = () => callMonetag("${Z_REWARD}", 4000, ()=>reward(5,"rewarded"));
    document.getElementById("btn-popup").onclick    = () => callMonetag("${Z_POPUP}",  3000, ()=>reward(5,"popup"));
    document.getElementById("btn-inter").onclick    = () => callMonetag("${Z_INTER}",  3000, ()=>reward(3,"interstitial"));

    // Slot mini
    let balance = 10;
    const syms = ["🍒","🍋","💎","⭐","7️⃣","⚓","🏴‍☠️"];
    const rand = ()=> syms[Math.floor(Math.random()*syms.length)];
    document.getElementById("btn-spin").onclick = async ()=>{
      if(balance<1){ document.getElementById("slot-msg").textContent="Top up via tasks"; return; }
      balance--;
      const R=[document.getElementById("r1"),document.getElementById("r2"),document.getElementById("r3")];
      const t=setInterval(()=>R.forEach(r=>r.textContent=rand()),90);
      setTimeout(()=>{
        clearInterval(t);
        const res=[rand(),rand(),rand()];
        R.forEach((r,i)=>r.textContent=res[i]);
        let win=0, msg="No win";
        if(res[0]===res[1] && res[1]===res[2]){ win=(res[0]==="🏴‍☠️")?50:20; msg=(win===50?"3x Scatter! +50":"Triple! +20"); }
        else if(res.filter(x=>x==="🏴‍☠️").length===2){ win=10; msg="2x Scatter! +10"; }
        if(win>0){ reward(win,"slot"); }
        balance += win;
        document.getElementById("slot-msg").textContent = msg + " | Balance (local): "+balance;
      }, 1800);
    };
  </script>
</body>
</html>`);
});

// root
app.get("/", (_req, res) => res.send("🚀 MiniApp is up. Open via Telegram (tombol biru **Open**)."));

// start
app.listen(PORT, () => console.log("✅ Server running on", PORT));
