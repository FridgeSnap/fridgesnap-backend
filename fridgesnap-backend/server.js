import "dotenv/config";

import express from "express";
import OpenAI from "openai";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

/* =========================================================
   GLOBAL ERROR HANDLERS
   ========================================================= */

process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED REJECTION]", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err);
});

/* =========================================================
   EXPRESS
   ========================================================= */

const app = express();

app.use(
  express.json({
    limit: "15mb",
  })
);

app.use((req, _res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.path}`);
  next();
});

/* =========================================================
   BASIC ROUTES
   ========================================================= */

app.get("/", (_req, res) => {
  res.send("SZZLE backend running.");
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
  });
});

/* =========================================================
   OPENAI
   ========================================================= */

let openai = null;

if (!process.env.OPENAI_API_KEY) {
  console.error(
    "[OPENAI] OPENAI_API_KEY is missing."
  );
} else {
  try {
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    console.log("[OPENAI] Client initialized.");
  } catch (err) {
    console.error(
      "[OPENAI INIT ERROR]",
      err
    );
  }
}

/* =========================================================
   STORAGE
   ========================================================= */

const SCANS_FILE = path.join(
  process.cwd(),
  "scans.json"
);

let scans = {};

function loadScans() {
  if (!fs.existsSync(SCANS_FILE)) {
    scans = {};
    return;
  }

  try {
    const raw = fs.readFileSync(
      SCANS_FILE,
      "utf8"
    );

    const parsed = JSON.parse(raw);

    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      scans = parsed;
    } else {
      scans = {};
    }
  } catch (err) {
    console.error(
      "[STORAGE] Failed to load scans.json:",
      err
    );

    scans = {};
  }
}

function saveScans() {
  try {
    const tempFile =
      `${SCANS_FILE}.tmp`;

    fs.writeFileSync(
      tempFile,
      JSON.stringify(scans, null, 2),
      "utf8"
    );

    fs.renameSync(
      tempFile,
      SCANS_FILE
    );
  } catch (err) {
    console.error(
      "[STORAGE] Failed to save scans.json:",
      err
    );
  }
}

loadScans();

/* =========================================================
   SCAN CLEANUP
   ========================================================= */

const SCAN_RETENTION_DAYS = 14;

function cleanupOldScans() {
  const cutoff =
    Date.now() -
    SCAN_RETENTION_DAYS *
      24 *
      60 *
      60 *
      1000;

  let deleted = 0;

  for (const [scanId, scan] of Object.entries(
    scans
  )) {
    if (
      !scan ||
      typeof scan.createdMs !== "number" ||
      scan.createdMs < cutoff
    ) {
      delete scans[scanId];
      deleted++;
    }
  }

  if (deleted > 0) {
    saveScans();

    console.log(
      `[CLEANUP] Removed ${deleted} expired scan(s).`
    );
  }
}

/*
 * Run immediately and then once every hour.
 */

cleanupOldScans();

const cleanupInterval = setInterval(
  cleanupOldScans,
  60 * 60 * 1000
);

cleanupInterval.unref();

/* =========================================================
   IDENTITY
   ========================================================= */

function getIdentityKey({
  guestId,
  deviceId,
}) {
  if (
    typeof guestId === "string" &&
    guestId.trim().length > 0
  ) {
    return `guest:${guestId.trim()}`;
  }

  if (
    typeof deviceId === "string" &&
    deviceId.trim().length > 0
  ) {
    return `device:${deviceId.trim()}`;
  }

  return null;
}

/*
 * Never log the actual guest/device identifier.
 */

function getIdentityLogLabel(identityKey) {
  if (!identityKey) {
    return "unknown";
  }

  const hash = crypto
    .createHash("sha256")
    .update(identityKey)
    .digest("hex");

  return hash.slice(0, 12);
}

/* =========================================================
   IMAGE VALIDATION
   ========================================================= */

const MAX_IMAGE_BASE64_LENGTH =
  12 * 1024 * 1024;

function validateImageBase64(imageBase64) {
  if (
    typeof imageBase64 !== "string" ||
    imageBase64.length === 0
  ) {
    return {
      ok: false,
      error: "MISSING_IMAGE",
    };
  }

  if (
    imageBase64.length >
    MAX_IMAGE_BASE64_LENGTH
  ) {
    return {
      ok: false,
      error: "IMAGE_TOO_LARGE",
    };
  }

  const dataUrlMatch =
    imageBase64.match(
      /^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/s
    );

  if (!dataUrlMatch) {
    return {
      ok: false,
      error: "INVALID_IMAGE",
    };
  }

  const base64Data =
    dataUrlMatch[2];

  if (
    !base64Data ||
    base64Data.length === 0
  ) {
    return {
      ok: false,
      error: "INVALID_IMAGE",
    };
  }

  return {
    ok: true,
  };
}

/* =========================================================
   TEMP IMAGE FILE
   ========================================================= */

function writeTempJpeg(base64) {
  const cleanBase64 = String(base64)
    .replace(
      /^data:image\/[a-zA-Z0-9.+-]+;base64,/i,
      ""
    );

  const buffer = Buffer.from(
    cleanBase64,
    "base64"
  );

  if (
    !buffer ||
    buffer.length === 0
  ) {
    throw new Error(
      "Image data could not be decoded."
    );
  }

  const filename =
    `szzle-${crypto
      .randomBytes(16)
      .toString("hex")}.jpg`;

  const filepath = path.join(
    os.tmpdir(),
    filename
  );

  fs.writeFileSync(
    filepath,
    buffer
  );

  return filepath;
}

function deleteTempFile(filepath) {
  if (
    filepath &&
    fs.existsSync(filepath)
  ) {
    try {
      fs.unlinkSync(filepath);
    } catch (err) {
      console.error(
        "[TEMP FILE] Failed to delete temporary file:",
        err
      );
    }
  }
}

/* =========================================================
   COOLDOWNS
   ========================================================= */

const ANALYZE_COOLDOWN_SECONDS = 60;
const REGENERATE_COOLDOWN_SECONDS = 10;

const cooldowns = new Map();

function enforceCooldown(
  identityKey,
  kind,
  seconds
) {
  const key =
    `${identityKey}:${kind}`;

  const now = Date.now();

  const last =
    cooldowns.get(key) || 0;

  const elapsed =
    now - last;

  if (
    elapsed <
    seconds * 1000
  ) {
    const remaining =
      seconds -
      Math.floor(
        elapsed / 1000
      );

    return {
      ok: false,
      retryAfterSeconds:
        Math.max(
          1,
          remaining
        ),
    };
  }

  cooldowns.set(
    key,
    now
  );

  return {
    ok: true,
  };
}

/* =========================================================
   OPENAI FILE CLEANUP
   ========================================================= */

async function deleteOpenAIFile(fileId) {
  if (
    !openai ||
    !fileId
  ) {
    return;
  }

  try {
    await openai.files.delete(
      fileId
    );

    console.log(
      `[OPENAI] Temporary file deleted: ${fileId}`
    );
  } catch (err) {
    /*
     * Do not fail the user's request merely because
     * cleanup of the remote temporary file failed.
     */

    console.error(
      `[OPENAI] Failed to delete temporary file ${fileId}:`,
      err
    );
  }
}

/* =========================================================
   RESPONSE PARSING
   ========================================================= */

function getOutputText(response) {
  if (
    typeof response?.output_text ===
    "string"
  ) {
    return response.output_text.trim();
  }

  const output =
    response?.output || [];

  let text = "";

  for (const item of output) {
    const content =
      item?.content || [];

    for (const part of content) {
      if (
        part?.type ===
          "output_text" &&
        typeof part?.text ===
          "string"
      ) {
        text += part.text;
      }
    }
  }

  return text.trim();
}

function safeJsonParse(text) {
  const cleaned =
    String(text || "")
      .replace(
        /^```json\s*/i,
        ""
      )
      .replace(
        /^```\s*/i,
        ""
      )
      .replace(
        /```\s*$/i,
        ""
      )
      .trim();

  return JSON.parse(cleaned);
}

