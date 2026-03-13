/**
 * DiárioVivo — Backend v3
 * ─────────────────────────────────────────────────────────────────
 * ✅ JWT Authentication (login com usuário + senha)
 * ✅ Rate Limiting (express-rate-limit)
 * ✅ Helmet (headers de segurança HTTP)
 * ✅ Input validation (express-validator)
 * ✅ msg.fromMe filtrado corretamente (sem loop)
 * ✅ intent = detected.intent — bug corrigido
 * ✅ LocalAuth mantido (sessão estável no Railway Volume)
 * ✅ PostgreSQL SSL flexível (Railway usa self-signed)
 * ✅ Todas as rotas e lógica de negócio preservadas
 */

const express    = require("express");
const cors       = require("cors");
const http       = require("http");
const { Server } = require("socket.io");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode     = require("qrcode-terminal");
const { Pool }   = require("pg");
const crypto     = require("crypto");
const jwt        = require("jsonwebtoken");
const rateLimit  = require("express-rate-limit");
const helmet     = require("helmet");
const { body, validationResult } = require("express-validator");
const fs         = require("fs");
const path       = require("path");

// ─── Variáveis de ambiente ────────────────────────────────────────────────────
for (const key of ["DATABASE_URL", "JWT_SECRET"]) {
  if (!process.env[key]) {
    console.error(`❌ Variável obrigatória ausente: ${key}`);
    process.exit(1);
  }
}

const JWT_SECRET   = process.env.JWT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://diario-vivo-frontend.vercel.app";
const PORT         = process.env.PORT || 3000;

// ─── Express + Socket.IO ──────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: {
    origin: [FRONTEND_URL, "http://localhost:5173", "http://localhost:3000"],
    methods: ["GET", "POST"],
    credentials: true,
  }
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: [FRONTEND_URL, "http://localhost:5173", "http://localhost:3000"],
  credentials: true,
}));
app.use(express.json({ limit: "50kb" }));
app.set("trust proxy", 1); // Railway usa proxy reverso

// ─── Rate Limiters ────────────────────────────────────────────────────────────
const generalLimiter = rateLimit({ windowMs: 15*60*1000, max: 300, standardHeaders: true, legacyHeaders: false });
const authLimiter    = rateLimit({ windowMs: 15*60*1000, max: 10,  message: { error: "Muitas tentativas. Aguarde 15 min." } });
const writeLimiter   = rateLimit({ windowMs: 60*1000,    max: 60 });
app.use("/api/", generalLimiter);

