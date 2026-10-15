-- CreateEnum
CREATE TYPE "QrRequestStatus" AS ENUM ('pending', 'accepted', 'rejected', 'expired');

-- AlterTable
ALTER TABLE "order_line" ADD COLUMN     "qr_request_id" UUID;

-- CreateTable
CREATE TABLE "qr_order_request" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "qr_code_id" UUID NOT NULL,
    "table_id" UUID NOT NULL,
    "client_session_hash" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "total_xaf" INTEGER NOT NULL,
    "status" "QrRequestStatus" NOT NULL DEFAULT 'pending',
    "order_id" UUID,
    "handled_by" UUID,
    "handled_at" TIMESTAMPTZ(3),
    "reject_reason" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "qr_order_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "qr_order_request_site_id_status_idx" ON "qr_order_request"("site_id", "status");

-- CreateIndex
CREATE INDEX "qr_order_request_table_id_status_idx" ON "qr_order_request"("table_id", "status");

-- CreateIndex
CREATE INDEX "qr_order_request_client_session_hash_idx" ON "qr_order_request"("client_session_hash");

-- CreateIndex
CREATE UNIQUE INDEX "qr_order_request_site_id_idempotency_key_key" ON "qr_order_request"("site_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "qr_order_request" ADD CONSTRAINT "qr_order_request_qr_code_id_fkey" FOREIGN KEY ("qr_code_id") REFERENCES "qr_code"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_qr_request_id_fkey" FOREIGN KEY ("qr_request_id") REFERENCES "qr_order_request"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Montant toujours positif.
ALTER TABLE "qr_order_request" ADD CONSTRAINT "qr_order_request_total_positive" CHECK ("total_xaf" >= 0);
