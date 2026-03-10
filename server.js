/**
 * DiárioVivo — Backend com PostgreSQL
 * Sessão WPP e histórico persistentes — não some mais com redeploy
 */

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { Client, RemoteAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const { Pool } = require("pg");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

// ─── PostgreSQL ───────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS entries (
      id BIGINT PRIMARY KEY,
      category TEXT,
      confidence TEXT,
      raw TEXT,
      data JSONB,
      timestamp TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS wpp_session (
      id TEXT PRIMARY KEY,
      session_data TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log("✅ Banco de dados pronto!");
}

async function loadEntries() {
  const res = await pool.query("SELECT * FROM entries ORDER BY timestamp ASC");
  return res.rows.map(r => ({ id: r.id, category: r.category, confidence: r.confidence, raw: r.raw, data: r.data, timestamp: r.timestamp }));
}

async function saveEntry(entry) {
  await pool.query(
    `INSERT INTO entries (id, category, confidence, raw, data, timestamp)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (id) DO UPDATE SET data=$5`,
    [entry.id, entry.category, entry.confidence, entry.raw, entry.data, entry.timestamp]
  );
}

async function updateEntryRoute(id, route) {
  const res = await pool.query("SELECT data FROM entries WHERE id=$1", [id]);
  if (!res.rows[0]) return null;
  const data = { ...res.rows[0].data, route };
  await pool.query("UPDATE entries SET data=$1 WHERE id=$2", [data, id]);
  return data;
}

// ─── Store de sessão WPP no PostgreSQL ───────────────────────────────────────
// Implementa a interface que o whatsapp-web.js RemoteAuth espera
class PGStore {
  async sessionExists({ session }) {
    const res = await pool.query("SELECT id FROM wpp_session WHERE id=$1", [session]);
    return res.rows.length > 0;
  }
  async save({ session }) {
    // A sessão é salva via extract() — aqui só registramos existência
  }
  async extract({ session, path: destPath }) {
    const res = await pool.query("SELECT session_data FROM wpp_session WHERE id=$1", [session]);
    if (!res.rows[0]) return;
    const fs = require("fs");
    const zlib = require("zlib");
    const buf = Buffer.from(res.rows[0].session_data, "base64");
    const zip = zlib.gunzipSync(buf);
    fs.mkdirSync(destPath, { recursive: true });
    // session_data é o tar em base64
    require("child_process").execSync(`echo "${res.rows[0].session_data}" | base64 -d | tar xz -C "${destPath}"`);
  }
  async save({ session, path: srcPath }) {
    const { execSync } = require("child_process");
    const b64 = execSync(`tar czf - -C "${srcPath}" . | base64`).toString().replace(/\n/g, "");
    await pool.query(
      `INSERT INTO wpp_session (id, session_data, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (id) DO UPDATE SET session_data=$2, updated_at=NOW()`,
      [session, b64]
    );
  }
  async delete({ session }) {
    await pool.query("DELETE FROM wpp_session WHERE id=$1", [session]);
  }
}

// ─── Parser de linguagem natural ─────────────────────────────────────────────
function parseMessage(text) {
  const lower = text.toLowerCase().trim();
  const result = {
    category: "note",
    confidence: "low",
    data: {},
    raw: text,
    timestamp: new Date().toISOString(),
  };

  const exerciseWords = ["corri", "corrida", "caminhei", "caminhada", "treino", "treinei",
    "academia", "musculação", "yoga", "pilates", "bike", "ciclismo", "natação", "pedalei",
    "exercício", "exercitei", "cardio", "hiit", "crossfit"];
  const distMatch  = lower.match(/(\d+[\.,]?\d*)\s*km/);
  const minMatch   = lower.match(/(\d+)\s*(min|minutos?)/);
  const hourMatch  = lower.match(/(\d+[\.,]?\d*)\s*(h|hora)/);
  const stepsMatch = lower.match(/(\d+)\s*pass/);

  if (exerciseWords.some(w => lower.includes(w)) || distMatch || stepsMatch) {
    result.category = "exercise";
    result.confidence = "high";
    const type = lower.includes("corri") || lower.includes("corrida") ? "running"
      : lower.includes("caminhei") || lower.includes("caminhada") ? "walking"
      : lower.includes("bike") || lower.includes("cicl") || lower.includes("pedal") ? "cycling"
      : lower.includes("nata") ? "swimming" : "gym";
    result.data = {
      type,
      distance_km: distMatch ? parseFloat(distMatch[1].replace(",", ".")) : null,
      duration_min: minMatch ? parseInt(minMatch[1]) : (hourMatch ? parseFloat(hourMatch[1]) * 60 : null),
      steps: stepsMatch ? parseInt(stepsMatch[1]) : null,
      needs_map: ["running", "walking", "cycling"].includes(type),
    };
    if (result.data.distance_km) result.data.calories_est = Math.round(result.data.distance_km * 60);
    else if (result.data.duration_min) {
      const mets = { running: 10, walking: 4, cycling: 7, gym: 6, swimming: 8 };
      result.data.calories_est = Math.round((result.data.duration_min / 60) * (mets[type] || 5) * 70);
    }
  }

  const financeWords = ["gastei", "paguei", "comprei", "recebi", "ganhei", "salário",
    "investimento", "poupança", "dividendo", "cobrança", "transferi", "depositei"];
  const moneyMatch = text.match(/r?\$\s?(\d+[\.,]?\d*)/i) || text.match(/(\d+[\.,]?\d*)\s*reais/i);
  if (financeWords.some(w => lower.includes(w)) || moneyMatch) {
    result.category = "finance";
    result.confidence = moneyMatch ? "high" : "medium";
    const isIncome = /recebi|ganhei|salário|dividendo|depositei/.test(lower);
    const amount = moneyMatch ? parseFloat(moneyMatch[1].replace(",", ".")) : 0;
    const expenseCategory = lower.includes("mercad") || lower.includes("super") ? "alimentação"
      : lower.includes("uber") || lower.includes("combustível") || lower.includes("gasolina") ? "transporte"
      : lower.includes("conta") || lower.includes("boleto") ? "contas"
      : lower.includes("farmácia") || lower.includes("médico") ? "saúde"
      : lower.includes("academia") || lower.includes("lazer") ? "lazer" : "outros";
    result.data = { type: isIncome ? "income" : "expense", amount, expense_category: isIncome ? null : expenseCategory, label: isIncome ? "Receita" : "Gasto" };
  }

  const sleepWords = ["dormi", "acordei", "sono", "dormindo", "insônia", "pesadelo", "descansado", "cansado", "sonolento"];
  const sleepHours = lower.match(/dormi\s+(\d+[\.,]?\d*)/)?.[1] || lower.match(/(\d+[\.,]?\d*)\s*(h|hora).*dorm/)?.[1];
  if (sleepWords.some(w => lower.includes(w))) {
    result.category = "sleep";
    result.confidence = sleepHours ? "high" : "medium";
    const quality = /bem|ótimo|excelente|descansad/.test(lower) ? "great" : /mal|ruim|pouco|cansad|insônia/.test(lower) ? "poor" : "ok";
    result.data = { hours: sleepHours ? parseFloat(sleepHours.replace(",", ".")) : 7, quality, quality_score: quality === "great" ? 5 : quality === "ok" ? 3 : 1 };
  }

  const moodWords = ["feliz", "triste", "ansioso", "ansiosa", "animado", "animada", "estressado", "estressada",
    "relaxado", "relaxada", "motivado", "motivada", "desmotivado", "irritado", "grato", "gratidão", "deprimido"];
  if (moodWords.some(w => lower.includes(w))) {
    result.category = "mood";
    result.confidence = "high";
    const score = /feliz|animad|motivad|grat|eufóric/.test(lower) ? 4 : /relaxad|bem|tranquil/.test(lower) ? 2
      : /ansios|estressad/.test(lower) ? -2 : /triste|desmotivad|deprimid|irritad/.test(lower) ? -4 : 0;
    const label = lower.includes("feliz") ? "Feliz" : lower.includes("ansios") ? "Ansioso/a"
      : lower.includes("motivad") ? "Motivado/a" : lower.includes("estressad") ? "Estressado/a"
      : lower.includes("triste") ? "Triste" : lower.includes("grat") ? "Grato/a"
      : lower.includes("relaxad") ? "Relaxado/a" : "Neutro";
    result.data = { label, score, emotion: score > 0 ? "positive" : score < 0 ? "negative" : "neutral" };
  }

  const foodWords = ["comi", "almocei", "jantei", "café da manhã", "tomei café", "lanch", "dieta", "jejum", "água", "hidratei"];
  if (foodWords.some(w => lower.includes(w))) {
    result.category = "food";
    result.confidence = "high";
    const healthiness = /salada|fruta|verdura|proteína|saudável/.test(lower) ? "healthy"
      : /pizza|hamburguer|sorvete|doce|fritura/.test(lower) ? "indulgent" : "neutral";
    const waterMatch = lower.match(/(\d+[\.,]?\d*)\s*(litros?|l)\s*(de\s+)?água/);
    result.data = {
      healthiness, health_score: healthiness === "healthy" ? 5 : healthiness === "indulgent" ? 1 : 3,
      water_liters: waterMatch ? parseFloat(waterMatch[1].replace(",", ".")) : null,
      meal: lower.includes("café") ? "café da manhã" : lower.includes("almoc") ? "almoço"
        : lower.includes("jant") ? "jantar" : lower.includes("lanch") ? "lanche" : "refeição",
    };
  }
  return result;
}

function generateBotResponse(parsed) {
  const { category, data } = parsed;
  if (category === "exercise") {
    const details = [data.distance_km ? `${data.distance_km}km` : null, data.duration_min ? `${data.duration_min} min` : null, data.calories_est ? `~${data.calories_est} kcal` : null].filter(Boolean).join(" · ");
    return `✅ *Atividade registrada!*\n🏃 ${data.type === "running" ? "Corrida" : data.type === "walking" ? "Caminhada" : data.type === "cycling" ? "Bike" : "Treino"}${details ? `\n📊 ${details}` : ""}`;
  }
  if (category === "finance") {
    const sign = data.type === "income" ? "+" : "-";
    return `✅ *Financeiro registrado!*\n${data.type === "income" ? "💰" : "💸"} ${data.label}: ${sign}R$${data.amount.toFixed(2)}${data.expense_category ? `\n🏷️ ${data.expense_category}` : ""}`;
  }
  if (category === "sleep") return `✅ *Sono registrado!*\n😴 ${data.hours}h · Qualidade: ${data.quality === "great" ? "Ótima ✨" : data.quality === "poor" ? "Ruim 😓" : "Ok"}`;
  if (category === "mood") return `✅ *Humor registrado!*\n${data.emotion === "positive" ? "😊" : data.emotion === "negative" ? "😔" : "😐"} ${data.label} · Score: ${data.score > 0 ? "+" : ""}${data.score}/5`;
  if (category === "food") return `✅ *Refeição registrada!*\n🥗 ${data.meal}${data.water_liters ? `\n💧 ${data.water_liters}L de água` : ""}\n🌿 ${data.healthiness === "healthy" ? "Saudável 👍" : data.healthiness === "indulgent" ? "Indulgente 😅" : "Normal"}`;
  return `📝 *Anotado!*\n"${parsed.raw.substring(0, 60)}"`;
}

// ─── WhatsApp Client com RemoteAuth ──────────────────────────────────────────
const pgStore = new PGStore();
let wppStatus = "disconnected";
let qrCodeData = null;

const wppClient = new Client({
  authStrategy: new RemoteAuth({
    store: pgStore,
    backupSyncIntervalMs: 300000, // salva sessão a cada 5 min
  }),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  }
});

