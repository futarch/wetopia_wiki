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
```

## Les deux tâches planifiées

### Lint nocturne

```
0 3 * * *  curl -fsS -m 280 -H "authorization: Bearer $WETOPIA_CRON_SECRET" https://<app>/api/cron/lint
```

Le cron n'est qu'une sonnette : le travail tourne **dans l'instance**, par la
même file d'écriture que les conversations. C'est ce qui garde vrai
l'invariant « un seul écrivain » — un conteneur cron avec sa propre copie
serait un second écrivain en course sur les mêmes bundles.

### Surveillance

```
*/15 * * * *  curl -fsS https://<app>/api/health   # échoue (exit ≠ 0) si status = down
```

Ou n'importe quelle sonde externe (UptimeRobot, etc.) sur la même URL.

## `/api/health`

Deux niveaux, volontairement :

| appel | réponse |
|---|---|
| sans en-tête | `{status, checkedAt, uptimeSeconds}` — de quoi surveiller, rien de plus |
| `authorization: Bearer $WETOPIA_CRON_SECRET` | tous les contrôles, avec détail |

Le **code HTTP porte le verdict** : `200` si `ok` ou `warn`, `503` si `down`.
Une sonde bête suffit donc, sans lire le JSON.

Contrôles :

| contrôle | `down` quand | `warn` quand |
|---|---|---|
| `boot` | le wiki n'a pas démarré | — |
| `durabilite` | la dernière sauvegarde a échoué (écriture **non** durable) | des écritures attendent d'être sauvegardées |
| `bundles` | un repo n'a **aucune** copie durable | — |
| `lint` | — | jamais exécuté, ou dernier passage > `WETOPIA_LINT_MAX_AGE_H` (36 h) |
| `configuration` | `MISTRAL_API_KEY` absent | secret cron absent ; en prod, `BETTER_AUTH_SECRET` ou `DATABASE_URL` absents |

### Pourquoi le battement de cœur vit dans le wiki

Le projet avait identifié son pire risque d'exploitation : « un cron mort
découvert un mois plus tard ». La date du dernier lint n'est donc **pas** un
compteur en mémoire — un redémarrage le remettrait à zéro et l'app se
déclarerait en bonne santé. Elle est lue dans le journal partagé du wiki
(ligne `[process:lint]`), qui survit aux redéploiements, aux crashs et aux
restaurations. Vérifié par un test : après destruction du disque et
restauration, la santé du lint est toujours connue.

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
