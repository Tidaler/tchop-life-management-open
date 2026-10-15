# TCHOP LIFE MANAGEMENT

Application de gestion pour snack-bar, lounge, bar et grill : commandes par QR code, prise de commande en salle, écran cuisine/bar, caisse, stocks, recettes, dépenses et rapports.

Produit commercialisé à plusieurs établissements (SaaS), avec un serveur local dans chaque établissement pour fonctionner sans Internet.

## Documents

- [Cahier des charges](docs/Cahier_des_charges_Tchop_Life_Management.docx)
- [Maquettes](docs/maquettes/index.html)
- [Architecture technique](docs/architecture/README.md) : modèle de données, synchronisation, sécurité, rôles et permissions

## Décisions validées

### Produit
- Application **web installable (PWA)** pour le personnel : tablettes, téléphones, ordinateurs.
- Menu client par **QR code** : simple page web, sans installation. Le client consulte le menu et envoie une commande, que le personnel valide.
- Interface **bilingue français / anglais**.
- Un établissement au départ ; architecture **multi-clients et multi-sites** dès le premier jour.
- Aucune limite imposée sur le nombre de tables, d'appareils ou d'employés.

### Fonctionnement
- **Fonctionne sans Internet** dans l'établissement grâce au serveur local. Le cloud sert à la consultation à distance, aux sauvegardes, aux licences et aux mises à jour.
- Les commandes QR passent par le cloud, qui les relaie au serveur local. Pendant une coupure Internet, la commande QR est suspendue, et tout le reste continue.
- **Caisse centrale** : seul le caissier encaisse ; les serveurs prennent les commandes.
- **Paiements non intégrés** en V1 : le caissier enregistre manuellement le moyen de paiement (espèces, MTN MoMo, Orange Money, carte) et une référence facultative.
- **Crédit client (ardoise)** : oui. **Consignes** (casiers, bouteilles) : non.
- Impression des **tickets de caisse** et des **bons cuisine/bar** sur imprimantes thermiques réseau.
- Tables **ajoutables et supprimables** par le gérant.

### Stocks
- Bar : vente **à l'unité** (bière, bouteille de whisky, etc.), pas au verre. Conversion uniquement à l'achat (casier → bouteilles).
- Cuisine et grill : **fiches recettes** avec déduction automatique des ingrédients à la vente.

### Stack technique (proposée)
- TypeScript partout, organisé en un seul dépôt.
- Backend Node.js (NestJS) + PostgreSQL (Prisma). Le même code tourne en mode local et en mode cloud.
- Frontend React + Vite (PWA), avec WebSocket pour le temps réel.
- Impression ESC/POS depuis le serveur local.
- Serveur local : mini-PC Linux + Docker, avec onduleur.

## Matériel par établissement

- Mini-PC (serveur local), 8–16 Go RAM, SSD.
- Onduleur pour le mini-PC et le routeur.
- Routeur Wi-Fi dédié (réseau personnel séparé du Wi-Fi clients).
- Imprimantes thermiques 80 mm réseau (Ethernet ou Wi-Fi).
- Tablettes et téléphones Android.
