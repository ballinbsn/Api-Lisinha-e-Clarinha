import "dotenv/config";
import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";

import { ensureSchema } from "./lib/db.js";
import pixRouter from "./routes/pix.js";
import webhookRouter from "./routes/webhook.js";

const app = express();
app.disable("x-powered-by");

const allowedOrigins = (process.env.FRONTEND_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

class CorsOriginError extends Error {}

app.use(
  cors({
    origin(origin, callback) {
      // Sem Origin = chamada servidor-a-servidor (curl, health check) — permite.
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new CorsOriginError(`Origem não autorizada: ${origin}`));
    },
  })
);

app.use((err, req, res, next) => {
  if (err instanceof CorsOriginError) {
    return res.status(403).json({ error: "forbidden_origin" });
  }
  next(err);
});

// Precisa vir ANTES do express.json(): o webhook exige o corpo cru para
// validar a assinatura HMAC (ver src/routes/webhook.js).
app.use("/api/webhooks", webhookRouter);

app.use(express.json({ limit: "256kb" }));

app.use((req, res, next) => {
  req.requestId = randomUUID();
  next();
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/api/pix", pixRouter);

app.use((req, res) => {
  res.status(404).json({ error: "not_found" });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("unhandled_error", { message: err.message, requestId: req.requestId });
  res.status(500).json({ error: "internal", request_id: req.requestId });
});

const port = process.env.PORT || 8080;

ensureSchema()
  .then(() => {
    app.listen(port, () => {
      console.log(`popozuda-pinpay-api ouvindo na porta ${port}`);
    });
  })
  .catch((err) => {
    console.error("falha ao preparar o banco de dados", err);
    process.exit(1);
  });