wppClient.on("qr", (qr) => {
  qrCodeData = qr;
  wppStatus = "qr_ready";
  qrcode.generate(qr, { small: true });
  console.log("\n📱 ESCANEIE O QR CODE!\n");
  io.emit("wpp_status", { status: "qr_ready", qr });
});

wppClient.on("authenticated", () => {
  wppStatus = "authenticated";
  qrCodeData = null;
  console.log("✅ WhatsApp autenticado!");
  io.emit("wpp_status", { status: "authenticated" });
});

wppClient.on("ready", () => {
  wppStatus = "ready";
  console.log("🟢 WhatsApp pronto!");
  io.emit("wpp_status", { status: "ready" });
});

wppClient.on("remote_session_saved", () => {
  console.log("💾 Sessão salva no PostgreSQL!");
});

wppClient.on("message_create", async (msg) => {
  if (msg.from === "status@broadcast") return;
  if (msg.body.startsWith("✅") || msg.body.startsWith("📝")) return;
  const chat = await msg.getChat();
  if (!chat.isGroup || chat.name !== "Diário Vivo") return;

  const text = msg.body;
  console.log(`📨 Diário Vivo: "${text}"`);

  const parsed = parseMessage(text);
  const entry = { id: Date.now(), ...parsed };
  await saveEntry(entry);
  io.emit("new_entry", entry);

  const botReply = generateBotResponse(parsed);
  await chat.sendMessage(botReply);
  console.log(`💾 [${parsed.category}] registrado`);
});

