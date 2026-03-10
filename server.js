/**
 * DiárioVivo — Backend
 */

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

const DB_PATH = path.join(__dirname, "data.json");

function loadDB() {
  if (!fs.existsSync(DB_PATH)) return { entries: [], lastUpdated: null };
  try {
    const data = fs.readFileSync(DB_PATH, "utf-8");
    return JSON.parse(data);
  } catch (e) {
    return { entries: [], lastUpdated: null };
  }
}

function saveDB(data) {
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

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
      : lower.includes("nata") ? "swimming"
      : "gym";

    result.data = {
      type,
      distance_km: distMatch ? parseFloat(distMatch[1].replace(",", ".")) : null,
      duration_min: minMatch ? parseInt(minMatch[1]) : (hourMatch ? parseFloat(hourMatch[1]) * 60 : null),
      steps: stepsMatch ? parseInt(stepsMatch[1]) : null,
      needs_map: ["running", "walking", "cycling"].includes(type),
    };

    if (result.data.distance_km) {
      result.data.calories_est = Math.round(result.data.distance_km * 60);
    } else if (result.data.duration_min) {
      const mets = { running: 10, walking: 4, cycling: 7, gym: 6, swimming: 8 };
      result.data.calories_est = Math.round((result.data.duration_min / 60) * (mets[type] || 5) * 70);
    }
  }

  const financeWords = ["gastei", "paguei", "comprei", "recebi", "ganhei", "salário",
    "investimento", "poupança", "dividendo", "cobrança", "transferi", "depositei"];
  const moneyMatch = text.match(/r?\$\s?(\d+[\.,]?\d*)/i) ||
                     text.match(/(\d+[\.,]?\d*)\s*reais/i);

  if (financeWords.some(w => lower.includes(w)) || moneyMatch) {
    result.category = "finance";
    result.confidence = moneyMatch ? "high" : "medium";

    const isIncome = /recebi|ganhei|salário|dividendo|depositei/.test(lower);
    const amount = moneyMatch ? parseFloat(moneyMatch[1].replace(",", ".")) : 0;

    const expenseCategory = lower.includes("mercad") || lower.includes("super") ? "alimentação"
      : lower.includes("uber") || lower.includes("combustível") || lower.includes("gasolina") ? "transporte"
      : lower.includes("factura") || lower.includes("conta") || lower.includes("boleto") ? "contas"
      : lower.includes("farmácia") || lower.includes("médico") || lower.includes("saúde") ? "saúde"
      : lower.includes("academia") || lower.includes("lazer") || lower.includes("cinema") ? "lazer"
      : "outros";

    result.data = {
      type: isIncome ? "income" : "expense",
      amount,
      expense_category: isIncome ? null : expenseCategory,
      label: isIncome ? "Receita" : "Gasto",
    };
  }

  const sleepWords = ["dormi", "acordei", "sono", "dormindo", "insônia", "pesadelo",
    "descansado", "cansado", "cansada", "sonolento"];
  const sleepHours = lower.match(/dormi\s+(\d+[\.,]?\d*)/)?.[1] ||
                     lower.match(/(\d+[\.,]?\d*)\s*h.*sono/)?.[1] ||
                     lower.match(/(\d+[\.,]?\d*)\s*(h|hora).*dorm/)?.[1];

  if (sleepWords.some(w => lower.includes(w))) {
    result.category = "sleep";
    result.confidence = sleepHours ? "high" : "medium";

    const quality = /bem|ótimo|excelente|descansad/.test(lower) ? "great"
      : /mal|ruim|pouco|cansad|insônia|pesadelo/.test(lower) ? "poor"
      : "ok";

    result.data = {
      hours: sleepHours ? parseFloat(sleepHours.replace(",", ".")) : 7,
      quality,
      quality_score: quality === "great" ? 5 : quality === "ok" ? 3 : 1,
    };
  }

  const moodWords = ["feliz", "triste", "ansioso", "ansiosa", "animado", "animada",
    "estressado", "estressada", "relaxado", "relaxada", "motivado", "motivada",
    "desmotivado", "irritado", "grato", "gratidão", "deprimido", "eufórico",
    "senti", "me sinto", "emoção", "humor"];

  if (moodWords.some(w => lower.includes(w))) {
    result.category = "mood";
    result.confidence = "high";

    const score = /feliz|animad|motivad|grat|eufóric|excelente/.test(lower) ? 4
      : /relaxad|bem|tranquil/.test(lower) ? 2
      : /ansios|estressad/.test(lower) ? -2
      : /triste|desmotivad|deprimid|irritad/.test(lower) ? -4
      : 0;

    const label = lower.includes("feliz") ? "Feliz"
      : lower.includes("ansios") ? "Ansioso/a"
      : lower.includes("motivad") ? "Motivado/a"
      : lower.includes("estressad") ? "Estressado/a"
      : lower.includes("triste") ? "Triste"
      : lower.includes("grat") ? "Grato/a"
      : lower.includes("relaxad") ? "Relaxado/a"
      : "Neutro";

    result.data = { label, score, emotion: score > 0 ? "positive" : score < 0 ? "negative" : "neutral" };
  }

  const foodWords = ["comi", "almocei", "jantei", "café da manhã", "tomei café",
    "lanch", "dieta", "jejum", "água", "hidratei", "proteína"];

  if (foodWords.some(w => lower.includes(w))) {
    result.category = "food";
    result.confidence = "high";

    const healthiness = /salada|fruta|verdura|legume|proteína|dieta|saudável|light/.test(lower) ? "healthy"
      : /pizza|hamburguer|sorvete|doce|fritura|fast food|chocolate/.test(lower) ? "indulgent"
      : "neutral";

    const waterMatch = lower.match(/(\d+[\.,]?\d*)\s*(litros?|l)\s*(de\s+)?água/);

    result.data = {
      healthiness,
      health_score: healthiness === "healthy" ? 5 : healthiness === "indulgent" ? 1 : 3,
      water_liters: waterMatch ? parseFloat(waterMatch[1].replace(",", ".")) : null,
      meal: lower.includes("café") ? "café da manhã"
        : lower.includes("almoc") ? "almoço"
        : lower.includes("jant") ? "jantar"
        : lower.includes("lanch") ? "lanche"
        : "refeição",
    };
  }

  return result;
}