/* =========================================================
   RECIPE SCHEMA
   ========================================================= */

const RECIPE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,

  properties: {
    error: {
      type: [
        "string",
        "null",
      ],
      enum: [
        "NO_FOOD_DETECTED",
        null,
      ],
    },

    title: {
      type: "string",
    },

    ingredients: {
      type: "array",

      items: {
        type: "string",
      },
    },

    recipe: {
      type: "string",
    },
  },

  required: [
    "error",
    "title",
    "ingredients",
    "recipe",
  ],
};

/* =========================================================
   RECIPE GENERATION
   ========================================================= */

async function generateRecipeFromScan({
  scan,
  scanId,
  fileId,
}) {
  if (!openai) {
    throw new Error(
      "AI service is unavailable."
    );
  }

  console.log(
    `[AI] Starting recipe generation for scan ${scanId}`
  );

  const cuisineStyles = [
    "Mediterranean-inspired",
    "Mexican-inspired",
    "Korean-inspired",
    "Italian-inspired",
    "American-inspired",
    "Middle Eastern-inspired",
    "Japanese-inspired",
  ];

  const hash =
    crypto
      .createHash("sha256")
      .update(String(scanId))
      .digest();

  const cuisine =
    cuisineStyles[
      hash[0] %
        cuisineStyles.length
    ];

  const customization = [
    `Meal type: ${
      scan.mealType || "any"
    }`,

    `Extra ingredients: ${
      scan.extraIngredientsText ||
      "none"
    }`,

    `Corrected ingredients: ${
      scan.correctedIngredientsText ||
      "none"
    }`,

    `Nutrition goals: ${
      Array.isArray(
        scan.nutritionGoals
      )
        ? scan.nutritionGoals.join(
            ", "
          )
        : "none"
    }`,

    `Time limit: ${
      scan.timeLimit || "any"
    }`,

    `Difficulty: ${
      scan.difficulty || "any"
    }`,

    `Equipment: ${
      Array.isArray(
        scan.equipment
      )
        ? scan.equipment.join(
            ", "
          )
        : "any"
    }`,
  ].join("\n");

  const prompt = `
You are SZZLE, an expert chef and recipe developer.

Analyze the food shown in the image and create ONE flavorful recipe using the available ingredients.

Cuisine direction:
${cuisine}

${customization}

Rules:
- If the image clearly contains food, generate a recipe.
- Only return NO_FOOD_DETECTED if the image is clearly unrelated to food.
- Prioritize ingredients that are visibly present.
- Respect corrected ingredients when provided.
- Do not invent major ingredients that are not reasonably available.
- Make the recipe flavorful and practical.
- Use appropriate seasoning.
- Include aromatics when appropriate.
- Include an acid or fresh finishing element when appropriate.
- Make the recipe feel distinct rather than generic.
- Return JSON only.

The title must be short and appetizing.

The ingredients array must contain simple ingredient names only.
Do not include quantities.

The recipe must be one concise paragraph.
Do not use numbered steps.
Do not include measurements.
Do not include cooking times.
Do not include temperatures.

Do not use digits in the recipe.

Return exactly this JSON structure:
{
  "error": null,
  "title": "recipe title",
  "ingredients": ["ingredient one", "ingredient two"],
  "recipe": "one concise recipe paragraph"
}
`;

  console.log(
    "[AI] Sending image to OpenAI..."
  );

  const response =
    await openai.responses.create({
      model:
        "gpt-4o-mini-2024-07-18",

      temperature: 0.35,

      max_output_tokens: 500,

      input: [
        {
          role: "user",

          content: [
            {
              type: "input_text",

              text: prompt,
            },

            {
              type: "input_image",

              file_id: fileId,

              detail: "low",
            },
          ],
        },
      ],

      text: {
        format: {
          type: "json_schema",

          name:
            "szzle_recipe",

          strict: true,

          schema:
            RECIPE_JSON_SCHEMA,
        },
      },
    });

  console.log(
    "[AI] OpenAI response received."
  );

  const outputText =
    getOutputText(response);

  if (!outputText) {
    throw new Error(
      "OpenAI returned an empty response."
    );
  }

  let result;

  try {
    result =
      safeJsonParse(
        outputText
      );
  } catch (err) {
    console.error(
      "[AI] Invalid JSON returned."
    );

    throw new Error(
      "OpenAI returned invalid recipe data."
    );
  }

  if (
    result?.error ===
    "NO_FOOD_DETECTED"
  ) {
    return {
      kind: "error",

      error:
        "NO_FOOD_DETECTED",
    };
  }

  if (
    typeof result?.title !==
      "string" ||
    !result.title.trim() ||

    !Array.isArray(
      result?.ingredients
    ) ||

    result.ingredients.length ===
      0 ||

    typeof result?.recipe !==
      "string" ||

    !result.recipe.trim()
  ) {
    console.error(
      "[AI] Invalid recipe structure."
    );

    throw new Error(
      "OpenAI returned incomplete recipe data."
    );
  }

  return {
    kind: "recipe",

    title:
      result.title.trim(),

    ingredients:
      result.ingredients
        .map((item) =>
          String(item).trim()
        )
        .filter(Boolean),

    recipe:
      result.recipe.trim(),
  };
}

