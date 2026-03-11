/**
 * DiárioVivo — Backend completo
 * ─────────────────────────────────────────────────────────────────
 * ✅ PostgreSQL — dados persistentes, nunca somem com redeploy
 * ✅ Relatório semanal automático com IA (domingo 20h)
 * ✅ Sistema de metas via WhatsApp e dashboard
 * ✅ Alertas automáticos de metas
 * ✅ Insights personalizados por IA sob demanda
 */

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

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
    CREATE TABLE IF NOT EXISTS goals (
      id BIGINT PRIMARY KEY,
      type TEXT,
      value NUMERIC,
      label TEXT,
      period TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log("✅ Banco de dados pronto!");
}

// ─── Funções de Entries ───────────────────────────────────────────────────────
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

// ─── Funções de Metas (PostgreSQL) ───────────────────────────────────────────
async function loadGoals() {
  const res = await pool.query("SELECT * FROM goals ORDER BY created_at ASC");
  return res.rows.map(r => ({ id: Number(r.id), type: r.type, value: Number(r.value), label: r.label, period: r.period, createdAt: r.created_at }));
}

async function saveGoal(goal) {
  await pool.query(
    `INSERT INTO goals (id, type, value, label, period) VALUES ($1,$2,$3,$4,$5)`,
    [goal.id, goal.type, goal.value, goal.label, goal.period]
  );
}

async function deleteGoal(id) {
  await pool.query("DELETE FROM goals WHERE id=$1", [id]);
}

// ─── Parser de metas via WhatsApp ─────────────────────────────────────────────
// Exemplos: "meta: gastar até R$2000 esse mês"
//           "meta: correr 20km essa semana"
//           "meta: dormir pelo menos 7h"
//           "meta: treinar 4 vezes na semana"
function parseGoal(text) {
  const lower = text.toLowerCase().trim();

  const financeMatch = lower.match(/gastar?\s+(?:até|ate|no máximo)?\s*r?\$?\s*(\d+[\.,]?\d*)/);
  if (financeMatch) return { type: "finance_expense", value: parseFloat(financeMatch[1].replace(",", ".")), label: `Gastar até R$${financeMatch[1]}`, period: lower.includes("semana") ? "week" : "month" };

  const incomeMatch = lower.match(/(?:ganhar|receber?)\s+(?:pelo menos)?\s*r?\$?\s*(\d+[\.,]?\d*)/);
  if (incomeMatch) return { type: "finance_income", value: parseFloat(incomeMatch[1].replace(",", ".")), label: `Receber R$${incomeMatch[1]}`, period: lower.includes("semana") ? "week" : "month" };

  const kmMatch = lower.match(/correr?\s+(\d+[\.,]?\d*)\s*km/);
  if (kmMatch) return { type: "exercise_km", value: parseFloat(kmMatch[1].replace(",", ".")), label: `Correr ${kmMatch[1]}km`, period: lower.includes("mês") || lower.includes("mes") ? "month" : "week" };

  const minMatch = lower.match(/(?:treinar|exercitar|academia)\s+(?:pelo menos)?\s*(\d+)\s*(?:min|minutos?|h|horas?)/);
  if (minMatch) {
    const val = (lower.includes("h") && !lower.includes("min")) ? parseInt(minMatch[1]) * 60 : parseInt(minMatch[1]);
    return { type: "exercise_min", value: val, label: `Treinar ${minMatch[1]}${lower.includes("h") && !lower.includes("min") ? "h" : "min"}`, period: lower.includes("mês") || lower.includes("mes") ? "month" : "week" };
  }

  const daysMatch = lower.match(/(?:treinar|exercitar)\s+(\d+)\s*(?:vezes|dias)/);
  if (daysMatch) return { type: "exercise_days", value: parseInt(daysMatch[1]), label: `Treinar ${daysMatch[1]}x`, period: lower.includes("mês") || lower.includes("mes") ? "month" : "week" };

  const sleepMatch = lower.match(/dormir\s+(?:pelo menos)?\s*(\d+[\.,]?\d*)\s*h/);
  if (sleepMatch) return { type: "sleep_hours", value: parseFloat(sleepMatch[1].replace(",", ".")), label: `Dormir ${sleepMatch[1]}h por noite`, period: "daily" };

  return null;
}