wppClient.on("disconnected", () => {
  wppStatus = "disconnected";
  io.emit("wpp_status", { status: "disconnected" });
});

// ─── API REST ─────────────────────────────────────────────────────────────────
app.get("/api/entries", async (req, res) => {
  const entries = await loadEntries();
  res.json(entries);
});

app.post("/api/entries", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "text is required" });
  const parsed = parseMessage(text);
  const entry = { id: Date.now(), ...parsed };
  await saveEntry(entry);
  io.emit("new_entry", entry);
  res.json(entry);
});

app.delete("/api/entries", async (req, res) => {
  await pool.query("DELETE FROM entries");
  io.emit("entries_cleared");
  res.json({ ok: true });
});

app.patch("/api/entries/:id/route", async (req, res) => {
  const { id } = req.params;
  const { route } = req.body;
  const data = await updateEntryRoute(id, route);
  if (!data) return res.status(404).json({ error: "Entry not found" });
  io.emit("entry_updated", { id, data });
  res.json({ id, data });
});

app.get("/api/wpp/status", (req, res) => {
  res.json({ status: wppStatus, qr: qrCodeData });
});

app.get("/api/stats", async (req, res) => {
  const entries = await loadEntries();
  const finance  = entries.filter(e => e.category === "finance");
  const exercise = entries.filter(e => e.category === "exercise");
  const sleep    = entries.filter(e => e.category === "sleep");
  const mood     = entries.filter(e => e.category === "mood");
  res.json({
    totals: {
      entries: entries.length,
      income:   finance.filter(e => e.data.type === "income").reduce((s, e) => s + e.data.amount, 0),
      expense:  finance.filter(e => e.data.type === "expense").reduce((s, e) => s + e.data.amount, 0),
      exercise_minutes: exercise.reduce((s, e) => s + (e.data.duration_min || 0), 0),
      exercise_km:      exercise.reduce((s, e) => s + (e.data.distance_km || 0), 0),
      avg_sleep: sleep.length ? sleep.reduce((s, e) => s + e.data.hours, 0) / sleep.length : 0,
      mood_score: mood.length ? mood.reduce((s, e) => s + e.data.score, 0) / mood.length : 0,
    },
    recent: entries.slice(-20).reverse(),
  });
});

