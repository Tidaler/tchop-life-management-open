-- CreateTable
CREATE TABLE "modifier_group" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "name" JSONB NOT NULL,
    "min_select" INTEGER NOT NULL DEFAULT 0,
    "max_select" INTEGER NOT NULL DEFAULT 1,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "modifier_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modifier" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "name" JSONB NOT NULL,
    "price_delta_xaf" INTEGER NOT NULL DEFAULT 0,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "modifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_modifier_group" (
    "product_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "product_modifier_group_pkey" PRIMARY KEY ("product_id","group_id")
);

-- CreateIndex
CREATE INDEX "modifier_group_site_id_idx" ON "modifier_group"("site_id");

-- CreateIndex
CREATE INDEX "modifier_group_id_idx" ON "modifier"("group_id");

-- AddForeignKey
ALTER TABLE "modifier_group" ADD CONSTRAINT "modifier_group_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifier" ADD CONSTRAINT "modifier_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "modifier_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_modifier_group" ADD CONSTRAINT "product_modifier_group_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_modifier_group" ADD CONSTRAINT "product_modifier_group_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "modifier_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