// ─── Verificador de alertas ───────────────────────────────────────────────────
async function checkAlertsAndNotify(wppChat) {
  const goals = await loadGoals();
  if (!goals.length) return;

  const now = new Date();
  const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - now.getDay());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const alerts = [];

  for (const goal of goals) {
    const since = goal.period === "month" ? startOfMonth : goal.period === "week" ? startOfWeek : new Date(now.setHours(0,0,0,0));
    const res = await pool.query("SELECT * FROM entries WHERE timestamp >= $1", [since]);
    const recent = res.rows;

    if (goal.type === "finance_expense") {
      const spent = recent.filter(e => e.category === "finance" && e.data.type === "expense").reduce((s, e) => s + (e.data.amount || 0), 0);
      const pct = (spent / goal.value) * 100;
      if (pct >= 100) alerts.push(`🚨 *Meta ultrapassada!*\n💸 Você gastou R$${spent.toFixed(2)} e ultrapassou sua meta de R$${goal.value}!`);
      else if (pct >= 80) alerts.push(`⚠️ *Alerta financeiro!*\n💸 Você já gastou R$${spent.toFixed(2)} de R$${goal.value} (${pct.toFixed(0)}% da meta ${goal.period === "month" ? "do mês" : "da semana"})`);
    }

    if (goal.type === "exercise_km") {
      const km = recent.filter(e => e.category === "exercise").reduce((s, e) => s + (e.data.distance_km || 0), 0);
      const pct = (km / goal.value) * 100;
      if (km >= goal.value) alerts.push(`🎉 *Meta de corrida atingida!*\nVocê correu ${km.toFixed(1)}km esta ${goal.period === "week" ? "semana" : "mês"}! Parabéns! 🏆`);
      else if (pct >= 80) alerts.push(`🏃 *Quase lá na corrida!*\n${km.toFixed(1)}km de ${goal.value}km (${pct.toFixed(0)}%) — você consegue!`);
    }

    if (goal.type === "exercise_days") {
      const allEx = await pool.query("SELECT timestamp FROM entries WHERE category='exercise' ORDER BY timestamp DESC LIMIT 1");
      if (allEx.rows.length) {
        const diff = Math.floor((now - new Date(allEx.rows[0].timestamp)) / (1000 * 60 * 60 * 24));
        if (diff >= 3) alerts.push(`😴 *Alerta de exercício!*\nFaz ${diff} dias que você não treina. Sua meta é treinar ${goal.value}x ${goal.period === "week" ? "por semana" : "por mês"}!`);
      }
    }

    if (goal.type === "sleep_hours") {
      const sleepEntries = recent.filter(e => e.category === "sleep");
      if (sleepEntries.length >= 2) {
        const avg = sleepEntries.reduce((s, e) => s + (e.data.hours || 0), 0) / sleepEntries.length;
        if (avg < goal.value) alerts.push(`😴 *Alerta de sono!*\nSua média esta semana é ${avg.toFixed(1)}h — abaixo da sua meta de ${goal.value}h por noite.`);
      }
    }
  }

  // Alerta de humor negativo consistente (sem precisar de meta cadastrada)
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const moodRes = await pool.query("SELECT data FROM entries WHERE category='mood' AND timestamp >= $1", [weekAgo]);
  if (moodRes.rows.length >= 3) {
    const avg = moodRes.rows.reduce((s, r) => s + (r.data.score || 0), 0) / moodRes.rows.length;
    if (avg < -1) alerts.push(`💙 *Atenção ao seu humor!*\nSua semana está com tendência emocional negativa (score ${avg.toFixed(1)}/5). Cuide-se! 🤗`);
  }

  for (const alert of alerts) {
    try { await wppChat.sendMessage(alert); } catch (e) { console.error("Erro ao enviar alerta:", e.message); }
  }
}

// ─── IA: Insights personalizados ─────────────────────────────────────────────
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

// ─── Relatório Semanal ────────────────────────────────────────────────────────
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

