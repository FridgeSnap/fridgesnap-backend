// MUST be line 1 — loads .env BEFORE anything else
import "dotenv/config";

import express from "express";
import OpenAI from "openai";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "15mb" }));

app.get("/", (req, res) => {
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
  const day = now.getDay(); // 0=Sun
  const start = new Date(now);
  start.setDate(now.getDate() - day);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

function getNextWeekStartMs(weekStartMs) {
  return weekStartMs + 7 * 24 * 60 * 60 * 1000;
}

function ensureUser(deviceId) {
  const weekStart = getStartOfWeekMs();

  if (!users[deviceId]) {
    users[deviceId] = {
      isPremium: false,
      weekStartMs: weekStart,
      freeUsedThisWeek: 0,
      lastAnalyzeMs: 0,
      lastRegenMs: 0,
    };
    saveUsers();
  }

  const user = users[deviceId];

  // normalize older shapes
  if (typeof user.isPremium !== "boolean") user.isPremium = false;
  if (typeof user.weekStartMs !== "number") user.weekStartMs = weekStart;
  if (typeof user.freeUsedThisWeek !== "number") user.freeUsedThisWeek = 0;
  if (typeof user.lastAnalyzeMs !== "number") user.lastAnalyzeMs = 0;
  if (typeof user.lastRegenMs !== "number") user.lastRegenMs = 0;

  // weekly reset
  if (user.weekStartMs !== weekStart) {
    user.weekStartMs = weekStart;
    user.freeUsedThisWeek = 0;
    user.lastAnalyzeMs = 0;
    user.lastRegenMs = 0;
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

/* ---------------- TEMP FILE HELPER ---------------- */

function writeTempJpeg(base64) {
  const buf = Buffer.from(base64, "base64");
  const filename = `fridgesnap-${crypto.randomBytes(8).toString("hex")}.jpg`;
  const filepath = path.join(os.tmpdir(), filename);
  fs.writeFileSync(filepath, buf);
  return filepath;
}

/* ---------------- FREE SANITIZER ---------------- */

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

/* ---------------- JSON SCHEMAS (PLAIN) ----------------
   Root MUST be { type: "object" } or OpenAI throws errors.
*/

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
  if (secret !== DEBUG_SECRET) return res.status(403).json({ error: "Forbidden" });

  const { deviceId, isPremium } = req.body || {};
  if (!deviceId || typeof deviceId !== "string") return res.status(400).json({ error: "Missing deviceId" });

  const user = ensureUser(deviceId);
  user.isPremium = isPremium === true;
  saveUsers();

  return res.json({ ok: true, deviceId, isPremium: user.isPremium });
});

/* ---------------- RATE LIMIT ---------------- */

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

/* ---------------- PARSE HELPERS ---------------- */

function getOutputText(resp) {
  // Responses API returns "output" array; extract concatenated text blocks.
  const blocks = resp?.output || [];
  let text = "";
  for (const item of blocks) {
    const content = item?.content || [];
    for (const c of content) {
      if (c?.type === "output_text" && typeof c?.text === "string") text += c.text;
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

/* ---------------- RECIPE QUALITY HELPERS ---------------- */

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

function hasMeatSignal(scan) {
  const hay = [
    scan?.extraIngredientsText || "",
    Array.isArray(scan?.nutritionGoals) ? scan.nutritionGoals.join(" ") : "",
  ]
    .join(" ")
    .toLowerCase();

  return MEAT_KEYWORDS.some((k) => hay.includes(k));
}

const CUISINE_STYLES = [
  "Mediterranean-inspired",
  "Mexican-inspired",
  "Korean-inspired",
  "Italian trattoria-inspired",
  "American steakhouse-inspired",
  "Middle Eastern-inspired",
  "Japanese-inspired",
];

function pickCuisine(scanId) {
  if (!scanId) return CUISINE_STYLES[Math.floor(Math.random() * CUISINE_STYLES.length)];
  const h = crypto.createHash("sha256").update(String(scanId)).digest();
  const n = h[0]; // 0-255
  return CUISINE_STYLES[n % CUISINE_STYLES.length];
}

/* ---------------- OPENAI GENERATION ---------------- */

async function generateRecipeFromScan({ scan, scanId, isPremium, fileId }) {
  // Stronger “chef brain” — drives tastier results
  const chefBrain = [
    "You are a professional chef and recipe developer.",
    "Assume ingredients may be partially obscured. If packaging is unclear, infer cautiously but prioritize clearly visible food items.",
    "Write crave-worthy, flavorful recipes (not bland or generic).",
    "Use proper seasoning and layering: aromatics + spice/seasoning + acid + finishing touch.",
    "Aim for restaurant-level flavor with simple home steps.",
    "Avoid repetitive, basic recipes; make each feel distinct.",
    "If meat or seafood is detected, make it the centerpiece and build around it.",
    "Add texture contrast when possible (sear/crisp + fresh/creamy).",
    "Include a sauce, glaze, or finishing drizzle when it fits.",
    "Be warm and encouraging. Call the user 'Chef' occasionally (not every sentence).",
  ].join("\n");

  const cuisine = pickCuisine(scanId);
  const meatSignal = hasMeatSignal(scan);

  const customizationBlock =
    `Meal Type: ${scan.mealType || "any"}\n` +
    `Extra Ingredients: ${scan.extraIngredientsText || "none"}\n` +
    `Nutrition Goals: ${(Array.isArray(scan.nutritionGoals) ? scan.nutritionGoals : []).join(", ") || "none"}\n` +
    `Time Limit: ${scan.timeLimit || "any"}\n` +
    `Difficulty: ${scan.difficulty || "any"}\n` +
    `Equipment: ${(Array.isArray(scan.equipment) ? scan.equipment : []).join(", ") || "any"}\n`;

  const noFoodRule =
    'Only return {"error":"NO_FOOD_DETECTED"} if you are VERY confident the image is NOT food-related (e.g., people, rooms, cars, text-only). If the image shows a fridge, pantry, groceries, ingredients, or anything that could be food, DO NOT return NO_FOOD_DETECTED — generate the recipe.\n';

  // Nudges that *don’t* require us to know ingredients ahead of time
  const flavorRules = [
    `Cuisine direction: ${cuisine}.`,
    "Season assertively (salt + pepper at minimum).",
    "Use at least one aromatic: garlic, onion, scallion, shallot, ginger.",
    "Use at least one acid: lemon/lime, vinegar, tomato, yogurt, pickled element.",
    "Finish with one: herbs, toasted crunch, drizzle, cheese, fresh squeeze.",
    meatSignal
      ? "User likely wants more meat: if you detect meat/seafood, center the recipe around it and make it the star."
      : "If you detect meat/seafood, center the recipe around it and make it the star.",
  ].join("\n");

  if (!isPremium) {
    const resp = await openai.responses.create({
      model: "gpt-4o-mini-2024-07-18",
      temperature: 0.35, // slightly higher = less “samey”
      max_output_tokens: 450,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                `${chefBrain}\n\n` +
                noFoodRule +
                `${flavorRules}\n\n` +
                `Return JSON only with:\n` +
                `- title: short appetizing name using EXACTLY ONE adjective from: savory, crispy, smoky, creamy, juicy, hearty, zesty, spicy, fresh, golden\n` +
                `- ingredients: simple ingredient names only (no quantities)\n` +
                `- recipe: EXACTLY ONE short paragraph. NO numbered steps. NO measurements. NO times. NO temperatures.\n` +
                `Constraints:\n` +
                `- Do not use any digits (0-9)\n` +
                `- Do not use units (cup, tbsp, tsp, oz, g, kg, ml, minutes, degrees)\n` +
                `- Make it flavorful even without measurements: mention seasonings, aromatics, acid, and a finishing touch.\n\n` +
                `Preferences:\n${customizationBlock}`,
            },
            { type: "input_image", file_id: fileId, detail: "low" },
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

    if (obj?.error === "NO_FOOD_DETECTED") return { kind: "error", error: "NO_FOOD_DETECTED" };

    const title = String(obj?.title || "").trim() || "Savory Fridge Find";
    const ingredients = Array.isArray(obj?.ingredients) ? obj.ingredients : [];
    const recipe = sanitizeFreeRecipe(obj?.recipe);

    if (!title || !ingredients.length || !recipe) return { kind: "error", error: "AI_BAD_OUTPUT" };

    return { kind: "free", title, ingredients, recipe };
  }

  const resp = await openai.responses.create({
    model: "gpt-4o-mini-2024-07-18",
    temperature: 0.3,
    max_output_tokens: 800,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              `${chefBrain}\n\n` +
              noFoodRule +
              `${flavorRules}\n\n` +
              `Return JSON only with:\n` +
              `- title: short appetizing name using EXACTLY ONE adjective from: savory, crispy, smoky, creamy, juicy, hearty, zesty, spicy, fresh, golden\n` +
              `- ingredients: list of {item, amount} with measurements\n` +
              `- steps: clear step-by-step array\n` +
              `- servings: short string (e.g., "2 servings")\n` +
              `- timeMinutes: number\n` +
              `- macros: { calories:number, proteinGrams:number, carbsGrams:number, fatGrams:number }\n\n` +
              `Quality rules:\n` +
              `- Do not be bland: use aromatics + seasoning + acid + finishing touch.\n` +
              `- If meat/seafood is detected, make it the centerpiece and include a good sear/texture step.\n` +
              `- When possible, include a sauce/glaze (even simple) to elevate flavor.\n\n` +
              `Preferences:\n${customizationBlock}`,
          },
          { type: "input_image", file_id: fileId, detail: "low" },
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

  if (obj?.error === "NO_FOOD_DETECTED") return { kind: "error", error: "NO_FOOD_DETECTED" };

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

app.post("/analyze", async (req, res) => {
  let tempPath = null;

  try {
    cleanupOldScans(14);

    const {
      deviceId,
      imageBase64,
      mealType,
      extraIngredientsText,
      nutritionGoals,
      timeLimit,
      difficulty,
      equipment,
    } = req.body || {};

    if (!deviceId || typeof deviceId !== "string") return res.status(400).json({ error: "Missing deviceId" });
    if (!imageBase64 || typeof imageBase64 !== "string") return res.status(400).json({ error: "Missing imageBase64" });

    const user = ensureUser(deviceId);
    const isPremium = user.isPremium === true;

    // cooldown (analyze)
    const ANALYZE_COOLDOWN_SECONDS = 60;
    const cd = enforceCooldown({ user, kind: "analyze", seconds: ANALYZE_COOLDOWN_SECONDS });
    if (!cd.ok) {
      saveUsers();
      return res.status(429).json({ error: "TOO_MANY_REQUESTS", retryAfterSeconds: cd.retryAfterSeconds });
    }
    saveUsers();

    // free weekly limit (only on analyze)
    const FREE_LIMIT = 4;
    if (!isPremium) {
      if (user.freeUsedThisWeek >= FREE_LIMIT) {
        const unlockAtMs = getNextWeekStartMs(user.weekStartMs);
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

    // create scan
    const scanId = crypto.randomUUID();
    scans[scanId] = {
      deviceId,
      createdMs: Date.now(),
      imageBase64,
      mealType: mealType || "any",
      extraIngredientsText: extraIngredientsText || "",
      nutritionGoals: Array.isArray(nutritionGoals) ? nutritionGoals : [],
      timeLimit: timeLimit || "any",
      difficulty: difficulty || "any",
      equipment: Array.isArray(equipment) ? equipment : [],
      regenCount: 0,
    };
    saveScans();

    // upload image
    tempPath = writeTempJpeg(imageBase64);
    const fileUpload = await openai.files.create({
      file: fs.createReadStream(tempPath),
      purpose: "vision",
    });

    const out = await generateRecipeFromScan({
      scan: scans[scanId],
      scanId,
      isPremium,
      fileId: fileUpload.id,
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
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "AI processing failed" });
  } finally {
    if (tempPath && fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {}
    }
  }
});

app.post("/regenerate", async (req, res) => {
  let tempPath = null;

  try {
    cleanupOldScans(14);

    const {
      deviceId,
      scanId,
      extraIngredientsText,
      mealType,
      nutritionGoals,
      timeLimit,
      difficulty,
      equipment,
    } = req.body || {};

    if (!deviceId || typeof deviceId !== "string") return res.status(400).json({ error: "Missing deviceId" });
    if (!scanId || typeof scanId !== "string") return res.status(400).json({ error: "Missing scanId" });

    const scan = scans[scanId];
    if (!scan) return res.status(404).json({ error: "SCAN_NOT_FOUND" });
    if (scan.deviceId !== deviceId) return res.status(403).json({ error: "SCAN_FORBIDDEN" });

    const user = ensureUser(deviceId);
    const isPremium = user.isPremium === true;

    // free: max 1 regen per scan
    if (!isPremium && (scan.regenCount || 0) >= 1) {
      return res.status(403).json({ error: "REGEN_LIMIT_REACHED" });
    }

    // cooldown (regen)
    const REGEN_COOLDOWN_SECONDS = 10;
    const cd = enforceCooldown({ user, kind: "regen", seconds: REGEN_COOLDOWN_SECONDS });
    if (!cd.ok) {
      saveUsers();
      return res.status(429).json({ error: "TOO_MANY_REQUESTS", retryAfterSeconds: cd.retryAfterSeconds });
    }
    saveUsers();

    // update scan fields if provided
    if (typeof extraIngredientsText === "string") scan.extraIngredientsText = extraIngredientsText;
    if (typeof mealType === "string") scan.mealType = mealType;
    if (Array.isArray(nutritionGoals)) scan.nutritionGoals = nutritionGoals;
    if (typeof timeLimit === "string") scan.timeLimit = timeLimit;
    if (typeof difficulty === "string") scan.difficulty = difficulty;
    if (Array.isArray(equipment)) scan.equipment = equipment;

    scan.updatedMs = Date.now();
    if (!isPremium) scan.regenCount = (scan.regenCount || 0) + 1;

    scans[scanId] = scan;
    saveScans();

    // re-upload image
    tempPath = writeTempJpeg(scan.imageBase64);
    const fileUpload = await openai.files.create({
      file: fs.createReadStream(tempPath),
      purpose: "vision",
    });

    const out = await generateRecipeFromScan({
      scan,
      scanId,
      isPremium,
      fileId: fileUpload.id,
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
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "AI processing failed" });
  } finally {
    if (tempPath && fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {}
    }
  }
});

/* ---------------- START SERVER ---------------- */

app.listen(3000, "0.0.0.0", () => {
  console.log("Server running on port 3000");
});