function generateBotResponse(parsed) {
  const { category, data } = parsed;

  if (category === "exercise") {
    const details = [
      data.distance_km ? `${data.distance_km}km` : null,
      data.duration_min ? `${data.duration_min} minutos` : null,
      data.calories_est ? `~${data.calories_est} kcal` : null,
    ].filter(Boolean).join(" · ");

    const mapMsg = data.needs_map ? "\n\n🗺️ Abra o app para registrar ou ver o trajeto no mapa!" : "";
    return `✅ *Atividade registrada!*\n🏃 ${data.type === "running" ? "Corrida" : data.type === "walking" ? "Caminhada" : data.type === "cycling" ? "Bike" : "Treino"}${details ? `\n📊 ${details}` : ""}${mapMsg}`;
  }

  if (category === "finance") {
    const sign = data.type === "income" ? "+" : "-";
    const emoji = data.type === "income" ? "💰" : "💸";
    return `✅ *Financeiro registrado!*\n${emoji} ${data.label}: ${sign}R$${data.amount.toFixed(2)}${data.expense_category ? `\n🏷️ Categoria: ${data.expense_category}` : ""}`;
  }

  if (category === "sleep") {
    const emoji = data.quality === "great" ? "😴✨" : data.quality === "poor" ? "😓" : "😴";
    return `✅ *Sono registrado!*\n${emoji} ${data.hours}h de sono\n⭐ Qualidade: ${data.quality === "great" ? "Ótima" : data.quality === "poor" ? "Ruim" : "Ok"}`;
  }

  if (category === "mood") {
    const emoji = data.emotion === "positive" ? "😊" : data.emotion === "negative" ? "😔" : "😐";
    return `✅ *Humor registrado!*\n${emoji} Você está se sentindo: *${data.label}*\n📈 Score emocional: ${data.score > 0 ? "+" : ""}${data.score}/5`;
  }

  if (category === "food") {
    return `✅ *Refeição registrada!*\n🥗 ${data.meal}${data.water_liters ? `\n💧 ${data.water_liters}L de água` : ""}\n🌿 Qualidade: ${data.healthiness === "healthy" ? "Saudável 👍" : data.healthiness === "indulgent" ? "Indulgente 😅" : "Normal"}`;
  }

  return `📝 *Anotado no diário!*\n"${parsed.raw.substring(0, 60)}..."`;
}

