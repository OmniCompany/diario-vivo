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
const DB_PATH = path.join(__dirname, "data.json");
const GOALS_PATH = path.join(__dirname, "goals.json");

function loadDB() {
  if (!fs.existsSync(DB_PATH)) return { entries: [], lastUpdated: null };
  try { return JSON.parse(fs.readFileSync(DB_PATH, "utf-8")); }
  catch (e) { return { entries: [], lastUpdated: null }; }
}

function saveDB(data) {
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function loadGoals() {
  if (!fs.existsSync(GOALS_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(GOALS_PATH, "utf-8")); }
  catch (e) { return []; }
}

function saveGoals(goals) {
  fs.writeFileSync(GOALS_PATH, JSON.stringify(goals, null, 2));
}

// ─── Parser de metas via WhatsApp ─────────────────────────────────────────────
// Exemplos: "meta: gastar até R$2000 esse mês"
//           "meta: correr 20km essa semana"
//           "meta: dormir pelo menos 7h por noite"
function parseGoal(text) {
  const lower = text.toLowerCase().trim();

  // Financeiro
  const financeMatch = lower.match(/gastar?\s+(?:até|ate|no máximo)?\s*r?\$?\s*(\d+[\.,]?\d*)/);
  if (financeMatch) {
    return { type: "finance_expense", value: parseFloat(financeMatch[1].replace(",", ".")), label: `Gastar até R$${financeMatch[1]}`, period: lower.includes("semana") ? "week" : "month" };
  }
  const incomeMatch = lower.match(/(?:ganhar|recebi?r)\s+(?:pelo menos)?\s*r?\$?\s*(\d+[\.,]?\d*)/);
  if (incomeMatch) {
    return { type: "finance_income", value: parseFloat(incomeMatch[1].replace(",", ".")), label: `Receber R$${incomeMatch[1]}`, period: lower.includes("semana") ? "week" : "month" };
  }

  // Exercício
  const exerciseKmMatch = lower.match(/correr?\s+(\d+[\.,]?\d*)\s*km/);
  if (exerciseKmMatch) {
    return { type: "exercise_km", value: parseFloat(exerciseKmMatch[1].replace(",", ".")), label: `Correr ${exerciseKmMatch[1]}km`, period: lower.includes("mês") || lower.includes("mes") ? "month" : "week" };
  }
  const exerciseMinMatch = lower.match(/(?:treinar|exercitar|academia)\s+(?:pelo menos)?\s*(\d+)\s*(?:min|minutos?|h|horas?)/);
  if (exerciseMinMatch) {
    const val = lower.includes("h") && !lower.includes("min") ? parseInt(exerciseMinMatch[1]) * 60 : parseInt(exerciseMinMatch[1]);
    return { type: "exercise_min", value: val, label: `Treinar ${exerciseMinMatch[1]}${lower.includes("h") ? "h" : "min"}`, period: lower.includes("mês") || lower.includes("mes") ? "month" : "week" };
  }
  const exerciseDaysMatch = lower.match(/(?:treinar|exercitar)\s+(\d+)\s*(?:vezes|dias)/);
  if (exerciseDaysMatch) {
    return { type: "exercise_days", value: parseInt(exerciseDaysMatch[1]), label: `Treinar ${exerciseDaysMatch[1]}x`, period: lower.includes("mês") || lower.includes("mes") ? "month" : "week" };
  }

  // Sono
  const sleepMatch = lower.match(/dormir\s+(?:pelo menos)?\s*(\d+[\.,]?\d*)\s*h/);
  if (sleepMatch) {
    return { type: "sleep_hours", value: parseFloat(sleepMatch[1].replace(",", ".")), label: `Dormir ${sleepMatch[1]}h por noite`, period: "daily" };
  }

  return null;
}

// ─── Verificador de alertas ────────────────────────────────────────────────────
async function checkAlertsAndNotify(wppChat) {
  const goals = loadGoals();
  if (!goals.length) return;

  const db = loadDB();
  const now = new Date();
  const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - now.getDay());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const alerts = [];

  for (const goal of goals) {
    const since = goal.period === "month" ? startOfMonth : goal.period === "week" ? startOfWeek : new Date(now.setHours(0,0,0,0));
    const recent = db.entries.filter(e => new Date(e.timestamp) >= since);

    if (goal.type === "finance_expense") {
      const spent = recent.filter(e => e.category === "finance" && e.data.type === "expense").reduce((s, e) => s + e.data.amount, 0);
      const pct = (spent / goal.value) * 100;
      if (pct >= 80 && pct < 100) alerts.push(`⚠️ *Alerta de meta!*\n💸 Você já gastou R$${spent.toFixed(2)} de R$${goal.value} (${pct.toFixed(0)}% da meta de gastos ${goal.period === "month" ? "do mês" : "da semana"})`);
      if (pct >= 100) alerts.push(`🚨 *Meta ultrapassada!*\n💸 Você gastou R$${spent.toFixed(2)} — ultrapassou sua meta de R$${goal.value}!`);
    }

    if (goal.type === "exercise_km") {
      const km = recent.filter(e => e.category === "exercise").reduce((s, e) => s + (e.data.distance_km || 0), 0);
      const pct = (km / goal.value) * 100;
      if (pct >= 80) alerts.push(`🏃 *Meta de corrida quase lá!*\nVocê correu ${km.toFixed(1)}km de ${goal.value}km (${pct.toFixed(0)}%)`);
      if (km >= goal.value) alerts.push(`🎉 *Meta de corrida atingida!*\nVocê correu ${km.toFixed(1)}km essa ${goal.period === "week" ? "semana" : "mês"}! Parabéns!`);
    }

    if (goal.type === "exercise_days") {
      const days = new Set(recent.filter(e => e.category === "exercise").map(e => new Date(e.timestamp).toDateString())).size;
      const daysSinceLastEx = recent.filter(e => e.category === "exercise").length === 0;
      if (daysSinceLastEx) {
        const lastEx = db.entries.filter(e => e.category === "exercise").pop();
        if (lastEx) {
          const diff = Math.floor((now - new Date(lastEx.timestamp)) / (1000 * 60 * 60 * 24));
          if (diff >= 3) alerts.push(`😴 *Alerta de exercício!*\nFaz ${diff} dias que você não treina. Sua meta é treinar ${goal.value}x ${goal.period === "week" ? "por semana" : "por mês"}!`);
        }
      }
    }

    if (goal.type === "sleep_hours") {
      const sleepEntries = recent.filter(e => e.category === "sleep");
      if (sleepEntries.length > 0) {
        const avg = sleepEntries.reduce((s, e) => s + e.data.hours, 0) / sleepEntries.length;
        if (avg < goal.value) alerts.push(`😴 *Alerta de sono!*\nSua média de sono esta semana é ${avg.toFixed(1)}h — abaixo da sua meta de ${goal.value}h por noite.`);
      }
    }
  }

  // Alerta de humor negativo consistente
  const recentMood = db.entries.filter(e => e.category === "mood" && new Date(e.timestamp) >= startOfWeek);
  if (recentMood.length >= 3) {
    const avgMood = recentMood.reduce((s, e) => s + e.data.score, 0) / recentMood.length;
    if (avgMood < -1) alerts.push(`💙 *Atenção ao seu humor!*\nSua semana está com tendência emocional negativa (score ${avgMood.toFixed(1)}/5). Cuide-se! 🤗`);
  }

  for (const alert of alerts) {
    try { await wppChat.sendMessage(alert); } catch (e) { console.error("Erro ao enviar alerta:", e.message); }
  }
}

