/**
 * smtp-validator.js
 * Validação real de e-mail via DNS MX + SMTP ping
 * Gratuito, ilimitado, sem API externa
 */

const dns = require("dns").promises;
const net = require("net");

// ── Config ───────────────────────────────────────────────────────
const SMTP_TIMEOUT   = 8000;   // ms por operação
const CONNECT_TIMEOUT = 5000;  // ms para conectar
const HELO_DOMAIN    = process.env.HELO_DOMAIN || "validator.local";
const FROM_EMAIL     = process.env.FROM_EMAIL  || "verify@validator.local";

// Domínios que bloqueiam SMTP ping (retornam catch-all ou timeout proposital)
const KNOWN_CATCHALL = [
  "gmail.com","googlemail.com","yahoo.com","yahoo.com.br",
  "hotmail.com","outlook.com","live.com","msn.com",
  "icloud.com","me.com","mac.com",
  "protonmail.com","proton.me",
  "aol.com","yandex.com","yandex.ru",
];

// Domínios que sempre bloqueiam verificação SMTP
const BLOCK_SMTP = [
  "gmail.com","googlemail.com","yahoo.com","yahoo.com.br",
  "hotmail.com","outlook.com","live.com","msn.com",
];

// ── DNS: busca MX records ────────────────────────────────────────
async function getMxRecords(domain) {
  try {
    const records = await dns.resolveMx(domain);
    if (!records || records.length === 0) return null;
    // Ordena por prioridade (menor = mais prioritário)
    return records.sort((a, b) => a.priority - b.priority);
  } catch (err) {
    return null;
  }
}

// ── SMTP ping via TCP ────────────────────────────────────────────
function smtpPing(mxHost, email) {
  return new Promise((resolve) => {
    const log = [];
    let resolved = false;
    let socket = null;

    const done = (result) => {
      if (resolved) return;
      resolved = true;
      if (socket) { try { socket.destroy(); } catch {} }
      resolve({ ...result, log });
    };

    const timeout = setTimeout(() => {
      done({ status: "risky", subStatus: "timeout", detail: "SMTP timeout" });
    }, SMTP_TIMEOUT);

    try {
      socket = net.createConnection({ host: mxHost, port: 25, timeout: CONNECT_TIMEOUT });

      let step = 0;
      let buffer = "";

      socket.on("connect", () => log.push(`→ Conectado em ${mxHost}:25`));

      socket.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\r\n");
        buffer = lines.pop(); // mantém linha incompleta

        for (const line of lines) {
          if (!line) continue;
          log.push(`← ${line}`);
          const code = parseInt(line.substring(0, 3));

          if (step === 0 && code === 220) {
            // Banner recebido → EHLO
            step = 1;
            const cmd = `EHLO ${HELO_DOMAIN}\r\n`;
            log.push(`→ ${cmd.trim()}`);
            socket.write(cmd);

          } else if (step === 1 && (code === 250 || code === 220)) {
            // EHLO aceito → MAIL FROM
            if (line.endsWith("250") || line.startsWith("250 ")) {
              step = 2;
              const cmd = `MAIL FROM:<${FROM_EMAIL}>\r\n`;
              log.push(`→ ${cmd.trim()}`);
              socket.write(cmd);
            }

          } else if (step === 2 && code === 250) {
            // MAIL FROM aceito → RCPT TO
            step = 3;
            const cmd = `RCPT TO:<${email}>\r\n`;
            log.push(`→ ${cmd.trim()}`);
            socket.write(cmd);

          } else if (step === 3) {
            clearTimeout(timeout);
            // Analisa resposta do RCPT TO
            if (code === 250 || code === 251) {
              done({ status: "valid", subStatus: "smtp_ok", detail: line });
            } else if (code === 550 || code === 551 || code === 553 || code === 554) {
              done({ status: "invalid", subStatus: "mailbox_not_found", detail: line });
            } else if (code === 421 || code === 450 || code === 451 || code === 452) {
              done({ status: "risky", subStatus: "temporarily_unavailable", detail: line });
            } else if (code === 550 && line.toLowerCase().includes("spam")) {
              done({ status: "risky", subStatus: "spam_block", detail: line });
            } else {
              done({ status: "risky", subStatus: `smtp_${code}`, detail: line });
            }
            // Fecha conexão educadamente
            try { socket.write("QUIT\r\n"); } catch {}

          } else if (code === 421 || code === 554) {
            clearTimeout(timeout);
            done({ status: "risky", subStatus: "server_reject", detail: line });
          }
        }
      });

      socket.on("error", (err) => {
        clearTimeout(timeout);
        done({ status: "risky", subStatus: "connection_error", detail: err.message });
      });

      socket.on("timeout", () => {
        clearTimeout(timeout);
        done({ status: "risky", subStatus: "timeout", detail: "TCP timeout" });
      });

      socket.on("close", () => {
        clearTimeout(timeout);
        if (!resolved) done({ status: "risky", subStatus: "connection_closed", detail: "Conexão fechada antes da resposta" });
      });

    } catch (err) {
      clearTimeout(timeout);
      done({ status: "risky", subStatus: "error", detail: err.message });
    }
  });
}

