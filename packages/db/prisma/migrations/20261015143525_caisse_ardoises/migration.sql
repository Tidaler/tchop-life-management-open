-- CreateEnum
CREATE TYPE "CashSessionStatus" AS ENUM ('open', 'closed');

-- CreateEnum
CREATE TYPE "BillStatus" AS ENUM ('open', 'paid', 'voided');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('cash', 'mtn_momo', 'orange_money', 'card', 'customer_credit');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('recorded', 'verified', 'voided');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('charge', 'payment', 'adjustment');

-- CreateTable
CREATE TABLE "cash_register" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_register_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_session" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "register_id" UUID NOT NULL,
    "cashier_id" UUID NOT NULL,
    "status" "CashSessionStatus" NOT NULL DEFAULT 'open',
    "opening_float_xaf" INTEGER NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(3),
    "closed_by" UUID,
    "expected" JSONB,
    "counted_cash_xaf" INTEGER,
    "difference_xaf" INTEGER,
    "comment" TEXT,

    CONSTRAINT "cash_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "status" "BillStatus" NOT NULL DEFAULT 'open',
    "subtotal_xaf" INTEGER NOT NULL,
    "discount_xaf" INTEGER NOT NULL DEFAULT 0,
    "discount_reason" TEXT,
    "discount_approved_by" UUID,
    "total_xaf" INTEGER NOT NULL,
    "created_by" UUID NOT NULL,
    "paid_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "bill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_line" (
    "id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "amount_xaf" INTEGER NOT NULL,

    CONSTRAINT "bill_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount_xaf" INTEGER NOT NULL,
    "tendered_xaf" INTEGER,
    "change_xaf" INTEGER NOT NULL DEFAULT 0,
    "reference" TEXT,
    "customer_id" UUID,
    "status" "PaymentStatus" NOT NULL DEFAULT 'recorded',
    "idempotency_key" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "approved_by" UUID,
    "verified_by" UUID,
    "verified_at" TIMESTAMPTZ(3),
    "voided_by" UUID,
    "voided_at" TIMESTAMPTZ(3),
    "void_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "bill_id" UUID NOT NULL,
    "snapshot" JSONB NOT NULL,
    "reprints" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "credit_limit_xaf" INTEGER NOT NULL,
    "note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_ledger_entry" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "amount_xaf" INTEGER NOT NULL,
    "bill_id" UUID,
    "payment_id" UUID,
    "session_id" UUID,
    "method" "PaymentMethod",
    "reference" TEXT,
    "created_by" UUID NOT NULL,
    "approved_by" UUID,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_ledger_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cash_session_site_id_status_idx" ON "cash_session"("site_id", "status");

-- CreateIndex
CREATE INDEX "bill_site_id_status_idx" ON "bill"("site_id", "status");

-- CreateIndex
CREATE INDEX "bill_order_id_idx" ON "bill"("order_id");

-- CreateIndex
CREATE INDEX "bill_line_order_line_id_idx" ON "bill_line"("order_line_id");

-- CreateIndex
CREATE INDEX "payment_bill_id_idx" ON "payment"("bill_id");

-- CreateIndex
CREATE INDEX "payment_session_id_idx" ON "payment"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_site_id_idempotency_key_key" ON "payment"("site_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_bill_id_key" ON "receipt"("bill_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_site_id_number_key" ON "receipt"("site_id", "number");

-- CreateIndex
CREATE INDEX "customer_site_id_idx" ON "customer"("site_id");

-- CreateIndex
CREATE INDEX "customer_ledger_entry_customer_id_idx" ON "customer_ledger_entry"("customer_id");

-- AddForeignKey
ALTER TABLE "cash_register" ADD CONSTRAINT "cash_register_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_session" ADD CONSTRAINT "cash_session_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "cash_register"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill" ADD CONSTRAINT "bill_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_line" ADD CONSTRAINT "bill_line_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_line" ADD CONSTRAINT "bill_line_order_line_id_fkey" FOREIGN KEY ("order_line_id") REFERENCES "order_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "cash_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt" ADD CONSTRAINT "receipt_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_ledger_entry" ADD CONSTRAINT "customer_ledger_entry_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------- Règles de caisse garanties par la base

-- Une seule session ouverte par caisse, et par caissier.
CREATE UNIQUE INDEX "cash_session_one_open_per_register" ON "cash_session" ("register_id") WHERE "status" = 'open';
CREATE UNIQUE INDEX "cash_session_one_open_per_cashier" ON "cash_session" ("cashier_id") WHERE "status" = 'open';

-- Une référence de transaction (MoMo, Orange Money, carte) ne sert qu'une fois par site.
CREATE UNIQUE INDEX "payment_reference_once" ON "payment" ("site_id", "method", lower("reference"))
  WHERE "reference" IS NOT NULL AND "status" <> 'voided';

-- Montants cohérents.
ALTER TABLE "cash_session" ADD CONSTRAINT "cash_session_float_positive" CHECK ("opening_float_xaf" >= 0);
ALTER TABLE "bill" ADD CONSTRAINT "bill_amounts_valid"
  CHECK ("subtotal_xaf" >= 0 AND "discount_xaf" >= 0 AND "discount_xaf" <= "subtotal_xaf" AND "total_xaf" = "subtotal_xaf" - "discount_xaf");
ALTER TABLE "bill_line" ADD CONSTRAINT "bill_line_quantity_positive" CHECK ("quantity" > 0 AND "amount_xaf" >= 0);
ALTER TABLE "payment" ADD CONSTRAINT "payment_amounts_valid"
  CHECK ("amount_xaf" > 0 AND "change_xaf" >= 0 AND ("tendered_xaf" IS NULL OR "tendered_xaf" = "amount_xaf" + "change_xaf"));
ALTER TABLE "customer" ADD CONSTRAINT "customer_limit_positive" CHECK ("credit_limit_xaf" >= 0);

-- L'ardoise est en ajout seul : on corrige par une écriture inverse, jamais en modifiant l'historique.
CREATE OR REPLACE FUNCTION ledger_forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'customer_ledger_entry est en ajout seul : % interdit', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER customer_ledger_no_update_delete
  BEFORE UPDATE OR DELETE ON "customer_ledger_entry"
  FOR EACH ROW EXECUTE FUNCTION ledger_forbid_change();

-- Un reçu émis ne change plus (seul le compteur de réimpressions évolue) et ne se supprime pas.
CREATE OR REPLACE FUNCTION receipt_forbid_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW."number" <> OLD."number" OR NEW."bill_id" <> OLD."bill_id"
     OR NEW."snapshot"::text <> OLD."snapshot"::text OR NEW."site_id" <> OLD."site_id" THEN
    RAISE EXCEPTION 'reçu émis : % interdit', TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER receipt_immutable
  BEFORE UPDATE OR DELETE ON "receipt"
  FOR EACH ROW EXECUTE FUNCTION receipt_forbid_change();