// ─── IA para insights personalizados ─────────────────────────────────────────
async function generateAIInsights(wppChat) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;

  const db = loadDB();
  const now = new Date();
  const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - 7);
  const recent = db.entries.filter(e => new Date(e.timestamp) >= startOfWeek);
  if (recent.length < 3) return;

  const summary = {
    finance: { income: 0, expense: 0, categories: {} },
    exercise: { sessions: 0, total_km: 0, total_min: 0 },
    sleep: { entries: [], avg: 0 },
    mood: { entries: [], avg: 0 },
    food: { healthy: 0, indulgent: 0, neutral: 0 },
  };

  recent.forEach(e => {
    if (e.category === "finance") {
      if (e.data.type === "income") summary.finance.income += e.data.amount;
      else { summary.finance.expense += e.data.amount; summary.finance.categories[e.data.expense_category] = (summary.finance.categories[e.data.expense_category] || 0) + e.data.amount; }
    }
    if (e.category === "exercise") { summary.exercise.sessions++; summary.exercise.total_km += e.data.distance_km || 0; summary.exercise.total_min += e.data.duration_min || 0; }
    if (e.category === "sleep") summary.sleep.entries.push(e.data.hours);
    if (e.category === "mood") summary.mood.entries.push(e.data.score);
    if (e.category === "food") summary.food[e.data.healthiness]++;
  });

  if (summary.sleep.entries.length) summary.sleep.avg = summary.sleep.entries.reduce((a, b) => a + b, 0) / summary.sleep.entries.length;
  if (summary.mood.entries.length) summary.mood.avg = summary.mood.entries.reduce((a, b) => a + b, 0) / summary.mood.entries.length;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        messages: [{
          role: "user",
          content: `Você é um coach pessoal simpático que analisa dados de hábitos e dá insights práticos em português.

Dados da última semana do usuário:
- Finanças: Receita R$${summary.finance.income.toFixed(2)}, Gastos R$${summary.finance.expense.toFixed(2)}, Categorias: ${JSON.stringify(summary.finance.categories)}
- Exercício: ${summary.exercise.sessions} sessões, ${summary.exercise.total_km.toFixed(1)}km, ${summary.exercise.total_min}min
- Sono: média ${summary.sleep.avg.toFixed(1)}h (${summary.sleep.entries.length} registros)
- Humor: média ${summary.mood.avg.toFixed(1)}/5 (${summary.mood.entries.length} registros)
- Alimentação: ${summary.food.healthy} saudável, ${summary.food.indulgent} indulgente, ${summary.food.neutral} neutro

Gere exatamente 3 insights curtos e práticos (máx 2 linhas cada). Seja direto, humano e motivador. Use emojis. Formato:
1. [insight]
2. [insight]
3. [insight]`
        }]
      })
    });

    const data = await response.json();
    const insights = data.content?.[0]?.text;
    if (insights) {
      await wppChat.sendMessage(`🤖 *Insights da semana — IA DiárioVivo*\n\n${insights}`);
    }
  } catch (e) { console.error("Erro ao gerar insights IA:", e.message); }
}

