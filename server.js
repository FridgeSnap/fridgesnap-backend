import "dotenv/config";

import express from "express";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "20mb" }));

app.get("/", (_req, res) => {
  res.send("FridgeSnap backend running.");
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ---------------- USERS STORAGE ---------------- */

const USERS_FILE = path.join(process.cwd(), "users.json");
let users = {};

if (fs.existsSync(USERS_FILE)) {
  try {
    users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch {
    users = {};
  }
}

function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function getStartOfWeekMs() {
  const now = new Date();
  const day = now.getDay();
  const start = new Date(now);
  start.setDate(now.getDate() - day);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

function getNextWeekStartMs(weekStartMs) {
  return weekStartMs + 7 * 24 * 60 * 60 * 1000;
}

function getIdentityKey({ guestId, deviceId }) {
  if (guestId && typeof guestId === "string" && guestId.length > 0) {
    return `guest:${guestId}`;
  }
  if (deviceId && typeof deviceId === "string" && deviceId.length > 0) {
    return `device:${deviceId}`;
  }
  return null;
}

function ensureUser(identityKey, fallbackDeviceKey = null) {
  const weekStart = getStartOfWeekMs();

  if (!users[identityKey] && fallbackDeviceKey && users[fallbackDeviceKey]) {
    users[identityKey] = { ...users[fallbackDeviceKey] };
    saveUsers();
  }

  if (!users[identityKey]) {
    users[identityKey] = {
      isPremium: false,
      weekStartMs: weekStart,
      freeUsedThisWeek: 0,
      lastAnalyzeMs: 0,
      lastRegenMs: 0,
      isLockedUntilReset: false,
      unlockAtMs: 0,
    };
    saveUsers();
  }

  const user = users[identityKey];

  if (typeof user.isPremium !== "boolean") user.isPremium = false;
  if (typeof user.weekStartMs !== "number") user.weekStartMs = weekStart;
  if (typeof user.freeUsedThisWeek !== "number") user.freeUsedThisWeek = 0;
  if (typeof user.lastAnalyzeMs !== "number") user.lastAnalyzeMs = 0;
  if (typeof user.lastRegenMs !== "number") user.lastRegenMs = 0;
  if (typeof user.isLockedUntilReset !== "boolean") user.isLockedUntilReset = false;
  if (typeof user.unlockAtMs !== "number") user.unlockAtMs = 0;

  if (user.weekStartMs !== weekStart) {
    user.weekStartMs = weekStart;
    user.freeUsedThisWeek = 0;
    user.lastAnalyzeMs = 0;
    user.lastRegenMs = 0;
    user.isLockedUntilReset = false;
    user.unlockAtMs = 0;
    saveUsers();
  }

  if (user.unlockAtMs > 0 && Date.now() >= user.unlockAtMs) {
    user.isLockedUntilReset = false;
    user.unlockAtMs = 0;
    saveUsers();
  }

  return user;
}

/* ---------------- SCANS STORAGE ---------------- */

const SCANS_FILE = path.join(process.cwd(), "scans.json");
let scans = {};

if (fs.existsSync(SCANS_FILE)) {
  try {
    scans = JSON.parse(fs.readFileSync(SCANS_FILE, "utf8"));
  } catch {
    scans = {};
  }
}

function saveScans() {
  fs.writeFileSync(SCANS_FILE, JSON.stringify(scans, null, 2));
}

function cleanupOldScans(days = 14) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let changed = false;

  for (const [scanId, s] of Object.entries(scans)) {
    if (!s?.createdMs || s.createdMs < cutoff) {
      delete scans[scanId];
      changed = true;
    }
  }

  if (changed) saveScans();
}

/* ---------------- HELPERS ---------------- */

function makeDataUrl(base64) {
  return `data:image/jpeg;base64,${base64}`;
}

function sanitizeFreeRecipe(text) {
  let recipe = String(text || "").trim();
  recipe = recipe.replace(/^\s*\d+\s*[\).\:-]\s*/gm, "");
  recipe = recipe.replace(/\d+([\/.]\d+)?/g, "");
  recipe = recipe.replace(
    /\b(cups?|tbsp|tablespoons?|tsp|teaspoons?|oz|ounces?|grams?|g|kg|ml|l|minutes?|mins?|degrees?|°f|°c|fahrenheit|celsius)\b/gi,
    ""
  );
  recipe = recipe.replace(/\s{2,}/g, " ").trim();
  return recipe;
}

function getOutputText(resp) {
  const blocks = resp?.output || [];
  let text = "";

  for (const item of blocks) {
    const content = item?.content || [];
    for (const c of content) {
      if (c?.type === "output_text" && typeof c?.text === "string") {
        text += c.text;
      }
    }
  }

  return text.trim();
}

function safeJsonParse(text) {
  const cleaned = String(text || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  return JSON.parse(cleaned);
}

function enforceCooldown({ user, kind, seconds }) {
  const nowMs = Date.now();
  const field = kind === "regen" ? "lastRegenMs" : "lastAnalyzeMs";
  const last = user[field] || 0;
  const elapsed = nowMs - last;
  const remaining = seconds - Math.floor(elapsed / 1000);

  if (elapsed < seconds * 1000) {
    return { ok: false, retryAfterSeconds: Math.max(1, remaining) };
  }

  user[field] = nowMs;
  return { ok: true };
}

const MEAT_KEYWORDS = [
  "chicken",
  "beef",
  "steak",
  "ground beef",
  "pork",
  "bacon",
  "turkey",
  "salmon",
  "shrimp",
  "sausage",
  "lamb",
  "ham",
  "tuna",
];

function hasMeatSignal(scan, detectedItems = []) {
  const hay = [
    scan?.correctedIngredientsText || "",
    scan?.extraIngredientsText || "",
    Array.isArray(scan?.nutritionGoals) ? scan.nutritionGoals.join(" ") : "",
    detectedItems.map((x) => x.name).join(" "),
  ]
    .join(" ")
    .toLowerCase();

  return MEAT_KEYWORDS.some((k) => hay.includes(k));
}

const CUISINE_STYLES = [
  "Mediterranean",
  "Mexican",
  "Korean",
  "Italian",
  "American",
  "Middle Eastern",
  "Japanese",
];

function pickCuisine(scanId) {
  if (!scanId) {
    return CUISINE_STYLES[Math.floor(Math.random() * CUISINE_STYLES.length)];
  }
  const h = crypto.createHash("sha256").update(String(scanId)).digest();
  return CUISINE_STYLES[h[0] % CUISINE_STYLES.length];
}

/* ---------------- SCHEMAS ---------------- */

const DETECTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          category: {
            type: "string",
            enum: [
              "produce",
              "leftover",
              "cooked_food",
              "meat",
              "seafood",
              "dairy",
              "drink",
              "condiment",
              "pantry",
              "sauce",
              "other_food",
            ],
          },
          confidence: {
            type: "string",
            enum: ["high", "medium", "low"],
          },
        },
        required: ["name", "category", "confidence"],
      },
    },
  },
  required: ["items"],
};

