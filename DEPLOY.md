# ImmoRadar — guide de déploiement v2

Sync auto Gmail → Gemini → ImmoRadar toutes les 15 minutes, hébergée sur Netlify.

---

## 1. Pré-requis

- Un compte **Google** (celui de Marie Astrid, qui reçoit les alertes Bien'ici)
- Un compte **Netlify** (gratuit, gratuit, gratuit)
- **Node.js 20+** installé en local
- L'outil CLI Netlify : `npm install -g netlify-cli`

---

## 2. Récupérer la clef Gemini

1. Aller sur **https://aistudio.google.com/app/apikey**
2. Cliquer **Create API key**
3. Copier la valeur `AIzaSy...` — on s'en sert à l'étape 5

> ⚠️ Régénérer cette clef si elle a transité par un chat avant ce déploiement.

---

## 3. Activer Gmail API + créer les credentials OAuth

1. Aller sur **https://console.cloud.google.com/**
2. Créer un projet "immoradar" (ou réutiliser celui de la v1)
3. **APIs & Services → Library** → activer **Gmail API**
4. **APIs & Services → OAuth consent screen** :
   - Type : **External**
   - Nom : ImmoRadar
   - Email support : ton adresse
   - Scopes : ajouter `gmail.readonly`
   - Test users : ajouter l'email de Marie Astrid
5. **APIs & Services → Credentials → Create credentials → OAuth Client ID** :
   - Application type : **Desktop** (Application de bureau) — surtout PAS "Web", le flow loopback du script l'exige
   - Name : ImmoRadar CLI
6. Télécharger / copier :
   - `Client ID` → `GMAIL_CLIENT_ID`
   - `Client secret` → `GMAIL_CLIENT_SECRET`

---

## 4. Obtenir le refresh token Gmail (à faire UNE fois)

Depuis le dossier du projet, en local :

```bash
cp .env.example .env
# Éditer .env : renseigner GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET
npm install
npm run get-token
```

Le script ouvre automatiquement le navigateur (flow "loopback" : un mini-serveur
local sur `http://localhost:4280` capture le code, aucun copier-coller).
→ **Se connecter avec le compte Gmail de Marie Astrid** → autoriser.

Le `GMAIL_REFRESH_TOKEN` s'affiche dans le terminal. **Le copier.**

> ⚠️ Le client OAuth DOIT être de type "Application de bureau". Un client
> "Application Web" ferait échouer le flow loopback (erreur `redirect_uri_mismatch`).

---

## 5. Configurer les variables d'environnement sur Netlify

Si le site est déjà lié à Netlify :

```bash
netlify link   # sélectionner le site preeminent-frangipane-442ab4
```

Puis ajouter les 5 variables :

```bash
netlify env:set GEMINI_API_KEY        "AIzaSy..."
netlify env:set GMAIL_CLIENT_ID       "xxxxxxxxxxxx-xxxxxxxxxxxxxx.apps.googleusercontent.com"
netlify env:set GMAIL_CLIENT_SECRET   "GOCSPX-xxxxxxxxxxxxxxxxxxxxxxx"
netlify env:set GMAIL_REFRESH_TOKEN   "1//xxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
netlify env:set GMAIL_USER            "marie.astrid@gmail.com"
```

> Ou via l'UI : **Netlify → Site settings → Environment variables**.

---

## 6. Déployer

```bash
git add .
git commit -m "v2 : sync auto Gmail + Gemini"
git push   # si le repo est déjà connecté à Netlify, déploiement auto

# OU déploiement manuel depuis le CLI :
netlify deploy --prod
```

---

## 7. Tester

### a) L'endpoint public

```bash
curl https://preeminent-frangipane-442ab4.netlify.app/.netlify/functions/get-listings
```

Réponse attendue :
```json
{ "updatedAt": "2026-05-13T09:42:13.000Z", "listings": [ ... ] }
```

### b) Forcer un scan immédiat

```bash
netlify functions:invoke scan-bienici --no-identity
```

ou via curl :

```bash
curl -X POST https://preeminent-frangipane-442ab4.netlify.app/.netlify/functions/scan-bienici
```

Vérifier dans **Netlify → Logs → Functions** que le scan trouve bien des emails et écrit dans Blobs.

### c) Voir la sync dans l'app

Ouvrir https://preeminent-frangipane-442ab4.netlify.app → la bannière haut de la liste doit afficher "À jour · N annonce(s) Bien'ici · scan aujourd'hui HH:MM".

---

## 8. Conflit GitHub Pages

Le repo `immoradar-bienici` est aussi déployé sur **GitHub Pages**. **GitHub Pages ne supporte PAS les Netlify Functions** — donc l'URL `*.github.io` ne pourra jamais synchroniser, elle restera bloquée sur les annonces fallback.

**Recommandation** : désactiver le déploiement GitHub Pages dans `Settings → Pages` du repo pour éviter la confusion. Marie Astrid utilise uniquement l'URL Netlify.

---

## 9. Sécurité

- La clef Gemini et les tokens Gmail sont stockés UNIQUEMENT dans les variables d'env Netlify (chiffrées au repos)
- Le scope OAuth est `gmail.readonly` — impossible d'écrire / supprimer / envoyer des emails
- `Access-Control-Allow-Origin: *` est OK pour `get-listings` car le contenu n'est pas sensible (annonces immo publiques)
- Si la clef Gemini fuite, la révoquer sur https://aistudio.google.com/app/apikey

---

## 10. Coûts attendus

| Service          | Quota gratuit                | Conso ImmoRadar              | Verdict      |
|------------------|------------------------------|------------------------------|--------------|
| Netlify Functions| 125k invocations/mois        | ~2 880 scans/mois            | ✓ gratuit    |
| Netlify Blobs    | 100 GB stockage              | < 1 MB                       | ✓ gratuit    |
| Gemini 1.5 Flash | 15 RPM · 1M tokens/jour      | ~30 req/jour · 100k tokens   | ✓ gratuit    |
| Gmail API        | 1 milliard quota/jour        | ~3k calls/jour               | ✓ gratuit    |

**Total prévu : 0 € / mois.**

---

## 11. Dépannage rapide

| Symptôme                              | Cause probable                       | Solution                          |
|---------------------------------------|--------------------------------------|-----------------------------------|
| "Sync indisponible · HTTP 500"        | Variable d'env manquante             | Vérifier les 5 vars sur Netlify   |
| "Refresh token expired" dans les logs | Token révoqué                        | Refaire `npm run get-token`       |
| Annonces 0 alors qu'il y a des emails | Communes non reconnues               | Voir `COMMUNE_NORMALIZE` dans `scan-bienici.mts` |
| Gemini renvoie du markdown            | Modèle drift                         | Le `responseMimeType:'application/json'` couvre déjà |
| Le cron ne se déclenche pas           | Site sur plan "Site Build" minimal   | Vérifier que les Scheduled Functions sont activées sur Netlify |
