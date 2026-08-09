import "dotenv/config";

import express from "express";
import OpenAI from "openai";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

/* ---------------- GLOBAL ERROR HANDLERS ---------------- */
/*
 * Without these, an unhandled promise rejection or uncaught exception
 * anywhere in the process (including inside dependencies) will crash
 * the Node process with no logged error, which is what was causing the
 * backend to silently die a few minutes after startup.
 */

process.on("unhandledRejection", (reason, promise) => {
  console.error(
    "[UNHANDLED REJECTION] Promise:",
    promise,
    "Reason:",
    reason
  );
});

process.on("uncaughtException", (err) => {
  console.error(
    "[UNCAUGHT EXCEPTION] The process almost crashed but was kept alive:",
    err
  );
});

const app = express();

app.use(express.json({ limit: "15mb" }));

/* ---------------- REQUEST LOGGING ---------------- */

app.use((req, _res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.path}`);
  next();
});


/* ---------------- BASIC ROUTE ---------------- */

app.get("/", (_req, res) => {
  res.send("FridgeSnap backend running.");
});

/* ---------------- HEALTH CHECK ---------------- */

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

/* ---------------- OPENAI ---------------- */

let openai;

try {
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
} catch (err) {
  console.error(
    "[OPENAI INIT ERROR] Failed to initialize OpenAI client:",
    err
  );

  openai = null;
}

/* ---------------- SCANS STORAGE ---------------- */

const SCANS_FILE = path.join(process.cwd(), "scans.json");

let scans = {};

if (fs.existsSync(SCANS_FILE)) {
  try {
    scans = JSON.parse(
      fs.readFileSync(SCANS_FILE, "utf8")
    );
  } catch (err) {
    console.error("Failed to load scans.json:", err);
    scans = {};
  }
}

function saveScans() {
  try {
    fs.writeFileSync(
      SCANS_FILE,
      JSON.stringify(scans, null, 2)
    );
  } catch (err) {
    console.error("Failed to save scans.json:", err);
  }
}

function cleanupOldScans(days = 14) {
  const cutoff =
    Date.now() - days * 24 * 60 * 60 * 1000;

  let changed = false;

  for (const [scanId, scan] of Object.entries(scans)) {
    if (
      !scan ||
      !scan.createdMs ||
      scan.createdMs < cutoff
    ) {
      delete scans[scanId];
      changed = true;
    }
  }

  if (changed) {
    saveScans();
  }
}

/* ---------------- IDENTITY ---------------- */

function getIdentityKey({ guestId, deviceId }) {
  if (
    guestId &&
    typeof guestId === "string"
  ) {
    return `guest:${guestId}`;
  }

  if (
    deviceId &&
    typeof deviceId === "string"
  ) {
    return `device:${deviceId}`;
  }

  return null;
}

/* ---------------- TEMP IMAGE FILE ---------------- */

function writeTempJpeg(base64) {
  const cleanBase64 = String(base64)
    .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "");

  const buffer = Buffer.from(
    cleanBase64,
    "base64"
  );

  const filename =
    `fridgesnap-${crypto.randomBytes(8).toString("hex")}.jpg`;

  const filepath = path.join(
    os.tmpdir(),
    filename
  );

  fs.writeFileSync(filepath, buffer);

  return filepath;
}

/* ---------------- COOLDOWN ---------------- */

const ANALYZE_COOLDOWN_SECONDS = 60;
const REGENERATE_COOLDOWN_SECONDS = 10;

const cooldowns = new Map();

function enforceCooldown(identityKey, kind, seconds) {
  const key = `${identityKey}:${kind}`;
  const now = Date.now();

  const last = cooldowns.get(key) || 0;
  const elapsed = now - last;

  if (elapsed < seconds * 1000) {
    const remaining =
      seconds -
      Math.floor(elapsed / 1000);

    return {
      ok: false,
      retryAfterSeconds: Math.max(
        1,
        remaining
      ),
    };
  }

  cooldowns.set(key, now);

  return {
    ok: true,
  };
}

/* ---------------- PARSE HELPERS ---------------- */

function getOutputText(response) {
  const output = response?.output || [];

  let text = "";

  for (const item of output) {
    const content = item?.content || [];

    for (const part of content) {
      if (
        part?.type === "output_text" &&
        typeof part?.text === "string"
      ) {
        text += part.text;
      }
    }
  }

  return text.trim();
}

function safeJsonParse(text) {
  const cleaned = String(text || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  return JSON.parse(cleaned);
}
/* ---------------- RECIPE GENERATION ---------------- */

const RECIPE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    error: {
      type: ["string", "null"],
      enum: ["NO_FOOD_DETECTED", null],
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

async function generateRecipeFromScan({
  scan,
  scanId,
  fileId,
}) {
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

  const hash = crypto
    .createHash("sha256")
    .update(String(scanId))
    .digest();

  const cuisine =
    cuisineStyles[
      hash[0] % cuisineStyles.length
    ];

  const customization = [
    `Meal type: ${scan.mealType || "any"}`,
    `Extra ingredients: ${
      scan.extraIngredientsText || "none"
    }`,
    `Corrected ingredients: ${
      scan.correctedIngredientsText || "none"
    }`,
    `Nutrition goals: ${
      Array.isArray(scan.nutritionGoals)
        ? scan.nutritionGoals.join(", ")
        : "none"
    }`,
    `Time limit: ${
      scan.timeLimit || "any"
    }`,
    `Difficulty: ${
      scan.difficulty || "any"
    }`,
    `Equipment: ${
      Array.isArray(scan.equipment)
        ? scan.equipment.join(", ")
        : "any"
    }`,
  ].join("\n");

  const prompt = `
You are FridgeSnap, an expert chef and recipe developer.

Analyze the food shown in the image and create ONE flavorful recipe using the available ingredients.

Cuisine direction:
${cuisine}

${customization}

Rules:
- If the image clearly contains food, generate a recipe.
- Assume the image contains food unless it is obviously unrelated to food.
- If you can identify even one food ingredient, generate a recipe.
- Groceries, packaged food, produce, meat, dairy, drinks, and cooked food all count as food.
- Only return NO_FOOD_DETECTED when the image is clearly not food-related.
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
  "title": "recipe title",
  "ingredients": ["ingredient one", "ingredient two"],
  "recipe": "one concise recipe paragraph"
}
`;

  console.log("[AI] Sending image to OpenAI...");

  const response =
    await openai.responses.create({
      model: "gpt-4o-mini-2024-07-18",
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
          name: "fridgesnap_recipe",
          strict: true,
          schema: RECIPE_JSON_SCHEMA,
        },
      },
    });

  console.log("[AI] OpenAI response received.");

  const outputText =
    getOutputText(response);
	
  console.log("[AI] RAW OUTPUT:", outputText);

  console.log(
    "[AI] Output length:",
    outputText.length
  );

  if (!outputText) {
    throw new Error(
      "OpenAI returned an empty response."
    );
  }

  let result;

  try {
    result = safeJsonParse(outputText);
  } catch (err) {
    console.error(
      "[AI] Invalid JSON returned:",
      outputText
    );

    throw new Error(
      "OpenAI returned invalid recipe JSON."
    );
  }

  if (
    result?.error ===
    "NO_FOOD_DETECTED"
  ) {
    return {
      kind: "error",
      error: "NO_FOOD_DETECTED",
    };
  }

  if (
    !result?.title ||
    !Array.isArray(result?.ingredients) ||
    result.ingredients.length === 0 ||
    !result?.recipe
  ) {
    console.error(
      "[AI] Invalid recipe structure:",
      result
    );

    throw new Error(
      "OpenAI returned an incomplete recipe."
    );
  }

  console.log(
    `[AI] Recipe generated: ${result.title}`
  );

  return {
    kind: "recipe",
    title: String(result.title).trim(),
    ingredients: result.ingredients.map(
      (item) => String(item).trim()
    ),
    recipe: String(result.recipe).trim(),
  };
}
/* ---------------- ANALYZE ROUTE ---------------- */

app.post("/analyze", async (req, res) => {
  let tempPath = null;

  console.log("[ANALYZE] Request received.");

  try {
    cleanupOldScans(14);

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

    console.log("[ANALYZE] Checking identity...");

    const identityKey = getIdentityKey({
      guestId,
      deviceId,
    });

    if (!identityKey) {
      console.error(
        "[ANALYZE] Missing identity."
      );

      return res.status(400).json({
        error: "MISSING_IDENTITY",
      });
    }

    if (
      !imageBase64 ||
      typeof imageBase64 !== "string"
    ) {
      console.error(
        "[ANALYZE] Missing image."
      );

      return res.status(400).json({
        error: "MISSING_IMAGE",
      });
    }

    console.log(
      "[ANALYZE] Identity:",
      identityKey
    );

    /* ---------------- COOLDOWN ---------------- */

    const cooldown =
      enforceCooldown(
        identityKey,
        "analyze",
        ANALYZE_COOLDOWN_SECONDS
      );

    if (!cooldown.ok) {
      console.log(
        `[ANALYZE] Cooldown active: ${cooldown.retryAfterSeconds}s`
      );

      return res.status(429).json({
        error: "TOO_MANY_REQUESTS",
        retryAfterSeconds:
          cooldown.retryAfterSeconds,
      });
    }

    /* ---------------- CREATE SCAN ---------------- */

    const scanId =
      crypto.randomUUID();

    scans[scanId] = {
      ownerKey: identityKey,
      createdMs: Date.now(),

      imageBase64,

      mealType:
        mealType || "any",

      extraIngredientsText:
        typeof extraIngredientsText === "string"
          ? extraIngredientsText
          : "",

      correctedIngredientsText: "",

      nutritionGoals:
        Array.isArray(nutritionGoals)
          ? nutritionGoals
          : [],

      timeLimit:
        timeLimit || "any",

      difficulty:
        difficulty || "any",

      equipment:
        Array.isArray(equipment)
          ? equipment
          : [],
    };

    saveScans();

    console.log(
      `[ANALYZE] Scan created: ${scanId}`
    );

    /* ---------------- WRITE IMAGE ---------------- */

    console.log(
      "[ANALYZE] Writing temporary image..."
    );

    tempPath =
      writeTempJpeg(imageBase64);
	
    fs.copyFileSync(
      tempPath,
      path.join(process.cwd(), "debug-image.jpg")
    );

    console.log("[IMAGE DEBUG] Saved debug-image.jpg");

    const imageBuffer = fs.readFileSync(tempPath);

    console.log("[IMAGE DEBUG] bytes:", imageBuffer.length);
    console.log(
      "[IMAGE DEBUG] JPEG header:",
      imageBuffer.subarray(0, 10).toString("hex")
    );

    console.log(
      "[ANALYZE] Temporary image created."
    );

    /* ---------------- UPLOAD IMAGE ---------------- */

    console.log(
      "[ANALYZE] Uploading image to OpenAI..."
    );

    const fileUpload =
      await openai.files.create({
        file: fs.createReadStream(
          tempPath
        ),
        purpose: "vision",
      });

    console.log(
      "[ANALYZE] OpenAI file uploaded:",
      fileUpload.id
    );

    /* ---------------- GENERATE RECIPE ---------------- */

    console.log(
      "[ANALYZE] Generating recipe..."
    );

    const result =
      await generateRecipeFromScan({
        scan: scans[scanId],
        scanId,
        fileId: fileUpload.id,
      });

    console.log(
      "[ANALYZE] Recipe generation finished."
    );

    /* ---------------- AI ERROR ---------------- */

    if (
      result.kind === "error"
    ) {
      console.log(
        "[ANALYZE] AI returned:",
        result.error
      );

      if (
        result.error ===
        "NO_FOOD_DETECTED"
      ) {
        return res.status(422).json({
          error: "NO_FOOD_DETECTED",
        });
      }

      return res.status(500).json({
        error: result.error,
      });
    }

    /* ---------------- SUCCESS ---------------- */

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
        mealType || "any",
    });

  } catch (err) {
    console.error(
      "[ANALYZE ERROR]",
      err
    );

    return res.status(500).json({
      error:
        err?.message ||
        "AI processing failed",
    });

  } finally {
    if (
      tempPath &&
      fs.existsSync(tempPath)
    ) {
      try {
        fs.unlinkSync(tempPath);

        console.log(
          "[ANALYZE] Temporary image deleted."
        );
      } catch (err) {
        console.error(
          "[ANALYZE] Failed to delete temporary image:",
          err
        );
      }
    }
  }
});
/* ---------------- REGENERATE ROUTE ---------------- */

app.post("/regenerate", async (req, res) => {
  let tempPath = null;

  console.log("[REGENERATE] Request received.");

  try {
    cleanupOldScans(14);

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

    /* ---------------- IDENTITY ---------------- */

    const identityKey =
      getIdentityKey({
        guestId,
        deviceId,
      });

    if (!identityKey) {
      console.error(
        "[REGENERATE] Missing identity."
      );

      return res.status(400).json({
        error: "MISSING_IDENTITY",
      });
    }

    /* ---------------- SCAN ID ---------------- */

    if (
      !scanId ||
      typeof scanId !== "string"
    ) {
      console.error(
        "[REGENERATE] Missing scanId."
      );

      return res.status(400).json({
        error: "MISSING_SCAN_ID",
      });
    }

    /* ---------------- FIND SCAN ---------------- */

    const scan = scans[scanId];

    if (!scan) {
      console.error(
        "[REGENERATE] Scan not found:",
        scanId
      );

      return res.status(404).json({
        error: "SCAN_NOT_FOUND",
      });
    }

    /* ---------------- OWNERSHIP ---------------- */

    if (
      scan.ownerKey !== identityKey
    ) {
      console.error(
        "[REGENERATE] Scan ownership mismatch."
      );

      return res.status(403).json({
        error: "SCAN_FORBIDDEN",
      });
    }

    /* ---------------- COOLDOWN ---------------- */

    const cooldown =
      enforceCooldown(
        identityKey,
        "regenerate",
        REGENERATE_COOLDOWN_SECONDS
      );

    if (!cooldown.ok) {
      console.log(
        `[REGENERATE] Cooldown active: ${cooldown.retryAfterSeconds}s`
      );

      return res.status(429).json({
        error: "TOO_MANY_REQUESTS",
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
      typeof mealType === "string"
    ) {
      scan.mealType = mealType;
    }

    if (
      Array.isArray(nutritionGoals)
    ) {
      scan.nutritionGoals =
        nutritionGoals;
    }

    if (
      typeof timeLimit === "string"
    ) {
      scan.timeLimit = timeLimit;
    }

    if (
      typeof difficulty === "string"
    ) {
      scan.difficulty = difficulty;
    }

    if (
      Array.isArray(equipment)
    ) {
      scan.equipment = equipment;
    }

    scan.updatedMs = Date.now();

    saveScans();

    console.log(
      `[REGENERATE] Using scan: ${scanId}`
    );

    /* ---------------- WRITE IMAGE ---------------- */

    console.log(
      "[REGENERATE] Writing temporary image..."
    );

    tempPath =
      writeTempJpeg(
        scan.imageBase64
      );

    /* ---------------- UPLOAD IMAGE ---------------- */

    console.log(
      "[REGENERATE] Uploading image to OpenAI..."
    );

    const fileUpload =
      await openai.files.create({
        file: fs.createReadStream(
          tempPath
        ),
        purpose: "vision",
      });

    console.log(
      "[REGENERATE] OpenAI file uploaded:",
      fileUpload.id
    );

    /* ---------------- GENERATE ---------------- */

    console.log(
      "[REGENERATE] Generating new recipe..."
    );

    const result =
      await generateRecipeFromScan({
        scan,
        scanId,
        fileId: fileUpload.id,
      });

    console.log(
      "[REGENERATE] Generation finished."
    );

    /* ---------------- AI ERROR ---------------- */

    if (
      result.kind === "error"
    ) {
      console.log(
        "[REGENERATE] AI returned:",
        result.error
      );

      if (
        result.error ===
        "NO_FOOD_DETECTED"
      ) {
        return res.status(422).json({
          error: "NO_FOOD_DETECTED",
        });
      }

      return res.status(500).json({
        error: result.error,
      });
    }

    /* ---------------- SUCCESS ---------------- */

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
    console.error(
      "[REGENERATE ERROR]",
      err
    );

    return res.status(500).json({
      error:
        err?.message ||
        "AI processing failed",
    });

  } finally {
    if (
      tempPath &&
      fs.existsSync(tempPath)
    ) {
      try {
        fs.unlinkSync(tempPath);

        console.log(
          "[REGENERATE] Temporary image deleted."
        );
      } catch (err) {
        console.error(
          "[REGENERATE] Failed to delete temporary image:",
          err
        );
      }
    }
  }
});
/* ---------------- STATUS ROUTE ---------------- */

app.post("/status", async (req, res) => {
  console.log("[STATUS] Request received.");

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
      console.error(
        "[STATUS] Missing identity."
      );

      return res.status(400).json({
        error: "MISSING_IDENTITY",
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
      error: "STATUS_FAILED",
    });
  }
});

/* ---------------- EXPRESS ERROR HANDLER ---------------- */
/*
 * Catches any error thrown/passed to next() from route handlers or
 * other middleware so it can be logged instead of crashing the process.
 */

app.use((err, _req, res, _next) => {
  console.error("[EXPRESS ERROR HANDLER]", err);

  if (res.headersSent) {
    return;
  }

  res.status(500).json({
    error: "INTERNAL_SERVER_ERROR",
  });
});

/* ---------------- SERVER START ---------------- */

const PORT =
  3000;

const server = app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `FridgeSnap backend running on port ${PORT}`
    );
  }
);

/* ---------------- GRACEFUL SHUTDOWN ---------------- */

function shutdown(signal) {
  console.log(
    `[SHUTDOWN] Received ${signal}. Closing server gracefully...`
  );

  server.close(() => {
    console.log("[SHUTDOWN] Server closed. Exiting process.");
    process.exit(0);
  });

  setTimeout(() => {
    console.error(
      "[SHUTDOWN] Forcing shutdown after timeout."
    );
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));