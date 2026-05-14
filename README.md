# ImmoRadar — Bien'ici · sync auto

Petite app personnelle pour **Marie Astrid**, agente immobilière IAD à Sceaux (92).

- Scan automatique de la boîte Gmail toutes les **15 minutes**
- Extraction des annonces Bien'ici via **Gemini 1.5 Flash**
- Filtre sur 4 communes : Sceaux · Bourg-la-Reine · Châtenay-Malabry · Fontenay-aux-Roses
- Frontend mobile-first, ajoutable à l'écran d'accueil iPhone
- Hébergé sur **Netlify** (Functions + Scheduled + Blobs)

## Architecture

```
Gmail (Bien'ici)
      ↓ OAuth readonly
  ┌──────────────────────────┐
  │ scan-bienici.mts         │  Scheduled Function — */15 min
  │  • Liste emails 24h      │
  │  • Gemini extrait JSON   │
  │  • Filtre 4 communes     │
  │  • Dédup + écrit Blob    │
  └──────────────┬───────────┘
                 │
            Netlify Blobs
                 │
  ┌──────────────▼───────────┐
  │ get-listings.mts         │  Function publique — GET JSON
  └──────────────┬───────────┘
                 │
            ImmoRadar.html
            (iPhone PWA)
```

## Démarrer

Voir **[DEPLOY.md](./DEPLOY.md)** pour le guide pas-à-pas.

Pour un dev local :

```bash
npm install
cp .env.example .env       # renseigner les 5 variables
netlify dev                # http://localhost:8888
```

## Structure

| Fichier                              | Rôle                                          |
|--------------------------------------|-----------------------------------------------|
| `index.html`                         | Frontend PWA (fetch JSON + favoris localStorage) |
| `netlify/functions/scan-bienici.mts` | Scheduled Function (cron 15 min)              |
| `netlify/functions/get-listings.mts` | Endpoint public JSON                          |
| `scripts/get-refresh-token.mjs`      | Helper OAuth one-shot (à exécuter UNE fois)   |
| `netlify.toml`                       | Config Netlify + cron                         |
| `.env.example`                       | Template variables d'environnement            |

## Communes ciblées

Les 4 communes du secteur de Marie Astrid sont définies dans `scan-bienici.mts` :

```ts
const TARGET_COMMUNES = ["Sceaux", "Bourg-la-Reine", "Châtenay-Malabry", "Fontenay-aux-Roses"];
```

Pour les modifier : éditer cette constante + la liste `COMMUNES` dans `index.html` + les chips dans le HTML.

## Versions

- **v1** — HTML statique avec données hardcodées, mise à jour manuelle via Claude.ai
- **v2** — *(actuel)* Sync auto Gmail + Gemini sur Netlify, frontend lit un JSON distant
