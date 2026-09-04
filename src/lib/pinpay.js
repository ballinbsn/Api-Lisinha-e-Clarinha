const BASE_URL = "https://api.usepinpay.com/functions/v1/api-v1";

function requireToken() {
  const token = process.env.PINPAY_TOKEN;
  if (!token || token.startsWith("INSERIR_")) {
    const err = new Error("PINPAY_TOKEN não configurado no ambiente");
    err.code = "PINPAY_NOT_CONFIGURED";
    throw err;
  }
  return token;
}

/**
 * Cria uma cobrança PIX na PinPay.
 * A Idempotency-Key deve ser o id do pedido gerado por nós: reenviar a
 * mesma chave (ex. retry de rede) devolve a mesma cobrança em vez de
 * cobrar duas vezes.
 */
export async function createPixCharge({
  idempotencyKey,
  amount,
  description,
  customer,
  webhookUrl,
  metadata,
}) {
  const token = requireToken();

  const res = await fetch(`${BASE_URL}/pix`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      amount,
      description,
      customer,
      expires_in: 3600,
      webhook_url: webhookUrl,
      metadata,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(body.message || `PinPay respondeu ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }

  return body;
}