// ─── Agendador de alertas (verifica a cada hora) ──────────────────────────────
let diaryChat = null;
function scheduleAlerts() {
  setInterval(async () => {
    if (!diaryChat || wppStatus !== "ready") return;
    await checkAlertsAndNotify(diaryChat);
  }, 60 * 60 * 1000); // a cada 1 hora

  // Insights de IA toda segunda-feira às 9h
  setInterval(async () => {
    const now = new Date();
    if (now.getDay() === 1 && now.getHours() === 9 && now.getMinutes() < 5) {
      if (diaryChat && wppStatus === "ready") await generateAIInsights(diaryChat);
    }
  }, 5 * 60 * 1000); // verifica a cada 5 min
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
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  },
});

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
wppClient.on("ready", async () => {
  wppStatus = "ready";
  console.log("🟢 WhatsApp pronto e conectado!");
  io.emit("wpp_status", { status: "ready" });
  scheduleAlerts();
});

// Quando receber uma mensagem:
wppClient.on("message", async (msg) => {
  if (msg.isGroupMsg) return;

  const text = msg.body.trim();
  console.log(`📨 Mensagem recebida: "${text}"`);
  const chat = await msg.getChat();
  diaryChat = chat;

  const lower = text.toLowerCase();

  // ── Comando: /metas — lista as metas ativas
  if (lower === "/metas" || lower === "metas" || lower === "/goals") {
    const goals = loadGoals();
    if (!goals.length) {
      await msg.reply("📋 Você ainda não tem metas cadastradas!\n\nExemplos para definir:\n• *meta: gastar até R$2000 esse mês*\n• *meta: correr 20km essa semana*\n• *meta: dormir pelo menos 7h*\n• *meta: treinar 4 vezes na semana*");
      return;
    }
    const list = goals.map((g, i) => `${i+1}. ${g.label} (${g.period === "month" ? "mês" : g.period === "week" ? "semana" : "diário"})`).join("\n");
    await msg.reply(`🎯 *Suas metas ativas:*\n\n${list}\n\nPara remover: *remover meta 1*`);
    return;
  }

  // ── Comando: remover meta N
  const removeMatch = lower.match(/remover\s+meta\s+(\d+)/);
  if (removeMatch) {
    const goals = loadGoals();
    const idx = parseInt(removeMatch[1]) - 1;
    if (idx >= 0 && idx < goals.length) {
      const removed = goals.splice(idx, 1)[0];
      saveGoals(goals);
      await msg.reply(`✅ Meta removida: _${removed.label}_`);
    } else {
      await msg.reply("❌ Número de meta inválido. Use */metas* para ver a lista.");
    }
    return;
  }

  // ── Comando: /insights — pede análise da IA agora
  if (lower === "/insights" || lower === "insights" || lower === "/ia") {
    await msg.reply("🤖 Gerando seus insights personalizados... um momento!");
    await generateAIInsights(chat);
    return;
  }

  // ── Comando: /alertas — verifica alertas agora
  if (lower === "/alertas" || lower === "alertas" || lower === "/check") {
    await checkAlertsAndNotify(chat);
    await msg.reply("✅ Alertas verificados!");
    return;
  }

  // ── Define nova meta
  const isGoal = lower.startsWith("meta:") || lower.startsWith("meta ") || lower.startsWith("objetivo:") || lower.startsWith("quero ");
  if (isGoal) {
    const goalText = text.replace(/^(meta:|meta|objetivo:|quero)\s*/i, "");
    const goal = parseGoal(goalText);
    if (goal) {
      const goals = loadGoals();
      goals.push({ ...goal, id: Date.now(), createdAt: new Date().toISOString() });
      saveGoals(goals);
      await msg.reply(`🎯 *Meta cadastrada com sucesso!*\n✅ ${goal.label}\n📅 Período: ${goal.period === "month" ? "Mensal" : goal.period === "week" ? "Semanal" : "Diário"}\n\nVou te avisar quando se aproximar do limite! 💪`);
      io.emit("goals_updated", goals);
      return;
    } else {
      await msg.reply("🤔 Não consegui entender a meta. Tente assim:\n• *meta: gastar até R$2000 esse mês*\n• *meta: correr 20km essa semana*\n• *meta: dormir pelo menos 7h*\n• *meta: treinar 4 vezes na semana*");
      return;
    }
  }

  // ── Ajuda
  if (lower === "/help" || lower === "ajuda" || lower === "/ajuda") {
    await msg.reply(`📖 *DiárioVivo — Comandos*\n\n*Registrar hábitos:*\nBasta escrever naturalmente! Ex: "Corri 5km", "Gastei R$50 no mercado", "Dormi 8h"\n\n*Metas:*\n• *meta: [descrição]* — cria uma nova meta\n• */metas* — lista metas ativas\n• *remover meta N* — remove uma meta\n\n*IA & Alertas:*\n• */insights* — análise personalizada agora\n• */alertas* — verifica alertas agora\n\n💡 Insights automáticos toda segunda às 9h!`);
    return;
  }

  // ── Registra entrada normal de hábito
  const parsed = parseMessage(text);
  const entry = { id: Date.now(), ...parsed };

  const db = loadDB();
  db.entries.push(entry);
  saveDB(db);

  io.emit("new_entry", entry);

  const botReply = generateBotResponse(parsed);
  await msg.reply(botReply);

  console.log(`💾 Registrado: [${parsed.category}] com confiança ${parsed.confidence}`);

  // Verifica alertas após cada novo registro
  setTimeout(() => checkAlertsAndNotify(chat), 2000);
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

// ─── Metas ────────────────────────────────────────────────────────────────────
app.get("/api/goals", (req, res) => {
  res.json(loadGoals());
});

app.post("/api/goals", (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "text is required" });
  const goal = parseGoal(text);
  if (!goal) return res.status(400).json({ error: "Não consegui entender a meta. Tente: 'gastar até R$2000', 'correr 20km', 'dormir 7h'" });
  const goals = loadGoals();
  const newGoal = { ...goal, id: Date.now(), createdAt: new Date().toISOString() };
  goals.push(newGoal);
  saveGoals(goals);
  io.emit("goals_updated", goals);
  res.json(newGoal);
});

