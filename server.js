/**
 * DiárioVivo — Backend
 * ─────────────────────────────────────────────────────────────────
 * Este servidor faz três coisas ao mesmo tempo:
 *  1. Conecta ao WhatsApp via whatsapp-web.js (escaneando um QR Code)
 *  2. Processa cada mensagem recebida com o parser de hábitos
 *  3. Expõe uma API REST + WebSocket para o frontend React consumir
 *
 * COMO FUNCIONA A INTEGRAÇÃO COM WHATSAPP:
 *  A lib whatsapp-web.js "controla" o WhatsApp Web por dentro usando
 *  o Puppeteer (um browser Chrome sem janela). Quando você escaneia
 *  o QR Code, o servidor autentica sua conta e fica "ouvindo" todas
 *  as mensagens que chegam. Cada mensagem é analisada e salva.
 *
 * FLUXO DE UMA MENSAGEM:
 *  Você manda "Corri 5km hoje" no WhatsApp →
 *  servidor recebe → parser extrai { category: "exercise", km: 5 } →
 *  salva no arquivo JSON (nosso "banco de dados" simples) →
 *  emite evento via WebSocket → frontend atualiza em tempo real
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

// ─── Banco de dados simples (arquivo JSON) ────────────────────────────────────
// Para produção, trocar por SQLite ou PostgreSQL. Por enquanto, JSON funciona
// perfeitamente para uso pessoal com centenas ou até milhares de registros.
const DB_PATH = path.join(__dirname, "data.json");

function loadDB() {
  if (!fs.existsSync(DB_PATH)) return { entries: [], lastUpdated: null };
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

function saveDB(data) {
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ─── Parser de linguagem natural ─────────────────────────────────────────────
// Este é o "cérebro" do sistema. Analisa texto livre e extrai dados
// estruturados. Pense nele como um mini-NLP customizado para hábitos.
function parseMessage(text) {
  const lower = text.toLowerCase().trim();
  const result = {
    category: "note",
    confidence: "low", // quão certo estamos da classificação
    data: {},
    raw: text,
    timestamp: new Date().toISOString(),
  };

  // ── EXERCÍCIO / CORRIDA / CAMINHADA ────────────────────────────────────────
  // Captura distância (5km, 3,5 km), duração (30 minutos, 1h) e tipo de atividade
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

    // Detecta o tipo específico de atividade para mostrar o ícone certo no mapa
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
      // Ativa flag para o frontend mostrar o mapa de trajeto
      needs_map: ["running", "walking", "cycling"].includes(type),
    };

    // Calcula calorias estimadas (fórmula simplificada)
    if (result.data.distance_km) {
      result.data.calories_est = Math.round(result.data.distance_km * 60);
    } else if (result.data.duration_min) {
      const mets = { running: 10, walking: 4, cycling: 7, gym: 6, swimming: 8 };
      result.data.calories_est = Math.round((result.data.duration_min / 60) * (mets[type] || 5) * 70);
    }
  }

  // ── FINANÇAS ───────────────────────────────────────────────────────────────
  const financeWords = ["gastei", "paguei", "comprei", "recebi", "ganhei", "salário",
    "investimento", "poupança", "dividendo", "cobrança", "transferi", "depositei"];
  const moneyMatch = text.match(/r?\$\s?(\d+[\.,]?\d*)/i) ||
                     text.match(/(\d+[\.,]?\d*)\s*reais/i);

  if (financeWords.some(w => lower.includes(w)) || moneyMatch) {
    result.category = "finance";
    result.confidence = moneyMatch ? "high" : "medium";

    const isIncome = /recebi|ganhei|salário|dividendo|depositei/.test(lower);
    const amount = moneyMatch ? parseFloat(moneyMatch[1].replace(",", ".")) : 0;

    // Tenta detectar a categoria do gasto para estatísticas mais ricas
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

  // ── SONO ───────────────────────────────────────────────────────────────────
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

  // ── HUMOR / EMOÇÕES ────────────────────────────────────────────────────────
  const moodWords = ["feliz", "triste", "ansioso", "ansiosa", "animado", "animada",
    "estressado", "estressada", "relaxado", "relaxada", "motivado", "motivada",
    "desmotivado", "irritado", "grato", "gratidão", "deprimido", "eufórico",
    "senti", "me sinto", "emoção", "humor"];

  if (moodWords.some(w => lower.includes(w))) {
    result.category = "mood";
    result.confidence = "high";

    // Score de -5 a +5 para traçar linha de tendência emocional
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

  // ── ALIMENTAÇÃO ────────────────────────────────────────────────────────────
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

// ─── Gera resposta automática do bot ─────────────────────────────────────────
// Esta função cria a mensagem de confirmação que o bot envia de volta no WPP
function generateBotResponse(parsed) {
  const { category, data, confidence } = parsed;

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

// ─── WhatsApp Client ──────────────────────────────────────────────────────────
// LocalAuth salva a sessão autenticada em disco para não precisar escanear
// o QR Code toda vez que o servidor reinicia — só na primeira vez!
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
},

let wppStatus = "disconnected"; // Estado atual da conexão WPP
let qrCodeData = null;          // QR Code em base64 para exibir no frontend

// Quando o QR Code estiver pronto para escanear:
wppClient.on("qr", (qr) => {
  qrCodeData = qr;
  wppStatus = "qr_ready";
  qrcode.generate(qr, { small: true }); // Mostra no terminal também
  console.log("\n📱 ESCANEIE O QR CODE ACIMA COM SEU WHATSAPP!\n");
  io.emit("wpp_status", { status: "qr_ready", qr }); // Envia para o frontend
});

// Quando autenticar com sucesso:
wppClient.on("authenticated", () => {
  wppStatus = "authenticated";
  qrCodeData = null;
  console.log("✅ WhatsApp autenticado!");
  io.emit("wpp_status", { status: "authenticated" });
});

// Quando estiver pronto para receber mensagens:
wppClient.on("ready", () => {
  wppStatus = "ready";
  console.log("🟢 WhatsApp pronto e conectado!");
  io.emit("wpp_status", { status: "ready" });
});

// Quando receber uma mensagem:
wppClient.on("message", async (msg) => {
  // Ignora mensagens de grupos e mensagens do próprio usuário em outros contextos
  // Só processa mensagens diretas (chats privados)
  if (msg.isGroupMsg) return;

  const text = msg.body;
  console.log(`📨 Mensagem recebida: "${text}"`);

  // Analisa a mensagem
  const parsed = parseMessage(text);
  const entry = { id: Date.now(), ...parsed };

  // Salva no banco de dados
  const db = loadDB();
  db.entries.push(entry);
  saveDB(db);

  // Emite para todos os clientes do frontend via WebSocket
  io.emit("new_entry", entry);

  // Envia resposta automática de volta no WhatsApp
  const botReply = generateBotResponse(parsed);
  await msg.reply(botReply);

  console.log(`💾 Registrado: [${parsed.category}] com confiança ${parsed.confidence}`);
});

wppClient.on("disconnected", () => {
  wppStatus = "disconnected";
  io.emit("wpp_status", { status: "disconnected" });
});

// ─── API REST ─────────────────────────────────────────────────────────────────

// Retorna todos os registros — o frontend chama isso ao carregar
app.get("/api/entries", (req, res) => {
  const db = loadDB();
  res.json(db.entries);
});

// Adiciona uma entrada manual (para quando o usuário digitar direto no app)
app.post("/api/entries", (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "text is required" });

  const parsed = parseMessage(text);
  const entry = { id: Date.now(), ...parsed };

  const db = loadDB();
  db.entries.push(entry);
  saveDB(db);

  io.emit("new_entry", entry); // Também notifica via WebSocket

  res.json(entry);
});

// Salva um trajeto do Maps para uma entrada de exercício existente
app.patch("/api/entries/:id/route", (req, res) => {
  const { id } = req.params;
  const { route } = req.body; // { polyline, distance_km, duration_min, start, end }

  const db = loadDB();
  const entry = db.entries.find(e => e.id === parseInt(id));
  if (!entry) return res.status(404).json({ error: "Entry not found" });

  entry.data.route = route;
  saveDB(db);
  io.emit("entry_updated", entry);

  res.json(entry);
});

// Status do WhatsApp (para o frontend saber se precisa mostrar QR Code)
app.get("/api/wpp/status", (req, res) => {
  res.json({ status: wppStatus, qr: qrCodeData });
});

// Estatísticas consolidadas para o dashboard
app.get("/api/stats", (req, res) => {
  const db = loadDB();
  const entries = db.entries;

  const finance = entries.filter(e => e.category === "finance");
  const exercise = entries.filter(e => e.category === "exercise");
  const sleep = entries.filter(e => e.category === "sleep");
  const mood = entries.filter(e => e.category === "mood");
  const food = entries.filter(e => e.category === "food");

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

// ─── WebSocket ────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("🌐 Frontend conectado via WebSocket");
  // Envia o status atual imediatamente ao conectar
  socket.emit("wpp_status", { status: wppStatus, qr: qrCodeData });
});

// ─── Inicialização ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🚀 DiárioVivo Backend rodando na porta ${PORT}`);
  console.log(`📡 API: http://localhost:${PORT}/api`);
  console.log(`\n🔄 Iniciando conexão com WhatsApp...`);
  wppClient.initialize();
});
