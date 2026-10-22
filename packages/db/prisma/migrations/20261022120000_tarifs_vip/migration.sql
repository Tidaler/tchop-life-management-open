-- Salon VIP : zone marquée VIP, règles VIP par catégorie (proposée ou non, supplément).
ALTER TABLE "zone" ADD COLUMN "vip" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "category" ADD COLUMN "vip_offered" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "vip_surcharge_xaf" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "category" ADD CONSTRAINT "category_vip_surcharge_check"
  CHECK ("vip_surcharge_xaf" BETWEEN 0 AND 1000000);

-- Cloud : l'aiguillage d'un QR code sait si sa table est en zone VIP.
ALTER TABLE "cloud_qr_route" ADD COLUMN "vip" BOOLEAN NOT NULL DEFAULT false;