// ─── Agendador de alertas (verifica a cada hora) ──────────────────────────────
let diaryChat = null;
function scheduleAlerts() {
  setInterval(async () => {
    if (!diaryChat || wppStatus !== "ready") return;
    await checkAlertsAndNotify(diaryChat);
  }, 60 * 60 * 1000);
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

// ─── WhatsApp Client ──────────────────────────────────────────────────────────
let wppStatus = "disconnected";
let qrCodeData = null;

const wppClient = new Client({
  authStrategy: new LocalAuth({ dataPath: "/app/wpp-session" }),
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
  scheduleAlerts();
});

wppClient.on("remote_session_saved", () => {
  console.log("💾 Sessão salva!");
});

// ─── Detecção de intenção via IA ─────────────────────────────────────────────
// Classifica a mensagem em: habit | goal | command | question
async function detectIntent(text) {
  if (!process.env.ANTHROPIC_API_KEY) return { intent: "habit" };
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 100,
        messages: [{ role: "user", content: `Classifique esta mensagem em português em UMA das categorias abaixo. Responda APENAS o JSON.

Mensagem: "${text}"

Categorias:
- "habit" = registrar um hábito (exercício, gasto, receita, sono, humor, refeição)
- "goal_set" = definir/criar uma meta ou objetivo pessoal
- "goal_list" = ver/listar metas ativas
- "goal_remove" = remover uma meta (menciona número)
- "insights" = pedir análise, insights, resumo, relatório da IA
- "report" = pedir relatório de gastos/hábitos/semana
- "alerts" = verificar alertas
- "help" = pedir ajuda ou lista de comandos
- "question" = fazer uma pergunta sobre seus dados

Responda APENAS: {"intent": "categoria", "goalText": "texto da meta se goal_set, senão null", "goalRemoveN": numero_ou_null}` }]
      })
    });
    const data = await response.json();
    const raw = data.content?.[0]?.text?.trim() || '{"intent":"habit"}';
    return JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch (e) {
    return { intent: "habit" };
  }
}