/* =========================================================
   INTERNAL ERROR RESPONSE
   ========================================================= */

function sendInternalError(
  res,
  logMessage,
  err
) {
  console.error(
    logMessage,
    err
  );

  return res.status(500).json({
    error:
      "AI processing failed.",
  });
}

/* =========================================================
   ANALYZE ROUTE
   ========================================================= */

app.post(
  "/analyze",
  async (req, res) => {
    let tempPath = null;
    let openAIFileId = null;
    let scanId = null;

    console.log(
      "[ANALYZE] Request received."
    );

    try {
      if (!openai) {
        return res.status(503).json({
          error:
            "AI service unavailable.",
        });
      }

      cleanupOldScans();

      const {
        deviceId,
        guestId,
        imageBase64,
        mealType,
        extraIngredientsText,
        nutritionGoals,
        timeLimit,
        difficulty,
        equipment,
      } = req.body || {};

      const identityKey =
        getIdentityKey({
          guestId,
          deviceId,
        });

      if (!identityKey) {
        return res.status(400).json({
          error:
            "MISSING_IDENTITY",
        });
      }

      const identityLabel =
        getIdentityLogLabel(
          identityKey
        );

      const imageValidation =
        validateImageBase64(
          imageBase64
        );

      if (
        !imageValidation.ok
      ) {
        return res.status(400).json({
          error:
            imageValidation.error,
        });
      }

      console.log(
        `[ANALYZE] Identity: ${identityLabel}`
      );

      const cooldown =
        enforceCooldown(
          identityKey,
          "analyze",
          ANALYZE_COOLDOWN_SECONDS
        );

      if (!cooldown.ok) {
        return res.status(429).json({
          error:
            "TOO_MANY_REQUESTS",

          retryAfterSeconds:
            cooldown.retryAfterSeconds,
        });
      }

      /* ---------------- CREATE SCAN ---------------- */

      scanId =
        crypto.randomUUID();

      scans[scanId] = {
        ownerKey:
          identityKey,

        createdMs:
          Date.now(),

        imageBase64,

        mealType:
          typeof mealType ===
          "string"
            ? mealType
            : "any",

        extraIngredientsText:
          typeof extraIngredientsText ===
          "string"
            ? extraIngredientsText
            : "",

        correctedIngredientsText:
          "",

        nutritionGoals:
          Array.isArray(
            nutritionGoals
          )
            ? nutritionGoals
            : [],

        timeLimit:
          typeof timeLimit ===
          "string"
            ? timeLimit
            : "any",

        difficulty:
          typeof difficulty ===
          "string"
            ? difficulty
            : "any",

        equipment:
          Array.isArray(
            equipment
          )
            ? equipment
            : [],
      };

      saveScans();

      console.log(
        `[ANALYZE] Scan created: ${scanId}`
      );

      /* ---------------- TEMP IMAGE ---------------- */

      tempPath =
        writeTempJpeg(
          imageBase64
        );

      /* ---------------- OPENAI UPLOAD ---------------- */

      console.log(
        "[ANALYZE] Uploading image to OpenAI..."
      );

      const fileUpload =
        await openai.files.create({
          file:
            fs.createReadStream(
              tempPath
            ),

          purpose:
            "vision",
        });

      openAIFileId =
        fileUpload.id;

      console.log(
        "[ANALYZE] OpenAI file uploaded."
      );

      /* ---------------- GENERATE ---------------- */

      const result =
        await generateRecipeFromScan({
          scan:
            scans[scanId],

          scanId,

          fileId:
            openAIFileId,
        });

      if (
        result.kind === "error"
      ) {
        if (
          result.error ===
          "NO_FOOD_DETECTED"
        ) {
          return res.status(422).json({
            error:
              "NO_FOOD_DETECTED",
          });
        }

        return res.status(500).json({
          error:
            "AI processing failed.",
        });
      }

      console.log(
        `[ANALYZE] SUCCESS: ${result.title}`
      );

      return res.json({
        scanId,

        title:
          result.title,

        ingredients:
          result.ingredients,

        recipe:
          result.recipe,

        mealType:
          scans[scanId]
            .mealType || "any",
      });

    } catch (err) {
      return sendInternalError(
        res,
        "[ANALYZE ERROR]",
        err
      );

    } finally {
      deleteTempFile(
        tempPath
      );

      if (
        openAIFileId
      ) {
        await deleteOpenAIFile(
          openAIFileId
        );
      }
    }
  }
);

