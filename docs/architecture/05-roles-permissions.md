# 5. Rôles et permissions

## Principes

- Les droits sont des **permissions** élémentaires (ex. `payment.void`). Un **rôle** est un ensemble de permissions.
- Un utilisateur reçoit un rôle **par site** (`user_site_role`). Le propriétaire a son rôle sur tous les sites du client.
- **V1** : rôles prédéfinis ci-dessous ; le propriétaire peut activer ou désactiver des permissions pour chaque rôle. **Phase 2** : rôles personnalisés.
- **Séparation des tâches** : l'approbateur d'une action sensible doit être **une autre personne** que celle qui agit. Si un gérant agit seul (aucun autre approbateur présent), l'action est marquée « auto-approuvée » et signalée dans le rapport du jour.
- Les permissions sont vérifiées par l'**API** ; l'interface se contente de masquer ce qui n'est pas autorisé.

## Rôles prédéfinis

| Rôle | Portée | Résumé |
|---|---|---|
| **Propriétaire** | Tous les sites du client | Tout, y compris paramètres sensibles, rôles, licence, vue multi-sites, accès à distance. |
| **Gérant** | Son ou ses sites | Gestion complète du site, approbation des actions sensibles, rapports, personnel du site. |
| **Caissier** | Son site | Session de caisse, encaissements, reçus, ardoises dans la limite du plafond. |
| **Serveur** | Son site | Tables, commandes, validation des commandes QR, demande d'addition. |
| **Cuisine / Bar** | Son ou ses postes | Écran de préparation, statuts des bons, produit indisponible. |
| **Magasinier** | Son site | Réceptions, transferts, pertes, inventaires, fournisseurs. |
| **Comptable** | Sites autorisés | Consultation financière, rapprochement des paiements, dépenses, exports. Aucune opération de vente. |

## Matrice des permissions

Légende : **✓** autorisé · **A** autorisé avec approbation du gérant · **≤** autorisé jusqu'au seuil, approbation au-delà · **L** lecture seule · **-** interdit

### Salle et commandes

| Permission | Code | Proprio | Gérant | Caissier | Serveur | Cuisine/Bar | Magasinier | Comptable |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Voir les tables et commandes | `order.view` | ✓ | ✓ | ✓ | ✓ | L | - | - |
| Créer une commande, ajouter des articles, envoyer | `order.create` | ✓ | ✓ | ✓ | ✓ | - | - | - |
| Valider / refuser une commande QR | `qr_request.handle` | ✓ | ✓ | ✓ | ✓ | - | - | - |
| Retirer un article **avant** envoi | `order.line.remove_draft` | ✓ | ✓ | ✓ | ✓ | - | - | - |
| Annuler un article **après** envoi | `order.line.cancel` | ✓ | ✓ | A | A | - | - | - |
| Changer de table, fusionner des tables | `order.transfer` | ✓ | ✓ | ✓ | ✓ | - | - | - |
| Demander l'addition, séparer une addition | `bill.prepare` | ✓ | ✓ | ✓ | ✓ | - | - | - |
| Changer le statut d'un bon (en préparation, prêt, servi) | `ticket.update` | ✓ | ✓ | - | ✓ | ✓ | - | - |
| Marquer un produit indisponible | `product.availability` | ✓ | ✓ | - | - | ✓ | ✓ | - |
| Gérer zones, tables et QR codes | `floor.manage` | ✓ | ✓ | - | - | - | - | - |

### Caisse

| Permission | Code | Proprio | Gérant | Caissier | Serveur | Cuisine/Bar | Magasinier | Comptable |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Ouvrir / clôturer une session de caisse | `cash_session.manage` | ✓ | ✓ | ✓ | - | - | - | - |
| Enregistrer un paiement, imprimer le reçu | `payment.record` | ✓ | ✓ | ✓ | - | - | - | - |
| Réimprimer un reçu | `receipt.reprint` | ✓ | ✓ | ✓ | - | - | - | - |
| Appliquer une remise | `discount.apply` | ✓ | ✓ | ≤ | - | - | - | - |
| Annuler un paiement | `payment.void` | ✓ | ✓ | A | - | - | - | - |
| Rembourser, émettre un avoir | `refund.create` | ✓ | ✓ | A | - | - | - | - |
| Rouvrir une addition payée | `bill.reopen` | ✓ | A | - | - | - | - | - |
| Mettre sur l'ardoise d'un client | `customer_credit.charge` | ✓ | ✓ | ≤ | - | - | - | - |
| Créer un client à ardoise, fixer son plafond | `customer.manage` | ✓ | ✓ | - | - | - | - | - |
| Rapprocher les paiements MoMo / OM / carte | `payment.verify` | ✓ | ✓ | - | - | - | - | ✓ |

### Catalogue

