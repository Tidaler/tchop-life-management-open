-- Chaque site existant reçoit une caisse principale (les nouveaux sites la reçoivent à leur création).
INSERT INTO "cash_register" ("id", "site_id", "name", "created_at")
SELECT gen_random_uuid(), s."id", 'Caisse principale', now()
FROM "site" s
WHERE NOT EXISTS (SELECT 1 FROM "cash_register" r WHERE r."site_id" = s."id");
