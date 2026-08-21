# BâtiPilot — Mise en production (Supabase + Vercel)

Ce document couvre l'initialisation d'un environnement Supabase + Vercel pour
BâtiPilot, et le cycle de vie normal des comptes (admin → invite/approuve un
ingénieur → lui assigne des chantiers).

## 1. Base de données (Supabase)

Dans le tableau de bord Supabase du projet → **SQL Editor → New query** :

1. Coller et exécuter `supabase/schema.sql` — crée les tables, les policies
   RLS et le trigger qui crée automatiquement une ligne `profiles` à chaque
   inscription (`role='ingenieur'`, `active=true` par défaut).
2. (Optionnel, données de démo) Charger le jeu de données d'exemple :
   ```
   node supabase/seed-to-supabase.mjs
   ```
   nécessite `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` dans l'environnement
   (voir `.env.example`). Sans cette étape, les tables restent vides — c'est
   le mode « prêt pour la production réelle », sans données fictives.

## 2. Premier compte admin

Aucun compte n'est admin par défaut — même le premier utilisateur inscrit
reste `ingenieur` tant qu'il n'est pas promu manuellement. Après avoir créé
votre propre compte (inscription normale sur l'écran de connexion, ou création
directe côté Supabase Auth), exécutez dans le SQL Editor :

```sql
update profiles set role = 'admin', active = true where email = 'vous@batipilot.tn';
```

## 3. Déploiement (Vercel)

Le projet importé doit avoir :
- **Root Directory** : `vercel` (le dossier contenant le front statique et
  `api/index.js` — pas la racine du dépôt). Attention en le saisissant dans
  le champ du tableau de bord Vercel : un espace de fin (`"vercel "`) est
  une erreur silencieuse fréquente et fait échouer le build avec « Root
  Directory does not exist ».
- **Variables d'environnement** (Project Settings → Environment Variables,
  cochées pour Production/Preview/Development) :

  | Variable | Où la trouver |
  |---|---|
  | `SUPABASE_URL` | Supabase → Project Settings → API |
  | `SUPABASE_ANON_KEY` | idem (clé « anon » / « publishable » — publique) |
  | `SUPABASE_SERVICE_ROLE_KEY` | idem (clé « service_role » / « secret » — **jamais côté navigateur**) |

  Ces mêmes valeurs sont hardcodées côté client dans
  `vercel/batipilot-standalone.html` (bloc `js/auth.js`) pour `SUPABASE_URL`
  et la clé anon uniquement — c'est attendu (voir note ci-dessous) et sans
  risque : elles sont protégées côté serveur par les policies RLS, pas par
  leur confidentialité.

Après une modification de Root Directory ou des variables d'environnement,
redéployez explicitement (Deployments → dernier déploiement → **⋯ → Redeploy**)
— un changement de réglage projet n'affecte pas rétroactivement un
déploiement déjà construit.

## 4. Cycle de vie des comptes

BâtiPilot a deux façons de créer un compte ingénieur :

**A. Auto-inscription (l'ingénieur crée son propre compte)**
1. Sur l'écran de connexion → « Créer un compte ingénieur ».
2. L'adresse doit obligatoirement se terminer par `@batipilot.tn` — vérifié
   côté serveur (`POST /api/v1/auth/signup`), pas seulement dans le
   formulaire.
3. Le compte est créé mais **inactif** (`profiles.active = false`) : il ne
   peut pas encore se connecter.
4. Un admin doit l'approuver depuis **Utilisateurs** (voir ci-dessous).

**B. Invitation directe (l'admin crée le compte)**
1. **Utilisateurs → Inviter un ingénieur** : nom, e-mail (même règle de
   domaine), chantiers à assigner immédiatement.
2. Le compte est actif dès sa création (l'admin l'a explicitement choisi).

**Dans les deux cas**, la page **Utilisateurs** (admin uniquement) permet
ensuite de :
- Activer / désactiver un compte.
- Modifier les chantiers assignés (« Chantiers » → sélection multiple).

Un ingénieur ne voit et ne peut modifier que les chantiers listés dans ses
affectations (`project_members`), appliqué au niveau de la base de données
(Row Level Security) — pas seulement caché côté interface. Un compte inactif
est bloqué au même niveau, même s'il est déjà affecté à un chantier.

## 5. Rôles

| | Admin | Ingénieur |
|---|---|---|
| Voit tous les chantiers, clients, fournisseurs | ✅ | uniquement les siens |
| Page Utilisateurs (inviter/approuver/assigner) | ✅ | ❌ (masqué + bloqué serveur) |
| Budgets & coûts (vue consolidée) | ✅ | ❌ (masqué + bloqué serveur) |
| CRUD complet sur ses propres chantiers (tâches, équipe, pointage, stock, pièces jointes) | ✅ | ✅ |

## 6. Dépannage rapide

- **Page blanche / 404 sur le domaine Vercel** : vérifier Root Directory
  (section 3) puis redéployer.
- **« Compte non approuvé » au login** : normal pour une auto-inscription
  tant qu'un admin n'a pas activé le compte depuis Utilisateurs.
- **Un ingénieur ne voit aucune donnée** : vérifier qu'il a bien un chantier
  assigné (Utilisateurs → Chantiers) — un compte actif sans chantier assigné
  voit une application vide par conception.