/* =========================================================
   REGENERATE ROUTE
   ========================================================= */

app.post(
  "/regenerate",
  async (req, res) => {
    let tempPath = null;
    let openAIFileId = null;

    console.log(
      "[REGENERATE] Request received."
    );

    try {
      if (!openai) {
        return res.status(503).json({
          error:
            "AI service unavailable.",
        });
      }

      cleanupOldScans();

      const {
        deviceId,
        guestId,
        scanId,
        extraIngredientsText,
        correctedIngredientsText,
        mealType,
        nutritionGoals,
        timeLimit,
        difficulty,
        equipment,
      } = req.body || {};

      const identityKey =
        getIdentityKey({
          guestId,
          deviceId,
        });

      if (!identityKey) {
        return res.status(400).json({
          error:
            "MISSING_IDENTITY",
        });
      }

      if (
        !scanId ||
        typeof scanId !==
          "string"
      ) {
        return res.status(400).json({
          error:
            "MISSING_SCAN_ID",
        });
      }

      const scan =
        scans[scanId];

      if (!scan) {
        return res.status(404).json({
          error:
            "SCAN_NOT_FOUND",
        });
      }

      if (
        scan.ownerKey !==
        identityKey
      ) {
        return res.status(403).json({
          error:
            "SCAN_FORBIDDEN",
        });
      }

      const cooldown =
        enforceCooldown(
          identityKey,
          "regenerate",
          REGENERATE_COOLDOWN_SECONDS
        );

      if (!cooldown.ok) {
        return res.status(429).json({
          error:
            "TOO_MANY_REQUESTS",

          retryAfterSeconds:
            cooldown.retryAfterSeconds,
        });
      }

      /* ---------------- UPDATE SCAN ---------------- */

      if (
        typeof extraIngredientsText ===
        "string"
      ) {
        scan.extraIngredientsText =
          extraIngredientsText;
      }

      if (
        typeof correctedIngredientsText ===
        "string"
      ) {
        scan.correctedIngredientsText =
          correctedIngredientsText;
      }

      if (
        typeof mealType ===
        "string"
      ) {
        scan.mealType =
          mealType;
      }

      if (
        Array.isArray(
          nutritionGoals
        )
      ) {
        scan.nutritionGoals =
          nutritionGoals;
      }

      if (
        typeof timeLimit ===
        "string"
      ) {
        scan.timeLimit =
          timeLimit;
      }

      if (
        typeof difficulty ===
        "string"
      ) {
        scan.difficulty =
          difficulty;
      }

      if (
        Array.isArray(
          equipment
        )
      ) {
        scan.equipment =
          equipment;
      }

      scan.updatedMs =
        Date.now();

      saveScans();

      /* ---------------- TEMP IMAGE ---------------- */

      const imageValidation =
        validateImageBase64(
          scan.imageBase64
        );

      if (
        !imageValidation.ok
      ) {
        return res.status(500).json({
          error:
            "Stored image is unavailable.",
        });
      }

      tempPath =
        writeTempJpeg(
          scan.imageBase64
        );

      /* ---------------- OPENAI UPLOAD ---------------- */

      console.log(
        "[REGENERATE] Uploading image to OpenAI..."
      );

      const fileUpload =
        await openai.files.create({
          file:
            fs.createReadStream(
              tempPath
            ),

          purpose:
            "vision",
        });

      openAIFileId =
        fileUpload.id;

      /* ---------------- GENERATE ---------------- */

      const result =
        await generateRecipeFromScan({
          scan,

          scanId,

          fileId:
            openAIFileId,
        });

      if (
        result.kind === "error"
      ) {
        if (
          result.error ===
          "NO_FOOD_DETECTED"
        ) {
          return res.status(422).json({
            error:
              "NO_FOOD_DETECTED",
          });
        }

        return res.status(500).json({
          error:
            "AI processing failed.",
        });
      }

      console.log(
        `[REGENERATE] SUCCESS: ${result.title}`
      );

      return res.json({
        scanId,

        title:
          result.title,

        ingredients:
          result.ingredients,

        recipe:
          result.recipe,

        mealType:
          scan.mealType || "any",
      });

    } catch (err) {
      return sendInternalError(
        res,
        "[REGENERATE ERROR]",
        err
      );

    } finally {
      deleteTempFile(
        tempPath
      );

      if (
        openAIFileId
      ) {
        await deleteOpenAIFile(
          openAIFileId
        );
      }
    }
  }
);