// ─── PostgreSQL ───────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
pool.on("error", err => console.error("❌ Pool error:", err.message));

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
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
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_entries_timestamp ON entries(timestamp);
      CREATE INDEX IF NOT EXISTS idx_entries_category  ON entries(category);
    `);
    console.log("✅ Banco de dados pronto!");
  } finally {
    client.release();
  }
}

// ─── Helpers de senha (crypto nativo — sem bcrypt) ───────────────────────────
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString("hex")}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(":");
  const attempt = crypto.scryptSync(pw, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(attempt, "hex"));
}

// ─── Middleware JWT ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return res.status(401).json({ error: "Token ausente." });
  try {
    req.user = jwt.verify(h.split(" ")[1], JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ error: err.name === "TokenExpiredError" ? "Token expirado. Faça login novamente." : "Token inválido." });
  }
}

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
//  AUTENTICAÇÃO (rotas públicas)
// ─────────────────────────────────────────────────────────────────────────────

app.post("/api/auth/register",
  authLimiter,
  [body("username").trim().isLength({ min: 3, max: 30 }), body("password").isLength({ min: 6 })],
  validate,
  async (req, res) => {
    const { username, password } = req.body;
    try {
      if ((await pool.query("SELECT id FROM users WHERE username=$1", [username])).rows.length)
        return res.status(409).json({ error: "Usuário já existe." });
      const id = crypto.randomUUID();
      await pool.query("INSERT INTO users (id, username, password_hash) VALUES ($1,$2,$3)", [id, username, hashPassword(password)]);
      const token = jwt.sign({ id, username }, JWT_SECRET, { expiresIn: "30d" });
      res.status(201).json({ token, username });
    } catch (err) {
      console.error("Register:", err.message);
      res.status(500).json({ error: "Erro interno." });
    }
  }
);

app.post("/api/auth/login",
  authLimiter,
  [body("username").trim().notEmpty(), body("password").notEmpty()],
  validate,
  async (req, res) => {
    const { username, password } = req.body;
    try {
      const user = (await pool.query("SELECT * FROM users WHERE username=$1", [username])).rows[0];
      if (!user || !verifyPassword(password, user.password_hash))
        return res.status(401).json({ error: "Usuário ou senha incorretos." });
      const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "30d" });
      res.json({ token, username: user.username });
    } catch (err) {
      console.error("Login:", err.message);
      res.status(500).json({ error: "Erro interno." });
    }
  }
);

app.get("/api/auth/me", requireAuth, (req, res) => res.json({ username: req.user.username }));

// ─────────────────────────────────────────────────────────────────────────────
//  FUNÇÕES DE DADOS
// ─────────────────────────────────────────────────────────────────────────────

async function loadEntries() {
  const res = await pool.query("SELECT * FROM entries ORDER BY timestamp ASC");
  return res.rows.map(r => ({ id: r.id, category: r.category, confidence: r.confidence, raw: r.raw, data: r.data, timestamp: r.timestamp }));
}

async function saveEntry(entry) {
  await pool.query(
    "INSERT INTO entries (id,category,confidence,raw,data,timestamp) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET data=$5",
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

async function loadGoals() {
  const res = await pool.query("SELECT * FROM goals ORDER BY created_at ASC");
  return res.rows.map(r => ({ id: Number(r.id), type: r.type, value: Number(r.value), label: r.label, period: r.period, createdAt: r.created_at }));
}

async function saveGoal(g) {
  await pool.query("INSERT INTO goals (id,type,value,label,period) VALUES ($1,$2,$3,$4,$5)", [g.id, g.type, g.value, g.label, g.period]);
}

async function deleteGoal(id) {
  await pool.query("DELETE FROM goals WHERE id=$1", [id]);
}

// ─── Parser de metas ─────────────────────────────────────────────────────────
function parseGoal(text) {
  const l = text.toLowerCase().trim();

  const fm = l.match(/gastar?\s+(?:até|ate|no máximo)?\s*r?\$?\s*(\d+[\.,]?\d*)/);
  if (fm) return { type: "finance_expense", value: parseFloat(fm[1].replace(",",".")), label: `Gastar até R$${fm[1]}`, period: l.includes("semana") ? "week" : "month" };

  const im = l.match(/(?:ganhar|receber?)\s+(?:pelo menos)?\s*r?\$?\s*(\d+[\.,]?\d*)/);
  if (im) return { type: "finance_income", value: parseFloat(im[1].replace(",",".")), label: `Receber R$${im[1]}`, period: l.includes("semana") ? "week" : "month" };

  const km = l.match(/correr?\s+(\d+[\.,]?\d*)\s*km/);
  if (km) return { type: "exercise_km", value: parseFloat(km[1].replace(",",".")), label: `Correr ${km[1]}km`, period: l.includes("mês")||l.includes("mes") ? "month" : "week" };

  const mm = l.match(/(?:treinar|exercitar|academia)\s+(?:pelo menos)?\s*(\d+)\s*(?:min|minutos?|h|horas?)/);
  if (mm) {
    const val = (l.includes("h") && !l.includes("min")) ? parseInt(mm[1])*60 : parseInt(mm[1]);
    return { type: "exercise_min", value: val, label: `Treinar ${mm[1]}${l.includes("h")&&!l.includes("min")?"h":"min"}`, period: l.includes("mês")||l.includes("mes") ? "month" : "week" };
  }

  const dm = l.match(/(?:treinar|exercitar)\s+(\d+)\s*(?:vezes|dias)/);
  if (dm) return { type: "exercise_days", value: parseInt(dm[1]), label: `Treinar ${dm[1]}x`, period: l.includes("mês")||l.includes("mes") ? "month" : "week" };

  const sm = l.match(/dormir\s+(?:pelo menos)?\s*(\d+[\.,]?\d*)\s*h/);
  if (sm) return { type: "sleep_hours", value: parseFloat(sm[1].replace(",",".")), label: `Dormir ${sm[1]}h por noite`, period: "daily" };

  const gi = l.match(/(?:fazer|ganhar|receber|faturar)\s+r?\$?\s*(\d+[\.,]?\d*)/);
  if (gi) return { type: "finance_income", value: parseFloat(gi[1].replace(",",".")), label: `Receber R$${gi[1]}`, period: "month" };

  return null;
}

// ─── Alertas ─────────────────────────────────────────────────────────────────
async function checkAlertsAndNotify(wppChat) {
  const goals = await loadGoals();
  if (!goals.length) return;

  const now          = new Date();
  const startOfWeek  = new Date(now); startOfWeek.setDate(now.getDate() - now.getDay());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const alerts       = [];

  for (const goal of goals) {
    const since  = goal.period === "month" ? startOfMonth : goal.period === "week" ? startOfWeek : new Date(new Date().setHours(0,0,0,0));
    const recent = (await pool.query("SELECT * FROM entries WHERE timestamp >= $1", [since])).rows;

    if (goal.type === "finance_expense") {
      const spent = recent.filter(e => e.category==="finance" && e.data.type==="expense").reduce((s,e) => s+(e.data.amount||0), 0);
      const pct   = (spent/goal.value)*100;
      if (pct >= 100) alerts.push(`🚨 *Meta ultrapassada!*\n💸 Você gastou R$${spent.toFixed(2)} e ultrapassou sua meta de R$${goal.value}!`);
      else if (pct >= 80) alerts.push(`⚠️ *Alerta financeiro!*\n💸 Você já gastou R$${spent.toFixed(2)} de R$${goal.value} (${pct.toFixed(0)}% da meta ${goal.period==="month"?"do mês":"da semana"})`);
    }
    if (goal.type === "exercise_km") {
      const km  = recent.filter(e => e.category==="exercise").reduce((s,e) => s+(e.data.distance_km||0), 0);
      const pct = (km/goal.value)*100;
      if (km >= goal.value) alerts.push(`🎉 *Meta de corrida atingida!*\nVocê correu ${km.toFixed(1)}km esta ${goal.period==="week"?"semana":"mês"}! Parabéns! 🏆`);
      else if (pct >= 80) alerts.push(`🏃 *Quase lá na corrida!*\n${km.toFixed(1)}km de ${goal.value}km (${pct.toFixed(0)}%) — você consegue!`);
    }
    if (goal.type === "exercise_days") {
      const lastEx = await pool.query("SELECT timestamp FROM entries WHERE category='exercise' ORDER BY timestamp DESC LIMIT 1");
      if (lastEx.rows.length) {
        const diff = Math.floor((now - new Date(lastEx.rows[0].timestamp)) / (1000*60*60*24));
        if (diff >= 3) alerts.push(`😴 *Alerta de exercício!*\nFaz ${diff} dias que você não treina. Sua meta é treinar ${goal.value}x ${goal.period==="week"?"por semana":"por mês"}!`);
      }
    }
    if (goal.type === "sleep_hours") {
      const sleepEntries = recent.filter(e => e.category==="sleep");
      if (sleepEntries.length >= 2) {
        const avg = sleepEntries.reduce((s,e) => s+(e.data.hours||0), 0) / sleepEntries.length;
        if (avg < goal.value) alerts.push(`😴 *Alerta de sono!*\nSua média esta semana é ${avg.toFixed(1)}h — abaixo da sua meta de ${goal.value}h por noite.`);
      }
    }
  }

  const weekAgo = new Date(Date.now() - 7*24*60*60*1000);
  const moodRes = (await pool.query("SELECT data FROM entries WHERE category='mood' AND timestamp >= $1", [weekAgo])).rows;
  if (moodRes.length >= 3) {
    const avg = moodRes.reduce((s,r) => s+(r.data.score||0), 0) / moodRes.length;
    if (avg < -1) alerts.push(`💙 *Atenção ao seu humor!*\nSua semana está com tendência emocional negativa (score ${avg.toFixed(1)}/5). Cuide-se! 🤗`);
  }

  for (const alert of alerts) {
    try { await wppChat.sendMessage(alert); } catch(e) { console.error("Erro ao enviar alerta:", e.message); }
  }
}

// ─── IA: Insights ─────────────────────────────────────────────────────────────
async function generateAIInsights(summary) {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 600,
        messages: [{ role: "user", content: `Você é um coach de hábitos pessoal. Analise os dados da semana e gere 3 insights práticos em português brasileiro. Use os números reais e dê sugestões acionáveis.\n\nDados:\n${JSON.stringify(summary, null, 2)}\n\nResponda APENAS com os 3 insights, um por linha, começando com emoji. Sem introdução.` }]
      })
    });
    const d = await r.json();
    return d.content?.[0]?.text || null;
  } catch(err) { console.error("Erro IA:", err.message); return null; }
}

// ─── Relatório Semanal ────────────────────────────────────────────────────────
async function getWeekEntries() {
  return (await pool.query("SELECT * FROM entries WHERE timestamp >= $1", [new Date(Date.now() - 7*24*60*60*1000)])).rows;
}

function buildWeekSummary(entries) {
  const f  = entries.filter(e => e.category==="finance");
  const x  = entries.filter(e => e.category==="exercise");
  const s  = entries.filter(e => e.category==="sleep");
  const m  = entries.filter(e => e.category==="mood");
  const fd = entries.filter(e => e.category==="food");
  const income  = f.filter(e => e.data.type==="income").reduce((a,e) => a+(e.data.amount||0), 0);
  const expense = f.filter(e => e.data.type==="expense").reduce((a,e) => a+(e.data.amount||0), 0);
  return {
    period:   { from: new Date(Date.now()-7*24*60*60*1000).toLocaleDateString("pt-BR"), to: new Date().toLocaleDateString("pt-BR") },
    finance:  { income, expense, balance: income-expense, transactions: f.length },
    exercise: { sessions: x.length, km: x.reduce((a,e) => a+(e.data.distance_km||0), 0).toFixed(1), minutes: x.reduce((a,e) => a+(e.data.duration_min||0), 0) },
    sleep:    { nights: s.length, avg_hours: s.length ? (s.reduce((a,e) => a+(e.data.hours||0), 0)/s.length).toFixed(1) : null },
    mood:     { records: m.length, avg_score: m.length ? (m.reduce((a,e) => a+(e.data.score||0), 0)/m.length).toFixed(1) : null },
    food:     { meals: fd.length, healthy: fd.filter(e => e.data.healthiness==="healthy").length },
    total_entries: entries.length,
  };
}

async function sendWeeklyReport() {
  if (wppStatus !== "ready") return;
  const entries = await getWeekEntries();
  if (!entries.length) return;
  const summary    = buildWeekSummary(entries);
  const aiInsights = process.env.ANTHROPIC_API_KEY ? await generateAIInsights(summary) : null;

  let report = `━━━━━━━━━━━━━━━━━━━━\n📋 *RELATÓRIO SEMANAL*\n${summary.period.from} → ${summary.period.to}\n━━━━━━━━━━━━━━━━━━━━\n\n💰 *FINANÇAS*\n• Receitas: +R$${summary.finance.income.toFixed(2)}\n• Gastos: -R$${summary.finance.expense.toFixed(2)}\n• ${summary.finance.balance>=0?"💚":"🔴"} Saldo: R$${summary.finance.balance.toFixed(2)}\n\n🏃 *ATIVIDADE*\n• ${summary.exercise.sessions} sessões · ${summary.exercise.km}km · ${summary.exercise.minutes}min\n\n😴 *SONO*\n• Média: ${summary.sleep.avg_hours||"—"}h · ${summary.sleep.nights} noites\n\n😊 *HUMOR*\n• Score médio: ${summary.mood.avg_score||"—"}/5\n\n🥗 *ALIMENTAÇÃO*\n• ${summary.food.meals} refeições · ${summary.food.healthy} saudáveis`;
  if (aiInsights) report += `\n\n💡 *INSIGHTS DA SEMANA*\n${aiInsights}`;
  report += `\n\n━━━━━━━━━━━━━━━━━━━━\n_${summary.total_entries} registros esta semana · Continue assim! 🚀_`;

  try {
    const chats      = await wppClient.getChats();
    const diaryGroup = chats.find(c => c.isGroup && c.name === "Diário Vivo");
    if (diaryGroup) { await diaryGroup.sendMessage(report); console.log("✅ Relatório semanal enviado!"); }
  } catch(err) { console.error("Erro relatório:", err.message); }
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
    setInterval(sendWeeklyReport, 7*24*60*60*1000);
  }, msUntil);
}

let diaryChat = null;
function scheduleAlerts() {
  setInterval(async () => {
    if (!diaryChat || wppStatus !== "ready") return;
    await checkAlertsAndNotify(diaryChat);
  }, 60*60*1000);
}

// ─── Parser de linguagem natural ─────────────────────────────────────────────
function parseMessage(text) {
  const lower  = text.toLowerCase().trim();
  const result = { category: "note", confidence: "low", data: {}, raw: text, timestamp: new Date().toISOString() };

  const exerciseWords = ["corri","corrida","caminhei","caminhada","treino","treinei","academia","musculação","yoga","pilates","bike","ciclismo","natação","pedalei","exercício","exercitei","cardio","hiit","crossfit"];
  const distMatch  = lower.match(/(\d+[\.,]?\d*)\s*km/);
  const minMatch   = lower.match(/(\d+)\s*(min|minutos?)/);
  const hourMatch  = lower.match(/(\d+[\.,]?\d*)\s*(h|hora)/);
  const stepsMatch = lower.match(/(\d+)\s*pass/);

  if (exerciseWords.some(w => lower.includes(w)) || distMatch || stepsMatch) {
    result.category   = "exercise";
    result.confidence = "high";
    const type = lower.includes("corri")||lower.includes("corrida") ? "running"
      : lower.includes("caminhei")||lower.includes("caminhada") ? "walking"
      : lower.includes("bike")||lower.includes("cicl")||lower.includes("pedal") ? "cycling"
      : lower.includes("nata") ? "swimming" : "gym";
    result.data = {
      type,
      distance_km:  distMatch  ? parseFloat(distMatch[1].replace(",","."))  : null,
      duration_min: minMatch   ? parseInt(minMatch[1]) : (hourMatch ? parseFloat(hourMatch[1])*60 : null),
      steps:        stepsMatch ? parseInt(stepsMatch[1]) : null,
      needs_map:    ["running","walking","cycling"].includes(type),
    };
    if (result.data.distance_km) result.data.calories_est = Math.round(result.data.distance_km*60);
    else if (result.data.duration_min) {
      const mets = { running:10, walking:4, cycling:7, gym:6, swimming:8 };
      result.data.calories_est = Math.round((result.data.duration_min/60)*(mets[type]||5)*70);
    }
  }

  const financeWords = ["gastei","paguei","comprei","recebi","ganhei","salário","investimento","poupança","dividendo","cobrança","transferi","depositei"];
  const moneyMatch   = text.match(/r?\$\s?(\d+[\.,]?\d*)/i) || text.match(/(\d+[\.,]?\d*)\s*reais/i);
  if (financeWords.some(w => lower.includes(w)) || moneyMatch) {
    result.category   = "finance";
    result.confidence = moneyMatch ? "high" : "medium";
    const isIncome    = /recebi|ganhei|salário|dividendo|depositei/.test(lower);
    const amount      = moneyMatch ? parseFloat(moneyMatch[1].replace(",",".")) : 0;
    const expenseCategory = lower.includes("mercad")||lower.includes("super") ? "alimentação"
      : lower.includes("uber")||lower.includes("combustível")||lower.includes("gasolina") ? "transporte"
      : lower.includes("conta")||lower.includes("boleto") ? "contas"
      : lower.includes("farmácia")||lower.includes("médico") ? "saúde"
      : lower.includes("academia")||lower.includes("lazer") ? "lazer" : "outros";
    result.data = { type: isIncome?"income":"expense", amount, expense_category: isIncome?null:expenseCategory, label: isIncome?"Receita":"Gasto" };
  }

  const sleepWords = ["dormi","acordei","sono","dormindo","insônia","pesadelo","descansado","cansado","sonolento"];
  const sleepHours = lower.match(/dormi\s+(\d+[\.,]?\d*)/)?.[1] || lower.match(/(\d+[\.,]?\d*)\s*(h|hora).*dorm/)?.[1];
  if (sleepWords.some(w => lower.includes(w))) {
    result.category   = "sleep";
    result.confidence = sleepHours ? "high" : "medium";
    const quality     = /bem|ótimo|excelente|descansad/.test(lower) ? "great" : /mal|ruim|pouco|cansad|insônia/.test(lower) ? "poor" : "ok";
    result.data       = { hours: sleepHours ? parseFloat(sleepHours.replace(",",".")) : 7, quality, quality_score: quality==="great"?5:quality==="ok"?3:1 };
  }

  const moodWords = ["feliz","triste","ansioso","ansiosa","animado","animada","estressado","estressada","relaxado","relaxada","motivado","motivada","desmotivado","irritado","grato","gratidão","deprimido"];
  if (moodWords.some(w => lower.includes(w))) {
    result.category   = "mood";
    result.confidence = "high";
    const score  = /feliz|animad|motivad|grat|eufóric/.test(lower) ? 4 : /relaxad|bem|tranquil/.test(lower) ? 2
      : /ansios|estressad/.test(lower) ? -2 : /triste|desmotivad|deprimid|irritad/.test(lower) ? -4 : 0;
    const label  = lower.includes("feliz")?"Feliz":lower.includes("ansios")?"Ansioso/a":lower.includes("motivad")?"Motivado/a":lower.includes("estressad")?"Estressado/a":lower.includes("triste")?"Triste":lower.includes("grat")?"Grato/a":lower.includes("relaxad")?"Relaxado/a":"Neutro";
    result.data  = { label, score, emotion: score>0?"positive":score<0?"negative":"neutral" };
  }

  const foodWords = ["comi","almocei","jantei","café da manhã","tomei café","lanch","dieta","jejum","água","hidratei"];
  if (foodWords.some(w => lower.includes(w))) {
    result.category   = "food";
    result.confidence = "high";
    const healthiness = /salada|fruta|verdura|proteína|saudável/.test(lower) ? "healthy"
      : /pizza|hamburguer|sorvete|doce|fritura/.test(lower) ? "indulgent" : "neutral";
    const waterMatch  = lower.match(/(\d+[\.,]?\d*)\s*(litros?|l)\s*(de\s+)?água/);
    result.data = {
      healthiness, health_score: healthiness==="healthy"?5:healthiness==="indulgent"?1:3,
      water_liters: waterMatch ? parseFloat(waterMatch[1].replace(",",".")) : null,
      meal: lower.includes("café")?"café da manhã":lower.includes("almoc")?"almoço":lower.includes("jant")?"jantar":lower.includes("lanch")?"lanche":"refeição",
    };
  }

  return result;
}

function generateBotResponse(parsed) {
  const { category, data } = parsed;
  if (category === "exercise") {
    const details = [data.distance_km?`${data.distance_km}km`:null, data.duration_min?`${data.duration_min} min`:null, data.calories_est?`~${data.calories_est} kcal`:null].filter(Boolean).join(" · ");
    return `✅ *Atividade registrada!*\n🏃 ${data.type==="running"?"Corrida":data.type==="walking"?"Caminhada":data.type==="cycling"?"Bike":"Treino"}${details?`\n📊 ${details}`:""}`;
  }
  if (category === "finance") return `✅ *Financeiro registrado!*\n${data.type==="income"?"💰":"💸"} ${data.label}: ${data.type==="income"?"+":"-"}R$${data.amount.toFixed(2)}${data.expense_category?`\n🏷️ ${data.expense_category}`:""}`;
  if (category === "sleep")   return `✅ *Sono registrado!*\n😴 ${data.hours}h · Qualidade: ${data.quality==="great"?"Ótima ✨":data.quality==="poor"?"Ruim 😓":"Ok"}`;
  if (category === "mood")    return `✅ *Humor registrado!*\n${data.emotion==="positive"?"😊":data.emotion==="negative"?"😔":"😐"} ${data.label} · Score: ${data.score>0?"+":""}${data.score}/5`;
  if (category === "food")    return `✅ *Refeição registrada!*\n🥗 ${data.meal}${data.water_liters?`\n💧 ${data.water_liters}L de água`:""}\n🌿 ${data.healthiness==="healthy"?"Saudável 👍":data.healthiness==="indulgent"?"Indulgente 😅":"Normal"}`;
  return `📝 *Anotado!*\n"${parsed.raw.substring(0,60)}"`;
}

// ─── WhatsApp Client (LocalAuth — estável no Railway Volume) ─────────────────
let wppStatus  = "disconnected";
let qrCodeData = null;

const wppClient = new Client({
  authStrategy: new LocalAuth({ dataPath: "/app/wpp-session" }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-gpu","--no-first-run","--no-zygote","--single-process"],
  }
});

wppClient.on("qr",            qr => { qrCodeData = qr; wppStatus = "qr_ready"; qrcode.generate(qr, { small: true }); console.log("\n📱 ESCANEIE O QR CODE!\n"); io.emit("wpp_status", { status: "qr_ready", qr }); });
wppClient.on("authenticated", () => { wppStatus = "authenticated"; qrCodeData = null; console.log("✅ WhatsApp autenticado!"); io.emit("wpp_status", { status: "authenticated" }); });
wppClient.on("ready",         () => { wppStatus = "ready"; console.log("🟢 WhatsApp pronto!"); io.emit("wpp_status", { status: "ready" }); scheduleAlerts(); });
wppClient.on("disconnected",  () => { wppStatus = "disconnected"; io.emit("wpp_status", { status: "disconnected" }); });

// ─── Detecção de intenção via IA ─────────────────────────────────────────────
async function detectIntent(text) {
  if (!process.env.ANTHROPIC_API_KEY) return { intent: "habit" };
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 100,
        messages: [{ role: "user", content: `Você é o classificador de intenções do DiárioVivo, um app de rastreamento de hábitos por WhatsApp.

