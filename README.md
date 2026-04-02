# ⚡ Email Hunter SMTP Pro
Validação de e-mail gratuita e ilimitada via SMTP ping próprio.

## Como funciona

```
1. MX Lookup  →  busca o servidor de e-mail do domínio via DNS
2. Catch-all  →  testa um e-mail falso para ver se o servidor aceita tudo
3. SMTP Ping  →  conecta no servidor e pergunta "RCPT TO: <email>" sem enviar nada
4. Resultado  →  250 OK = Válido | 550 = Inválido | catch-all/timeout = Arriscado
```

## Rodar localmente

```bash
npm install
cp .env.example .env
npm start
# Acesse http://localhost:3000
```

## Deploy no Render (recomendado — IP fixo limpo)

1. Suba o projeto para o GitHub
2. Crie conta em https://render.com
3. New → Web Service → conecte o repositório
4. Configure:
   - Build Command: `npm install`
   - Start Command:  `npm start`
   - Variáveis de ambiente: copie do `.env.example`
5. Deploy automático ✅

## Deploy no Railway

```bash
npm install -g @railway/cli
railway login
railway init
railway up
railway variables set HELO_DOMAIN=mail.seudominio.com.br
railway variables set FROM_EMAIL=verify@seudominio.com.br
railway variables set SMTP_CONCURRENCY=3
```

## ⚠ Limitações do SMTP ping

| Provedor | SMTP Verificável? |
|---|---|
| Empresas (yamaha.com, bosal.com, etc.) | ✅ Sim |
| Gmail, Outlook, Yahoo | ❌ Bloqueiam — retorna "Arriscado" |
| Protonmail, iCloud | ❌ Bloqueiam |

Para listas B2B (empresas), a taxa de acerto é de **85-95%**.

## Estrutura

```
email-hunter-smtp/
├── src/
│   ├── server.js          # Express + SSE para progresso em tempo real
│   └── smtp-validator.js  # Core: MX lookup + catch-all + SMTP ping
├── public/
│   └── index.html         # Frontend completo
├── .env.example
└── package.json
```