const FREE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    error: { type: "string", enum: ["NO_FOOD_DETECTED"] },
    title: { type: "string" },
    ingredients: { type: "array", items: { type: "string" } },
    recipe: { type: "string" },
  },
};

const PREMIUM_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    error: { type: "string", enum: ["NO_FOOD_DETECTED"] },
    title: { type: "string" },
    ingredients: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          item: { type: "string" },
          amount: { type: "string" },
        },
        required: ["item", "amount"],
      },
    },
    steps: { type: "array", items: { type: "string" } },
    servings: { type: "string" },
    timeMinutes: { type: "number" },
    macros: {
      type: "object",
      additionalProperties: false,
      properties: {
        calories: { type: "number" },
        proteinGrams: { type: "number" },
        carbsGrams: { type: "number" },
        fatGrams: { type: "number" },
      },
      required: ["calories", "proteinGrams", "carbsGrams", "fatGrams"],
    },
  },
  required: ["title", "ingredients", "steps", "servings", "timeMinutes", "macros"],
};

/* ---------------- DEBUG ---------------- */

const DEBUG_SECRET = "abc123";

app.post("/debug/setPremium", (req, res) => {
  const secret = req.headers["x-debug-secret"];
  if (secret !== DEBUG_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { deviceId, guestId, isPremium } = req.body || {};
  const identityKey = getIdentityKey({ guestId, deviceId });
  const fallbackDeviceKey =
    deviceId && typeof deviceId === "string" ? `device:${deviceId}` : null;

  if (!identityKey) {
    return res.status(400).json({ error: "Missing identity" });
  }

  const user = ensureUser(identityKey, fallbackDeviceKey);
  user.isPremium = isPremium === true;

  if (user.isPremium) {
    user.isLockedUntilReset = false;
    user.unlockAtMs = 0;
  }

  saveUsers();

  return res.json({
    ok: true,
    identityKey,
    isPremium: user.isPremium,
  });
});

/* ---------------- DETECTION ---------------- */

async function detectFoodItemsFromImage(imageDataUrl) {
  const resp = await openai.responses.create({
    model: "gpt-4o-mini-2024-07-18",
    temperature: 0.1,
    max_output_tokens: 500,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "Identify visible food in this fridge image. Include raw ingredients, drinks, condiments, pantry items, and prepared leftovers inside containers. " +
              "If a container appears to hold cooked pasta, spaghetti, salad, soup, rice, stir-fry, roasted vegetables, cooked meat, or mixed leftovers, name that prepared food directly. " +
              "Return JSON only.",
          },
          { type: "input_image", image_url: imageDataUrl, detail: "high" },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "detection",
        strict: false,
        schema: DETECTION_JSON_SCHEMA,
      },
    },
  });

  const obj = safeJsonParse(getOutputText(resp));
  return Array.isArray(obj?.items) ? obj.items : [];
}

