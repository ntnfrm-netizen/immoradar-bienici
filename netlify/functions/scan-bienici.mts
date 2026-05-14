// netlify/functions/scan-bienici.mts
// ────────────────────────────────────────────────────────────────────
// Scheduled Function — s'exécute toutes les 15 minutes via Netlify Cron.
//
// 1. S'authentifie sur Gmail (OAuth refresh token)
// 2. Cherche les emails Bien'ici reçus depuis le dernier scan
// 3. Pour chaque email, appelle Gemini 1.5 Flash pour extraire les annonces
// 4. Filtre sur les 4 communes cibles (Sceaux, BLR, Châtenay, Fontenay)
// 5. Merge avec le JSON existant dans Netlify Blobs (dédup par lien)
// 6. Écrit le résultat dans le store "listings"
// ────────────────────────────────────────────────────────────────────

import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { google } from "googleapis";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ─── Constantes métier ──────────────────────────────────────────────
const TARGET_COMMUNES = [
  "Sceaux",
  "Bourg-la-Reine",
  "Châtenay-Malabry",
  "Fontenay-aux-Roses",
];

const COMMUNE_NORMALIZE: Record<string, string> = {
  "sceaux": "Sceaux",
  "bourg la reine": "Bourg-la-Reine",
  "bourg-la-reine": "Bourg-la-Reine",
  "blr": "Bourg-la-Reine",
  "chatenay malabry": "Châtenay-Malabry",
  "chatenay-malabry": "Châtenay-Malabry",
  "châtenay-malabry": "Châtenay-Malabry",
  "châtenay malabry": "Châtenay-Malabry",
  "fontenay aux roses": "Fontenay-aux-Roses",
  "fontenay-aux-roses": "Fontenay-aux-Roses",
};

// Query Gmail : emails Bien'ici des dernières 24h
const GMAIL_QUERY = "from:no_reply@bienici.com newer_than:1d";

// Lecture d'une variable d'env, nettoyée des espaces et guillemets parasites
// (évite les erreurs invalid_client dues à un copier-coller imparfait)
function env(name: string): string {
  const raw = process.env[name];
  if (!raw) return "";
  return raw.trim().replace(/^["']|["']$/g, "").trim();
}

// ─── Types ──────────────────────────────────────────────────────────
type Listing = {
  id: string;
  type: "Appartement" | "Maison" | "Autre";
  commune: string;
  adresse: string;
  prix: number;
  surface: number;
  pieces: number;
  lien: string;
  emailDate: string; // ISO
  ingestedAt: string; // ISO
  source: "bienici-gmail";
};

type Snapshot = {
  updatedAt: string;
  listings: Listing[];
};

// ─── Helpers ────────────────────────────────────────────────────────
function normalizeCommune(raw: string): string | null {
  if (!raw) return null;
  const k = raw.trim().toLowerCase();
  if (COMMUNE_NORMALIZE[k]) return COMMUNE_NORMALIZE[k];
  // Match par préfixe (gère les codes postaux genre "92330 Sceaux")
  for (const [key, val] of Object.entries(COMMUNE_NORMALIZE)) {
    if (k.includes(key)) return val;
  }
  return null;
}

function decodeBody(part: any): string {
  if (!part) return "";
  // Cas direct
  if (part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf-8");
  }
  // Cas multipart : on cherche text/html ou text/plain en priorité
  if (part.parts) {
    const html = part.parts.find((p: any) => p.mimeType === "text/html");
    if (html) return decodeBody(html);
    const plain = part.parts.find((p: any) => p.mimeType === "text/plain");
    if (plain) return decodeBody(plain);
    // Sinon on essaye récursivement
    for (const p of part.parts) {
      const content = decodeBody(p);
      if (content) return content;
    }
  }
  return "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Prompt Gemini : extraction structurée ──────────────────────────
const GEMINI_PROMPT = `Tu es un extracteur d'annonces immobilières. On te donne le contenu textuel d'un email d'alerte Bien'ici reçu par un agent immobilier.

Renvoie UNIQUEMENT un JSON valide (sans markdown, sans \`\`\`) de cette forme :

{
  "annonces": [
    {
      "type": "Appartement" | "Maison" | "Autre",
      "commune": "Sceaux" | "Bourg-la-Reine" | "Châtenay-Malabry" | "Fontenay-aux-Roses" | "<autre commune>",
      "adresse": "<adresse ou code postal + ville>",
      "prix": <entier en euros, sans espaces ni symbole>,
      "surface": <entier en m², 0 si inconnu>,
      "pieces": <entier, 0 si inconnu>,
      "lien": "<URL complète vers l'annonce Bien'ici>"
    }
  ]
}

Règles :
- Si l'email contient plusieurs annonces, renvoie-les toutes dans le tableau.
- Si une annonce ne contient ni prix ni lien, ignore-la (ne la renvoie pas).
- Les liens doivent commencer par https://www.bienici.com/.
- Si l'email ne contient AUCUNE annonce exploitable, renvoie { "annonces": [] }.
- Réponds STRICTEMENT en JSON, aucun texte avant ou après.

Contenu de l'email :
---
`;

async function extractWithGemini(emailText: string): Promise<any[]> {
  const apiKey = env("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY manquante");

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json",
    },
  });

  // On tronque pour rester sous la limite de tokens (les emails Bien'ici sont rarement >50k chars)
  const truncated = emailText.slice(0, 60_000);
  const result = await model.generateContent(GEMINI_PROMPT + truncated);
  const text = result.response.text();

  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.annonces) ? parsed.annonces : [];
  } catch (e) {
    console.error("Réponse Gemini non-parsable :", text.slice(0, 200));
    return [];
  }
}

