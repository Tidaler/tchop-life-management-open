/** Textes de référence (français). Toute clé ajoutée ici doit être traduite dans en.ts. */
export const fr = {
  'app.name': 'TCHOP LIFE',
  'common.loading': 'Chargement…',
  'common.retry': 'Réessayer',
  'common.cancel': 'Annuler',
  'common.back': 'Retour',
  'common.confirm': 'Confirmer',
  'common.close': 'Fermer',
  'lang.label': 'Langue',
  'lang.fr': 'Français',
  'lang.en': 'English',

  'offline.banner': 'Serveur local injoignable. Nouvelle tentative en cours…',

  'enroll.title': 'Enregistrer cet appareil',
  'enroll.intro': 'Demandez au gérant un code d’enregistrement (menu Appareils), puis saisissez-le ici.',
  'enroll.code': 'Code à 6 chiffres',
  'enroll.name': 'Nom de l’appareil',
  'enroll.namePlaceholder': 'Ex. Tablette caisse',
  'enroll.kind': 'Type d’appareil',
  'enroll.submit': 'Enregistrer',
  'enroll.invalid': 'Code invalide ou expiré.',
  'enroll.revoked': 'Cet appareil a été révoqué. Enregistrez-le à nouveau.',
  'kind.tablet': 'Tablette',
  'kind.phone': 'Téléphone',
  'kind.desktop': 'Ordinateur',

  'pin.title': 'Qui êtes-vous ?',
  'pin.enter': 'Saisissez votre PIN',
  'pin.wrong': 'PIN incorrect.',
  'pin.locked': 'Trop de tentatives. Réessayez dans {minutes} min.',
  'pin.changeUser': 'Changer d’utilisateur',
  'pin.clear': 'Effacer',
  'pin.passwordLink': 'Connexion avec mot de passe',
  'pin.noUsers': 'Aucun employé avec un PIN sur ce site.',

  'login.title': 'Connexion back-office',
  'login.username': 'Identifiant',
  'login.password': 'Mot de passe',
  'login.submit': 'Se connecter',
  'login.invalid': 'Identifiant ou mot de passe incorrect.',
  'login.usePin': 'Retour à la connexion par PIN',

  'shell.lock': 'Verrouiller',
  'shell.autoLock': 'Verrouillage automatique après {seconds} s d’inactivité',

  'nav.home': 'Accueil',
  'nav.floor': 'Salle',
  'nav.cashier': 'Caisse',
  'nav.kitchen': 'Cuisine / Bar',
  'nav.stock': 'Stocks',
  'nav.dashboard': 'Tableau de bord',
  'nav.devices': 'Appareils',

  'home.hello': 'Bonjour {name}',
  'home.role': 'Connecté en tant que {role} · {site}',
  'home.pick': 'Choisissez un écran dans le menu.',
  'home.soon': 'Cet écran arrive en {phase}.',

  'devices.title': 'Appareils du site',
  'devices.newCode': 'Nouveau code d’enregistrement',
  'devices.codeHelp':
    'Saisissez ce code sur la nouvelle tablette. Valable {minutes} minutes, une seule fois.',
  'devices.lastSeen': 'Dernière activité',
  'devices.never': 'Jamais',
  'devices.revoke': 'Révoquer',
  'devices.revoked': 'Révoqué',
  'devices.active': 'Actif',
  'devices.confirmRevoke': 'Révoquer « {name} » ? Toutes ses sessions seront fermées.',
  'devices.empty': 'Aucun appareil enregistré.',

  'error.forbidden': 'Vous n’avez pas le droit d’effectuer cette action.',
  'error.network': 'Impossible de joindre le serveur local.',
  'error.generic': 'Une erreur est survenue. Réessayez.',
} as const;

export type MessageKey = keyof typeof fr;
export type Messages = Record<MessageKey, string>;
