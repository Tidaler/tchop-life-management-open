-- AlterTable
ALTER TABLE "customer_ledger_entry" ADD COLUMN     "idempotency_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "customer_ledger_entry_customer_id_idempotency_key_key" ON "customer_ledger_entry"("customer_id", "idempotency_key");

