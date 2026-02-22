cat > server.js << 'EOF'
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("FridgeSnap backend running");
});

app.post("/analyze", (req, res) => {
  const { imageBase64 } = req.body;

  if (!imageBase64) {
    return res.status(400).json({ error: "No image provided" });
  }

  res.json({
    ingredients: ["eggs", "cheese", "tomato"],
    recipe: "Cheesy tomato omelet cooked with melted cheese and fresh tomato."
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
EOF
