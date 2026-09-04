# popozuda-pinpay-api

Backend do checkout PIX (PinPay) do Kit Popozuda Lisinha + Clarinha. Recebe o
pedido do site estático, gera a cobrança PIX na PinPay, guarda o pedido no
Postgres e escuta o webhook da PinPay pra marcar o pagamento como confirmado.

Feito para rodar no **Railway** (API + Postgres) e ser chamado pelo site
estático (Vercel) do projeto `lisinha`, que fica numa pasta irmã a esta.

## Como funciona

```
[Landing page]  --POST /api/pix-->  [Esta API]  --POST /pix-->  [PinPay]
      |                                  |                          |
      |<--QR code + copia-e-cola---------|                          |
      |                                  |<--POST /api/webhooks/pinpay (assinado)
      |--GET /api/pix/:id/status (poll)->|
```

- `POST /api/pix` — valida os dados do cliente, cria o pedido no banco com
  status `creating`, chama a PinPay e devolve `order_id` + QR code. Preço e
  nome de cada kit ficam fixos no servidor (`src/routes/pix.js`) — o
  navegador nunca manda o valor a cobrar.
- `GET /api/pix/:orderId/status` — usado pela landing page em polling leve
  enquanto o modal de pagamento está aberto.
- `POST /api/webhooks/pinpay` — recebe a confirmação da PinPay, valida a
  assinatura HMAC (`X-Webhook-Signature`) com `PINPAY_WEBHOOK_SECRET` e
  atualiza o status do pedido (`paid`, `failed`, `expired`, `refunded`).

Testado localmente com um Postgres em memória (pg-mem) e um stub da API da
PinPay: criação de pedido, validações, assinatura do webhook (correta,
errada e ausente) e atualização de status via webhook — todos os caminhos
passaram antes deste código ser considerado pronto.

## Rodando localmente

Requisitos: Node 20+, um Postgres (local ou um serviço gratuito qualquer).

```bash
npm install
cp .env.example .env
# edite o .env com sua DATABASE_URL local
npm run dev
```

`GET /health` deve responder `{"ok":true}`. Sem `PINPAY_TOKEN` configurado,
`POST /api/pix` responde `503 gateway_not_configured` de propósito — é o
mesmo padrão de "placeholder claro" usado no site estático, pra nunca
navegar/cobrar com uma integração pela metade.

## Deploy no Railway

1. Suba esta pasta como um repositório próprio no GitHub (`git init`, commit,
   `git remote add origin ...`, `git push`). Não é a mesma repo do site.
2. No Railway: **New Project → Deploy from GitHub repo** apontando pra esse
   repositório.
3. **Add a plugin → Postgres** no mesmo projeto Railway. Ele injeta
   `DATABASE_URL` automaticamente no serviço da API — não precisa configurar
   nada manualmente.
4. Em **Variables** do serviço da API, defina:
   - `PINPAY_TOKEN` — sua **Secret Key** (`sk_live_...`) da PinPay.
   - `PINPAY_WEBHOOK_SECRET` — o **Signing Secret** (`whsec_...`) do webhook
     que você vai cadastrar no passo 6.
   - `PUBLIC_URL` — a URL pública que o Railway vai gerar pra este serviço
     (você pode implantar uma vez, copiar a URL gerada em Settings →
     Networking, e então voltar aqui e preencher).
   - **Nunca** cole essas chaves em arquivo, commit ou chat — só no painel do
     Railway.
5. Deploy. Confirme `https://SEU-BACKEND.up.railway.app/health`.
6. No painel da PinPay, cadastre o webhook apontando para
   `https://SEU-BACKEND.up.railway.app/api/webhooks/pinpay` e copie o
   Signing Secret gerado para `PINPAY_WEBHOOK_SECRET` (passo 4).
7. No projeto do site (`lisinha`), defina `API_BASE` em `js/main.js` com essa
   mesma URL do Railway (veja o README do site).

## Variáveis de ambiente

| Nome | Obrigatória | Descrição |
|---|---|---|
| `DATABASE_URL` | sim | Injetada pelo plugin Postgres do Railway |
| `PINPAY_TOKEN` | sim (pra cobrar de verdade) | Secret Key da PinPay (`sk_live_...`) |
| `PINPAY_WEBHOOK_SECRET` | sim (pra confirmar pagamento) | Signing Secret do webhook (`whsec_...`) |
| `PUBLIC_URL` | recomendada | URL pública deste serviço, usada para montar `webhook_url` |
| `PORT` | não | Railway define sozinho |

## Segurança

- **CORS está aberto de propósito** (sem allowlist de origem) — decisão
  explícita pra simplificar o deploy. Isso deixa `POST /api/pix` chamável
  por qualquer site, o que na pior hipótese gera pedidos "fantasma" no
  banco (nenhum dinheiro se move por causa disso: quem paga de verdade é o
  cliente, autenticado no app do próprio banco dele). Se um dia quiser
  reduzir esse abuso, reintroduza uma checagem de `Origin` em
  `src/server.js`.
- Preço e nome de cada kit são fixos no servidor; o payload do cliente só
  informa qual kit (`kit1`/`kit3`/`kit5`) e os dados do comprador.
- Webhook exige assinatura HMAC-SHA256 válida (comparação constant-time);
  sem isso, ou com o segredo ainda não configurado, retorna 401/503 e não
  altera nenhum pedido.
- `sk_live_...` e `whsec_...` só existem como variável de ambiente no
  Railway — nunca em arquivo versionado.
