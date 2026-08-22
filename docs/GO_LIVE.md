# BâtiPilot — Mise en production (Supabase + Vercel)

Ce document couvre l'initialisation d'un environnement Supabase + Vercel pour
BâtiPilot, et le cycle de vie normal des comptes (admin → approuve une
entreprise ingénieur, l'ingénieur → invite ses propres assistants).

## 1. Base de données (Supabase)

Dans le tableau de bord Supabase du projet → **SQL Editor → New query** :

1. Coller et exécuter `supabase/schema.sql` — crée les tables, les policies
   RLS et le trigger qui crée automatiquement une ligne `profiles` à chaque
   inscription (`role='ingenieur'`, `active=true` par défaut — la route
   d'auto-inscription désactive ensuite le compte explicitement, voir §4).
   Le script est idempotent, y compris pour faire évoluer une base déjà en
   place vers le modèle à trois rôles (ajout du rôle `assistant` et de la
   colonne `company_id`) : le ré-exécuter en entier ne casse rien.
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

Chaque compte **ingénieur** est le propriétaire d'une « entreprise » — lui
seul, plus les assistants qu'il invite, et toutes les données qu'il crée
(chantiers, clients, ouvriers, fournisseurs...). `profiles.company_id`
pointe vers son propre `id` : c'est la clé qui isole les données d'une
entreprise de celles d'une autre au niveau de la base (Row Level Security),
pas seulement côté interface.

**A. Auto-inscription (un ingénieur crée son propre compte)**
1. Sur l'écran de connexion → « Créer un compte ingénieur ».
2. L'adresse doit obligatoirement se terminer par `@batipilot.tn` — vérifié
   côté serveur (`POST /api/v1/auth/signup`), pas seulement dans le
   formulaire.
3. Le compte est créé mais **inactif** (`profiles.active = false`) : il ne
   peut pas encore se connecter.
4. Un admin doit l'approuver depuis **Entreprises** (voir ci-dessous).

**B. Invitation directe (l'admin crée le compte ingénieur)**
1. **Entreprises → Inviter un ingénieur** : nom, e-mail (même règle de
   domaine).
2. Le compte est actif dès sa création (l'admin l'a explicitement choisi) —
   c'est une entreprise vide, prête à recevoir des données réelles ou une
   démo (§5).

**C. Assistants (invités par l'ingénieur, ou par l'admin en son nom)**
- Un ingénieur invite ses propres assistants depuis **Mes assistants**
  (nom + e-mail, même règle de domaine `@batipilot.tn`).
- L'admin peut aussi le faire pour lui depuis **Entreprises → [ligne de
  l'entreprise] → Assistants**.
- Un assistant appartient à exactement une entreprise (`company_id` = l'id de
  l'ingénieur). Il a accès en **lecture seule** à toutes les données de
  cette entreprise, et en **lecture/écriture complète uniquement sur la
  table `workers`** (fiches ouvriers) — imposé par les policies RLS, pas
  seulement par la navigation masquée côté interface.

**Dans tous les cas**, la page **Entreprises** (admin uniquement) permet
d'activer / désactiver n'importe quel compte (ingénieur ou assistant).

## 5. Charger des données de démonstration pour une entreprise

Une entreprise nouvellement créée démarre totalement vide (aucun chantier,
client, ouvrier...) — c'est le mode « prêt pour la production réelle ».
Pour la peupler avec un jeu de données réaliste (utile en démo commerciale
ou pour tester le compte d'un nouvel ingénieur) :

1. **Entreprises → [ligne de l'ingénieur] → Données démo**.
2. Disponible uniquement si l'entreprise est encore vide (0 chantier) —
   sinon le serveur refuse (`company_already_has_data`) pour ne jamais
   écraser des données réelles.
3. Crée quelques clients, fournisseurs, articles, ouvriers et deux chantiers
   d'exemple (phases, tâches, matériaux affectés), tous rattachés à cette
   entreprise (`company_id`).

## 6. Rôles

| | Admin | Ingénieur | Assistant |
|---|---|---|---|
| Portée des données | toutes les entreprises (gestion des comptes uniquement) | uniquement les siennes | uniquement celles de son entreprise |
| Page Entreprises (inviter/approuver/activer les ingénieurs et leurs assistants) | ✅ | ❌ | ❌ |
| Mes assistants (inviter/désactiver ses propres assistants) | — | ✅ | ❌ |
| Chantiers, planning, tâches, clients, articles, fournisseurs — lecture | — | ✅ | ✅ |
| Chantiers, planning, tâches, clients, articles, fournisseurs — écriture | — | ✅ | ❌ (masqué + bloqué serveur) |
| Fiches ouvriers (`workers`) — CRUD complet | — | ✅ | ✅ |
| Pointage (heures travaillées) — écriture | — | ✅ | ❌ (masqué + bloqué serveur) |
| Budgets & coûts, Rapports | ❌ (hors périmètre admin) | ✅ | ❌ (masqué + bloqué serveur) |

## 7. Dépannage rapide

- **Page blanche / 404 sur le domaine Vercel** : vérifier Root Directory
  (section 3) puis redéployer.
- **« Compte non approuvé » au login** : normal pour une auto-inscription
  tant qu'un admin n'a pas activé le compte depuis Entreprises.
- **Un ingénieur ne voit aucune donnée** : normal pour une entreprise toute
  neuve — soit il crée ses propres chantiers/clients, soit l'admin charge
  les données de démonstration (§5).
- **Un assistant ne peut rien modifier hors Pointage/Ouvriers** : c'est le
  comportement voulu (§6) — les boutons de création/édition sont masqués et
  la RLS bloque aussi la requête si elle était forcée côté client.
