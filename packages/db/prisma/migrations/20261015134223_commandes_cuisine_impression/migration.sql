-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('dine_in', 'takeaway', 'delivery');

-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('staff', 'qr');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('open', 'billed', 'paid', 'cancelled');

-- CreateEnum
CREATE TYPE "LineStatus" AS ENUM ('sent', 'preparing', 'ready', 'served', 'cancelled');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('new', 'preparing', 'ready', 'served');

-- CreateEnum
CREATE TYPE "PrinterRole" AS ENUM ('cashier', 'kitchen', 'grill', 'bar');

-- CreateEnum
CREATE TYPE "PrintJobStatus" AS ENUM ('pending', 'printed', 'failed');

-- CreateTable
CREATE TABLE "order" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "business_day" DATE NOT NULL,
    "table_id" UUID,
    "type" "OrderType" NOT NULL DEFAULT 'dine_in',
    "source" "OrderSource" NOT NULL DEFAULT 'staff',
    "status" "OrderStatus" NOT NULL DEFAULT 'open',
    "waiter_id" UUID,
    "guests" INTEGER,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_line" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "name" JSONB NOT NULL,
    "unit_price_xaf" INTEGER NOT NULL,
    "tax_rate_bp" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "modifiers" JSONB NOT NULL DEFAULT '[]',
    "note" TEXT,
    "station" "Station" NOT NULL,
    "status" "LineStatus" NOT NULL DEFAULT 'sent',
    "ticket_id" UUID,
    "created_by" UUID NOT NULL,
    "sent_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "served_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by" UUID,
    "approved_by" UUID,
    "cancel_reason" TEXT,
    "cancelled_from" "LineStatus",
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "order_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kitchen_ticket" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "station" "Station" NOT NULL,
    "number" INTEGER NOT NULL,
    "business_day" DATE NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'new',
    "created_by" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "ready_at" TIMESTAMPTZ(3),
    "served_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "kitchen_ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_counter" (
    "site_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "site_counter_pkey" PRIMARY KEY ("site_id","key")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "site_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "route" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("site_id","key")
);

-- CreateTable
CREATE TABLE "printer" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 9100,
    "paper_width" INTEGER NOT NULL DEFAULT 80,
    "role" "PrinterRole" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "printer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "print_job" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "printer_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "PrintJobStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "printed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "print_job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_site_id_status_idx" ON "order"("site_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "order_site_id_business_day_number_key" ON "order"("site_id", "business_day", "number");

-- CreateIndex
CREATE INDEX "order_line_order_id_idx" ON "order_line"("order_id");

-- CreateIndex
CREATE INDEX "order_line_ticket_id_idx" ON "order_line"("ticket_id");

-- CreateIndex
CREATE INDEX "kitchen_ticket_site_id_status_idx" ON "kitchen_ticket"("site_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "kitchen_ticket_site_id_business_day_number_key" ON "kitchen_ticket"("site_id", "business_day", "number");

-- CreateIndex
CREATE INDEX "printer_site_id_idx" ON "printer"("site_id");

-- CreateIndex
CREATE INDEX "print_job_status_next_attempt_at_idx" ON "print_job"("status", "next_attempt_at");

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "dining_table"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "kitchen_ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kitchen_ticket" ADD CONSTRAINT "kitchen_ticket_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kitchen_ticket" ADD CONSTRAINT "kitchen_ticket_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "printer" ADD CONSTRAINT "printer_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_job" ADD CONSTRAINT "print_job_printer_id_fkey" FOREIGN KEY ("printer_id") REFERENCES "printer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Une seule commande ouverte par table.
CREATE UNIQUE INDEX "order_one_open_per_table" ON "order" ("table_id") WHERE "status" = 'open' AND "table_id" IS NOT NULL;

-- Quantités et prix toujours positifs.
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_price_positive" CHECK ("unit_price_xaf" >= 0);
