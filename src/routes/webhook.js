import { Router } from "express";
import express from "express";
import crypto from "node:crypto";
import { pool } from "../lib/db.js";

const router = Router();

// A PinPay assina o corpo cru com HMAC-SHA256 usando o Signing Secret
// deste webhook (whsec_...). Por isso este endpoint usa express.raw em
// vez do express.json global do server.js — precisamos dos bytes exatos
// que a PinPay assinou, antes de qualquer parse.
router.post(
  "/pinpay",
  express.raw({ type: "application/json", limit: "256kb" }),
  async (req, res) => {
    const secret = process.env.PINPAY_WEBHOOK_SECRET;
    if (!secret || secret.startsWith("INSERIR_")) {
      console.error("webhook_secret_not_configured");
      return res.status(503).end();
    }

    const signatureHeader = req.headers["x-webhook-signature"];
    if (!signatureHeader) return res.status(401).end();

    const expected =
      "sha256=" +
      crypto.createHmac("sha256", secret).update(req.body).digest("hex");

    const received = Buffer.from(String(signatureHeader));
    const expectedBuf = Buffer.from(expected);
    const valid =
      received.length === expectedBuf.length &&
      crypto.timingSafeEqual(received, expectedBuf);

    if (!valid) {
      console.error("webhook_invalid_signature");
      return res.status(401).end();
    }

    let payload;
    try {
      payload = JSON.parse(req.body.toString("utf8"));
    } catch {
      return res.status(400).end();
    }

    const { event, data } = payload || {};
    const txId = data?.transaction_id;

    // Cada branch abaixo é um UPDATE por status — reaplicar o mesmo
    // evento duas vezes (reentrega da PinPay) é inofensivo, então não
    // precisamos de uma tabela extra de deduplicação para este volume.
    try {
      switch (event) {
        case "payment_approved":
          await pool.query(
            `UPDATE orders SET status = 'paid', updated_at = now() WHERE pinpay_transaction_id = $1`,
            [txId]
          );
          break;
        case "pix_received":
          await pool.query(
            `UPDATE orders SET status = 'paid', payer_bank = $2, updated_at = now() WHERE pinpay_transaction_id = $1`,
            [txId, data?.payer_bank || null]
          );
          break;
        case "payment_failed":
          await pool.query(
            `UPDATE orders SET status = $2, updated_at = now() WHERE pinpay_transaction_id = $1`,
            [txId, data?.status || "failed"]
          );
          break;
        case "payment_refunded":
          await pool.query(
            `UPDATE orders SET status = 'refunded', updated_at = now() WHERE pinpay_transaction_id = $1`,
            [txId]
          );
          break;
        case "payment_pending":
          break; // já criamos o pedido como 'pending' na criação do PIX
        default:
          console.log("webhook_evento_nao_tratado", event);
      }
    } catch (err) {
      console.error("webhook_processing_error", { event, txId, message: err.message });
      return res.status(500).end(); // PinPay reenvia em caso de 5xx
    }

    res.status(200).end();
  }
);

export default router;
