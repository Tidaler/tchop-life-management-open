-- Serveur en ligne : registre des établissements hébergés, une base de données par établissement.
CREATE TYPE "EstablishmentStatus" AS ENUM ('active', 'suspended', 'closed');

CREATE TABLE "establishment" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "database_name" TEXT NOT NULL,
    "site_id" UUID NOT NULL,
    "status" "EstablishmentStatus" NOT NULL DEFAULT 'active',
    "activation_code_hash" TEXT,
    "activated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "establishment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "establishment_code_key" ON "establishment"("code");
CREATE UNIQUE INDEX "establishment_database_name_key" ON "establishment"("database_name");
