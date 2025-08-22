// MiniApp + Ads (Monetag) + Slot + Postgres (Railway Ready)
// =========================================================

require("dotenv").config();
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { Pool } = require("pg");

// ===== ENV =====
const TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "change-me";

// Railway public URL fallback
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

// ===== DB (Postgres) =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

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

// ===== Bot (Polling) =====
const bot = new TelegramBot(TOKEN, { polling: true });

// tombol biru "Open" → /game
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
    bot.sendMessage(msg.chat.id, `💰 Balance: ${u.points} PIR`);
  } catch {
    bot.sendMessage(msg.chat.id, "⚠️ Gagal ambil balance.");
  }
});

// ===== Web API =====
const app = express();
app.use(express.json());

// Leaderboard
app.get("/api/top", async (_req, res) => {
  try {
    res.json(await topUsers());
  } catch {
    res.status(500).json({ ok: false });
  }
});

// Daily (1x/24h)
app.post("/api/daily", async (req, res) => {
  try {
    const { user_id } = req.body || {};
    if (!user_id)
      return res.status(400).json({ ok: false, error: "no user_id" });
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

// Reward (setelah ads/slot)
app.post("/api/reward", async (req, res) => {
  try {
    const { user_id, amount, source } = req.body || {};
    if (!user_id || !amount)
      return res.status(400).json({ ok: false, error: "bad params" });
    const updated = await addPoints(user_id, parseInt(amount, 10));
    res.json({ ok: true, balance: updated.points, source });
  } catch {
    res.status(500).json({ ok: false });
  }
});

// ===== Admin (simple) =====
app.get("/admin/add", async (req, res) => {
  const { user, amt, key } = req.query;
  if (key !== ADMIN_KEY) return res.status(403).send("❌ Unauthorized");
  if (!user || !amt) return res.send("⚠️ user & amt required");
  try {
    const u = await addPoints(user, parseInt(amt, 10));
    res.send(`✅ User ${user} +${amt}, balance = ${u.points}`);
  } catch {
    res.status(500).send("❌ Error");
  }
});
app.get("/admin/reset", async (req, res) => {
  const { user, key } = req.query;
  if (key !== ADMIN_KEY) return res.status(403).send("❌ Unauthorized");
  if (!user) return res.send("⚠️ user required");
  try {
    await pool.query("UPDATE users SET points=0 WHERE user_id=$1", [user]);
    res.send(`♻️ Reset balance user ${user} → 0`);
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
        rows
          .map(
            (u, i) => `${i + 1}. ${u.user_id} — <b>${u.points}</b>`
          )
          .join("<br>")
    );
  } catch {
    res.status(500).send("❌ Error");
  }
});

// ===== MiniApp UI (Full: Tasks/Ads + Daily + Leaders + Slot + Tabbar)
app.get("/game", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Your app — mini app</title>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>

  <!-- Monetag SDK (tiga zona) -->
  <script src='//libtl.com/sdk.js' data-zone='${process.env.MONETAG_REWARDED || ""}' data-sdk='show_${process.env.MONETAG_REWARDED || ""}'></script>
  <script src='//libtl.com/sdk.js' data-zone='${process.env.MONETAG_POPUP || ""}' data-sdk='show_${process.env.MONETAG_POPUP || ""}'></script>
  <script src='//libtl.com/sdk.js' data-zone='${process.env.MONETAG_INTER || ""}' data-sdk='show_${process.env.MONETAG_INTER || ""}'></script>

  <style>
    *{box-sizing:border-box}
    body{margin:0;background:#0c0c10;color:#fff;font-family:system-ui,Roboto,Segoe UI,sans-serif}
    .wrap{max-width:760px;margin:0 auto;padding:14px 14px 96px}
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
    .slot{display:flex;gap:10px;justify-content:center;margin:12px 0}
    .reel{width:78px;height:78px;background:#0f0f14;border:1px solid #2a2a33;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:42px}
    .purple{background:#3c2f92}
  </style>
</head>
<body>
  <div class="wrap">
    <!-- HOME -->
    <div id="page-home" class="page active">
      <div class="section">
        <div class="title">Tasks</div>
        <div class="sub">Get rewards for actions</div>

        <div class="task">
          <div class="left">
            <div class="emoji">🤩</div>
            <div><b>Watch short ads</b><div class="sub">Rewarded Interstitial</div></div>
          </div>
          <button class="claim" id="btn-rewarded">Claim</button>
        </div>

        <div class="task">
          <div class="left">
            <div class="emoji">😎</div>
            <div><b>Click to get reward</b><div class="sub">Rewarded Popup</div></div>
          </div>
          <button class="claim" id="btn-popup">Claim</button>
        </div>
      </div>

      <div class="section">
        <div class="title">Daily</div>
        <div class="sub">After time actions</div>
        <div class="center"><button class="btn" id="btn-daily">Claim daily (+10)</button></div>
        <div class="sub" id="daily-status"></div>
      </div>

      <div class="section purple">
        <div class="title">👀 Watch video</div>
        <div class="sub">In-App Interstitial</div>
        <div class="center"><button class="claim" id="btn-inter">Play</button></div>
      </div>
    </div>

    <!-- LEADERS -->
    <div id="page-leaders" class="page">
      <div class="section">
        <div class="title">Leaderboard</div>
        <div id="leaders" class="sub">Loading…</div>
      </div>
    </div>

    <!-- ALL TASKS (placeholder) -->
    <div id="page-all" class="page">
      <div class="section center">
        <div class="title">All tasks</div>
        <div class="sub">All available tasks collected here</div>
        <button class="claim" onclick="switchTab('home')">Go to tasks</button>
      </div>
    </div>

    <!-- GAMES -->
    <div id="page-games" class="page">
      <div class="section center">
        <div class="title">🎰 Pirate Slot</div>
        <div class="sub">Spin & win</div>
        <div class="slot"><div class="reel" id="r1">❓</div><div class="reel" id="r2">❓</div><div class="reel" id="r3">❓</div></div>
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

    function switchTab(key){
      ["home","leaders","all","games"].forEach(k=>{
        document.getElementById("page-"+k).classList.toggle("active", k===key);
        document.getElementById("tab-"+k).classList.toggle("active", k===key);
      });
      if(key==="leaders") loadLeaders();
    }

    async function loadLeaders(){
      const el=document.getElementById("leaders");
      el.textContent="Loading…";
      try{
        const r=await fetch("/api/top").then(r=>r.json());
        el.innerHTML=(r||[]).map((u,i)=> (i+1)+". "+u.user_id+" — <b>"+u.points+"</b>").join("<br>");
      }catch(e){ el.textContent="⚠️ Failed"; }
    }

    // Daily
    document.getElementById("btn-daily").onclick = async ()=>{
      if(!userId) return alert("Open from Telegram");
      const r = await post("/api/daily",{ user_id:userId });
      if(r.ok){ document.getElementById("daily-status").textContent="✅ Claimed!"; tg.HapticFeedback?.notificationOccurred?.("success"); }
      else if(r.next){ document.getElementById("daily-status").textContent="Next: "+new Date(r.next).toLocaleString(); }
      else { document.getElementById("daily-status").textContent="⚠️ Try later"; }
    };

    // Reward helper
    async function reward(amount, source){
      if(!userId) return alert("Open from Telegram");
      try{ await post("/api/reward",{ user_id:userId, amount, source }); }catch(e){}
      tg.HapticFeedback?.notificationOccurred?.("success");
    }

    // Monetag helper (graceful fallback)
    function callMonetag(zone, fbMs, onOk){
      if(!zone){ setTimeout(onOk, fbMs); return; }
      const fn="show_"+zone;
      try{
        if(typeof window[fn]==="function"){
          const p = window[fn]();
          if(p && typeof p.then==="function"){ p.then(onOk).catch(()=>setTimeout(onOk, fbMs)); }
          else { setTimeout(onOk, fbMs); }
        }else{
          setTimeout(onOk, fbMs);
        }
      }catch(e){ setTimeout(onOk, fbMs); }
    }

    document.getElementById("btn-rewarded").onclick = ()=>callMonetag("${process.env.MONETAG_REWARDED || ""}", 4000, ()=>reward(5,"rewarded"));
    document.getElementById("btn-popup").onclick    = ()=>callMonetag("${process.env.MONETAG_POPUP || ""}",    3000, ()=>reward(5,"popup"));
    document.getElementById("btn-inter").onclick    = ()=>callMonetag("${process.env.MONETAG_INTER || ""}",    3000, ()=>reward(3,"inter"));

    // Slot
    let localBal = 10;
    const syms=["🍒","🍋","💎","⭐","7️⃣","⚓","🏴‍☠️"];
    const rand=()=> syms[Math.floor(Math.random()*syms.length)];
    const R=[document.getElementById("r1"),document.getElementById("r2"),document.getElementById("r3")];
    document.getElementById("btn-spin").onclick=async ()=>{
      if(localBal<1){ document.getElementById("slot-msg").textContent="Top up via tasks (watch ads)"; return; }
      localBal--;
      const t=setInterval(()=>R.forEach(r=>r.textContent=rand()),90);
      setTimeout(()=>{
        clearInterval(t);
        const res=[rand(),rand(),rand()];
        R.forEach((r,i)=>r.textContent=res[i]);
        let win=0,msg="No win";
        if(res[0]===res[1] && res[1]===res[2]){ win=(res[0]==="🏴‍☠️")?50:20; msg=(win===50?"3x Scatter! +50":"Triple! +20"); }
        else if(res.filter(x=>x==="🏴‍☠️").length===2){ win=10; msg="2x Scatter! +10"; }
        if(win>0){ reward(win,"slot"); }
        localBal+=win; document.getElementById("slot-msg").textContent=msg+" | Local: "+localBal;
      },1800);
    };
  </script>
</body>
</html>`);
});

// Root health
app.get("/", (_req, res) =>
  res.send("🚀 MiniApp is running. Open via Telegram (tombol biru **Open**).")
);

// Start server
app.listen(PORT, () => console.log("✅ Server running on", PORT));
