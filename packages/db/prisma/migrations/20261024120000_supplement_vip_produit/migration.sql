-- Salon VIP : supplément propre à un produit (ex. brochettes rangées dans Plats) ; null : celui de la catégorie.
ALTER TABLE "product" ADD COLUMN "vip_surcharge_xaf" INTEGER;
ALTER TABLE "product" ADD CONSTRAINT "product_vip_surcharge_check"
  CHECK ("vip_surcharge_xaf" IS NULL OR "vip_surcharge_xaf" BETWEEN 0 AND 1000000);