const wppClient = new Client({
  authStrategy: new LocalAuth({ dataPath: "./wpp-session" }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ],
  }
});

let wppStatus = "disconnected";
let qrCodeData = null;

wppClient.on("qr", (qr) => {
  qrCodeData = qr;
  wppStatus = "qr_ready";
  qrcode.generate(qr, { small: true });
  console.log("\n📱 ESCANEIE O QR CODE ACIMA COM SEU WHATSAPP!\n");
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
  console.log("🟢 WhatsApp pronto e conectado!");
  io.emit("wpp_status", { status: "ready" });
});

// ✅ FILTRO CORRIGIDO: só escuta o grupo "Diário Vivo"
wppClient.on("message", async (msg) => {
  if (msg.from === 'status@broadcast') return;

  // Busca dados do chat para verificar se é o grupo certo
  const chat = await msg.getChat();
  if (!chat.isGroup || chat.name !== 'Diário Vivo') return;

  const text = msg.body;
  console.log(`📨 Mensagem do Diário Vivo: "${text}"`);

  const parsed = parseMessage(text);
  const entry = { id: Date.now(), ...parsed };

  const db = loadDB();
  db.entries.push(entry);
  saveDB(db);

  io.emit("new_entry", entry);

  const botReply = generateBotResponse(parsed);
  await msg.reply(botReply);

  console.log(`💾 Registrado: [${parsed.category}] com confiança ${parsed.confidence}`);
});

wppClient.on("disconnected", () => {
  wppStatus = "disconnected";
  io.emit("wpp_status", { status: "disconnected" });
});

app.delete("/api/entries", (req, res) => {
  saveDB({ entries: [] });
  io.emit("entries_cleared");
  res.json({ ok: true });
});

app.get("/api/entries", (req, res) => {
  const db = loadDB();
  res.json(db.entries);
});

app.post("/api/entries", (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "text is required" });

  const parsed = parseMessage(text);
  const entry = { id: Date.now(), ...parsed };

  const db = loadDB();
  db.entries.push(entry);
  saveDB(db);

  io.emit("new_entry", entry);

  res.json(entry);
});

app.patch("/api/entries/:id/route", (req, res) => {
  const { id } = req.params;
  const { route } = req.body;

  const db = loadDB();
  const entry = db.entries.find(e => e.id === parseInt(id));
  if (!entry) return res.status(404).json({ error: "Entry not found" });

  entry.data.route = route;
  saveDB(db);
  io.emit("entry_updated", entry);

  res.json(entry);
});

app.get("/api/wpp/status", (req, res) => {
  res.json({ status: wppStatus, qr: qrCodeData });
});

app.get("/api/stats", (req, res) => {
  const db = loadDB();
  const entries = db.entries;

  const finance = entries.filter(e => e.category === "finance");
  const exercise = entries.filter(e => e.category === "exercise");
  const sleep = entries.filter(e => e.category === "sleep");
  const mood = entries.filter(e => e.category === "mood");

  res.json({
    totals: {
      entries: entries.length,
      income: finance.filter(e => e.data.type === "income").reduce((s, e) => s + e.data.amount, 0),
      expense: finance.filter(e => e.data.type === "expense").reduce((s, e) => s + e.data.amount, 0),
      exercise_minutes: exercise.reduce((s, e) => s + (e.data.duration_min || 0), 0),
      exercise_km: exercise.reduce((s, e) => s + (e.data.distance_km || 0), 0),
      avg_sleep: sleep.length ? sleep.reduce((s, e) => s + e.data.hours, 0) / sleep.length : 0,
      mood_score: mood.length ? mood.reduce((s, e) => s + e.data.score, 0) / mood.length : 0,
    },
    recent: entries.slice(-20).reverse(),
  });
});

io.on("connection", (socket) => {
  console.log("🌐 Frontend conectado via WebSocket");
  socket.emit("wpp_status", { status: wppStatus, qr: qrCodeData });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🚀 DiárioVivo Backend rodando na porta ${PORT}`);
  console.log(`📡 API: http://localhost:${PORT}/api`);
  console.log(`\n🔄 Iniciando conexão com WhatsApp...`);
  wppClient.initialize();
});
