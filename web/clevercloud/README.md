# Déploiement Clever Cloud

L'app vit dans `web/`, pas à la racine du dépôt : la variable
`CC_WEBROOT`/`APP_FOLDER` doit valoir `web`.

Variables à poser sur l'app (`clever env set`) :

| variable | valeur |
|---|---|
| `MISTRAL_API_KEY` | la clé Mistral |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | l'URL publique de l'app |
| `WETOPIA_CRON_SECRET` | `openssl rand -base64 32` |
| `WETOPIA_RUNTIME` | `/tmp/wetopia` (disque éphémère, reconstruit au boot) |
| `WETOPIA_BUNDLE_BUCKET` | le bucket Cellar |
| `DATABASE_URL` | l'URI Postgres (auth uniquement) |
| `CC_PRE_BUILD_HOOK` | `npm ci` |
| `CC_BUILD_HOOK` | `npm run build` |

Les `CELLAR_ADDON_*` et l'URI Postgres sont injectées automatiquement par les
add-ons liés.

Impératif : **un seul écrivain**. Une seule instance, autoscaling désactivé,
et déploiement *stop-then-start* plutôt que rolling.