/* ---------------- GENERATION ---------------- */

async function generateRecipeFromScan({
  scan,
  scanId,
  isPremium,
  imageDataUrl,
  detectedItems = [],
}) {
  const cuisine = pickCuisine(scanId);
  const meatSignal = hasMeatSignal(scan, detectedItems);

  const detectedItemsBlock = detectedItems.length
    ? `Detected items:
${detectedItems
  .map((x) => `- ${x.name} (${x.category}, ${x.confidence})`)
  .join("\n")}\n`
    : "";

  const ingredientOverrideBlock = scan.correctedIngredientsText
    ? `Corrected ingredients (strict override): ${scan.correctedIngredientsText}
If this corrected list conflicts with the image, trust the corrected list.
Do not reintroduce removed ingredients even if visible in the image.`
    : `Extra ingredients: ${scan.extraIngredientsText || "none"}`;

  const preferencesBlock =
    `Meal type: ${scan.mealType || "any"}
${ingredientOverrideBlock}
Nutrition goals: ${(Array.isArray(scan.nutritionGoals) ? scan.nutritionGoals : []).join(", ") || "none"}
Time limit: ${scan.timeLimit || "any"}
Difficulty: ${scan.difficulty || "any"}
Equipment: ${(Array.isArray(scan.equipment) ? scan.equipment : []).join(", ") || "any"}`;

  const coreRules = [
    "You are a sharp food-vision cooking assistant and strong recipe writer.",
    "Identify both raw ingredients and prepared leftovers.",
    "Food inside containers, jars, bowls, meal prep boxes, and covered dishes counts as usable food.",
    "If a container strongly looks like cooked spaghetti, pasta, salad, soup, rice, stir-fry, or roasted leftovers, treat that as real prepared food.",
    "Prefer visible food over packaging text, but use packaging text to confirm items like broth, tomato paste, sauces, and drinks.",
    "Only return NO_FOOD_DETECTED if the image is clearly unrelated to food.",
    `Cuisine direction: ${cuisine}.`,
    "Write flavorful, appealing recipes, not bland ones.",
    "Use seasoning, aromatics, acid, and a finishing touch when appropriate.",
    meatSignal
      ? "If meat or seafood is available, make it the centerpiece."
      : "If meat or seafood is available, make it the centerpiece.",
  ].join("\n");

  if (!isPremium) {
    const resp = await openai.responses.create({
      model: "gpt-4o-mini-2024-07-18",
      temperature: 0.4,
      max_output_tokens: 420,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                `${coreRules}\n\n` +
                `${detectedItemsBlock}\n` +
                `Return JSON only with:
- title: short appetizing recipe name
- ingredients: simple ingredient names only
- recipe: exactly one short appealing paragraph, no numbered steps, no measurements, no times, no temperatures

If there are corrected ingredients, never use ingredients outside that corrected list unless they are basic seasonings or staples.

Preferences:
${preferencesBlock}`,
            },
            { type: "input_image", image_url: imageDataUrl, detail: "low" },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "free",
          strict: false,
          schema: FREE_JSON_SCHEMA,
        },
      },
    });

    const obj = safeJsonParse(getOutputText(resp));

    if (obj?.error === "NO_FOOD_DETECTED") {
      return { kind: "error", error: "NO_FOOD_DETECTED" };
    }

    const title = String(obj?.title || "").trim() || "Fridge Find";
    const ingredients = Array.isArray(obj?.ingredients) ? obj.ingredients : [];
    const recipe = sanitizeFreeRecipe(obj?.recipe);

    if (!title || !ingredients.length || !recipe) {
      return { kind: "error", error: "AI_BAD_OUTPUT" };
    }

    return { kind: "free", title, ingredients, recipe };
  }

  const resp = await openai.responses.create({
    model: "gpt-4o-mini-2024-07-18",
    temperature: 0.35,
    max_output_tokens: 760,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              `${coreRules}\n\n` +
              `${detectedItemsBlock}\n` +
              `Return JSON only with:
- title: short appetizing recipe name
- ingredients: list of {item, amount}
- steps: clear step-by-step array
- servings: short string
- timeMinutes: number
- macros: { calories:number, proteinGrams:number, carbsGrams:number, fatGrams:number }

Rules:
- Make the dish taste genuinely good.
- If leftovers are detected, intelligently transform or reuse them.
- If corrected ingredients are provided, trust them over the image.
- Keep steps practical and home-cook friendly.

Preferences:
${preferencesBlock}`,
          },
          { type: "input_image", image_url: imageDataUrl, detail: "low" },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "premium",
        strict: false,
        schema: PREMIUM_JSON_SCHEMA,
      },
    },
  });

  const obj = safeJsonParse(getOutputText(resp));

  if (obj?.error === "NO_FOOD_DETECTED") {
    return { kind: "error", error: "NO_FOOD_DETECTED" };
  }

  if (
    !obj?.title ||
    !Array.isArray(obj?.ingredients) ||
    !Array.isArray(obj?.steps) ||
    !obj?.servings ||
    typeof obj?.timeMinutes !== "number" ||
    !obj?.macros
  ) {
    return { kind: "error", error: "AI_BAD_OUTPUT" };
  }

  return {
    kind: "premium",
    title: obj.title,
    ingredients: obj.ingredients,
    steps: obj.steps,
    servings: obj.servings,
    timeMinutes: obj.timeMinutes,
    macros: obj.macros,
  };
}

