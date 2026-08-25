# Exploitation — Wetopia

## Démarrer

```
npm install
cp .env.example .env.local     # puis remplir MISTRAL_API_KEY, BETTER_AUTH_SECRET, WETOPIA_CRON_SECRET
npm run dev
```

L'app se lève seule : migration des tables d'auth, restauration des bundles
depuis le magasin durable (ou création au premier démarrage).

## Tests

```
npm test              # déterministe, sans clé API : garde, durabilité, lint, monitoring
npm run test:agent    # boucle agent en conditions réelles (Mistral)
npm run test:lint     # lint nocturne en conditions réelles (Mistral)
npm run check:ui      # navigateur : connexion, conversation, dictée
npm run check:panes   # navigateur : les trois panneaux, le graphe, la barrière
```

Les deux vérifications navigateur lisent le compte de test dans
l'environnement — jamais dans le dépôt :

```
WETOPIA_TEST_EMAIL=… WETOPIA_TEST_PASSWORD=… npm run check:panes -- http://localhost:3000
```

## La tâche planifiée

### Lint nocturne

```
0 3 * * *  curl -fsS -m 280 -H "authorization: Bearer $WETOPIA_CRON_SECRET" https://<app>/api/cron/lint
```

Le cron n'est qu'une sonnette : le travail tourne **dans l'instance**, par la
même file d'écriture que les conversations. C'est ce qui garde vrai
l'invariant « un seul écrivain » — un conteneur cron avec sa propre copie
serait un second écrivain en course sur les mêmes bundles.

## Surveillance

`/api/health` existe et répond, mais **rien ne l'appelle périodiquement** :
l'appel toutes les 15 minutes a été retiré parce qu'il ne prévenait
personne. Un échec ne faisait sortir `curl` en erreur que dans les logs de
cron, qu'il fallait aller lire — le coût d'une panne non vue restait
entier.

Pour rétablir une vraie surveillance, il faut d'abord une destination
d'alerte. Le plus simple : une sonde externe (UptimeRobot ou équivalent)
sur `https://<app>/api/health`, qui envoie un mail sur un 503. Ajouter
alors, si on veut aussi une trace côté application, dans
`clevercloud/cron.json` :

```
*/15 * * * *  curl -fsS https://<app>/api/health   # échoue (exit ≠ 0) si status = down
```

En attendant, l'appel se fait à la main :

```
curl -fsS https://<app>/api/health                                  # vivant ?
curl -fsS -H "authorization: Bearer $WETOPIA_CRON_SECRET" …/api/health   # le rapport complet
```

## Qui peut créer un compte

`WETOPIA_ALLOWED_EMAILS` liste les adresses autorisées, séparées par des
virgules. Sans elle l'inscription est **ouverte** : pratique sur un poste de
dev, inacceptable en ligne — n'importe qui trouvant l'URL entrerait dans le
wiki. `/api/health` le signale en production, et le filtre vit dans notre
route d'auth plutôt que dans un hook de la bibliothèque, avec les autres
politiques de l'app.

## Le modèle : `-latest`, décidé, pas subi

`WETOPIA_MODEL` reste sur `mistral-medium-latest`, et c'est un choix, pas un
oubli. La question s'est posée d'épingler un snapshot daté pour figer le
comportement qu'on a validé (Medium a été retenu sur preuves : Large
brouillonnait et inventait des détails, Small échouait en scope privé).

Le catalogue Mistral, relevé le 2026-08-24, tranche dans l'autre sens :

| modèle | obsolescence annoncée |
|---|---|
| `mistral-medium-2505` | 2026-08-31 |
| `mistral-medium-2508` | 2026-08-31 |
| `mistral-medium-2604` | aucune |
| `mistral-medium-latest` | aucune |

Épingler aurait été précisément ce qui casse : un snapshot daté choisi il y a
quelques mois cesserait de répondre à une date fixe, alors que l'alias n'a pas
de date de péremption. Épingler échange un risque de **qualité** (le
comportement peut dériver) contre un risque de **disponibilité** (l'app meurt
un jour donné) — mauvais échange sans astreinte pour suivre les dépréciations.

Le risque de dérive est par ailleurs contenu par construction : un nouveau
modèle ne peut ni franchir la barrière privé/partagé, ni écrire hors scope, ni
supprimer une page — les outils et la garde refusent, ce ne sont pas des
consignes de prompt. Une dérive ferait varier la qualité, pas la sûreté.

Les contre-mesures sont donc la détection, pas le gel :

- `npm run test:agent` et `npm run test:lint` rejouent tout le contrat de
  comportement contre le modèle courant, en une commande ;
- chaque page porte `generated: { by: "wetopia-agent/<model-id>" }`, donc le
  wiki enregistre lui-même quel modèle a écrit quoi.

À revoir le jour où une vraie communauté et une astreinte existent : la
reproductibilité vaudra alors le coût de suivre les dépréciations.

## Où vivent les transcripts

pi écrit un transcript JSONL par conversation. Par défaut il les met dans
`~/.pi/agent/sessions` — le home de l'utilisateur qui fait tourner le
processus, hors de tout ce qu'on gère. L'option `agentDir` du superviseur ne
suffit pas : il construit son `SessionManager` lui-même. Le levier est la
variable d'environnement `PI_CODING_AGENT_DIR`, fixée par `lib/server/config.ts`
avant tout appel à pi.

Ils sont donc dans `runtime/agent/sessions/`, et le passage nocturne les
archive **à côté** des bundles (préfixe `sessions/` du même bucket), jamais
**dedans** :

