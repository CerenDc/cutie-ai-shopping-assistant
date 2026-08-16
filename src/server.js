import "dotenv/config";

import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import OpenAI from "openai";

const app = express();

/*
  Hostinger utilise un proxy devant l'application.
  Nécessaire pour express-rate-limit.
*/
app.set("trust proxy", 1);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* -----------------------------
   SÉCURITÉ
------------------------------ */

app.use(
  express.json({
    limit: "20kb",
  })
);

const allowedOrigins = [
  "https://creativitybycutie.fr",
  "https://www.creativitybycutie.fr",
];

app.use(
  cors({
    origin(origin, callback) {
      // Autorise également curl / Postman
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(
        new Error("Origin non autorisée")
      );
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

  /*
    Maximum autorisé afin de récupérer
    tout ton petit catalogue en une requête.
  */
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
    /*
      On garde uniquement les produits disponibles.
    */
    .filter((product) => product.is_in_stock)

    /*
      On transforme les données WooCommerce
      dans un format simple pour Cutie AI.
    */
    .map((product) => {
      const minorUnit =
        Number(
          product.prices?.currency_minor_unit
        ) || 2;

      const rawPrice = Number(
        product.prices?.price
      );

      const price =
        Number.isFinite(rawPrice)
          ? rawPrice /
            Math.pow(10, minorUnit)
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
          product.attributes?.map(
            (attribute) => ({
              name: attribute.name,

              options:
                attribute.terms?.map(
                  (term) => term.name
                ) || [],
            })
          ) || [],
      };
    })

    /*
      Si un budget maximum est indiqué,
      on élimine les produits trop chers.
    */
    .filter(
      (product) =>
        !maxPrice ||
        maxPrice <= 0 ||
        (product.price !== null &&
          product.price <= maxPrice)
    );
}

/* -----------------------------
   NETTOYAGE DU TEXTE HTML
------------------------------ */

function cleanText(html) {
  return String(html || "")
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

11. Tiens compte des informations données précédemment dans la conversation.
Par exemple :
- prénom ;
- budget ;
- couleurs préférées ;
- destinataire du cadeau ;
- occasion ;
- préférences ;
- produits déjà évoqués.

12. Ne redemande pas une information que la cliente a déjà donnée dans la conversation.
`;

/* -----------------------------
   PAGE PRINCIPALE API
------------------------------ */

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Cutie AI",
    message:
      "Assistant IA Creativity by Cutie",
  });
});

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
    /*
      On récupère :
      - le nouveau message du visiteur ;
      - l'identifiant de la réponse précédente
        s'il existe.
    */
    const {
      message,
      previousResponseId,
    } = req.body;

    /*
      Vérification du message.
    */
    if (
      typeof message !== "string" ||
      message.trim().length < 1
    ) {
      return res.status(400).json({
        error: "Message manquant.",
      });
    }

    /*
      Évite les messages énormes
      et donc les dépenses API inutiles.
    */
    if (message.length > 1000) {
      return res.status(400).json({
        error: "Message trop long.",
      });
    }

    /*
      On sécurise l'identifiant reçu
      depuis le navigateur.

      Si aucun identifiant n'existe,
      il s'agit simplement du premier
      message de la conversation.
    */
    let currentPreviousResponseId =
      typeof previousResponseId === "string" &&
      previousResponseId.trim().length > 0
        ? previousResponseId.trim()
        : null;

    /*
      Premier input :
      le nouveau message de l'utilisateur.
    */
    let input = [
      {
        role: "user",
        content: message.trim(),
      },
    ];

    let response;

    /*
      Maximum 3 tours de tool calling
      pour éviter une boucle infinie.
    */
    for (
      let round = 0;
      round < 3;
      round++
    ) {
      /*
        Construction de la requête OpenAI.

        previous_response_id permet de rattacher
        ce message à la conversation précédente.
      */
      const requestData = {
        model: "gpt-5.6-luna",

        instructions,

        input,

        tools,

        /*
          On conserve la Response côté OpenAI
          afin qu'elle puisse être référencée
          au message suivant.
        */
        store: true,
      };

      /*
        Si une conversation existe déjà,
        on indique à OpenAI quelle était
        la dernière Response.
      */
      if (currentPreviousResponseId) {
        requestData.previous_response_id =
          currentPreviousResponseId;
      }

      /*
        Appel OpenAI.
      */
      response =
        await openai.responses.create(
          requestData
        );

      /*
        Recherche des appels d'outils
        demandés par le modèle.
      */
      const functionCalls =
        response.output.filter(
          (item) =>
            item.type === "function_call"
        );

      /*
        S'il n'y a plus de tool call,
        la réponse finale est prête.
      */
      if (functionCalls.length === 0) {
        break;
      }

      /*
        IMPORTANT :

        La réponse OpenAI qui vient de demander
        le tool devient maintenant la réponse
        précédente.

        Cela permet de poursuivre correctement
        la chaîne :
        
        utilisateur
            ↓
        OpenAI
            ↓
        tool call
            ↓
        WooCommerce
            ↓
        OpenAI
            ↓
        réponse finale
      */
      currentPreviousResponseId =
        response.id;

      /*
        Pour la requête suivante,
        l'input contiendra uniquement
        les résultats des outils.
      */
      const toolOutputs = [];

      /*
        Exécution des outils demandés.
      */
      for (const call of functionCalls) {
        if (call.name !== "get_products") {
          continue;
        }

        const args = JSON.parse(
          call.arguments
        );

        const products =
          await getProducts(
            args.max_price
          );

        /*
          On renvoie à OpenAI les vrais
          produits récupérés depuis WooCommerce.
        */
        toolOutputs.push({
          type: "function_call_output",

          call_id: call.call_id,

          output: JSON.stringify(products),
        });
      }

      /*
        Le résultat WooCommerce devient
        l'input du prochain appel OpenAI.
      */
      input = toolOutputs;
    }

    /*
      Vérification de sécurité supplémentaire.
    */
    if (!response) {
      throw new Error(
        "Aucune réponse OpenAI générée."
      );
    }

    /*
      Réponse finale envoyée AU NAVIGATEUR.

      On envoie maintenant deux éléments :

      1. answer
         = le texte de Cutie AI

      2. responseId
         = l'identifiant OpenAI de cette réponse

      Le navigateur conservera responseId
      pour le prochain message.
    */
    return res.json({
      answer:
        response.output_text ||
        "Je n'ai pas réussi à générer une réponse.",

      responseId:
        response.id,
    });
  } catch (error) {
    /*
      L'erreur complète reste uniquement
      dans les logs Hostinger.
    */
    console.error(
      "Cutie AI error:",
      error
    );

    return res.status(500).json({
      error:
        "Cutie AI rencontre momentanément un problème.",
    });
  }
});

/* -----------------------------
   START SERVER
------------------------------ */

const PORT =
  process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    `💕 Cutie AI fonctionne sur le port ${PORT}`
  );
});