| Permission | Code | Proprio | Gérant | Caissier | Serveur | Cuisine/Bar | Magasinier | Comptable |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Voir le catalogue | `catalog.view` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | L |
| Créer / modifier produits, catégories, photos | `catalog.edit` | ✓ | ✓ | - | - | - | - | - |
| Modifier un prix | `price.edit` | ✓ | ✓ | - | - | - | - | - |
| Modifier une fiche recette | `recipe.edit` | ✓ | ✓ | - | - | - | L | - |

### Stocks et achats

| Permission | Code | Proprio | Gérant | Caissier | Serveur | Cuisine/Bar | Magasinier | Comptable |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Voir les stocks | `stock.view` | ✓ | ✓ | - | - | L | ✓ | L |
| Gérer les articles, conditionnements et magasins | `stock.item.manage` | ✓ | ✓ | - | - | - | ✓ | - |
| Réceptionner une livraison | `stock.receive` | ✓ | ✓ | - | - | - | ✓ | - |
| Transférer entre magasins | `stock.transfer` | ✓ | ✓ | - | - | - | ✓ | - |
| Déclarer perte, casse, consommation interne | `stock.loss` | ✓ | ✓ | - | - | A | ≤ | - |
| Faire un inventaire | `stock.count` | ✓ | ✓ | - | - | - | ✓ | - |
| Corriger un stock à la main | `stock.adjust` | ✓ | ✓ | - | - | - | A | - |
| Gérer fournisseurs et commandes d'achat | `purchase.manage` | ✓ | ✓ | - | - | - | ✓ | L |

### Finances et rapports

| Permission | Code | Proprio | Gérant | Caissier | Serveur | Cuisine/Bar | Magasinier | Comptable |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Saisir une dépense | `expense.create` | ✓ | ✓ | ≤ | - | - | - | ✓ |
| Voir les dépenses | `expense.view` | ✓ | ✓ | - | - | - | - | ✓ |
| Tableau de bord du site | `dashboard.view` | ✓ | ✓ | - | - | - | - | ✓ |
| Rapports de ventes | `report.sales` | ✓ | ✓ | L¹ | - | - | - | ✓ |
| Rapports de caisse et clôtures | `report.cash` | ✓ | ✓ | L¹ | - | - | - | ✓ |
| Rapports financiers (marges, bénéfice estimé) | `report.finance` | ✓ | ✓ | - | - | - | - | ✓ |
| Rapports de stock | `report.stock` | ✓ | ✓ | - | - | - | ✓ | ✓ |
| Exports comptables (PDF, Excel, CSV) | `export.accounting` | ✓ | ✓ | - | - | - | - | ✓ |
| Consulter le journal d'audit | `audit.view` | ✓ | ✓ | - | - | - | - | L |

¹ Uniquement sa propre session de caisse.

### Administration

| Permission | Code | Proprio | Gérant | Caissier | Serveur | Cuisine/Bar | Magasinier | Comptable |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Approuver une action sensible (PIN) | `approval.grant` | ✓ | ✓ | - | - | - | - | - |
| Gérer le personnel du site, réinitialiser un PIN | `user.manage` | ✓ | ✓² | - | - | - | - | - |
| Configurer les rôles et permissions | `role.manage` | ✓ | - | - | - | - | - | - |
| Enregistrer / révoquer appareils et imprimantes | `device.manage` | ✓ | ✓ | - | - | - | - | - |
| Paramètres du site (seuils, règles d'annulation, horaires) | `site.settings` | ✓ | ✓ | - | - | - | - | - |
| Taxes, informations légales, numérotation | `site.legal` | ✓ | - | - | - | - | - | L |
| Accès à distance (console cloud) | `remote.access` | ✓ | ✓ | - | - | - | - | ✓ |
| Vue consolidée multi-sites | `tenant.overview` | ✓ | - | - | - | - | - | L |
| Licence, abonnement, ajout de sites | `tenant.billing` | ✓ | - | - | - | - | - | - |
| Autoriser un accès de support temporaire | `support.grant` | ✓ | - | - | - | - | - | - |

² Sauf les comptes Propriétaire et Gérant, et seulement pour ses sites.

## Seuils paramétrables par site

| Seuil | Valeur par défaut suggérée |
|---|---|
| Remise sans approbation (caissier) | 10 % ou 2 000 FCFA |
| Perte / casse sans approbation (magasinier) | 10 000 FCFA de valeur |
| Écarts d'un inventaire sans approbation (magasinier) | 10 000 FCFA (valeur cumulée des écarts) |
| Dépense sans approbation (caissier) | 5 000 FCFA |
| Verrouillage automatique | Caisse 60 s · Salle 3 min · Back-office 10 min |

## Rôles de la plateforme (équipe TCHOP LIFE)

Ces rôles n'existent que dans le cloud et ne sont **jamais** attribués aux employés des clients.

| Rôle | Droits |
|---|---|
| **Super-administrateur** | Créer et suspendre des clients, gérer les licences, publier les mises à jour. Pas d'accès aux données métier d'un client. |
| **Support** | Voir l'état technique des sites (connexion, version, sauvegardes, imprimantes). Accès aux données métier uniquement pendant une fenêtre autorisée par le propriétaire, et toujours tracé. |