/* ---------------- ROUTES ---------------- */

app.post("/status", async (req, res) => {
  try {
    const { guestId, deviceId } = req.body || {};
    const identityKey = getIdentityKey({ guestId, deviceId });
    const fallbackDeviceKey =
      deviceId && typeof deviceId === "string" ? `device:${deviceId}` : null;

    if (!identityKey) {
      return res.status(400).json({ error: "MISSING_IDENTITY" });
    }

    const user = ensureUser(identityKey, fallbackDeviceKey);

    return res.json({
      isPremium: !!user.isPremium,
      isLockedUntilReset: !!user.isLockedUntilReset,
      unlockAtMs: user.unlockAtMs || 0,
      freeUsedThisWeek: user.freeUsedThisWeek || 0,
    });
  } catch (err) {
    console.error("STATUS ERROR:", err);
    return res.status(500).json({ error: "STATUS_FAILED" });
  }
});

app.post("/analyze", async (req, res) => {
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

    const identityKey = getIdentityKey({ guestId, deviceId });
    const fallbackDeviceKey =
      deviceId && typeof deviceId === "string" ? `device:${deviceId}` : null;

    if (!identityKey) {
      return res.status(400).json({ error: "Missing identity" });
    }

    if (!imageBase64 || typeof imageBase64 !== "string") {
      return res.status(400).json({ error: "Missing imageBase64" });
    }

    const user = ensureUser(identityKey, fallbackDeviceKey);
    const isPremium = user.isPremium === true;

    const ANALYZE_COOLDOWN_SECONDS = 60;
    const cd = enforceCooldown({ user, kind: "analyze", seconds: ANALYZE_COOLDOWN_SECONDS });
    if (!cd.ok) {
      saveUsers();
      return res.status(429).json({
        error: "TOO_MANY_REQUESTS",
        retryAfterSeconds: cd.retryAfterSeconds,
      });
    }
    saveUsers();

    const FREE_LIMIT = 4;
    if (!isPremium) {
      if (user.freeUsedThisWeek >= FREE_LIMIT) {
        const unlockAtMs = getNextWeekStartMs(user.weekStartMs);
        user.isLockedUntilReset = true;
        user.unlockAtMs = unlockAtMs;
        saveUsers();

        return res.status(403).json({
          error: "FREE_LIMIT_REACHED",
          usedThisWeek: user.freeUsedThisWeek,
          limitPerWeek: FREE_LIMIT,
          unlockAtMs,
        });
      }

      user.freeUsedThisWeek += 1;
      saveUsers();
    }

    const scanId = crypto.randomUUID();
    scans[scanId] = {
      ownerKey: identityKey,
      createdMs: Date.now(),
      imageBase64,
      mealType: mealType || "any",
      extraIngredientsText: extraIngredientsText || "",
      correctedIngredientsText: "",
      nutritionGoals: Array.isArray(nutritionGoals) ? nutritionGoals : [],
      timeLimit: timeLimit || "any",
      difficulty: difficulty || "any",
      equipment: Array.isArray(equipment) ? equipment : [],
      regenCount: 0,
    };
    saveScans();

    const imageDataUrl = makeDataUrl(imageBase64);
    const detectedItems = await detectFoodItemsFromImage(imageDataUrl);

    const out = await generateRecipeFromScan({
      scan: scans[scanId],
      scanId,
      isPremium,
      imageDataUrl,
      detectedItems,
    });

    if (out.kind === "error") {
      const status = out.error === "NO_FOOD_DETECTED" ? 422 : 500;
      return res.status(status).json({ error: out.error });
    }

    if (out.kind === "free") {
      return res.json({
        scanId,
        isPremium: false,
        mealType: mealType || "any",
        title: out.title,
        ingredients: out.ingredients,
        recipe: out.recipe,
        usedThisWeek: user.freeUsedThisWeek,
        limitPerWeek: FREE_LIMIT,
        detectedItems,
      });
    }

    return res.json({
      scanId,
      isPremium: true,
      mealType: mealType || "any",
      title: out.title,
      ingredients: out.ingredients,
      steps: out.steps,
      servings: out.servings,
      timeMinutes: out.timeMinutes,
      macros: out.macros,
      detectedItems,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "AI processing failed" });
  }
});

