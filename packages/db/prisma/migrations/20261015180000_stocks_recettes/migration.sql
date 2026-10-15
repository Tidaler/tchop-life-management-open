-- CreateEnum
CREATE TYPE "StockUnit" AS ENUM ('piece', 'bottle', 'g', 'kg', 'ml', 'l');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('receipt', 'sale', 'sale_cancel', 'transfer_out', 'transfer_in', 'loss', 'breakage', 'internal_use', 'inventory_adjustment');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('open', 'received', 'cancelled');

-- CreateEnum
CREATE TYPE "InventoryStatus" AS ENUM ('open', 'closed', 'cancelled');

-- CreateTable
CREATE TABLE "stock_location" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "stock_location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_item" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "unit" "StockUnit" NOT NULL,
    "location_id" UUID NOT NULL,
    "alert_threshold" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "avg_cost_xaf" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "stock_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_packaging" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "factor" DECIMAL(14,3) NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_packaging_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_level" (
    "item_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_level_pkey" PRIMARY KEY ("item_id","location_id")
);

-- CreateTable
CREATE TABLE "stock_movement" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit_cost_xaf" DECIMAL(14,4) NOT NULL,
    "reason" TEXT,
    "order_line_id" UUID,
    "goods_receipt_id" UUID,
    "inventory_count_id" UUID,
    "group_id" UUID,
    "created_by" UUID NOT NULL,
    "approved_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_line" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "modifier_id" UUID,
    "quantity" DECIMAL(14,3) NOT NULL,

    CONSTRAINT "recipe_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "contact" TEXT,
    "note" TEXT,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'open',
    "note" TEXT,
    "created_by" UUID NOT NULL,
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "purchase_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_line" (
    "id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "unit_name" TEXT NOT NULL,
    "factor" DECIMAL(14,3) NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit_price_xaf" INTEGER NOT NULL,
    "received_quantity" DECIMAL(14,3) NOT NULL DEFAULT 0,

    CONSTRAINT "purchase_order_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipt" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "supplier_id" UUID,
    "purchase_order_id" UUID,
    "location_id" UUID NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "total_xaf" INTEGER NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goods_receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipt_line" (
    "id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "purchase_order_line_id" UUID,
    "unit_name" TEXT NOT NULL,
    "factor" DECIMAL(14,3) NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "base_quantity" DECIMAL(14,3) NOT NULL,
    "unit_price_xaf" INTEGER NOT NULL,
    "total_xaf" INTEGER NOT NULL,

    CONSTRAINT "goods_receipt_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_count" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "location_id" UUID NOT NULL,
    "status" "InventoryStatus" NOT NULL DEFAULT 'open',
    "note" TEXT,
    "variance_xaf" INTEGER,
    "created_by" UUID NOT NULL,
    "closed_by" UUID,
    "approved_by" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "inventory_count_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_count_line" (
    "id" UUID NOT NULL,
    "count_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "counted_qty" DECIMAL(14,3),
    "expected_qty" DECIMAL(14,3),
    "variance_qty" DECIMAL(14,3),
    "counted_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_count_line_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_location_site_id_idx" ON "stock_location"("site_id");

-- CreateIndex
CREATE INDEX "stock_item_site_id_idx" ON "stock_item"("site_id");

-- CreateIndex
CREATE INDEX "stock_packaging_item_id_idx" ON "stock_packaging"("item_id");

-- CreateIndex
CREATE INDEX "stock_level_location_id_idx" ON "stock_level"("location_id");

-- CreateIndex
CREATE INDEX "stock_movement_site_id_created_at_idx" ON "stock_movement"("site_id", "created_at");

-- CreateIndex
CREATE INDEX "stock_movement_item_id_created_at_idx" ON "stock_movement"("item_id", "created_at");

-- CreateIndex
CREATE INDEX "stock_movement_order_line_id_idx" ON "stock_movement"("order_line_id");

-- CreateIndex
CREATE INDEX "recipe_line_product_id_idx" ON "recipe_line"("product_id");

-- CreateIndex
CREATE INDEX "recipe_line_item_id_idx" ON "recipe_line"("item_id");

-- CreateIndex
CREATE INDEX "supplier_site_id_idx" ON "supplier"("site_id");

-- CreateIndex
CREATE INDEX "purchase_order_site_id_status_idx" ON "purchase_order"("site_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_site_id_number_key" ON "purchase_order"("site_id", "number");

-- CreateIndex
CREATE INDEX "purchase_order_line_purchase_order_id_idx" ON "purchase_order_line"("purchase_order_id");

-- CreateIndex
CREATE INDEX "goods_receipt_site_id_created_at_idx" ON "goods_receipt"("site_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipt_site_id_number_key" ON "goods_receipt"("site_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipt_site_id_idempotency_key_key" ON "goods_receipt"("site_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "goods_receipt_line_receipt_id_idx" ON "goods_receipt_line"("receipt_id");

-- CreateIndex
CREATE INDEX "inventory_count_site_id_status_idx" ON "inventory_count"("site_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_count_site_id_number_key" ON "inventory_count"("site_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_count_line_count_id_item_id_key" ON "inventory_count_line"("count_id", "item_id");

-- AddForeignKey
ALTER TABLE "stock_location" ADD CONSTRAINT "stock_location_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_item" ADD CONSTRAINT "stock_item_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_item" ADD CONSTRAINT "stock_item_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "stock_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_packaging" ADD CONSTRAINT "stock_packaging_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "stock_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_level" ADD CONSTRAINT "stock_level_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "stock_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_level" ADD CONSTRAINT "stock_level_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "stock_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "stock_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "stock_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_order_line_id_fkey" FOREIGN KEY ("order_line_id") REFERENCES "order_line"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_line" ADD CONSTRAINT "recipe_line_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_line" ADD CONSTRAINT "recipe_line_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "stock_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_line" ADD CONSTRAINT "recipe_line_modifier_id_fkey" FOREIGN KEY ("modifier_id") REFERENCES "modifier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier" ADD CONSTRAINT "supplier_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_line" ADD CONSTRAINT "purchase_order_line_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_line" ADD CONSTRAINT "purchase_order_line_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "stock_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt" ADD CONSTRAINT "goods_receipt_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt" ADD CONSTRAINT "goods_receipt_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt" ADD CONSTRAINT "goods_receipt_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt" ADD CONSTRAINT "goods_receipt_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "stock_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_line" ADD CONSTRAINT "goods_receipt_line_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "goods_receipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_line" ADD CONSTRAINT "goods_receipt_line_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "stock_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_line" ADD CONSTRAINT "goods_receipt_line_purchase_order_line_id_fkey" FOREIGN KEY ("purchase_order_line_id") REFERENCES "purchase_order_line"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_count" ADD CONSTRAINT "inventory_count_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_count" ADD CONSTRAINT "inventory_count_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "stock_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_count_line" ADD CONSTRAINT "inventory_count_line_count_id_fkey" FOREIGN KEY ("count_id") REFERENCES "inventory_count"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_count_line" ADD CONSTRAINT "inventory_count_line_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "stock_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------- Règles posées par la base

-- Noms uniques (sans tenir compte de la casse) parmi les éléments actifs.
CREATE UNIQUE INDEX "stock_item_name_active" ON "stock_item" ("site_id", lower("name")) WHERE "archived_at" IS NULL;
CREATE UNIQUE INDEX "stock_location_name_active" ON "stock_location" ("site_id", lower("name")) WHERE "archived_at" IS NULL;
CREATE UNIQUE INDEX "stock_packaging_name_active" ON "stock_packaging" ("item_id", lower("name")) WHERE "archived_at" IS NULL;
CREATE UNIQUE INDEX "supplier_name_active" ON "supplier" ("site_id", lower("name")) WHERE "archived_at" IS NULL;
-- Un seul inventaire en cours par magasin.
CREATE UNIQUE INDEX "inventory_count_open_per_location" ON "inventory_count" ("location_id") WHERE "status" = 'open';
-- Une ligne de recette par article et par option.
CREATE UNIQUE INDEX "recipe_line_unique" ON "recipe_line" ("product_id", "item_id", COALESCE("modifier_id", '00000000-0000-0000-0000-000000000000'::uuid));

ALTER TABLE "stock_item" ADD CONSTRAINT "stock_item_amounts_check" CHECK ("alert_threshold" >= 0 AND "avg_cost_xaf" >= 0);
ALTER TABLE "stock_packaging" ADD CONSTRAINT "stock_packaging_factor_check" CHECK ("factor" > 0);
ALTER TABLE "recipe_line" ADD CONSTRAINT "recipe_line_quantity_check" CHECK ("quantity" > 0);
ALTER TABLE "purchase_order_line" ADD CONSTRAINT "purchase_order_line_check"
  CHECK ("quantity" > 0 AND "factor" > 0 AND "unit_price_xaf" >= 0 AND "received_quantity" >= 0);
ALTER TABLE "goods_receipt" ADD CONSTRAINT "goods_receipt_total_check" CHECK ("total_xaf" >= 0);
ALTER TABLE "goods_receipt_line" ADD CONSTRAINT "goods_receipt_line_check"
  CHECK ("quantity" > 0 AND "factor" > 0 AND "base_quantity" > 0 AND "unit_price_xaf" >= 0 AND "total_xaf" >= 0);
ALTER TABLE "inventory_count_line" ADD CONSTRAINT "inventory_count_line_counted_check" CHECK ("counted_qty" IS NULL OR "counted_qty" >= 0);

-- Sens du mouvement imposé par son type (une sortie est toujours négative, une entrée positive).
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_sign_check" CHECK (
  "quantity" <> 0 AND "unit_cost_xaf" >= 0 AND (
    ("type" IN ('receipt', 'sale_cancel', 'transfer_in') AND "quantity" > 0) OR
    ("type" IN ('sale', 'transfer_out', 'loss', 'breakage', 'internal_use') AND "quantity" < 0) OR
    "type" = 'inventory_adjustment'
  )
);

-- Mouvements de stock en ajout seul.
CREATE OR REPLACE FUNCTION stock_movement_forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'stock_movement est en ajout seul : % interdit', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stock_movement_no_update_delete
  BEFORE UPDATE OR DELETE ON "stock_movement"
  FOR EACH ROW EXECUTE FUNCTION stock_movement_forbid_change();
CREATE TRIGGER stock_movement_no_truncate
  BEFORE TRUNCATE ON "stock_movement"
  FOR EACH STATEMENT EXECUTE FUNCTION stock_movement_forbid_change();

-- Réceptions figées une fois enregistrées.
CREATE OR REPLACE FUNCTION goods_receipt_forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% est figé : % interdit', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER goods_receipt_immutable
  BEFORE UPDATE OR DELETE ON "goods_receipt"
  FOR EACH ROW EXECUTE FUNCTION goods_receipt_forbid_change();
CREATE TRIGGER goods_receipt_line_immutable
  BEFORE UPDATE OR DELETE ON "goods_receipt_line"
  FOR EACH ROW EXECUTE FUNCTION goods_receipt_forbid_change();

-- ---------------------------------------------------------------- Données

-- Nouvelle permission « gérer les articles et magasins » pour les rôles prédéfinis concernés.
INSERT INTO "role_permission" ("role_id", "permission", "level")
SELECT r."id", 'stock.item.manage', 'full'
FROM "role" r
WHERE r."is_system" AND r."code" IN ('owner', 'manager', 'storekeeper')
ON CONFLICT DO NOTHING;

-- Magasins par défaut de chaque site existant (les nouveaux sites les reçoivent à leur création).
INSERT INTO "stock_location" ("id", "site_id", "name", "sort_order", "updated_at")
SELECT gen_random_uuid(), s."id", l."name", l."sort_order", now()
FROM "site" s
CROSS JOIN (VALUES ('Réserve', 0), ('Bar', 1), ('Cuisine', 2), ('Grill', 3)) AS l("name", "sort_order")
WHERE NOT EXISTS (SELECT 1 FROM "stock_location" x WHERE x."site_id" = s."id");
