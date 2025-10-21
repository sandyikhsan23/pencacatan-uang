import 'dotenv/config';
import { Telegraf, Markup, session } from "telegraf";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

console.log("BOT_TOKEN length:", (process.env.BOT_TOKEN || '').length);
console.log("ADMIN_ID:", process.env.ADMIN_ID);

const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session({ defaultSession: () => ({}) }));

const db = new Database("money.db");

// --- DB setup
db.exec(`
CREATE TABLE IF NOT EXISTS txn (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  kind TEXT CHECK(kind IN ('in','out')) NOT NULL,
  amount INTEGER NOT NULL,
  category TEXT,
  method TEXT,
  note TEXT,
  ts DATETIME DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS users (
  tg_id INTEGER PRIMARY KEY,
  name TEXT,
  greeted INTEGER DEFAULT 0
);
`);

try {
  db.prepare("ALTER TABLE users ADD COLUMN greeted INTEGER DEFAULT 0").run();
} catch (e) {
  if (!String(e).includes("duplicate column name")) throw e;
}

function menuKeyboard() {
  return Markup.keyboard([
    ["Export", "Reset"],         // baris pertama
    ["Lapor", "Saldo", "Top 3"]  // baris kedua
  ]).resize().persistent();       // resize = muat layar, persistent = biar tetap muncul
}

// --- Auto greeting saat user baru pertama kali kirim pesan ---
bot.on("message", (ctx, next) => {
  const tg_id = ctx.from.id;

  // cek apakah user sudah pernah disapa
  const user = db.prepare("SELECT greeted FROM users WHERE tg_id=?").get(tg_id);

  if (!user || !user.greeted) {
    // tandai sudah disapa
    db.prepare(`
      INSERT INTO users(tg_id, name, greeted) VALUES (?, NULL, 1)
      ON CONFLICT(tg_id) DO UPDATE SET greeted=1
    `).run(tg_id);

    // kirim pesan sambutan
    return ctx.reply(
      "👋 Hai! Saya bot pencatatan keuangan.\nKetik /start untuk memulai 💰"
    );
  }

  // kalau sudah pernah disapa, teruskan ke handler berikut
  return next();
});

bot.use((ctx, next) => {
  if (!ctx.session) ctx.session = {};      
  return next();
});

// --- Helpers
const rupiah = n => new Intl.NumberFormat("id-ID").format(n);
const thisMonthExpr = `strftime('%Y-%m', ts,'localtime') = strftime('%Y-%m','now','localtime')`;
const todayExpr     = `date(ts,'localtime') = date('now','localtime')`;

function getUserName(tg_id) {
  const row = db.prepare("SELECT name FROM users WHERE tg_id=?").get(tg_id);
  return row?.name || null;
}

function setUserName(tg_id, name) {
  const trimmed = name.trim();
  const first = trimmed.split(/\s+/)[0]; // ambil nama depan
  db.prepare(`
    INSERT INTO users(tg_id, name) VALUES(?, ?)
    ON CONFLICT(tg_id) DO UPDATE SET name=excluded.name
  `).run(tg_id, first);
  return first;
}

function greetText(name) {
  const who = name || "teman";
  return (
    `Halo, ${who}! Saya selaku bendahara kamu siap melakukan pencatatan keuanganmu.\n\n` +
    "Perintah:\n" +
    "• out (nominal) (nama pengeluaran)\n"+
    "--> contoh: out 15000 kopi\n"+
    "\n" +
    "• in (nominal) (sumber pemasukan)\n" +
    "--> contoh: in 500000 gaji\n" +
    "\n" +
    "• lapor (laporan keuangan hari ini)\n" +
    "• saldo\n" +
    "• top 3\n" +
    "• export (CSV bulan ini)\n" +
    "• reset  (hapus semua transaksi milikmu)"
  );
}

