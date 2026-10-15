# Architecture technique — TCHOP LIFE MANAGEMENT

Version 0.1 · octobre 2026 · à valider avant le démarrage du développement.

## Sommaire

1. [Vue d'ensemble et déploiement](01-vue-ensemble.md) : principes, topologie site + cloud, organisation du code, réseau, HTTPS local, impression
2. [Modèle de données](02-modele-donnees.md) : conventions, domaines, tables, règles de calcul
3. [Synchronisation site ↔ cloud](03-synchronisation.md) : autorité des données, flux d'événements, commandes QR, sauvegardes, supervision
4. [Sécurité](04-securite.md) : menaces, authentification, approbation du gérant, QR code, intégrité, serveur local
5. [Rôles et permissions](05-roles-permissions.md) : rôles prédéfinis, matrice complète, seuils

## Décisions structurantes

| # | Décision | Pourquoi |
|---|---|---|
| D1 | **Serveur local par site** + cloud multi-clients | L'établissement doit fonctionner sans Internet ; le produit est vendu à plusieurs clients. |
| D2 | **PWA** pour le personnel, page web pour le menu QR | Un seul code pour tous les appareils, mises à jour instantanées, pas de store. |
| D3 | **TypeScript** partout : NestJS, React, PostgreSQL + Prisma | Un seul langage ; règles métier partagées entre API et interface. |
| D4 | **Une seule autorité par donnée** (site pour les opérations, cloud pour les comptes) | Supprime les conflits de synchronisation au lieu de les résoudre. |
| D5 | **Outbox transactionnelle + séquences par site** | Aucune opération perdue ni dupliquée, même après une longue coupure. |
| D6 | **Connexion sortante** du site vers le cloud | Aucun port ouvert, fonctionne derrière n'importe quelle box ou connexion 4G. |
| D7 | **Commande QR relayée par le cloud** | Les clients utilisent leurs données mobiles et ne rejoignent pas le Wi-Fi du bar. |
| D8 | **Chaque produit vendu a une recette** (une bière = 1 bouteille) | Un seul mécanisme de déduction de stock pour le bar et la cuisine. |
| D9 | **Rien ne s'efface**, correction par écriture inverse + audit | Lutte contre la fraude ; exigence du cahier des charges. |
| D10 | **Tablettes dépendantes du serveur local** en V1 | Simplicité et fiabilité ; un mode hors ligne par tablette pourra venir plus tard. |

## Points encore ouverts

| Sujet | À décider avec |
|---|---|
| Nom de domaine du produit (`tchoplife.app` est utilisé ici comme exemple) | Porteur du projet |
| Hébergeur cloud (VPS en Europe, ou hébergeur africain pour la latence) | Porteur du projet |
| Taux de TVA applicables, mentions obligatoires sur les reçus, conservation légale | Comptable / fiscaliste |
| Conformité protection des données personnelles | Juriste |
| Modèle de licence (par site, par mois, par nombre d'appareils) | Porteur du projet |
| Modèle exact de mini-PC, d'onduleur et d'imprimantes à valider pour le pilote | Tests matériels |

## Prochaine étape

**Phase 0 — Fondations** :
1. Initialiser le monorepo (pnpm + Turborepo) avec `apps/api`, `apps/web`, `apps/menu` et `packages/*`.
2. Base PostgreSQL en Docker, premier schéma Prisma (plateforme, identité, salle, catalogue).
3. Authentification (mot de passe + PIN), enregistrement des appareils, garde de permissions dans l'API.
4. Squelette de la PWA : connexion, choix du rôle, navigation, FR/EN.
5. Intégration continue (lint, tests, build) sur GitHub Actions.