- un transcript contient le corps de chaque page lue plus tout ce que la
  personne a tapé : dans git, il gonflerait chaque instantané ;
- l'historique git est append-only et les bundles sont immuables — un
  transcript commité serait ineffaçable. Hors de git, une politique de
  rétention suffit (`WETOPIA_SESSION_RETENTION_DAYS`, 90 jours par défaut).

Seuls les fichiers nouveaux ou qui ont grandi sont téléversés : un transcript
ne fait que croître tant que sa conversation vit, donc une taille identique
signifie qu'il n'y a rien de neuf à conserver.

## `/api/health`

Deux niveaux, volontairement :

| appel | réponse |
|---|---|
| sans en-tête | `{status, checkedAt, uptimeSeconds}` — de quoi surveiller, rien de plus |
| `authorization: Bearer $WETOPIA_CRON_SECRET` | tous les contrôles, avec détail |

Le **code HTTP porte le verdict** : `200` si `ok` ou `warn`, `503` si `down`.
Une sonde bête suffit donc, sans lire le JSON. Aucune ne l'appelle
aujourd'hui : voir « Surveillance » plus haut.

Contrôles :

| contrôle | `down` quand | `warn` quand |
|---|---|---|
| `boot` | le wiki n'a pas démarré | — |
| `durabilite` | la dernière sauvegarde a échoué (écriture **non** durable) | des écritures attendent d'être sauvegardées |
| `bundles` | un repo n'a **aucune** copie durable | — |
| `lint` | — | jamais exécuté, ou dernier passage > `WETOPIA_LINT_MAX_AGE_H` (36 h) |
| `configuration` | `MISTRAL_API_KEY` absent | secret cron absent ; en prod, `BETTER_AUTH_SECRET`, `DATABASE_URL` ou `WETOPIA_ALLOWED_EMAILS` absents |
| `memoire` | — | le tas dépasse 85 % de son plafond (mourir en plein tour emporte l'unique écrivain) |

### Pourquoi le battement de cœur vit dans le wiki

Le projet avait identifié son pire risque d'exploitation : « un cron mort
découvert un mois plus tard ». La date du dernier lint n'est donc **pas** un
compteur en mémoire — un redémarrage le remettrait à zéro et l'app se
déclarerait en bonne santé. Elle est lue dans le journal partagé du wiki
(ligne `[process:lint]`), qui survit aux redéploiements, aux crashs et aux
restaurations. Vérifié par un test : après destruction du disque et
restauration, la santé du lint est toujours connue.

## Le déploiement en place

App `wetopia-node` (Paris, 1×XS, autoscaling coupé), add-ons `wetopia-postgres`
et `wetopia-cellar` liés, bucket `wetopia-bundles`.
URL : https://app-6f9ff783-560f-47e2-bf64-3c7f8a85a208.cleverapps.io

Trois pièges rencontrés, à connaître avant d'y retoucher :

1. **`APP_FOLDER` ne déplace que l'installation.** Le hook de build et la
   commande de lancement s'exécutent à la **racine du dépôt** : d'où
   `CC_POST_BUILD_HOOK="cd web && npm run build"` et
   `CC_RUN_COMMAND="cd web && npm run start"`. Idem pour `clevercloud/cron.json`,
   qui doit être à la racine.
2. **`next build` ne tient pas dans une XS** — il s'est fait tuer par l'OOM.
   Réglé par une instance de build dédiée (`clever scale --build-flavor M`),
   facturée seulement pendant le build ; l'app reste en XS.
3. **`typescript` doit être en `dependencies`** (le build type-check), et
   `playwright` en `devDependencies` (il n'a rien à faire en production).

## Déploiement (Clever Cloud)

- **Un seul écrivain** : déploiement *stop-then-start* (pas de rolling),
  autoscaling **désactivé**. Deux instances = deux files = deux écrivains.
- Disque éphémère : rien à conserver hors des bundles.
- Postgres pour l'auth uniquement (`DATABASE_URL`).
- Cellar (S3) pour les bundles. Lier l'add-on Cellar à l'app (Clever Cloud
  injecte `CELLAR_ADDON_HOST/KEY_ID/KEY_SECRET`) puis créer le bucket et le
  nommer dans `WETOPIA_BUNDLE_BUCKET`. Sans ces variables, l'app retombe sur
  un répertoire local — visible dans les logs au démarrage
  (`[wetopia] bundles : …`).

  Le démarrage **échoue franchement** si le bucket est injoignable, plutôt que
  d'accepter des écritures qu'il ne pourrait pas conserver :
  `magasin de bundles injoignable (bucket « … »)`.

  Autre fournisseur S3 (Scaleway, MinIO) : `WETOPIA_S3_ENDPOINT`,
  `WETOPIA_S3_KEY_ID`, `WETOPIA_S3_KEY_SECRET`, `WETOPIA_S3_REGION`.

## En cas de panne

| symptôme | à faire |
|---|---|
| `durabilite: down` | le magasin de bundles est injoignable : les écritures ne sont plus durables. Vérifier Cellar/les identifiants **avant** de laisser les gens écrire. |
| `bundles: down` | un repo n'a aucune copie durable. Ne pas redémarrer : un redémarrage reconstruit l'arbre de travail depuis les bundles et effacerait ce qui n'est que sur disque. |
| `lint: warn` depuis > 36 h | le cron ne tourne plus. Le déclencher à la main avec la commande ci-dessus et regarder sa réponse JSON. |
| l'app ne démarre pas | `/api/health` répond `503` avec la cause (avec le secret). |
