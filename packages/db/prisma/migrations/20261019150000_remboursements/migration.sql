-- CreateEnum
CREATE TYPE "RefundMethod" AS ENUM ('cash', 'mtn_momo', 'orange_money', 'card', 'customer_credit');

-- CreateTable
CREATE TABLE "refund" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "bill_id" UUID NOT NULL,
    "session_id" UUID,
    "method" "RefundMethod" NOT NULL,
    "amount_xaf" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "reference" TEXT,
    "customer_id" UUID,
    "restocked" BOOLEAN NOT NULL DEFAULT false,
    "snapshot" JSONB NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "approved_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund_line" (
    "id" UUID NOT NULL,
    "refund_id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "amount_xaf" INTEGER NOT NULL,

    CONSTRAINT "refund_line_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "refund_bill_id_idx" ON "refund"("bill_id");

-- CreateIndex
CREATE INDEX "refund_session_id_idx" ON "refund"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "refund_site_id_number_key" ON "refund"("site_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "refund_site_id_idempotency_key_key" ON "refund"("site_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "refund_line_refund_id_idx" ON "refund_line"("refund_id");

-- CreateIndex
CREATE INDEX "refund_line_order_line_id_idx" ON "refund_line"("order_line_id");

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_line" ADD CONSTRAINT "refund_line_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------- Règles posées par la base

ALTER TABLE "refund" ADD CONSTRAINT "refund_amount_check" CHECK ("amount_xaf" > 0);
-- Un remboursement en espèces sort forcément d'une caisse ouverte.
ALTER TABLE "refund" ADD CONSTRAINT "refund_cash_session_check" CHECK ("method" <> 'cash' OR "session_id" IS NOT NULL);
ALTER TABLE "refund" ADD CONSTRAINT "refund_customer_check" CHECK ("method" <> 'customer_credit' OR "customer_id" IS NOT NULL);
ALTER TABLE "refund_line" ADD CONSTRAINT "refund_line_check" CHECK ("quantity" > 0 AND "amount_xaf" >= 0);

-- Remboursements et avoirs en ajout seul : ils se corrigent par une nouvelle opération, jamais par modification.
CREATE OR REPLACE FUNCTION refund_forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% est en ajout seul : % interdit', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER refund_append_only BEFORE UPDATE OR DELETE ON "refund" FOR EACH ROW EXECUTE FUNCTION refund_forbid_change();
CREATE TRIGGER refund_line_append_only BEFORE UPDATE OR DELETE ON "refund_line" FOR EACH ROW EXECUTE FUNCTION refund_forbid_change();
