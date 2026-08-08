import "dotenv/config";

import express from "express";
import OpenAI from "openai";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

// Global error handlers - MUST be first
process.on("unhandledRejection", (reason, promise) => {
  console.error("[FATAL] Unhandled Rejection:", reason);
  // Don't exit, let the app keep running
});

process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught Exception:", err);
  // Don't exit, let the app keep running
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

app.get("/health", (_req, res) => {
  res.json({ ok: true, timestamp: Date.now() });
});

/* ---------------- OPENAI ---------------- */

let openai;
try {
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
  console.log("[INIT] OpenAI client initialized");
} catch (err) {
  console.error("[INIT ERROR] Failed to initialize OpenAI:", err);
  // Continue anyway, routes will fail gracefully
}

/* ---------------- SCANS STORAGE ---------------- */

const SCANS_FILE = path.join(process.cwd(), "scans.json");

let scans = {};

if (fs.existsSync(SCANS_FILE)) {
  try {
    scans = JSON.parse(
      fs.readFileSync(SCANS_FILE, "utf8")
    );
    console.log("[INIT] Loaded scans.json");
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

/* ---------------- COOLDOWN & RATE LIMITING ---------------- */

const ANALYZE_COOLDOWN_SECONDS = 10;
const REGENERATE_COOLDOWN_SECONDS = 5;
const COOLDOWNS = {};

function enforceCooldown(
  identityKey,
  action,
  cooldownSeconds
) {
  const key = `${identityKey}:${action}`;
  const now = Date.now();
  const last = COOLDOWNS[key] || 0;
  const elapsed = Math.floor((now - last) / 1000);

  if (elapsed < cooldownSeconds) {
    return {
      ok: false,
      retryAfterSeconds:
        cooldownSeconds - elapsed,
    };
  }

  COOLDOWNS[key] = now;

  return { ok: true };
}

/* ---------------- AI HELPERS ---------------- */

function getOutputText(response) {
  if (!response?.choices?.[0]) return "";

  const choice = response.choices[0];

  if (choice.message?.content) {
    return choice.message.content;
  }

  if (choice.text) {
    return choice.text;
  }

  return "";
}

function safeJsonParse(text) {
  // Try to find JSON in the text
  const jsonMatch =
    text.match(/\{[\s\S]*\}/);

  if (jsonMatch) {
    return JSON.parse(jsonMatch[0]);
  }

  // Fallback: parse as-is
  return JSON.parse(text);
}

async function callOpenAI(
  systemPrompt,
  userMessage
) {
  if (!openai) {
    throw new Error("OpenAI client not initialized");
  }

  try {
    const response =
      await openai.chat.completions.create({
        model: "gpt-4-vision",
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: userMessage,
          },
        ],
        temperature: 0.3,
        max_tokens: 2000,
      });

    return response;
  } catch (err) {
    console.error(
      "[OpenAI API Error]",
      err?.message || err
    );
    throw err;
  }
}

async function generateRecipe(
  systemPrompt,
  userMessage
) {
  const response =
    await callOpenAI(
      systemPrompt,
      userMessage
    );

  const outputText =
    getOutputText(response);

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
    kind: "success",
    title: result.title,
    ingredients: result.ingredients,
    recipe: result.recipe,
  };
}

/* ============================================
   ANALYZE ROUTE
   ============================================ */

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

    /* COOLDOWN */

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
        error: "RATE_LIMITED",
        retryAfterSeconds:
          cooldown.retryAfterSeconds,
      });
    }

    /* IMAGE PROCESSING */

    const tempDir = os.tmpdir();
    tempPath = path.join(
      tempDir,
      `scan_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2)}.jpg`
    );

    const imageBuffer = Buffer.from(
      imageBase64,
      "base64"
    );

    fs.writeFileSync(tempPath, imageBuffer);

    console.log(
      "[ANALYZE] Temporary image written to:",
      tempPath
    );

    /* AI PROCESSING */

    const systemPrompt = `You are a helpful food analysis and recipe generation assistant. When given an image of food, analyze it to:
1. Identify the main ingredients
2. Generate a creative recipe using those ingredients

Respond with ONLY valid JSON (no markdown, no extra text). If you cannot identify food in the image, respond with: {"error": "NO_FOOD_DETECTED"}

For a valid food image, respond with this exact structure:
{
  "title": "Recipe Name",
  "ingredients": [{"name": "ingredient", "amount": "quantity", "unit": "unit"}],
  "recipe": "Step-by-step instructions"
}`;

    const userMessage = `Please analyze this food image and generate a recipe. Extra ingredients available: ${extraIngredientsText || "none"}. Nutrition goals: ${nutritionGoals || "balanced"}. Time limit: ${timeLimit || "30 minutes"}. Difficulty: ${difficulty || "medium"}. Equipment: ${equipment || "standard kitchen"}.`;

    const result =
      await generateRecipe(
        systemPrompt,
        userMessage
      );

    if (result.kind === "error") {
      return res.status(400).json({
        error: result.error,
      });
    }

    /* SAVE SCAN */

    const scanId = crypto
      .randomBytes(16)
      .toString("hex");

    scans[scanId] = {
      deviceId,
      guestId,
      createdMs: Date.now(),
      mealType: mealType || "any",
      title: result.title,
      ingredients: result.ingredients,
      recipe: result.recipe,
      imageBase64,
    };

    saveScans();

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

