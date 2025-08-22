// ================= DEPENDENCIES =================
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

// ================= CONFIG =================
const TOKEN = process.env.TOKEN;
const PORT = process.env.PORT || 3000;
const BASE_HOST =
  process.env.PUBLIC_HOST ||
  process.env.RAILWAY_STATIC_URL ||
  ("localhost:" + PORT);
const DATABASE_URL = process.env.DATABASE_URL;

if (!TOKEN || !DATABASE_URL) {
  console.error("❌ TOKEN & DATABASE_URL harus di-set di environment variable");
  process.exit(1);
}

// ================= DATABASE =================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id BIGINT PRIMARY KEY,
      points INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
})();

async function getUser(user_id) {
  const r = await pool.query("SELECT * FROM users WHERE user_id=$1", [user_id]);
  return r.rows[0];
}
async function addUser(user_id) {
  await pool.query(
    "INSERT INTO users (user_id, points) VALUES ($1,0) ON CONFLICT DO NOTHING",
    [user_id]
  );
}
async function updatePoints(user_id, pts) {
  await pool.query(
    "UPDATE users SET points=points+$1 WHERE user_id=$2",
    [pts, user_id]
  );
}

// ================= BOT SETUP (POLLING) =================
const bot = new TelegramBot(TOKEN, { polling: true });

// ✅ Set tombol biru "Open" global
bot.setChatMenuButton({
  menu_button: {
    type: "web_app",
    text: "Buka",
    web_app: { url: "https://stargazer21bot-production.up.railway.app/game" }
  }
})
  .then(() => console.log("✅ Menu button diarahkan ke /game"))
  .catch(console.error);
  .then(() => console.log("✅ Global menu button berhasil di-set"))
  .catch(console.error);

// ================= BOT COMMANDS =================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  await addUser(chatId);
  bot.sendMessage(
    chatId,
    "👋 Selamat datang di Pirate Slot!\n\nKlik tombol biru **Open** di bawah untuk main 🎮\nGunakan /balance untuk cek saldo 💰"
  );
});

bot.onText(/\/balance/, async (msg) => {
  const chatId = msg.chat.id;
  await addUser(chatId);
  const user = await getUser(chatId);
  bot.sendMessage(chatId, `💰 Saldo kamu: ${user.points} PIR`);
});

bot.onText(/\/top/, async (msg) => {
  const chatId = msg.chat.id;
  const r = await pool.query(
    "SELECT user_id, points FROM users ORDER BY points DESC LIMIT 10"
  );
  const lines = r.rows.map(
    (u, i) => `${i + 1}. ${u.user_id} — ${u.points} PIR`
  );
  bot.sendMessage(
    chatId,
    `🏆 Top Players:\n` + (lines.join("\n") || "Belum ada pemain")
  );
});