app.delete("/api/goals/:id", (req, res) => {
  const goals = loadGoals().filter(g => g.id !== parseInt(req.params.id));
  saveGoals(goals);
  io.emit("goals_updated", goals);
  res.json({ ok: true });
});

// Retorna o progresso atual de cada meta
app.get("/api/goals/progress", (req, res) => {
  const goals = loadGoals();
  const db = loadDB();
  const now = new Date();
  const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - now.getDay());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const progress = goals.map(goal => {
    const since = goal.period === "month" ? startOfMonth : goal.period === "week" ? startOfWeek : new Date(now.setHours(0,0,0,0));
    const recent = db.entries.filter(e => new Date(e.timestamp) >= since);

    let current = 0;
    if (goal.type === "finance_expense") current = recent.filter(e => e.category === "finance" && e.data.type === "expense").reduce((s, e) => s + e.data.amount, 0);
    if (goal.type === "finance_income") current = recent.filter(e => e.category === "finance" && e.data.type === "income").reduce((s, e) => s + e.data.amount, 0);
    if (goal.type === "exercise_km") current = recent.filter(e => e.category === "exercise").reduce((s, e) => s + (e.data.distance_km || 0), 0);
    if (goal.type === "exercise_min") current = recent.filter(e => e.category === "exercise").reduce((s, e) => s + (e.data.duration_min || 0), 0);
    if (goal.type === "exercise_days") current = new Set(recent.filter(e => e.category === "exercise").map(e => new Date(e.timestamp).toDateString())).size;
    if (goal.type === "sleep_hours") { const s = recent.filter(e => e.category === "sleep"); current = s.length ? s.reduce((acc, e) => acc + e.data.hours, 0) / s.length : 0; }

    return { ...goal, current, pct: Math.min(100, Math.round((current / goal.value) * 100)) };
  });

  res.json(progress);
});

