import { Router } from "express";
import { randomUUID } from "node:crypto";
import { pool } from "../lib/db.js";
import { createPixCharge } from "../lib/pinpay.js";

const router = Router();

const CPF_RE = /^\d{11}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Preço e nome de cada kit ficam fixados no servidor — o cliente nunca
// manda o valor a cobrar. Ajuste aqui se os preços da campanha mudarem.
const KITS = {
  kit1: { name: "Kit Inicial 1 + 1 (1 Lisinha + 1 Clarinha)", amount: 5990 },
  kit3: { name: "Kit 3 + 3 (3 Lisinha + 3 Clarinha)", amount: 11990 },
  kit5: { name: "Kit 5 + 5 (5 Lisinha + 5 Clarinha)", amount: 17990 },
};

function badRequest(res, field, message) {
  return res.status(400).json({ error: "validation_error", field, message });
}

// POST /api/pix — cria uma cobrança PIX para um dos 3 kits.
router.post("/", async (req, res) => {
  const { kit, name, email, document, phone } = req.body || {};

  const kitInfo = KITS[kit];
  if (!kitInfo) return badRequest(res, "kit", "Kit inválido.");
  if (!name || String(name).trim().length < 3) {
    return badRequest(res, "name", "Informe o nome completo.");
  }
  if (!EMAIL_RE.test(String(email || ""))) {
    return badRequest(res, "email", "E-mail inválido.");
  }
  const cpf = String(document || "").replace(/\D/g, "");
  if (!CPF_RE.test(cpf)) {
    return badRequest(res, "document", "CPF inválido (11 dígitos, apenas números).");
  }
  const phoneDigits = String(phone || "").replace(/\D/g, "");

  const orderId = randomUUID();
  const webhookUrl = process.env.PUBLIC_URL
    ? `${process.env.PUBLIC_URL.replace(/\/$/, "")}/api/webhooks/pinpay`
    : undefined;

  try {
    await pool.query(
      `INSERT INTO orders
         (id, kit_key, kit_name, amount_cents, customer_name, customer_email, customer_document, customer_phone, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'creating')`,
      [orderId, kit, kitInfo.name, kitInfo.amount, name, email, cpf, phoneDigits || null]
    );
  } catch (err) {
    console.error("pix_order_insert_failed", { orderId, message: err.message });
    return res.status(500).json({ error: "internal", message: "Erro ao registrar pedido." });
  }

  let charge;
  try {
    charge = await createPixCharge({
      idempotencyKey: orderId,
      amount: kitInfo.amount,
      description: `Popozuda — ${kitInfo.name}`,
      customer: {
        name,
        email,
        document: { type: "CPF", number: cpf },
        phone: phoneDigits || undefined,
      },
      webhookUrl,
      // external_reference e checkout_url sao exigidos pela PinPay de verdade
      // (validado em producao via 422 missing_metadata), mesmo nao constando
      // no guia inicial. checkout_url cai pra PUBLIC_URL se CHECKOUT_URL nao
      // estiver definida ainda -- troque para o dominio real do site assim
      // que ele estiver publicado (ver README).
      metadata: {
        external_reference: orderId,
        order_id: orderId,
        kit,
        checkout_url:
          process.env.CHECKOUT_URL || process.env.PUBLIC_URL || "https://popozuda.com.br",
      },
    });
  } catch (err) {
    const notConfigured = err.code === "PINPAY_NOT_CONFIGURED";
    await pool
      .query(`UPDATE orders SET status = 'failed', updated_at = now() WHERE id = $1`, [orderId])
      .catch(() => {});
    console.error("pinpay_pix_failed", {
      orderId,
      message: err.message,
      status: err.status,
      body: err.body,
    });
    return res.status(notConfigured ? 503 : 502).json({
      error: notConfigured ? "gateway_not_configured" : "gateway_error",
      message: notConfigured
        ? "Pagamento ainda não configurado neste servidor (PINPAY_TOKEN ausente)."
        : "Não foi possível gerar o PIX agora. Tente novamente em instantes.",
    });
  }

  // TEMP DEBUG: os nomes de campo do guia inicial (qr_code/qr_code_url) nao
  // batem com a resposta real da PinPay -- log temporario para descobrir os
  // nomes corretos, remover depois de confirmado.
  console.log("pinpay_charge_response_debug", JSON.stringify(charge));

  await pool.query(
    `UPDATE orders
        SET pinpay_transaction_id = $1, status = $2, qr_code = $3, qr_code_url = $4, expires_at = $5, updated_at = now()
      WHERE id = $6`,
    [
      charge.id,
      charge.status || "pending",
      charge.qr_code,
      charge.qr_code_url,
      charge.expires_at,
      orderId,
    ]
  );

  res.status(201).json({
    order_id: orderId,
    status: charge.status || "pending",
    qr_code: charge.qr_code,
    qr_code_url: charge.qr_code_url,
    expires_at: charge.expires_at,
    amount: kitInfo.amount,
  });
});

// GET /api/pix/:orderId/status — usado pelo frontend em polling leve
// enquanto o modal de pagamento está aberto.
router.get("/:orderId/status", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT status, kit_name, amount_cents FROM orders WHERE id = $1`,
      [req.params.orderId]
    );
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    res.json({
      status: rows[0].status,
      kit_name: rows[0].kit_name,
      amount: rows[0].amount_cents,
    });
  } catch (err) {
    console.error("pix_status_exception", err);
    res.status(500).json({ error: "internal" });
  }
});

export default router;