// ================= MINI APP HTML =================
const gameHTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Pirate Slot</title>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <script src="//libtl.com/sdk.js" data-zone="9755147" data-sdk="show_9755147"></script>
  <style>
    body { font-family: sans-serif; background:#120026; color:#fff; text-align:center; }
    h2 { margin-top:20px; }
    .tab { margin:10px; padding:14px; border:1px solid #555; border-radius:8px; cursor:pointer; }
  </style>
</head>
<body>
  <h2>🏴‍☠️ Pirate Slot</h2>
  <div id="balance">Balance: 0 PIR</div>

  <div class="tab" onclick="spin()">🎰 Spin</div>
  <div class="tab" onclick="earn('Interstitial')">📺 Reward Interstitial</div>
  <div class="tab" onclick="earn('Pop')">📺 Reward Pop</div>
  <div class="tab" onclick="earn('Survey')">📋 Pass Survey</div>

  <script>
    const tg = window.Telegram.WebApp;
    tg.expand();
    let balance = 0;
    const user_id = tg.initDataUnsafe.user?.id;

    async function updateBalance(add=0) {
      balance += add;
      document.getElementById("balance").textContent = "Balance: " + balance + " PIR";
      if(user_id && add > 0){
        await fetch("/reward?user_id="+user_id+"&reward="+add);
      }
    }

    function spin() {
      if(typeof window.show_9755147 === "function") {
        window.show_9755147().then(()=>{
          const win = Math.floor(Math.random()*50);
          updateBalance(win);
          alert("🎉 Kamu menang "+win+" PIR!");
        });
      } else {
        alert("⚠️ Iklan belum siap!");
      }
    }

    function earn(type) {
      if(typeof window.show_9755147 === "function") {
        window.show_9755147().then(()=>{
          updateBalance(5);
          alert("✅ +5 PIR dari "+type);
        });
      } else {
        alert("⚠️ Iklan belum siap!");
      }
    }
  </script>
</body>
</html>
`;

// Endpoint untuk Mini App
app.get("/game", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8"/>
      <title>Pirate Slot</title>
      <meta name="viewport" content="width=device-width,initial-scale=1"/>
      <script src="https://telegram.org/js/telegram-web-app.js"></script>
      <style>
        body { font-family: sans-serif; background:#120026; color:#fff; text-align:center; }
        h2 { margin:20px 0; }
        #slot { display:flex; justify-content:center; margin:20px auto; font-size:50px; }
        .reel { width:80px; height:80px; border:2px solid #fff; margin:0 5px; display:flex; align-items:center; justify-content:center; background:#222; border-radius:10px; }
        #balance { margin:15px; font-size:20px; }
        button { margin:10px; padding:14px 20px; font-size:18px; border-radius:8px; border:none; cursor:pointer; }
        #msg { margin-top:15px; font-size:18px; }
      </style>
    </head>
    <body>
      <h2>🏴‍☠️ Pirate Slot</h2>
      <div id="balance">Balance: 0 PIR</div>
      <div id="slot">
        <div class="reel" id="r1">❓</div>
        <div class="reel" id="r2">❓</div>
        <div class="reel" id="r3">❓</div>
      </div>
      <button onclick="spin()">🎰 Spin</button>
      <button onclick="earnAd()">📺 Watch Ad (+5)</button>
      <div id="msg"></div>

      <script>
        const tg = window.Telegram.WebApp;
        tg.expand();

        const symbols = ["🍒","🍋","💎","⭐","7️⃣","⚓","🏴‍☠️"]; // scatter = 🏴‍☠️
        let balance = 0;
        const user_id = tg.initDataUnsafe.user?.id;

        async function updateBalance(add=0) {
          balance += add;
          document.getElementById("balance").textContent = "Balance: " + balance + " PIR";
          if(user_id && add>0){
            await fetch("/reward?user_id="+user_id+"&reward="+add);
          }
        }

        function randSymbol(){ return symbols[Math.floor(Math.random()*symbols.length)]; }

        async function spin(){
          if(balance < 1){ 
            document.getElementById("msg").textContent = "⚠️ Balance tidak cukup!";
            return;
          }
          balance--; // biaya spin
          document.getElementById("balance").textContent = "Balance: " + balance + " PIR";

          const reels = [document.getElementById("r1"),document.getElementById("r2"),document.getElementById("r3")];
          let results = [];

          // animasi gulungan
          let spins = 20;
          let timer = setInterval(()=>{
            reels.forEach(r=>r.textContent = randSymbol());
          },100);

          setTimeout(()=>{
            clearInterval(timer);
            results = [randSymbol(), randSymbol(), randSymbol()];
            reels.forEach((r,i)=>r.textContent = results[i]);
            checkWin(results);
          }, 2000);
        }

        function checkWin(res){
          let msg = "❌ Tidak ada kemenangan";
          let win = 0;

          if(res[0]===res[1] && res[1]===res[2]){
            if(res[0]==="🏴‍☠️"){ 
              win = 50; 
              msg = "🎉 3 Scatter! Jackpot +50 PIR 🎁";
            } else {
              win = 20;
              msg = "🎉 Triple "+res[0]+"! +20 PIR";
            }
          } else if(res.includes("🏴‍☠️") && res.filter(x=>x==="🏴‍☠️").length===2){
            win = 10;
            msg = "✨ 2 Scatter! +10 PIR";
          }

          if(win>0){ updateBalance(win); }
          document.getElementById("msg").textContent = msg;
        }

        function earnAd(){
          updateBalance(5);
          document.getElementById("msg").textContent = "✅ +5 PIR dari nonton iklan";
        }

        // init balance
        updateBalance(10); // kasih saldo awal
      </script>
    </body>
    </html>
  `);
});

// ================= REWARD API =================
app.get("/reward", async (req, res) => {
  const { user_id, reward } = req.query;
  if (!user_id) return res.send("user_id kosong");
  await addUser(user_id);
  const pts = parseInt(reward || "0", 10);
  if (pts > 0) await updatePoints(user_id, pts);
  res.send("✅ Reward diberikan");
});

// ================= KEEP ALIVE =================
app.get("/", (_req, res) => res.send("🚀 Bot + MiniApp jalan"));
setInterval(() => {
  axios.get(`https://${BASE_HOST}`).catch(() => {});
}, 300000);

// ================= START SERVER =================
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
