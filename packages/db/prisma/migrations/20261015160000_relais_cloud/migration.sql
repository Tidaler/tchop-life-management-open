-- CreateTable
CREATE TABLE "site_link" (
    "site_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "last_seen_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_link_pkey" PRIMARY KEY ("site_id")
);

-- CreateTable
CREATE TABLE "cloud_menu_snapshot" (
    "site_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "hash" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cloud_menu_snapshot_pkey" PRIMARY KEY ("site_id")
);

-- CreateTable
CREATE TABLE "cloud_qr_route" (
    "token_hash" TEXT NOT NULL,
    "site_id" UUID NOT NULL,
    "table_label" TEXT NOT NULL,
    "mode" "QrMode" NOT NULL,

    CONSTRAINT "cloud_qr_route_pkey" PRIMARY KEY ("token_hash")
);

-- CreateTable
CREATE TABLE "cloud_media_route" (
    "name" TEXT NOT NULL,
    "site_id" UUID NOT NULL,

    CONSTRAINT "cloud_media_route_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE INDEX "cloud_qr_route_site_id_idx" ON "cloud_qr_route"("site_id");

-- CreateIndex
CREATE INDEX "cloud_media_route_site_id_idx" ON "cloud_media_route"("site_id");