wppClient.on("message_create", async (msg) => {
  if (msg.from === "status@broadcast") return;
  if (msg.body.startsWith("✅") || msg.body.startsWith("📝") || msg.body.startsWith("🎯") || msg.body.startsWith("⚠️") || msg.body.startsWith("🚨") || msg.body.startsWith("━") || msg.body.startsWith("🤖") || msg.body.startsWith("📋") || msg.body.startsWith("📖")) return;

  const chat = await msg.getChat();
  if (!chat.isGroup || chat.name !== "Diário Vivo") return;

  const text = msg.body.trim();
  const lower = text.toLowerCase();
  console.log(`📨 Diário Vivo: "${text}"`);
  diaryChat = chat;

  // ── Detecta intenção (IA + fallback por palavras-chave)
  let intent = "habit";
  let goalText = null;
  let goalRemoveN = null;

  // Palavras-chave diretas (rápido, sem custo de API)
  if (/^\/(metas|goals|help|ajuda|insights?|ia|alertas?|check|relat[oó]rio|report)$/i.test(lower) ||
      /^(metas|ajuda|alertas?|insights?)$/i.test(lower)) {
    if (/metas|goals/.test(lower)) intent = "goal_list";
    else if (/help|ajuda/.test(lower)) intent = "help";
    else if (/insights?|ia$/.test(lower)) intent = "insights";
    else if (/alertas?|check/.test(lower)) intent = "alerts";
    else if (/relat|report/.test(lower)) intent = "report";
  } else if (/remover?\s+meta\s+\d+/i.test(lower)) {
    intent = "goal_remove";
    goalRemoveN = parseInt(lower.match(/\d+/)[0]);
  } else if (/^(meta:|objetivo:|quero )/i.test(text)) {
    intent = "goal_set";
    goalText = text.replace(/^(meta:|objetivo:|quero)\s*/i, "");
  } else {
    // Mensagem ambígua — usa IA para classificar
    const detected = await detectIntent(text);
    intent = detected.intent || "habit";
    goalText = detected.goalText || text;
    goalRemoveN = detected.goalRemoveN || null;
  }

  console.log(`🧠 Intent: ${intent}`);

  // ── GOAL LIST
  if (intent === "goal_list") {
    const goals = await loadGoals();
    if (!goals.length) {
      await chat.sendMessage("📋 Você ainda não tem metas cadastradas!\n\nExemplos:\n• _Minha meta é gastar até R$2000 esse mês_\n• _Quero correr 20km essa semana_\n• _Meta: dormir pelo menos 7h_");
      return;
    }
    const list = goals.map((g, i) => `${i+1}. ${g.label} (${g.period === "month" ? "mês" : g.period === "week" ? "semana" : "diário"})`).join("\n");
    await chat.sendMessage(`🎯 *Suas metas ativas:*\n\n${list}\n\nPara remover: _remover meta 1_`);
    return;
  }

  // ── GOAL REMOVE
  if (intent === "goal_remove" && goalRemoveN) {
    const goals = await loadGoals();
    const idx = goalRemoveN - 1;
    if (idx >= 0 && idx < goals.length) {
      await deleteGoal(goals[idx].id);
      await chat.sendMessage(`✅ Meta removida: _${goals[idx].label}_`);
      io.emit("goals_updated", await loadGoals());
    } else {
      await chat.sendMessage("❌ Número inválido. Use _metas_ para ver a lista.");
    }
    return;
  }

  // ── INSIGHTS
  if (intent === "insights") {
    await chat.sendMessage("🤖 Gerando seus insights personalizados... um momento!");
    const entries = await getWeekEntries();
    if (entries.length < 3) { await chat.sendMessage("📊 Ainda poucos dados esta semana. Registre mais hábitos e tente novamente!"); return; }
    const summary = buildWeekSummary(entries);
    const insights = await generateAIInsights(summary);
    if (insights) await chat.sendMessage(`🤖 *Insights da semana*\n\n${insights}`);
    return;
  }

  // ── ALERTS
  if (intent === "alerts") {
    await checkAlertsAndNotify(chat);
    await chat.sendMessage("✅ Alertas verificados!");
    return;
  }

  // ── REPORT
  if (intent === "report") {
    await chat.sendMessage("📋 Gerando relatório...");
    await sendWeeklyReport();
    return;
  }

  // ── HELP
  if (intent === "help") {
    await chat.sendMessage(`📖 *DiárioVivo*\n\nEscreva naturalmente:\n• _"Corri 5km hoje"_\n• _"Gastei R$50 no mercado"_\n• _"Dormi 8h bem"_\n• _"Minha meta é gastar até R$2000 esse mês"_\n• _"Quero ver meus insights"_\n• _"Me manda o relatório"_\n\n💡 Relatório automático todo domingo às 20h!`);
    return;
  }

  // ── GOAL SET
  if (intent === "goal_set") {
    const goal = parseGoal(goalText || text);
    if (goal) {
      const newGoal = { ...goal, id: Date.now() };
      await saveGoal(newGoal);
      await chat.sendMessage(`🎯 *Meta cadastrada!*\n✅ ${goal.label}\n📅 Período: ${goal.period === "month" ? "Mensal" : goal.period === "week" ? "Semanal" : "Diário"}\n\nVou te avisar quando se aproximar! 💪`);
      io.emit("goals_updated", await loadGoals());
    } else {
      await chat.sendMessage("🤔 Não entendi a meta. Tente:\n• *meta: gastar até R$2000 esse mês*\n• *meta: correr 20km essa semana*\n• *meta: dormir pelo menos 7h*\n• *meta: treinar 4 vezes na semana*");
    }
    return;
  }

  // ── Registra entrada normal
  const parsed = parseMessage(text);
  const entry = { id: Date.now(), ...parsed };
  await saveEntry(entry);
  io.emit("new_entry", entry);

  const botReply = generateBotResponse(parsed);
  await chat.sendMessage(botReply);
  console.log(`💾 [${parsed.category}] registrado`);

  // Verifica alertas após novo registro (com delay para não sobrecarregar)
  setTimeout(() => checkAlertsAndNotify(chat), 2000);
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

// ─── API Metas ────────────────────────────────────────────────────────────────
app.get("/api/goals", async (req, res) => {
  res.json(await loadGoals());
});

app.post("/api/goals", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "text is required" });
  const goal = parseGoal(text);
  if (!goal) return res.status(400).json({ error: "Não entendi a meta. Tente: 'gastar até R$2000', 'correr 20km', 'dormir 7h'" });
  const newGoal = { ...goal, id: Date.now() };
  await saveGoal(newGoal);
  io.emit("goals_updated", await loadGoals());
  res.json(newGoal);
});

