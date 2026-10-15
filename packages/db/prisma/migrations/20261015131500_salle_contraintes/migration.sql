-- Un seul QR code actif par table (remplacer un QR désactive l'ancien).
CREATE UNIQUE INDEX "qr_code_one_active_per_table" ON "qr_code" ("table_id") WHERE "active";

-- Libellé de table unique dans un site, parmi les tables non archivées (insensible à la casse).
CREATE UNIQUE INDEX "dining_table_label_active" ON "dining_table" ("site_id", lower("label")) WHERE "archived_at" IS NULL;
