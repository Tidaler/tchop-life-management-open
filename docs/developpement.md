# Guide de développement

## Prérequis

| Outil | Version |
|---|---|
| Node.js | 24 LTS (voir `.nvmrc`) |
| pnpm | 12 (`npm install -g pnpm`) |
| Docker Desktop | pour PostgreSQL |
| Git | — |

## Première installation

```bash
pnpm install
cp .env.example .env
pnpm db:up
pnpm db:migrate
pnpm db:seed
```

- `pnpm db:up` démarre PostgreSQL 17 dans Docker, sur le port **5434**. Une seconde base, `tchop_test`, est créée pour les tests.
- `pnpm db:migrate` applique les migrations Prisma et génère le client.
- `pnpm db:seed` crée les données de démonstration : un client, un site, le personnel, 30 tables avec leur QR code et le catalogue des maquettes.

## Lancer l'application

```bash
pnpm dev
```

- API : http://localhost:3000/api (santé : `/api/health`)
- Application du personnel : http://localhost:5180 (les appels `/api` passent par le proxy de Vite)

### Premier parcours

1. Ouvrir http://localhost:5180 : sans appareil enregistré, l'application propose la connexion par mot de passe.
2. Se connecter en **gérant**, ouvrir **Appareils**, cliquer sur **Nouveau code d'enregistrement**.
3. **Verrouiller**, ouvrir `/enroll`, saisir le code : le navigateur devient un appareil enregistré.
4. L'écran PIN affiche le personnel du site. Se connecter par exemple en serveur ou en caissière.

### Écrans disponibles

| Écran | Pour qui | Contenu |
|---|---|---|
| Catalogue | Gérant, propriétaire | Catégories, produits (FR/EN, prix, poste, photo), groupes d'options |
| Disponibilités | Cuisine/bar, magasinier, gérant | Marquer un produit épuisé en un geste |
| Plan de salle | Gérant, propriétaire | Zones, tables, mode du QR code, remplacement d'un QR code |
| Plan de salle › Imprimer les QR codes | Gérant, propriétaire | Planche de cartes QR bilingues à imprimer et découper |
| Salle | Serveurs, caisse, gérant | État des tables ; prise de commande avec options, notes, annulation, changement de table |
| Cuisine / Bar | Cuisine, serveurs, gérant | Bons par poste en temps réel : commencer, prêt, servi, réimprimer |
| Imprimantes | Gérant, propriétaire | Imprimantes thermiques réseau par poste, page de test, impressions en échec |

Les bons sont envoyés aux imprimantes réseau (ESC/POS, port 9100) du poste concerné. Sans imprimante, ils restent visibles sur l'écran de préparation. Pour tester sans matériel, une imprimante peut pointer vers un port qui écoute en local (les tests automatisés utilisent une fausse imprimante TCP).

Les photos sont stockées dans `apps/api/data/media` (variable `MEDIA_DIR`), réencodées en WebP de 800 px maximum.

### Comptes de démonstration

Ces comptes n'existent que dans les données de démo (`packages/db/prisma/seed.ts`). Ne jamais les utiliser en production.

| Identifiant | Rôle | Mot de passe | PIN |
|---|---|---|---|
| `proprietaire` | Propriétaire | `Demo-Proprio-2026!` | — |
| `gerant` | Gérant | `Demo-Gerant-2026!` | 4826 |
| `mireille` | Caissière | — | 2468 |
| `joel` | Serveur | — | 1357 |
| `aicha` | Serveuse | — | 3579 |
| `cuisine` | Cuisine / Bar | — | 9753 |
| `magasin` | Magasinier | — | 8642 |
| `comptable` | Comptable | `Demo-Compta-2026!` | — |

Après 5 PIN faux, le compte est bloqué 5 minutes.

## Commandes utiles

| Commande | Rôle |
|---|---|
| `pnpm build` | Compile tous les paquets (Turborepo, dans l'ordre des dépendances) |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | Vérification TypeScript |
| `pnpm test` | Tests : rôles et permissions, traductions, API de bout en bout (sur la base `tchop_test`) |
| `pnpm format` | Formate le code avec Prettier |
| `pnpm db:reset` | Supprime et recrée la base de développement, puis relance le seed (**efface toutes les données** ; les fichiers photo restent dans `MEDIA_DIR`) |
| `pnpm db:down` | Arrête PostgreSQL |

## Organisation

```
apps/
  api/       API NestJS (mode site ou cloud) : connexion, appareils, permissions, audit
  web/       PWA du personnel : enregistrement, PIN, mot de passe, menu selon le rôle
  menu/      Menu public QR (squelette, Phase 3)
packages/
  shared/    Permissions, rôles par défaut, schémas de validation, formatage FCFA
  i18n/      Textes français et anglais
  db/        Schéma Prisma, migrations, données de démo
infra/dev/   PostgreSQL de développement (Docker)
```

## Règles à respecter

- **Chaque route de l'API déclare sa politique d'accès** : `@Public()`, `@Authenticated()` ou `@RequirePermission('code', 'read' | 'write')`. Une route sans politique est refusée (code `NO_ACCESS_POLICY`).
- Les permissions et la matrice des rôles sont dans `packages/shared/src/roles.ts` et doivent rester alignées avec [docs/architecture/05-roles-permissions.md](architecture/05-roles-permissions.md).
- Le journal d'audit est en **ajout seul** : un déclencheur PostgreSQL refuse toute modification ou suppression.
- Les montants sont des entiers en FCFA ; les textes affichés passent par `@tchop/i18n` (français et anglais).
- L'application du personnel n'utilise **aucune ressource externe** (polices, CDN) : elle doit fonctionner sans Internet.

## Pourquoi l'API est compilée avec `tsc`

NestJS lit les types des constructeurs à l'exécution pour l'injection de dépendances. Seul `tsc` émet ces métadonnées. C'est pourquoi `pnpm dev` compile l'API en continu (`tsc --watch`) et que les tests de l'API importent le code compilé (`dist/`).
