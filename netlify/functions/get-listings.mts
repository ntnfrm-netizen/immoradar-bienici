// netlify/functions/get-listings.mts
// ─────────────────────────────────────────────────────────
// Endpoint public lu par le frontend ImmoRadar.html.
// Renvoie le JSON courant des annonces Bien'ici scannées.
// CORS ouvert pour permettre la lecture depuis n'importe où.
// ─────────────────────────────────────────────────────────

import { getStore } from "@netlify/blobs";

export default async (_req: Request) => {
  try {
    const store = getStore("listings");
    const data = (await store.get("data", { type: "json" })) ?? {
      updatedAt: null,
      listings: [],
    };

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=60",
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message, listings: [] }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
};
