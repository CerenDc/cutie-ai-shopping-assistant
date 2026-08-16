import "dotenv/config";

import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import OpenAI from "openai";

const app = express();

app.set("trust proxy", 1);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* -----------------------------
   SÉCURITÉ
------------------------------ */

app.use(express.json({ limit: "20kb" }));

const allowedOrigins = [
  "https://creativitybycutie.fr",
  "https://www.creativitybycutie.fr",
];

app.use(
  cors({
    origin(origin, callback) {
      // Autorise aussi les tests sans navigateur (curl/Postman)
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Origin non autorisée"));
    },
  })
);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/chat", limiter);

/* -----------------------------
   OUTIL WOOCOMMERCE
------------------------------ */

async function getProducts(maxPrice = 0) {
  const url = new URL(
    `${process.env.WC_URL}/wp-json/wc/store/v1/products`
  );

  url.searchParams.set("per_page", "100");

  const response = await fetch(url);

  if (!response.ok) {
    const errorBody = await response.text();

    console.error(
      "WooCommerce Store API error:",
      response.status,
      errorBody
    );

    throw new Error(
      `Erreur WooCommerce Store API : ${response.status}`
    );
  }

  const products = await response.json();

  return products
    .filter((product) => product.is_in_stock)
    .map((product) => {
      const minorUnit =
        Number(product.prices?.currency_minor_unit) || 2;

      const rawPrice = Number(product.prices?.price);

      const price =
        Number.isFinite(rawPrice)
          ? rawPrice / Math.pow(10, minorUnit)
          : null;

      return {
        id: product.id,

        name: product.name,

        price,

        url: product.permalink,

        image:
          product.images?.[0]?.src || null,

        description: cleanText(
          product.short_description ||
            product.description ||
            ""
        ).slice(0, 800),

        categories:
          product.categories?.map(
            (category) => category.name
          ) || [],

        tags:
          product.tags?.map(
            (tag) => tag.name
          ) || [],

        attributes:
          product.attributes?.map((attribute) => ({
            name: attribute.name,
            options:
              attribute.terms?.map(
                (term) => term.name
              ) || [],
          })) || [],
      };
    })
    .filter(
      (product) =>
        !maxPrice ||
        maxPrice <= 0 ||
        (product.price !== null &&
          product.price <= maxPrice)
    );
}

  const products = await response.json();

  return products.map((product) => ({
    id: product.id,

    name: product.name,

    price: product.price || null,

    url: product.permalink,

    image:
      product.images?.[0]?.src || null,

    description: cleanText(
      product.short_description ||
        product.description ||
        ""
    ).slice(0, 800),

    categories:
      product.categories?.map(
        (category) => category.name
      ) || [],

    tags:
      product.tags?.map(
        (tag) => tag.name
      ) || [],

    attributes:
      product.attributes?.map((attribute) => ({
        name: attribute.name,
        options: attribute.options,
      })) || [],
  }));
}

function cleanText(html) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* -----------------------------
   TOOL CALLING
------------------------------ */

const tools = [
  {
    type: "function",

    name: "get_products",

    description:
      "Récupère les vrais produits actuellement disponibles dans le catalogue WooCommerce Creativity by Cutie. Tu dois utiliser cet outil avant toute recommandation de produit.",

    parameters: {
      type: "object",

      properties: {
        max_price: {
          type: "number",

          description:
            "Budget maximum de la cliente en euros. Utiliser 0 si aucun budget maximum n'est indiqué.",
        },
      },

      required: ["max_price"],

      additionalProperties: false,
    },

    strict: true,
  },
];

/* -----------------------------
   PROMPT CUTIE AI
------------------------------ */

const instructions = `
Tu es Cutie AI, l'assistante shopping officielle de Creativity by Cutie.

Creativity by Cutie est une boutique de créations artisanales et de créations au crochet.

Ton objectif est d'aider les visiteurs à trouver la création la plus adaptée à :
- leur budget ;
- leurs goûts ;
- leurs couleurs préférées ;
- l'occasion ;
- la personne à qui le cadeau est destiné.

RÈGLES IMPORTANTES :

1. Avant de recommander un produit, utilise toujours l'outil get_products.

2. Ne recommande jamais un produit qui n'a pas été retourné par WooCommerce.

3. N'invente jamais :
- un produit ;
- un prix ;
- une promotion ;
- une disponibilité ;
- une caractéristique.

4. Lorsque plusieurs produits correspondent, propose au maximum trois créations.

5. Explique brièvement pourquoi chaque produit correspond à la demande.

6. Lorsque l'URL est disponible, indique le lien vers la fiche produit.

7. Si aucun produit ne correspond réellement, dis-le clairement et propose éventuellement une création personnalisée.

8. Réponds en français par défaut.

9. Ton style est chaleureux, féminin, doux et professionnel, sans être excessivement enfantin.

10. Reste concise : l'objectif est d'aider la cliente à choisir, pas de produire de très longues réponses.
`;

/* -----------------------------
   HEALTH CHECK
------------------------------ */

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "Cutie AI",
  });
});

/* -----------------------------
   CHAT
------------------------------ */

app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;

    if (
      typeof message !== "string" ||
      message.trim().length < 1
    ) {
      return res.status(400).json({
        error: "Message manquant.",
      });
    }

    if (message.length > 1000) {
      return res.status(400).json({
        error: "Message trop long.",
      });
    }

    let input = [
      {
        role: "user",
        content: message.trim(),
      },
    ];

    let response;

    for (let round = 0; round < 3; round++) {
      response = await openai.responses.create({
        model: "gpt-5.6-luna",

        instructions,

        input,

        tools,
      });

      const functionCalls = response.output.filter(
        (item) => item.type === "function_call"
      );

      if (functionCalls.length === 0) {
        break;
      }

      input.push(...response.output);

      for (const call of functionCalls) {
        if (call.name !== "get_products") {
          continue;
        }

        const args = JSON.parse(call.arguments);

        const products = await getProducts(
          args.max_price
        );

        input.push({
          type: "function_call_output",

          call_id: call.call_id,

          output: JSON.stringify(products),
        });
      }
    }

    return res.json({
      answer:
        response?.output_text ||
        "Je n'ai pas réussi à générer une réponse.",
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error:
        "Cutie AI rencontre momentanément un problème.",
    });
  }
});

/* -----------------------------
   START SERVER
------------------------------ */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    `💕 Cutie AI fonctionne sur le port ${PORT}`
  );
});