/* ============================================
   REGENERATE ROUTE
   ============================================ */

app.post("/regenerate", async (req, res) => {
  let tempPath = null;

  console.log("[REGENERATE] Request received.");

  try {
    const {
      deviceId,
      guestId,
      scanId,
      nutritionGoals,
      timeLimit,
      difficulty,
      equipment,
    } = req.body || {};

    const identityKey = getIdentityKey({
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

    if (!scanId || typeof scanId !== "string") {
      console.error(
        "[REGENERATE] Missing or invalid scanId."
      );

      return res.status(400).json({
        error: "MISSING_SCAN_ID",
      });
    }

    /* COOLDOWN */

    const cooldown =
      enforceCooldown(
        identityKey,
        "regenerate",
        REGENERATE_COOLDOWN_SECONDS
      );

    if (!cooldown.ok) {
      return res.status(429).json({
        error: "RATE_LIMITED",
        retryAfterSeconds:
          cooldown.retryAfterSeconds,
      });
    }

    /* FETCH SCAN */

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

    if (
      scan.guestId !== guestId &&
      scan.deviceId !== deviceId
    ) {
      console.error(
        "[REGENERATE] Unauthorized access to scan:",
        scanId
      );

      return res.status(403).json({
        error: "UNAUTHORIZED",
      });
    }

    /* IMAGE PROCESSING */

    const tempDir = os.tmpdir();
    tempPath = path.join(
      tempDir,
      `regenerate_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2)}.jpg`
    );

    const imageBuffer = Buffer.from(
      scan.imageBase64,
      "base64"
    );

    fs.writeFileSync(tempPath, imageBuffer);

    /* AI PROCESSING */

    const systemPrompt = `You are a helpful recipe generation assistant. Given an image analysis, generate a NEW and DIFFERENT recipe.

Respond with ONLY valid JSON (no markdown, no extra text):
{
  "title": "New Recipe Name",
  "ingredients": [{"name": "ingredient", "amount": "quantity", "unit": "unit"}],
  "recipe": "Step-by-step instructions"
}`;

    const userMessage = `Generate a DIFFERENT recipe from the food in this image. Original recipe was: "${scan.title}". Nutrition goals: ${nutritionGoals || "balanced"}. Time limit: ${timeLimit || "30 minutes"}. Difficulty: ${difficulty || "medium"}. Equipment: ${equipment || "standard kitchen"}.`;

    const result =
      await generateRecipe(
        systemPrompt,
        userMessage
      );

    if (result.kind === "error") {
      return res.status(400).json({
        error: result.error,
      });
    }

    /* UPDATE SCAN */

    scans[scanId] = {
      ...scan,
      createdMs: Date.now(),
      title: result.title,
      ingredients: result.ingredients,
      recipe: result.recipe,
    };

    saveScans();

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

/* ============================================
   STATUS ROUTE
   ============================================ */

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

/* ============================================
   ERROR HANDLERS
   ============================================ */

app.use((err, req, res, next) => {
  console.error("[Express Error Handler]", err);
  res.status(500).json({
    error: "Internal server error",
    message: err?.message,
  });
});

/* ============================================
   SERVER START
   ============================================ */

const PORT =
  Number(process.env.PORT) || 3000;

const server = app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `FridgeSnap backend running on port ${PORT}`
    );
    console.log(`Health check available at http://localhost:${PORT}/health`);
  }
);

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[SHUTDOWN] SIGTERM received, shutting down gracefully...");
  server.close(() => {
    console.log("[SHUTDOWN] Server closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log("[SHUTDOWN] SIGINT received, shutting down gracefully...");
  server.close(() => {
    console.log("[SHUTDOWN] Server closed");
    process.exit(0);
  });
});

