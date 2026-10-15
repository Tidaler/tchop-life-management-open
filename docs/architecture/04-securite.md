# 4. Sécurité

## Menaces principales

| Menace | Exemple concret | Parade principale |
|---|---|---|
| Fraude interne | Un employé annule une vente payée en espèces et garde l'argent | Ventes non supprimables, approbation du gérant, journal d'audit, écarts de clôture |
| Accès indu entre rôles | Un serveur consulte le chiffre d'affaires | Permissions vérifiées par l'API |
| Fuite entre clients | Le bar A voit les données du bar B dans le cloud | `tenant_id` partout + sécurité au niveau des lignes (RLS) |
| Abus du QR code | Commandes fantaisistes, accès à une autre table | Jeton aléatoire, validation par le personnel, limitation de débit |
| Vol du mini-PC | Données de vente et du personnel emportées | Disque chiffré, sauvegarde cloud, révocation à distance |
| Faux paiement Mobile Money | Capture d'écran truquée | Référence obligatoire, vérification humaine, statut « vérifié » distinct |
| Double encaissement | Double appui sur « Valider » | Clés d'idempotence + contraintes d'unicité |

## Authentification

### Personnel

| Contexte | Méthode |
|---|---|
| **Tablette partagée** (salle, caisse, cuisine) | L'appareil est **enregistré** (jeton d'appareil). L'employé choisit son nom et tape son **PIN à 4–6 chiffres**. |
| **Back-office** (gérant, comptable) | Identifiant + **mot de passe** (12 caractères minimum). |
| **Accès à distance** (propriétaire, depuis le cloud) | Identifiant + mot de passe + **code à usage unique** (application d'authentification ou SMS), obligatoire pour le propriétaire. |

Règles :
- Mots de passe et PIN hachés avec **Argon2id**, jamais stockés en clair.
- **5 PIN faux** → compte bloqué 5 minutes (sur tous les appareils du site) ; l’événement est tracé.
- **Verrouillage automatique** après inactivité, réglable par poste (ex. 60 s à la caisse, 3 min en salle).
- Jeton d'accès court (15 min) + jeton de rafraîchissement renouvelé à chaque usage, stocké en cookie `HttpOnly`, `Secure`, `SameSite=Strict`.
- Les comptes (avec leurs hachages) sont **répliqués du cloud vers le site** pour permettre la connexion sans Internet. Une révocation faite dans le cloud s'applique au site dès sa reconnexion ; le gérant peut aussi désactiver un compte directement sur place.
- Réinitialisation : le gérant réinitialise le PIN d'un employé ; le mot de passe du propriétaire se réinitialise par lien envoyé par e-mail ou SMS.

### Appareils et serveur local

- **Tablette** : enregistrée par le gérant (code affiché à l'écran du gérant, à saisir sur la tablette). Elle reçoit un jeton d'appareil révocable. Un appareil non enregistré ne voit que l'écran d'enregistrement.
- **Serveur local** : activé une seule fois avec un code d'activation à usage unique fourni par le cloud. Il génère sa paire de clés ; le cloud enregistre la clé publique. Toute la communication site ↔ cloud est authentifiée par cette clé et passe en TLS. Un site révoqué (mini-PC volé) ne peut plus se synchroniser.

## Autorisation

- Contrôle d'accès par **rôles et permissions** (voir [Rôles et permissions](05-roles-permissions.md)).
- **Chaque route de l'API déclare la permission requise.** Une route sans permission déclarée est refusée par défaut. L'interface masque les boutons, mais ce n'est qu'un confort : la décision est toujours prise par l'API.
- Chaque requête est limitée au **site** et au **client** de l'utilisateur. Dans le cloud, PostgreSQL applique en plus une politique **RLS** sur `tenant_id` : même une erreur de code ne peut pas exposer les données d'un autre client.

### Approbation du gérant

Les actions sensibles exigent, **au moment de l'action**, le PIN d'un utilisateur qui a la permission d'approuver. Le journal enregistre les deux personnes : celle qui agit et celle qui approuve.

| Action | Approbation requise |
|---|---|
| Annuler une ligne déjà envoyée en préparation | Oui |
| Remise au-delà du seuil du site (ex. 10 %) | Oui |
| Remboursement, avoir, annulation d'un paiement | Oui |
| Ardoise au-delà du plafond du client | Oui |
| Modification de prix en cours de service | Oui |
| Ajustement de stock, perte, casse | Oui au-delà d'un seuil de valeur |
| Réouverture d'une addition payée | Toujours, avec motif |

## Commande par QR code

- L'URL est de la forme `https://menu.tchoplife.app/q/{jeton}`. Le **jeton fait 128 bits aléatoires** : impossible à deviner, il ne révèle ni l'identifiant de la table, ni celui du site.
- Le jeton ne donne accès **qu'au menu public de ce site** et à la création d'une **demande** pour cette table. Aucune route interne n'accepte ce jeton.
- Chaque demande est **validée par un membre du personnel** avant d'aller en cuisine.
- Limites : 3 demandes en attente maximum par table ; 10 envois par minute par adresse IP ; panier limité (ex. 30 articles, 500 000 FCFA).
- Le navigateur du client reçoit un **cookie de session anonyme** lié au jeton : il ne voit que le statut de ses propres demandes.
- Un QR code perdu ou photographié et diffusé se **remplace** en un clic : nouveau jeton, l'ancien est refusé immédiatement.
- Aucune donnée personnelle n'est demandée au client.

## Paiements (non intégrés en V1)

- Le moyen de paiement est **déclaré** par le caissier. Pour MTN MoMo et Orange Money, la **référence de transaction est obligatoire**.
- Un paiement électronique est créé au statut `recorded`. Il passe à `verified` lors du **rapprochement** (gérant ou comptable, à partir du relevé de l'opérateur). Le rapport de caisse distingue clairement les deux.
- Une même référence Mobile Money ne peut pas être utilisée deux fois sur un site (contrainte d'unicité).

## Intégrité des données

- **Rien ne s'efface** : une vente payée, un paiement ou un mouvement de stock se corrige par une écriture inverse, avec motif et approbation.
- `audit_log` est en **ajout seul** : l'utilisateur PostgreSQL de l'application n'a pas le droit `UPDATE`/`DELETE` sur cette table. Option : chaîner les entrées par hachage pour rendre toute altération détectable.
- **Idempotence** : toute requête d'écriture porte une clé unique ; un renvoi retourne le même résultat sans créer de doublon.
- Les montants sont **recalculés par l'API** : un total envoyé par l'interface n'est jamais cru tel quel.

## Réseau et transport

- **HTTPS partout**, y compris sur le réseau local (voir [Vue d'ensemble](01-vue-ensemble.md#réseau-et-https-sur-le-site)).
- Le serveur local **n'ouvre aucun port vers Internet** : il se connecte lui-même au cloud.
- Le Wi-Fi **personnel** (WPA2/WPA3, mot de passe changé à chaque départ d'employé) est séparé du Wi-Fi **clients**.
- Pare-feu du mini-PC : seuls le 443 (HTTPS) et le 53 (DNS) sont ouverts sur le réseau personnel ; SSH uniquement par le tunnel de support.
- En-têtes de sécurité : CSP stricte, HSTS, `X-Content-Type-Options`, `frame-ancestors 'none'`.

## Serveur local

- Disque **chiffré** (LUKS, déverrouillé automatiquement par la puce TPM du mini-PC).
- Mises à jour : images Docker **signées**, vérifiées avant installation, sauvegarde automatique avant chaque mise à jour, retour arrière possible.
- **Accès de support** : désactivé par défaut. Le propriétaire l'autorise pour une durée limitée ; chaque session est tracée.
- Mises à jour de sécurité d'Ubuntu appliquées automatiquement.

## Données personnelles

- Données collectées au strict minimum : employés (nom, téléphone, PIN) et clients à ardoise (nom, téléphone, plafond). Aucune donnée personnelle pour les clients du menu QR.
- Export et suppression ou anonymisation d'un client à sa demande, sans toucher aux montants comptables.
- La conformité à la loi camerounaise sur la protection des données personnelles, ainsi que la durée légale de conservation des pièces comptables, sont **à valider avec un juriste** avant la commercialisation.

## Plateforme (équipe TCHOP LIFE)

- Le **super-administrateur** de la plateforme gère les clients, les licences et les sites, mais **n'accède pas aux données d'un client** sans autorisation explicite et limitée dans le temps de son propriétaire.
- Les accès à la console d'administration exigent une double authentification et sont tracés.
- Les secrets (clés de chiffrement, certificats, jetons d'API) sont stockés dans un coffre de secrets, jamais dans le code ni dans Git.