// ─── IA Insights on-demand ───────────────────────────────────────────────────
app.post("/api/insights", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY não configurada" });

  const db = loadDB();
  const now = new Date();
  const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - 7);
  const recent = db.entries.filter(e => new Date(e.timestamp) >= startOfWeek);

  if (recent.length < 2) return res.json({ insights: "📊 Ainda não há dados suficientes para gerar insights. Registre mais hábitos esta semana!" });

  const summary = { finance: { income: 0, expense: 0 }, exercise: { sessions: 0, km: 0 }, sleep: [], mood: [], food: { healthy: 0, indulgent: 0 } };
  recent.forEach(e => {
    if (e.category === "finance") { if (e.data.type === "income") summary.finance.income += e.data.amount; else summary.finance.expense += e.data.amount; }
    if (e.category === "exercise") { summary.exercise.sessions++; summary.exercise.km += e.data.distance_km || 0; }
    if (e.category === "sleep") summary.sleep.push(e.data.hours);
    if (e.category === "mood") summary.mood.push(e.data.score);
    if (e.category === "food") { if (e.data.healthiness === "healthy") summary.food.healthy++; else if (e.data.healthiness === "indulgent") summary.food.indulgent++; }
  });

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        messages: [{ role: "user", content: `Coach pessoal simpático. Dados da última semana: Finanças: receita R$${summary.finance.income.toFixed(2)}, gastos R$${summary.finance.expense.toFixed(2)}. Exercício: ${summary.exercise.sessions} sessões, ${summary.exercise.km.toFixed(1)}km. Sono: média ${summary.sleep.length ? (summary.sleep.reduce((a,b)=>a+b,0)/summary.sleep.length).toFixed(1) : "N/A"}h. Humor: média ${summary.mood.length ? (summary.mood.reduce((a,b)=>a+b,0)/summary.mood.length).toFixed(1) : "N/A"}/5. Alimentação: ${summary.food.healthy} saudável, ${summary.food.indulgent} indulgente.\n\nGere 3 insights práticos e motivadores em português. Use emojis. Seja direto e humano. Formato numerado.` }]
      })
    });
    const data = await response.json();
    res.json({ insights: data.content?.[0]?.text || "Não foi possível gerar insights agora." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