app.delete("/api/goals/:id", async (req, res) => {
  await deleteGoal(parseInt(req.params.id));
  io.emit("goals_updated", await loadGoals());
  res.json({ ok: true });
});

app.get("/api/goals/progress", async (req, res) => {
  const goals = await loadGoals();
  const now = new Date();
  const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - now.getDay());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const progress = await Promise.all(goals.map(async (goal) => {
    const since = goal.period === "month" ? startOfMonth : goal.period === "week" ? startOfWeek : new Date(now.setHours(0,0,0,0));
    const res = await pool.query("SELECT * FROM entries WHERE timestamp >= $1", [since]);
    const recent = res.rows;

    let current = 0;
    if (goal.type === "finance_expense") current = recent.filter(e => e.category === "finance" && e.data.type === "expense").reduce((s, e) => s + (e.data.amount || 0), 0);
    if (goal.type === "finance_income") current = recent.filter(e => e.category === "finance" && e.data.type === "income").reduce((s, e) => s + (e.data.amount || 0), 0);
    if (goal.type === "exercise_km") current = recent.filter(e => e.category === "exercise").reduce((s, e) => s + (e.data.distance_km || 0), 0);
    if (goal.type === "exercise_min") current = recent.filter(e => e.category === "exercise").reduce((s, e) => s + (e.data.duration_min || 0), 0);
    if (goal.type === "exercise_days") current = new Set(recent.filter(e => e.category === "exercise").map(e => new Date(e.timestamp).toDateString())).size;
    if (goal.type === "sleep_hours") { const s = recent.filter(e => e.category === "sleep"); current = s.length ? s.reduce((acc, e) => acc + (e.data.hours || 0), 0) / s.length : 0; }

    return { ...goal, current: parseFloat(current.toFixed(2)), pct: Math.min(100, Math.round((current / goal.value) * 100)) };
  }));

  res.json(progress);
});

// ─── API Insights ─────────────────────────────────────────────────────────────
app.post("/api/insights", async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY não configurada" });
  const entries = await getWeekEntries();
  if (entries.length < 2) return res.json({ insights: "📊 Ainda não há dados suficientes. Registre mais hábitos esta semana!" });
  const summary = buildWeekSummary(entries);
  const insights = await generateAIInsights(summary);
  res.json({ insights: insights || "Não foi possível gerar insights agora." });
});

// ─── API Relatório ────────────────────────────────────────────────────────────
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

  // Remove TODOS os lock files do Chromium recursivamente
  // O whatsapp-web.js cria a sessão em /app/wpp-session/session-default/
  function removeLocks(dir) {
    if (!fs.existsSync(dir)) return;
    try {
      const items = fs.readdirSync(dir);
      items.forEach(item => {
        const fullPath = path.join(dir, item);
        if (["SingletonLock", "SingletonCookie", "SingletonSocket", "LOCK", ".org.chromium.Chromium.*"].some(n => item === n || item.startsWith(".org.chromium"))) {
          try { fs.unlinkSync(fullPath); console.log(`🧹 Lock removido: ${fullPath}`); } catch (e) {}
        } else {
          try { if (fs.statSync(fullPath).isDirectory()) removeLocks(fullPath); } catch (e) {}
        }
      });
    } catch (e) {}
  }
  removeLocks("/app/wpp-session");
  console.log("🧹 Limpeza de locks concluída");

  server.listen(PORT, () => {
    console.log(`\n🚀 DiárioVivo rodando na porta ${PORT}`);
    console.log(`📡 API: http://localhost:${PORT}/api`);
    wppClient.initialize();
    scheduleWeeklyReport();
  });
}

start().catch(console.error);
