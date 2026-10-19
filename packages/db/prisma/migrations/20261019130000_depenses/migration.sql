-- CreateEnum
CREATE TYPE "ExpenseKind" AS ENUM ('operating', 'purchase');

-- CreateEnum
CREATE TYPE "ExpenseMethod" AS ENUM ('cash', 'mtn_momo', 'orange_money', 'card', 'bank_transfer');

-- CreateEnum
CREATE TYPE "ExpenseStatus" AS ENUM ('recorded', 'voided');

-- CreateTable
CREATE TABLE "expense_category" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ExpenseKind" NOT NULL DEFAULT 'operating',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "expense_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "category_id" UUID NOT NULL,
    "business_day" DATE NOT NULL,
    "amount_xaf" INTEGER NOT NULL,
    "method" "ExpenseMethod" NOT NULL,
    "session_id" UUID,
    "supplier_id" UUID,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "attachment" TEXT,
    "status" "ExpenseStatus" NOT NULL DEFAULT 'recorded',
    "idempotency_key" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "approved_by" UUID,
    "voided_at" TIMESTAMPTZ(3),
    "voided_by" UUID,
    "void_approved_by" UUID,
    "void_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "expense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "expense_category_site_id_idx" ON "expense_category"("site_id");

-- CreateIndex
CREATE INDEX "expense_site_id_business_day_idx" ON "expense"("site_id", "business_day");

-- CreateIndex
CREATE INDEX "expense_session_id_idx" ON "expense"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "expense_site_id_number_key" ON "expense"("site_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "expense_site_id_idempotency_key_key" ON "expense"("site_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "expense_category" ADD CONSTRAINT "expense_category_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense" ADD CONSTRAINT "expense_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense" ADD CONSTRAINT "expense_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "expense_category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------- Règles posées par la base

CREATE UNIQUE INDEX "expense_category_name_active" ON "expense_category" ("site_id", lower("name")) WHERE "archived_at" IS NULL;

ALTER TABLE "expense" ADD CONSTRAINT "expense_amount_check" CHECK ("amount_xaf" > 0);
-- Une dépense prise dans la caisse est forcément payée en espèces.
ALTER TABLE "expense" ADD CONSTRAINT "expense_session_cash_check" CHECK ("session_id" IS NULL OR "method" = 'cash');
-- Une dépense annulée porte toujours son motif, son auteur et sa date.
ALTER TABLE "expense" ADD CONSTRAINT "expense_void_check" CHECK (
  "status" = 'recorded' OR ("voided_at" IS NOT NULL AND "voided_by" IS NOT NULL AND "void_reason" IS NOT NULL)
);

-- Une dépense ne se supprime jamais (elle s'annule).
CREATE OR REPLACE FUNCTION expense_forbid_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'expense : suppression interdite, annulez la dépense' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER expense_no_delete BEFORE DELETE ON "expense" FOR EACH ROW EXECUTE FUNCTION expense_forbid_delete();

-- ---------------------------------------------------------------- Données

-- Catégories par défaut du cahier des charges, pour chaque site existant.
INSERT INTO "expense_category" ("id", "site_id", "name", "kind", "sort_order", "updated_at")
SELECT gen_random_uuid(), s."id", c."name", c."kind"::"ExpenseKind", c."sort_order", now()
FROM "site" s
CROSS JOIN (VALUES
  ('Approvisionnement', 'purchase', 0), ('Transport', 'operating', 1), ('Énergie', 'operating', 2),
  ('Entretien', 'operating', 3), ('Salaires', 'operating', 4), ('Loyer', 'operating', 5), ('Divers', 'operating', 6)
) AS c("name", "kind", "sort_order")
WHERE NOT EXISTS (SELECT 1 FROM "expense_category" x WHERE x."site_id" = s."id");
