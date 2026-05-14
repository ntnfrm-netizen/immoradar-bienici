#!/usr/bin/env node
// scripts/get-refresh-token.mjs
// ─────────────────────────────────────────────────────────
// Script utilitaire à exécuter UNE seule fois en local pour
// obtenir le GMAIL_REFRESH_TOKEN qui sera ensuite copié dans
// les variables d'environnement Netlify.
//
// Utilise le flow "loopback" : un mini-serveur HTTP local
// capture automatiquement le code OAuth (aucun copier-coller).
// Nécessite un client OAuth de type "Application de bureau".
//
// Usage :
//   1. Renseigner GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET dans .env
//   2. node scripts/get-refresh-token.mjs
//   3. Le navigateur s'ouvre → se connecter avec le compte
//      Gmail de Marie Astrid → autoriser
//   4. Le refresh_token s'affiche dans le terminal
// ─────────────────────────────────────────────────────────

import { google } from "googleapis";
import http from "node:http";
import { readFileSync } from "node:fs";
import { exec } from "node:child_process";

// Lecture simple du .env (sans dotenv pour éviter une dep)
// Tolérant aux espaces parasites autour du = et de la valeur
try {
  const env = readFileSync(".env", "utf-8");
  for (const line of env.split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
    if (m) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "").trim();
    }
  }
} catch {
  /* pas grave */
}

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌ GMAIL_CLIENT_ID et GMAIL_CLIENT_SECRET requis dans .env");
  process.exit(1);
}

const PORT = 4280;
const REDIRECT_URI = `http://localhost:${PORT}`;

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent", // force la génération d'un refresh_token
  scope: ["https://www.googleapis.com/auth/gmail.readonly"],
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, REDIRECT_URI);
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (error) {
      res.end("Erreur OAuth : " + error + ". Tu peux fermer cet onglet.");
      console.error("\n❌ Erreur OAuth :", error);
      server.close();
      process.exit(1);
    }

    // Requêtes parasites (favicon, etc.) : on ignore
    if (!code) {
      res.end("En attente de l'autorisation Google…");
      return;
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      "<h2>✅ Autorisation reçue</h2><p>Tu peux fermer cet onglet et revenir au terminal.</p>"
    );

    const { tokens } = await oauth2.getToken(code);
    console.log("\n✅ Tokens obtenus :\n");
    console.log("GMAIL_REFRESH_TOKEN=" + tokens.refresh_token);
    console.log(
      "\n→ Copie cette ligne dans Netlify : Site settings → Environment variables\n"
    );
    server.close();
    process.exit(0);
  } catch (err) {
    res.end("Erreur : " + err.message);
    console.error("\n❌ Erreur :", err.message);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(
    "\n🔑  Ouverture du navigateur pour autoriser l'accès Gmail…\n"
  );
  console.log("Si le navigateur ne s'ouvre pas, copie cette URL :\n");
  console.log(authUrl);
  console.log(`\n(En attente sur ${REDIRECT_URI} …)\n`);

  // Tentative d'ouverture automatique du navigateur
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  exec(`${opener} "${authUrl}"`);
});