Mensagem do usuário: "${text}"

Classifique em UMA categoria. Regras críticas:
- "goal_set" = qualquer mensagem que defina uma meta pessoal futura. Exemplos: "meta de dormir 8h", "/meta correr 21km até fim do mês", "minha meta é ganhar R$10000", "quero correr 20km essa semana", "objetivo: gastar menos de R$2000"
- "habit" = registrar algo que JÁ ACONTECEU ou está acontecendo AGORA. Exemplos: "corri 10km", "gastei R$100", "dormi 7h", "recebi meu salário"
- "insights" = pedir análise, resumo, relatório, dicas da IA. Exemplos: "me manda uma análise", "como tá minha semana?", "me dá insights", "análise dos meus hábitos"
- "report" = pedir relatório semanal/mensal formatado
- "goal_list" = listar metas ativas
- "goal_remove" = remover meta por número
- "alerts" = verificar alertas
- "help" = ajuda/comandos

ATENÇÃO: Se a mensagem usa futuro ("quero", "vou", "meta", "objetivo", "até o fim") = goal_set.
Se usa passado/presente ("corri", "gastei", "dormi", "fiz") = habit.

Responda APENAS JSON: {"intent": "categoria", "goalText": "descrição da meta SEM prefixos como /meta, meta:, objetivo: (só o conteúdo)", "goalRemoveN": numero_ou_null}` }]
      })
    });
    const d   = await r.json();
    const raw = d.content?.[0]?.text?.trim() || '{"intent":"habit"}';
    return JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch { return { intent: "habit" }; }
}

// ─── Handler principal do WhatsApp ────────────────────────────────────────────
wppClient.on("message_create", async (msg) => {
  // ✅ Filtros essenciais — evita loop e mensagens indesejadas
  if (msg.fromMe) return;
  if (msg.from === "status@broadcast") return;
  const botPrefixes = ["✅","📝","🎯","⚠️","🚨","━","🤖","📋","📖","💙","🎉","🏃","😴","💸","💰"];
  if (botPrefixes.some(p => msg.body.startsWith(p))) return;

  const chat = await msg.getChat();
  if (!chat.isGroup || chat.name !== "Diário Vivo") return;

  const text  = msg.body.trim();
  const lower = text.toLowerCase();
  console.log(`📨 [${new Date().toLocaleTimeString("pt-BR")}] "${text.substring(0,80)}"`);
  diaryChat = chat;

  // ── Detecta intent (palavras-chave diretas primeiro, IA para o resto)
  let intent      = "habit";
  let goalText    = null;
  let goalRemoveN = null;

  // ✅ Prefixo /meta ou "meta:" — sempre goal_set, sem chamar IA
  if (/^\/(meta|goal)\s+.+/i.test(lower) || /^meta[:\s]\s*.+/i.test(lower)) {
    intent   = "goal_set";
    goalText = text.replace(/^\/(meta|goal)\s+/i, "").replace(/^meta[:\s]\s*/i, "").trim();
  } else if (/^\/(metas|goals|help|ajuda|insights?|ia|alertas?|check|relat[oó]rio|report)$/i.test(lower)
      || /^(metas|ajuda|alertas?|insights?)$/i.test(lower)) {
    if (/metas|goals/.test(lower))         intent = "goal_list";
    else if (/help|ajuda/.test(lower))     intent = "help";
    else if (/insights?|ia$/.test(lower))  intent = "insights";
    else if (/alertas?|check/.test(lower)) intent = "alerts";
    else if (/relat|report/.test(lower))   intent = "report";
  } else if (/remover?\s+meta\s+\d+/i.test(lower)) {
    intent      = "goal_remove";
    goalRemoveN = parseInt(lower.match(/\d+/)[0]);
  } else {
    // ✅ BUG CORRIGIDO: intent agora recebe o valor retornado pela IA
    const detected = await detectIntent(text);
    intent         = detected.intent      || "habit";
    goalText       = detected.goalText    || text;
    goalRemoveN    = detected.goalRemoveN || null;
  }

  console.log(`🧠 Intent: ${intent}`);

  if (intent === "goal_list") {
    const goals = await loadGoals();
    if (!goals.length) { await chat.sendMessage("📋 Você ainda não tem metas cadastradas!\n\nExemplos:\n• _Minha meta é gastar até R$2000 esse mês_\n• _Quero correr 20km essa semana_\n• _Meta: dormir pelo menos 7h_"); return; }
    const list = goals.map((g,i) => `${i+1}. ${g.label} (${g.period==="month"?"mês":g.period==="week"?"semana":"diário"})`).join("\n");
    await chat.sendMessage(`🎯 *Suas metas ativas:*\n\n${list}\n\nPara remover: _remover meta 1_`);
    return;
  }
  if (intent === "goal_remove" && goalRemoveN) {
    const goals = await loadGoals(), idx = goalRemoveN-1;
    if (idx >= 0 && idx < goals.length) {
      await deleteGoal(goals[idx].id);
      await chat.sendMessage(`✅ Meta removida: _${goals[idx].label}_`);
      io.emit("goals_updated", await loadGoals());
    } else {
      await chat.sendMessage("❌ Número inválido. Use _metas_ para ver a lista.");
    }
    return;
  }
  if (intent === "insights") {
    await chat.sendMessage("🤖 Gerando seus insights personalizados... um momento!");
    const entries = await getWeekEntries();
    if (entries.length < 3) { await chat.sendMessage("📊 Ainda poucos dados esta semana. Registre mais hábitos e tente novamente!"); return; }
    const insights = await generateAIInsights(buildWeekSummary(entries));
    if (insights) await chat.sendMessage(`🤖 *Insights da semana*\n\n${insights}`);
    return;
  }
  if (intent === "alerts") { await checkAlertsAndNotify(chat); await chat.sendMessage("✅ Alertas verificados!"); return; }
  if (intent === "report") { await chat.sendMessage("📋 Gerando relatório..."); await sendWeeklyReport(); return; }
  if (intent === "help") {
    await chat.sendMessage(`📖 *DiárioVivo*\n\nEscreva naturalmente:\n• _"Corri 5km hoje"_\n• _"Gastei R$50 no mercado"_\n• _"Dormi 8h bem"_\n• _"Minha meta é gastar até R$2000 esse mês"_\n• _"Quero ver meus insights"_\n• _"Me manda o relatório"_\n\n💡 Relatório automático todo domingo às 20h!`);
    return;
  }
  if (intent === "goal_set") {
    const goal = parseGoal(goalText || text);
    if (goal) {
      const newGoal = { ...goal, id: Date.now() };
      await saveGoal(newGoal);
      await chat.sendMessage(`🎯 *Meta cadastrada!*\n✅ ${goal.label}\n📅 Período: ${goal.period==="month"?"Mensal":goal.period==="week"?"Semanal":"Diário"}\n\nVou te avisar quando se aproximar! 💪`);
      io.emit("goals_updated", await loadGoals());
    } else {
      await chat.sendMessage("🤔 Não entendi a meta. Tente:\n• *meta: gastar até R$2000 esse mês*\n• *meta: correr 20km essa semana*\n• *meta: dormir pelo menos 7h*\n• *meta: treinar 4 vezes na semana*");
    }
    return;
  }

  // ── Hábito normal
  const parsed = parseMessage(text);
  const entry  = { id: Date.now(), ...parsed };
  await saveEntry(entry);
  io.emit("new_entry", entry);
  await chat.sendMessage(generateBotResponse(parsed));
  console.log(`💾 [${parsed.category}] registrado`);
  setTimeout(() => checkAlertsAndNotify(chat), 2000);
});

// ─────────────────────────────────────────────────────────────────────────────
//  API REST (protegidas com requireAuth)
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/entries",               requireAuth, async (req, res) => { res.json(await loadEntries()); });
app.post("/api/entries",              requireAuth, writeLimiter, async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "text is required" });
  const parsed = parseMessage(text), entry = { id: Date.now(), ...parsed };
  await saveEntry(entry); io.emit("new_entry", entry); res.json(entry);
});
app.delete("/api/entries",            requireAuth, async (req, res) => {
  await pool.query("DELETE FROM entries"); io.emit("entries_cleared"); res.json({ ok: true });
});
app.patch("/api/entries/:id/route",   requireAuth, async (req, res) => {
  const data = await updateEntryRoute(req.params.id, req.body.route);
  if (!data) return res.status(404).json({ error: "Entry not found" });
  io.emit("entry_updated", { id: req.params.id, data }); res.json({ id: req.params.id, data });
});
app.get("/api/wpp/status",            (req, res) => res.json({ status: wppStatus, qr: qrCodeData }));
app.get("/api/stats",                 requireAuth, async (req, res) => {
  const entries = await loadEntries();
  const f = entries.filter(e => e.category==="finance");
  const x = entries.filter(e => e.category==="exercise");
  const s = entries.filter(e => e.category==="sleep");
  const m = entries.filter(e => e.category==="mood");
  res.json({
    totals: {
      entries:          entries.length,
      income:           f.filter(e => e.data.type==="income").reduce((a,e) => a+e.data.amount, 0),
      expense:          f.filter(e => e.data.type==="expense").reduce((a,e) => a+e.data.amount, 0),
      exercise_minutes: x.reduce((a,e) => a+(e.data.duration_min||0), 0),
      exercise_km:      x.reduce((a,e) => a+(e.data.distance_km||0), 0),
      avg_sleep:        s.length ? s.reduce((a,e) => a+e.data.hours, 0)/s.length : 0,
      mood_score:       m.length ? m.reduce((a,e) => a+e.data.score, 0)/m.length : 0,
    },
    recent: entries.slice(-20).reverse(),
  });
});
app.get("/api/goals",                 requireAuth, async (req, res) => { res.json(await loadGoals()); });
app.post("/api/goals",                requireAuth, writeLimiter, async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "text is required" });
  const goal = parseGoal(text);
  if (!goal) return res.status(400).json({ error: "Não entendi a meta. Tente: 'gastar até R$2000', 'correr 20km', 'dormir 7h'" });
  const newGoal = { ...goal, id: Date.now() };
  await saveGoal(newGoal); io.emit("goals_updated", await loadGoals()); res.json(newGoal);
});
app.delete("/api/goals/:id",          requireAuth, async (req, res) => {
  await deleteGoal(parseInt(req.params.id)); io.emit("goals_updated", await loadGoals()); res.json({ ok: true });
});
app.get("/api/goals/progress",        requireAuth, async (req, res) => {
  const goals = await loadGoals(), now = new Date();
  const startOfWeek  = new Date(now); startOfWeek.setDate(now.getDate() - now.getDay());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const progress = await Promise.all(goals.map(async goal => {
    const since  = goal.period==="month" ? startOfMonth : goal.period==="week" ? startOfWeek : new Date(new Date().setHours(0,0,0,0));
    const recent = (await pool.query("SELECT * FROM entries WHERE timestamp >= $1", [since])).rows;
    let current  = 0;
    if (goal.type==="finance_expense") current = recent.filter(e => e.category==="finance"&&e.data.type==="expense").reduce((a,e) => a+(e.data.amount||0), 0);
    if (goal.type==="finance_income")  current = recent.filter(e => e.category==="finance"&&e.data.type==="income").reduce((a,e) => a+(e.data.amount||0), 0);
    if (goal.type==="exercise_km")     current = recent.filter(e => e.category==="exercise").reduce((a,e) => a+(e.data.distance_km||0), 0);
    if (goal.type==="exercise_min")    current = recent.filter(e => e.category==="exercise").reduce((a,e) => a+(e.data.duration_min||0), 0);
    if (goal.type==="exercise_days")   current = new Set(recent.filter(e => e.category==="exercise").map(e => new Date(e.timestamp).toDateString())).size;
    if (goal.type==="sleep_hours")     { const sl = recent.filter(e => e.category==="sleep"); current = sl.length ? sl.reduce((a,e) => a+(e.data.hours||0), 0)/sl.length : 0; }
    return { ...goal, current: parseFloat(current.toFixed(2)), pct: Math.min(100, Math.round((current/goal.value)*100)) };
  }));
  res.json(progress);
});
app.post("/api/insights",             requireAuth, async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY não configurada" });
  const entries = await getWeekEntries();
  if (entries.length < 2) return res.json({ insights: "📊 Ainda não há dados suficientes. Registre mais hábitos esta semana!" });
  const insights = await generateAIInsights(buildWeekSummary(entries));
  res.json({ insights: insights || "Não foi possível gerar insights agora." });
});
app.post("/api/report/send",          requireAuth, async (req, res) => {
  await sendWeeklyReport(); res.json({ ok: true });
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on("connection", socket => {
  console.log("🌐 Frontend conectado");
  socket.emit("wpp_status", { status: wppStatus, qr: qrCodeData });
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  await initDB();

  function removeLocks(dir) {
    if (!fs.existsSync(dir)) return;
    try {
      fs.readdirSync(dir).forEach(item => {
        const full = path.join(dir, item);
        if (["SingletonLock","SingletonCookie","SingletonSocket","LOCK"].includes(item) || item.startsWith(".org.chromium")) {
          try { fs.unlinkSync(full); console.log(`🧹 Lock removido: ${full}`); } catch {}
        } else {
          try { if (fs.statSync(full).isDirectory()) removeLocks(full); } catch {}
        }
      });
    } catch {}
  }
  removeLocks("/app/wpp-session");
  console.log("🧹 Limpeza de locks concluída");

  server.listen(PORT, () => {
    console.log(`\n🚀 DiárioVivo v3 rodando na porta ${PORT}`);
    console.log(`📡 API: http://localhost:${PORT}/api`);
    wppClient.initialize();
    scheduleWeeklyReport();
  });
}

start().catch(console.error);
