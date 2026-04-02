require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const multer    = require("multer");
const XLSX      = require("xlsx");
const rateLimit = require("express-rate-limit");
const path      = require("path");
const { validateEmail, validateBatch, getMxRecords } = require("./smtp-validator");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ───────────────────────────────────────────────────
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "../public")));

const limiter = rateLimit({ windowMs: 60_000, max: 120 });
app.use("/api/", limiter);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Helpers ──────────────────────────────────────────────────────
function norm(str) {
  return (str || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9._-]/g, "");
}
function parseName(name) {
  const p = (name || "").trim().split(/\s+/);
  return { first: norm(p[0] || "x"), last: norm(p[p.length - 1] || "x") };
}
function getDomain(raw) {
  if (!raw) return "";
  raw = raw.trim();
  try {
    if (!raw.includes("://")) raw = "https://" + raw;
    return new URL(raw).hostname.replace(/^www\./, "");
  } catch { return norm(raw); }
}

const PATTERNS = [
  { label: "nome.sobrenome",  fn: (f,l) => `${f}.${l}`,    conf: 92 },
  { label: "n.sobrenome",     fn: (f,l) => `${f[0]}.${l}`, conf: 85 },
  { label: "nome",            fn: (f,l) => f,               conf: 72 },
  { label: "nome_sobrenome",  fn: (f,l) => `${f}_${l}`,    conf: 68 },
  { label: "nomesobrenome",   fn: (f,l) => `${f}${l}`,     conf: 64 },
  { label: "sobrenome.nome",  fn: (f,l) => `${l}.${f}`,    conf: 60 },
  { label: "nsobrenome",      fn: (f,l) => `${f[0]}${l}`,  conf: 55 },
  { label: "sobrenome",       fn: (f,l) => l,               conf: 48 },
  { label: "nome.s",          fn: (f,l) => `${f}.${l[0]}`, conf: 42 },
];

function genVariants(name, domain) {
  const { first, last } = parseName(name);
  return PATTERNS.map(p => ({
    email: `${p.fn(first, last)}@${domain}`,
    pattern: p.label,
    conf: p.conf,
  }));
}

function parseRows(rows) {
  if (!rows || rows.length < 2) return [];
  const header = rows[0].map(h => norm(String(h || "")));
  const idx = field => {
    const alts = {
      nome:    ["nome","name","fullname","nomecompleto","contato"],
      cargo:   ["cargo","role","position","title","funcao"],
      empresa: ["empresa","company","organizacao","org"],
      dominio: ["dominio","domain","site","website","url","email_domain"],
    };
    for (const k of alts[field]) {
      const i = header.findIndex(h => h.includes(k));
      if (i >= 0) return i;
    }
    return -1;
  };
  const ni = idx("nome"), ci = idx("cargo"), ei = idx("empresa"), di = idx("dominio");
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row  = rows[r];
    const name = String(row[ni] || "").trim();
    const dom  = getDomain(String(row[di] || "").trim());
    if (!name || !dom) continue;
    out.push({
      name,
      cargo:   String(row[ci] || "").trim(),
      empresa: String(row[ei] || "").trim(),
      domain:  dom,
      variants: genVariants(name, dom),
    });
  }
  return out;
}

// ── SSE helper (Server-Sent Events para progresso em tempo real) ─
function sseSetup(res) {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();
  return (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

// ── Routes ───────────────────────────────────────────────────────

app.get("/api/health", (req, res) => {
  res.json({ ok: true, mode: "smtp-own", version: "2.0.0" });
});

// Upload + parse
app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Nenhum arquivo enviado." });
  try {
    const ext = req.file.originalname.split(".").pop().toLowerCase();
    let rows;
    if (ext === "csv" || ext === "txt") {
      const text  = req.file.buffer.toString("utf8");
      const delim = text.includes("\t") ? "\t" : ",";
      rows = text.trim().split(/\r?\n/).map(l => l.split(delim).map(c => c.replace(/^"|"$/g, "")));
    } else {
      const wb = XLSX.read(req.file.buffer, { type: "buffer" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
    }
    const contacts = parseRows(rows);
    if (!contacts.length) return res.status(422).json({ error: "Nenhum contato válido. Verifique as colunas: Nome, Cargo, Empresa, Domínio" });
    res.json({ contacts, total: contacts.length });
  } catch (err) {
    res.status(500).json({ error: "Erro ao processar: " + err.message });
  }
});

// Validação única
app.post("/api/validate", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "E-mail obrigatório." });
  try {
    const result = await validateEmail(email);
    res.json({ email, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// MX check rápido
app.post("/api/mx-check", async (req, res) => {
  const { domain } = req.body;
  if (!domain) return res.status(400).json({ error: "Domínio obrigatório." });
  const records = await getMxRecords(domain);
  res.json({ domain, hasMx: !!records && records.length > 0, records: records || [] });
});

// ── Validação em lote com progresso via SSE ──────────────────────
// GET /api/validate-stream?emails=a@b.com,c@d.com
// O cliente abre um EventSource para receber updates em tempo real
app.get("/api/validate-stream", async (req, res) => {
  const emailsRaw = req.query.emails || "";
  const emails = emailsRaw.split(",").map(e => e.trim()).filter(Boolean);

  if (!emails.length) {
    res.status(400).json({ error: "Nenhum e-mail." });
    return;
  }

  const send = sseSetup(res);
  send("start", { total: emails.length });

  const results = [];
  const CONCURRENCY = parseInt(process.env.SMTP_CONCURRENCY || "3");

  for (let i = 0; i < emails.length; i += CONCURRENCY) {
    const chunk = emails.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(chunk.map(e => validateEmail(e)));

    settled.forEach((r, j) => {
      const item = { email: chunk[j], index: i + j, ...r };
      results.push(item);
      // Envia cada resultado individualmente para o frontend atualizar em tempo real
      send("result", item);
    });

    send("progress", {
      done: Math.min(i + CONCURRENCY, emails.length),
      total: emails.length,
      pct: Math.round((Math.min(i + CONCURRENCY, emails.length) / emails.length) * 100),
    });

    if (i + CONCURRENCY < emails.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // Resumo final
  const summary = {
    total:   results.length,
    valid:   results.filter(r => r.status === "valid").length,
    risky:   results.filter(r => r.status === "risky").length,
    invalid: results.filter(r => r.status === "invalid").length,
  };
  send("done", { summary, results });
  res.end();
});

// Catch-all → serve frontend
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "../public/index.html")));

app.listen(PORT, () => {
  console.log(`\n⚡ Email Hunter SMTP Pro`);
  console.log(`   Rodando em: http://localhost:${PORT}`);
  console.log(`   Modo: SMTP ping próprio (gratuito, ilimitado)`);
  console.log(`   HELO domain: ${process.env.HELO_DOMAIN || "validator.local"}`);
  console.log(`   Concorrência: ${process.env.SMTP_CONCURRENCY || 3} conexões simultâneas\n`);
});