// ─── Handler principal ──────────────────────────────────────────────
export default async (_req: Request) => {
  const startedAt = Date.now();
  console.log("[scan-bienici] Démarrage scan");

  try {
    // 1. Auth Gmail OAuth
    const clientId = env("GMAIL_CLIENT_ID");
    const clientSecret = env("GMAIL_CLIENT_SECRET");
    const refreshToken = env("GMAIL_REFRESH_TOKEN");
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error(
        "Variables Gmail manquantes (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN)"
      );
    }

    const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
    oauth2.setCredentials({ refresh_token: refreshToken });

    const gmail = google.gmail({ version: "v1", auth: oauth2 });

    // 2. Liste des messages récents
    const list = await gmail.users.messages.list({
      userId: "me",
      q: GMAIL_QUERY,
      maxResults: 25,
    });

    const messages = list.data.messages ?? [];
    console.log(`[scan-bienici] ${messages.length} email(s) trouvé(s)`);

    if (messages.length === 0) {
      return new Response("OK · aucun email à traiter", { status: 200 });
    }

    // 3. Charger le snapshot existant pour dédup
    const store = getStore("listings");
    const existing = (await store.get("data", { type: "json" })) as Snapshot | null;
    const existingByLink = new Map<string, Listing>();
    for (const l of existing?.listings ?? []) existingByLink.set(l.lien, l);

    // 4. Pour chaque email, extraire les annonces avec Gemini
    const newListings: Listing[] = [];
    for (const m of messages) {
      try {
        const msg = await gmail.users.messages.get({
          userId: "me",
          id: m.id!,
          format: "full",
        });

        const rawBody = decodeBody(msg.data.payload);
        if (!rawBody) {
          console.warn(`[scan-bienici] Email ${m.id} : body vide`);
          continue;
        }

        const text = stripHtml(rawBody);
        const emailDate = new Date(
          parseInt(msg.data.internalDate ?? `${Date.now()}`)
        ).toISOString();

        const annonces = await extractWithGemini(text);

        for (const a of annonces) {
          // Validation minimale
          if (!a.lien || !a.lien.startsWith("https://www.bienici.com/")) continue;
          if (!a.prix || a.prix <= 0) continue;

          // Filtre 4 communes
          const commune = normalizeCommune(a.commune ?? "");
          if (!commune || !TARGET_COMMUNES.includes(commune)) continue;

          // Dédup par lien
          if (existingByLink.has(a.lien)) continue;
          if (newListings.find((n) => n.lien === a.lien)) continue;

          newListings.push({
            id: `bi_${Buffer.from(a.lien).toString("base64url").slice(0, 14)}`,
            type:
              a.type === "Maison" || a.type === "Appartement" ? a.type : "Autre",
            commune,
            adresse: String(a.adresse ?? "").trim() || `${commune}`,
            prix: parseInt(`${a.prix}`) || 0,
            surface: parseInt(`${a.surface}`) || 0,
            pieces: parseInt(`${a.pieces}`) || 0,
            lien: a.lien,
            emailDate,
            ingestedAt: new Date().toISOString(),
            source: "bienici-gmail",
          });
        }
      } catch (err) {
        console.error(`[scan-bienici] Erreur message ${m.id} :`, err);
      }
    }

    console.log(`[scan-bienici] ${newListings.length} nouvelle(s) annonce(s)`);

    // 5. Merge et écriture
    const merged: Listing[] = [
      ...newListings,
      ...(existing?.listings ?? []),
    ];

    // On garde les 150 plus récentes (par ingestedAt desc)
    merged.sort(
      (a, b) =>
        new Date(b.ingestedAt).getTime() - new Date(a.ingestedAt).getTime()
    );
    const trimmed = merged.slice(0, 150);

    const snapshot: Snapshot = {
      updatedAt: new Date().toISOString(),
      listings: trimmed,
    };
    await store.setJSON("data", snapshot);

    const ms = Date.now() - startedAt;
    return new Response(
      `OK · ${newListings.length} nouvelles · ${trimmed.length} au total · ${ms}ms`,
      { status: 200 }
    );
  } catch (err) {
    console.error("[scan-bienici] Erreur fatale :", err);
    return new Response(`ERROR : ${(err as Error).message}`, { status: 500 });
  }
};

export const config: Config = {
  schedule: "*/15 * * * *",
};