/* =========================================================
   STATUS ROUTE
   ========================================================= */

app.post(
  "/status",
  async (req, res) => {
    try {
      const {
        guestId,
        deviceId,
      } = req.body || {};

      const identityKey =
        getIdentityKey({
          guestId,
          deviceId,
        });

      if (!identityKey) {
        return res.status(400).json({
          error:
            "MISSING_IDENTITY",
        });
      }

      return res.json({
        ok: true,
      });

    } catch (err) {
      console.error(
        "[STATUS ERROR]",
        err
      );

      return res.status(500).json({
        error:
          "STATUS_FAILED",
      });
    }
  }
);

/* =========================================================
   EXPRESS ERROR HANDLER
   ========================================================= */

app.use(
  (
    err,
    _req,
    res,
    _next
  ) => {
    console.error(
      "[EXPRESS ERROR HANDLER]",
      err
    );

    if (
      res.headersSent
    ) {
      return;
    }

    return res.status(500).json({
      error:
        "INTERNAL_SERVER_ERROR",
    });
  }
);

/* =========================================================
   SERVER
   ========================================================= */

const PORT =
  Number(
    process.env.PORT
  ) || 3000;

const server =
  app.listen(
    PORT,
    "0.0.0.0",
    () => {
      console.log(
        `SZZLE backend running on port ${PORT}`
      );
    }
  );

/* =========================================================
   GRACEFUL SHUTDOWN
   ========================================================= */

function shutdown(signal) {
  console.log(
    `[SHUTDOWN] Received ${signal}.`
  );

  clearInterval(
    cleanupInterval
  );

  server.close(() => {
    console.log(
      "[SHUTDOWN] Server closed."
    );

    process.exit(0);
  });

  setTimeout(() => {
    console.error(
      "[SHUTDOWN] Forced shutdown after timeout."
    );

    process.exit(1);
  }, 10000).unref();
}

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);