function parseCatat(text) {
  // catat 25000 kopi #cash "nasi uduk"
  const m = text.match(/^catat\s+(\d+)(?:\s+([^\#"]+?))?(?:\s+\#([^\s"]+))?(?:\s+"([^"]+)")?$/i);
  if (!m) return null;
  return {
    amount: parseInt(m[1],10),
    category: (m[2]?.trim() || "umum").toLowerCase(),
    method: m[3]?.toLowerCase() || null,
    note: m[4] || null
  };
}

// --- Commands
bot.start((ctx) => {
  const tg_id = ctx.from.id;
  const name = getUserName(tg_id);

  if (name) {
    // Sudah punya nama → greet langsung
    return ctx.reply(
      greetText(name),
      menuKeyboard()
    );  
  }

  // Belum punya nama → tanya dulu dan set flag session
  ctx.session.awaitingName = true;
  return ctx.reply(
    "Namamu panggilanmu apa?",
    Markup.removeKeyboard()
  );
});

bot.on("text", (ctx, next) => {
  if (ctx.session?.awaitingName) {
    const input = (ctx.message?.text || "").trim();
    if (!input) return ctx.reply("Namanya belum kebaca, coba ketik lagi ya 🙂");

    const saved = setUserName(ctx.from.id, input);
    ctx.session.awaitingName = false;

    // Tampilkan keyboard setelah nama disimpan
    return ctx.reply(greetText(saved), menuKeyboard());
  }
  return next();
});

// Reset semua data (admin only)
bot.hears(/^reset\s+all$/i, (ctx) => {
  const admin = parseInt(process.env.ADMIN_ID || "0", 10);
  if (ctx.from.id !== admin) return ctx.reply("❌ Khusus admin.");

  ctx.session.awaitingGlobalReset = true;
  return ctx.reply(
    "⚠️ Ini akan menghapus *semua data* dari seluruh pengguna.\nKetik `ya` untuk melanjutkan.",
    { parse_mode: "Markdown" }
  );
});

bot.hears(/^ya$/i, (ctx, next) => {
  // kalau lagi mode reset all
  if (ctx.session?.awaitingGlobalReset) {
    const info = db.prepare("DELETE FROM txn").run();
    ctx.session.awaitingGlobalReset = false;
    return ctx.reply(`🧹 Semua data dihapus (${info.changes} transaksi).`);
  }

  // kalau bukan mode reset all, teruskan ke handler lain
  return next();
});


// Minta konfirmasi reset
bot.hears(/^reset$/i, (ctx) => {
  ctx.session.awaitingReset = true;
  return ctx.reply(
    "⚠️ Ini akan menghapus SEMUA transaksi milikmu.\n" +
    "Ketik `'ya'` untuk konfirmasi, atau abaikan pesan ini jika tidak jadi.",
    { parse_mode: "Markdown" }
  );
});

// Konfirmasi reset (jawaban 'ya')
bot.hears(/^ya$/i, (ctx) => {
  // hanya valid kalau memang sedang menunggu konfirmasi reset
  if (!ctx.session?.awaitingReset) return; // kalau bukan mode reset, abaikan

  const tg_id = ctx.from.id;
  const info = db.prepare("DELETE FROM txn WHERE tg_id=?").run(tg_id);
  ctx.session.awaitingReset = false;

  return ctx.reply(`✅ Semua data milikmu telah dihapus (${info.changes} transaksi).`);
});


bot.hears(/^out\s+/i, ctx => {
  const m = ctx.message.text.match(/^out\s+(\d+)\s+(.+)$/i);
  if (!m) return ctx.reply("Format: out <nominal> <keterangan>");
  
  const amount = parseInt(m[1], 10);
  const category = m[2].trim().toLowerCase();

  db.prepare("INSERT INTO txn(tg_id,kind,amount,category) VALUES (?,?,?,?)")
    .run(ctx.from.id, "out", amount, category);

  ctx.reply(`✅ Pengeluaran Rp${rupiah(amount)} • ${category}`);
});


bot.hears(/^in\s+/i, ctx => {
  const m = ctx.message.text.match(/^in\s+(\d+)\s+(.+)$/i);
  if (!m) return ctx.reply("Format: in <nominal> <kategori/ket>");
  const amount = parseInt(m[1],10), cat = m[2].trim().toLowerCase();
  db.prepare("INSERT INTO txn(tg_id,kind,amount,category) VALUES (?,?,?,?)")
    .run(ctx.from.id, "in", amount, cat);
  ctx.reply(`✅ Pemasukan Rp${rupiah(amount)} • ${cat}`);
});

bot.hears(/^lapor$/i, ctx => {
  const rows = db.prepare(
    `SELECT kind, SUM(amount) total FROM txn
     WHERE tg_id=? AND ${todayExpr}
     GROUP BY kind`
  ).all(ctx.from.id);
  const tin  = rows.find(r=>r.kind==='in')?.total || 0;
  const tout = rows.find(r=>r.kind==='out')?.total || 0;
  ctx.reply(`📊 Hari ini:\nMasuk: Rp${rupiah(tin)}\nKeluar: Rp${rupiah(tout)}`);
});

bot.hears(/^saldo$/i, ctx => {
  const rows = db.prepare(
    `SELECT kind, SUM(amount) total FROM txn
     WHERE tg_id=? AND ${thisMonthExpr}
     GROUP BY kind`
  ).all(ctx.from.id);
  const tin  = rows.find(r=>r.kind==='in')?.total || 0;
  const tout = rows.find(r=>r.kind==='out')?.total || 0;
  const s = tin - tout;
  ctx.reply(`💼 Saldo bulan ini: Rp${rupiah(s)} (Masuk ${rupiah(tin)} - Keluar ${rupiah(tout)})`);
});

bot.hears(/^top 3$/i, ctx => {
  const rows = db.prepare(
    `SELECT category, SUM(amount) total FROM txn
     WHERE tg_id=? AND kind='out' AND ${thisMonthExpr}
     GROUP BY category ORDER BY total DESC LIMIT 3`
  ).all(ctx.from.id);
  if (!rows.length) return ctx.reply("Belum ada data.");
  ctx.reply("🏆 Top 3 pengeluaran bulan ini:\n" +
    rows.map((r,i)=>`${i+1}. ${r.category}: Rp${rupiah(r.total)}`).join("\n"));
});

// Export CSV bulan berjalan
bot.hears(/^export$/i, ctx => {
  const rows = db.prepare(
    `SELECT date(ts,'localtime') d, kind, amount, category, method, note
     FROM txn WHERE tg_id=? AND ${thisMonthExpr} ORDER BY ts`
  ).all(ctx.from.id);
  if (!rows.length) return ctx.reply("Belum ada data bulan ini.");
  const header = "date,kind,amount,category,method,note";
  const body = rows.map(r =>
    [r.d, r.kind, r.amount, (r.category||""), (r.method||""), (r.note||"")]
      .map(v => `"${String(v).replace(/"/g,'""')}"`).join(",")
  ).join("\n");
  const csv = header + "\n" + body;
  const fname = `export-${ctx.from.id}-${new Date().toISOString().slice(0,7)}.csv`;
  const fpath = path.join(process.cwd(), fname);
  fs.writeFileSync(fpath, csv);
  ctx.replyWithDocument({ source: fpath, filename: fname }).finally(()=>{
    try { fs.unlinkSync(fpath); } catch {}
  });
});

bot.hears(/^help$|^\/help$/i, ctx => ctx.reply(
  "Perintah:\n" +
  "• catat 32000 makan #bca \"ayam geprek\"\n" +
  "• in 150000 gaji\n" +
  "• lapor\n" +
  "• saldo\n" +
  "• top 3\n" +
    "• export (CSV bulan ini)\n" +
    "• reset  (hapus semua transaksi milikmu)"
));

// --- Pastikan tidak ada webhook aktif dulu, baru mulai polling
(async () => {
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.launch({ dropPendingUpdates: true });
    console.log("✅ Bot Telegram berjalan (long-polling)…");
  } catch (err) {
    console.error("🚫 Gagal menjalankan bot:", err);
    process.exit(1);
  }
})();

// graceful stop saat Railway / server mati
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
