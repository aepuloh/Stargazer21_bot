const TelegramBot = require("node-telegram-bot-api");
const express = require("express");

const TOKEN = process.env.TOKEN;
const PORT = process.env.PORT || 3000;
const BASE_HOST =
  process.env.PUBLIC_HOST ||
  process.env.RAILWAY_STATIC_URL ||
  ("localhost:" + PORT);

if (!TOKEN) {
  console.error("❌ Harus set TOKEN di environment variable");
  process.exit(1);
}

// ================= BOT SETUP =================
const bot = new TelegramBot(TOKEN, { polling: true });

// 🚀 Set tombol menu "Open" global untuk semua user
bot.setChatMenuButton({
  chat_id: 0, // 0 = default global
  menu_button: {
    type: "web_app",
    text: "Open",
    web_app: { url: `https://${BASE_HOST}/game` }
  }
})
  .then(() => console.log("✅ Global menu button set"))
  .catch(console.error);

// ================= COMMANDS =================
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "👋 Welcome!\nKlik tombol biru 'Open' di bawah untuk membuka Mini App."
  );
});

// ================= MINI APP TEST PAGE =================
const app = express();

app.get("/game", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8"/>
        <title>Test MiniApp</title>
        <script src="https://telegram.org/js/telegram-web-app.js"></script>
      </head>
      <body style="background:#120026;color:#fff;text-align:center;">
        <h2>✅ Mini App jalan!</h2>
        <p>Halo <span id="user"></span></p>
        <script>
          const tg = window.Telegram.WebApp;
          document.getElementById("user").textContent =
            tg.initDataUnsafe?.user?.first_name || "Guest";
          tg.expand();
        </script>
      </body>
    </html>
  `);
});

app.get("/", (req, res) => res.send("🚀 Bot + MiniApp Test jalan"));
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