// ── Catch-all detection ──────────────────────────────────────────
async function detectCatchAll(mxHost, domain) {
  // Testa um e-mail obviamente inexistente
  const fake = `catchall-test-${Date.now()}@${domain}`;
  const result = await smtpPing(mxHost, fake);
  return result.status === "valid"; // se aceitar qualquer coisa = catch-all
}

// ── Validação completa ───────────────────────────────────────────
async function validateEmail(email) {
  email = email.trim().toLowerCase();

  // 1. Sintaxe básica
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { status: "invalid", subStatus: "invalid_syntax", mxFound: false, catchAll: false, log: [] };
  }

  const domain = email.split("@")[1];

  // 2. Domínios que bloqueiam SMTP — retorna "risky" imediatamente
  if (BLOCK_SMTP.includes(domain)) {
    return {
      status: "risky",
      subStatus: "free_provider",
      mxFound: true,
      catchAll: false,
      detail: "Provedor gratuito — SMTP bloqueado",
      log: [`ℹ Domínio ${domain} bloqueia verificação SMTP`],
    };
  }

  // 3. MX lookup
  const mxRecords = await getMxRecords(domain);
  if (!mxRecords || mxRecords.length === 0) {
    return { status: "invalid", subStatus: "no_mx_record", mxFound: false, catchAll: false, log: [`✗ Nenhum MX record para ${domain}`] };
  }

  const primaryMx = mxRecords[0].exchange;

  // 4. Catch-all check (antes do ping real)
  let catchAll = false;
  if (!KNOWN_CATCHALL.includes(domain)) {
    try {
      catchAll = await detectCatchAll(primaryMx, domain);
    } catch { catchAll = false; }
  }

  if (catchAll) {
    return {
      status: "risky",
      subStatus: "catch_all",
      mxFound: true,
      catchAll: true,
      mxHost: primaryMx,
      detail: "Servidor aceita qualquer e-mail (catch-all)",
      log: [`⚠ Catch-all detectado em ${primaryMx}`],
    };
  }

  // 5. SMTP ping real
  const result = await smtpPing(primaryMx, email);

  return {
    ...result,
    mxFound: true,
    catchAll: false,
    mxHost: primaryMx,
    mxRecords: mxRecords.map(m => `${m.priority} ${m.exchange}`),
  };
}

// ── Batch com concorrência controlada ───────────────────────────
async function validateBatch(emails, concurrency = 3, onProgress = null) {
  const results = [];
  for (let i = 0; i < emails.length; i += concurrency) {
    const chunk = emails.slice(i, i + concurrency);
    const settled = await Promise.all(chunk.map(e => validateEmail(e)));
    settled.forEach((r, j) => results.push({ email: chunk[j], ...r }));
    if (onProgress) onProgress(Math.min(i + concurrency, emails.length), emails.length);
    // Pausa entre batches para não ser bloqueado por rate limiting dos servidores
    if (i + concurrency < emails.length) await new Promise(r => setTimeout(r, 300));
  }
  return results;
}

module.exports = { validateEmail, validateBatch, getMxRecords };