// ─── Relatório Semanal com IA ─────────────────────────────────────────────────
async function getWeekEntries() {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const res = await pool.query("SELECT * FROM entries WHERE timestamp >= $1", [weekAgo]);
  return res.rows;
}

function buildWeekSummary(entries) {
  const finance  = entries.filter(e => e.category === "finance");
  const exercise = entries.filter(e => e.category === "exercise");
  const sleep    = entries.filter(e => e.category === "sleep");
  const mood     = entries.filter(e => e.category === "mood");
  const food     = entries.filter(e => e.category === "food");
  const income   = finance.filter(e => e.data.type === "income").reduce((s, e) => s + (e.data.amount || 0), 0);
  const expense  = finance.filter(e => e.data.type === "expense").reduce((s, e) => s + (e.data.amount || 0), 0);
  return {
    period: { from: new Date(Date.now() - 7*24*60*60*1000).toLocaleDateString("pt-BR"), to: new Date().toLocaleDateString("pt-BR") },
    finance: { income, expense, balance: income - expense, transactions: finance.length },
    exercise: { sessions: exercise.length, km: exercise.reduce((s, e) => s + (e.data.distance_km || 0), 0).toFixed(1), minutes: exercise.reduce((s, e) => s + (e.data.duration_min || 0), 0) },
    sleep: { nights: sleep.length, avg_hours: sleep.length ? (sleep.reduce((s, e) => s + (e.data.hours || 0), 0) / sleep.length).toFixed(1) : null },
    mood: { records: mood.length, avg_score: mood.length ? (mood.reduce((s, e) => s + (e.data.score || 0), 0) / mood.length).toFixed(1) : null },
    food: { meals: food.length, healthy: food.filter(e => e.data.healthiness === "healthy").length },
    total_entries: entries.length,
  };
}