app.post("/regenerate", async (req, res) => {
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

    const identityKey = getIdentityKey({ guestId, deviceId });
    const fallbackDeviceKey =
      deviceId && typeof deviceId === "string" ? `device:${deviceId}` : null;

    if (!identityKey) {
      return res.status(400).json({ error: "Missing identity" });
    }

    if (!scanId || typeof scanId !== "string") {
      return res.status(400).json({ error: "Missing scanId" });
    }

    const scan = scans[scanId];
    if (!scan) {
      return res.status(404).json({ error: "SCAN_NOT_FOUND" });
    }

    if (scan.ownerKey !== identityKey) {
      return res.status(403).json({ error: "SCAN_FORBIDDEN" });
    }

    const user = ensureUser(identityKey, fallbackDeviceKey);
    const isPremium = user.isPremium === true;

    if (!isPremium && (scan.regenCount || 0) >= 1) {
      return res.status(403).json({ error: "REGEN_LIMIT_REACHED" });
    }

    const REGEN_COOLDOWN_SECONDS = 10;
    const cd = enforceCooldown({ user, kind: "regen", seconds: REGEN_COOLDOWN_SECONDS });
    if (!cd.ok) {
      saveUsers();
      return res.status(429).json({
        error: "TOO_MANY_REQUESTS",
        retryAfterSeconds: cd.retryAfterSeconds,
      });
    }
    saveUsers();

    if (typeof extraIngredientsText === "string") {
      scan.extraIngredientsText = extraIngredientsText;
    }
    if (typeof correctedIngredientsText === "string") {
      scan.correctedIngredientsText = correctedIngredientsText;
    }
    if (typeof mealType === "string") {
      scan.mealType = mealType;
    }
    if (Array.isArray(nutritionGoals)) {
      scan.nutritionGoals = nutritionGoals;
    }
    if (typeof timeLimit === "string") {
      scan.timeLimit = timeLimit;
    }
    if (typeof difficulty === "string") {
      scan.difficulty = difficulty;
    }
    if (Array.isArray(equipment)) {
      scan.equipment = equipment;
    }

    scan.updatedMs = Date.now();

    if (!isPremium) {
      scan.regenCount = (scan.regenCount || 0) + 1;
    }

    scans[scanId] = scan;
    saveScans();

    const imageDataUrl = makeDataUrl(scan.imageBase64);
    const detectedItems = await detectFoodItemsFromImage(imageDataUrl);

    const out = await generateRecipeFromScan({
      scan,
      scanId,
      isPremium,
      imageDataUrl,
      detectedItems,
    });

    if (out.kind === "error") {
      const status = out.error === "NO_FOOD_DETECTED" ? 422 : 500;
      return res.status(status).json({ error: out.error });
    }

    const FREE_LIMIT = 4;

    if (out.kind === "free") {
      return res.json({
        scanId,
        isPremium: false,
        mealType: scan.mealType || "any",
        title: out.title,
        ingredients: out.ingredients,
        recipe: out.recipe,
        usedThisWeek: user.freeUsedThisWeek,
        limitPerWeek: FREE_LIMIT,
        detectedItems,
      });
    }

    return res.json({
      scanId,
      isPremium: true,
      mealType: scan.mealType || "any",
      title: out.title,
      ingredients: out.ingredients,
      steps: out.steps,
      servings: out.servings,
      timeMinutes: out.timeMinutes,
      macros: out.macros,
      detectedItems,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "AI processing failed" });
  }
});

app.listen(3000, "0.0.0.0", () => {
  console.log("Server running on port 3000");
});