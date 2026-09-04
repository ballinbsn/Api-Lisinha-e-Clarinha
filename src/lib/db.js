import pg from "pg";

const { Pool } = pg;

const isLocal = (process.env.DATABASE_URL || "").includes("localhost");

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway's managed Postgres sits behind a proxy with a self-signed cert.
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

export async function ensureSchema() {
  // Ignored if the DB user lacks CREATE EXTENSION privileges — recent
  // Postgres (Railway's default) ships gen_random_uuid() in core anyway.
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kit_key TEXT NOT NULL,
      kit_name TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      customer_document TEXT NOT NULL,
      customer_phone TEXT,
      pinpay_transaction_id TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      qr_code TEXT,
      qr_code_url TEXT,
      expires_at TIMESTAMPTZ,
      payer_bank TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_orders_pinpay_tx ON orders (pinpay_transaction_id);`
  );
}