async function generateAIInsights(summary) {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 600,
        messages: [{ role: "user", content: `Você é um coach de hábitos pessoal. Analise os dados da semana e gere 3 insights práticos em português brasileiro. Use os números reais e dê sugestões acionáveis.\n\nDados:\n${JSON.stringify(summary, null, 2)}\n\nResponda APENAS com os 3 insights, um por linha, começando com emoji. Sem introdução.` }]
      })
    });
    const data = await response.json();
    return data.content?.[0]?.text || null;
  } catch (err) {
    console.error("Erro IA:", err.message);
    return null;
  }
}

async function sendWeeklyReport() {
  if (wppStatus !== "ready") return;
  const entries = await getWeekEntries();
  if (entries.length === 0) return;
  const summary = buildWeekSummary(entries);
  const aiInsights = process.env.ANTHROPIC_API_KEY ? await generateAIInsights(summary) : null;
  const balanceEmoji = summary.finance.balance >= 0 ? "💚" : "🔴";

  let report = `━━━━━━━━━━━━━━━━━━━━\n📋 *RELATÓRIO SEMANAL*\n${summary.period.from} → ${summary.period.to}\n━━━━━━━━━━━━━━━━━━━━\n\n💰 *FINANÇAS*\n• Receitas: +R$${summary.finance.income.toFixed(2)}\n• Gastos: -R$${summary.finance.expense.toFixed(2)}\n• ${balanceEmoji} Saldo: R$${summary.finance.balance.toFixed(2)}\n\n🏃 *ATIVIDADE*\n• ${summary.exercise.sessions} sessões · ${summary.exercise.km}km · ${summary.exercise.minutes}min\n\n😴 *SONO*\n• Média: ${summary.sleep.avg_hours || "—"}h · ${summary.sleep.nights} noites\n\n😊 *HUMOR*\n• Score médio: ${summary.mood.avg_score || "—"}/5\n\n🥗 *ALIMENTAÇÃO*\n• ${summary.food.meals} refeições · ${summary.food.healthy} saudáveis`;
  if (aiInsights) report += `\n\n💡 *INSIGHTS DA SEMANA*\n${aiInsights}`;
  report += `\n\n━━━━━━━━━━━━━━━━━━━━\n_${summary.total_entries} registros esta semana · Continue assim! 🚀_`;

  try {
    const chats = await wppClient.getChats();
    const diaryGroup = chats.find(c => c.isGroup && c.name === "Diário Vivo");
    if (diaryGroup) {
      await diaryGroup.sendMessage(report);
      console.log("✅ Relatório semanal enviado!");
    }
  } catch (err) {
    console.error("Erro relatório:", err.message);
  }
}

function scheduleWeeklyReport() {
  const now = new Date();
  const daysUntilSunday = (7 - now.getUTCDay()) % 7 || 7;
  const nextSunday = new Date(now);
  nextSunday.setUTCDate(now.getUTCDate() + daysUntilSunday);
  nextSunday.setUTCHours(23, 0, 0, 0);
  const msUntil = nextSunday.getTime() - now.getTime();
  console.log(`📅 Próximo relatório: domingo 20h (em ${Math.round(msUntil/3600000)}h)`);
  setTimeout(async () => {
    await sendWeeklyReport();
    setInterval(sendWeeklyReport, 7 * 24 * 60 * 60 * 1000);
  }, msUntil);
}

app.post("/api/report/send", async (req, res) => {
  await sendWeeklyReport();
  res.json({ ok: true });
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("🌐 Frontend conectado");
  socket.emit("wpp_status", { status: wppStatus, qr: qrCodeData });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

async function start() {
  await initDB();
  server.listen(PORT, () => {
    console.log(`\n🚀 DiárioVivo rodando na porta ${PORT}`);
    console.log(`📡 API: http://localhost:${PORT}/api`);
    wppClient.initialize();
    scheduleWeeklyReport();
  });
}

start().catch(console.error);
