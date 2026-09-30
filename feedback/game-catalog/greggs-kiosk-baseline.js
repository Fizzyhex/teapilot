// GREGGS Kiosk — discord.play app
// Rules:
//  - Two pages: "main" (Find your yummy) and "detail" (item details)
//  - Main: category select (breakfast / sweet_treats), prev/next (wrap), details jump
//  - Detail: name, description, 5 nutrient buttons (colour-coded), "You may also like"
//  - Nutrient colours: energy -> grey; fat/sat/sugar/salt -> green -> amber -> red
//  - Recommendations: tag-overlap, 0-3 other products, deterministic
//  - Blue/orange scheme: main embed blue, detail embed orange
//  - No web, no async, all data embedded

import { app, embed, row, button, select, step, ephemeral } from "@teapilot/discord-play";

// ---- Embedded data ----
const DATA = {
  breakfast: [
    {
      id: "egg_bap",
      name: "Egg & Cheese Bap",
      desc: "Fluffy bap with a fried egg and melted cheese, served warm.",
      nutrition: { energy: 320, fat: 18, sat: 8, sugar: 2, salt: 1.1 },
      tags: ["flaky", "savory", "egg", "pastry"],
    },
    {
      id: "sausage_roll",
      name: "Sausage Roll",
      desc: "Golden pastry wrapped around seasoned sausage, a breakfast classic.",
      nutrition: { energy: 280, fat: 16, sat: 6, sugar: 1, salt: 1.3 },
      tags: ["flaky", "savory", "pastry"],
    },
    {
      id: "croissant",
      name: "Butter Croissant",
      desc: "Buttery, layered croissant baked fresh each morning.",
      nutrition: { energy: 250, fat: 14, sat: 8, sugar: 4, salt: 0.4 },
      tags: ["flaky", "pastry", "butter"],
    },
    {
      id: "bacon_roll",
      name: "Bacon Roll",
      desc: "Soft roll with crispy bacon and a dusting of cheese.",
      nutrition: { energy: 300, fat: 17, sat: 7, sugar: 2, salt: 1.2 },
      tags: ["savory", "pastry", "butter"],
    },
  ],
  sweet_treats: [
    {
      id: "cinnamon_bun",
      name: "Cinnamon Bun",
      desc: "Swirled cinnamon sugar with a cream cheese glaze.",
      nutrition: { energy: 350, fat: 15, sat: 9, sugar: 22, salt: 0.3 },
      tags: ["sweet", "pastry", "butter", "glazed"],
    },
    {
      id: "danish",
      name: "Fruit Danish",
      desc: "Puff pastry with custard and fresh fruit, lightly glazed.",
      nutrition: { energy: 290, fat: 13, sat: 7, sugar: 18, salt: 0.2 },
      tags: ["sweet", "pastry", "glazed"],
    },
    {
      id: "muffin",
      name: "Blueberry Muffin",
      desc: "Tender muffin studded with blueberries and a crumb top.",
      nutrition: { energy: 260, fat: 10, sat: 5, sugar: 16, salt: 0.4 },
      tags: ["sweet", "baked"],
    },
    {
      id: "donut",
      name: "Glazed Donut",
      desc: "Light, airy donut with a classic sugar glaze.",
      nutrition: { energy: 240, fat: 11, sat: 5, sugar: 14, salt: 0.2 },
      tags: ["sweet", "glazed", "baked"],
    },
  ],
};

const CATEGORIES = [
  { value: "breakfast", label: "Breakfast" },
  { value: "sweet_treats", label: "Sweet Treats" },
];

// Nutrient thresholds (per serving): green < low, amber low..high, red > high
const THRESHOLDS = {
  fat: { low: 10, high: 15 },
  sat: { low: 5, high: 8 },
  sugar: { low: 10, high: 15 },
  salt: { low: 0.5, high: 1.0 },
};

const NUTRIENTS = [
  { key: "energy", label: "Energy", unit: "kcal" },
  { key: "fat", label: "Fat", unit: "g" },
  { key: "sat", label: "Sat. Fat", unit: "g" },
  { key: "sugar", label: "Sugar", unit: "g" },
  { key: "salt", label: "Salt", unit: "g" },
];

// ---- Helpers ----
function nutrientColor(key, value) {
  if (key === "energy") return "#9e9e9e"; // grey
  const t = THRESHOLDS[key];
  if (value < t.low) return "#4caf50"; // green
  if (value <= t.high) return "#ff9800"; // amber
  return "#f44336"; // red
}

function nutrientVerdict(key, value) {
  if (key === "energy") return "Calories per serving.";
  const t = THRESHOLDS[key];
  if (value < t.low) return "Low.";
  if (value <= t.high) return "Moderate.";
  return "High.";
}

function findItem(id) {
  for (const cat of Object.values(DATA)) {
    for (const item of cat) if (item.id === id) return item;
  }
  return null;
}

function recommend(item, max = 3) {
  const all = Object.values(DATA).flat().filter((i) => i.id !== item.id);
  const scored = all.map((other) => ({
    other,
    overlap: item.tags.filter((t) => other.tags.includes(t)).length,
  }));
  scored.sort((a, b) => b.overlap - a.overlap);
  return scored.filter((s) => s.overlap > 0).slice(0, max).map((s) => s.other);
}

// ---- App ----
export default app({
  init(ctx) {
    return {
      page: "main",
      category: "breakfast",
      index: 0,
      detailId: null,
    };
  },

  update(state, action, ctx) {
    // Category select
    if (action.kind === "select" && action.id === "category") {
      const cat = action.values[0];
      return { ...state, page: "main", category: cat, index: 0 };
    }

    // Prev / Next
    if (action.kind === "button" && action.id === "prev") {
      const len = DATA[state.category].length;
      const idx = (state.index - 1 + len) % len;
      return { ...state, index: idx };
    }
    if (action.kind === "button" && action.id === "next") {
      const len = DATA[state.category].length;
      const idx = (state.index + 1) % len;
      return { ...state, index: idx };
    }

    // Jump to detail
    if (action.kind === "button" && action.id === "details") {
      const item = DATA[state.category][state.index];
      return { ...state, page: "detail", detailId: item.id };
    }

    // Back to main
    if (action.kind === "button" && action.id === "back") {
      return { ...state, page: "main", detailId: null };
    }

    // Nutrient button -> ephemeral reveal
    if (action.kind === "button" && NUTRIENTS.some((n) => n.key === action.id)) {
      const item = findItem(state.detailId);
      const n = NUTRIENTS.find((x) => x.key === action.id);
      const val = item.nutrition[action.id];
      return step(state, ephemeral(`${n.label}: ${val}${n.unit === "kcal" ? "" : " " + n.unit} — ${nutrientVerdict(action.id, val)}`));
    }

    return state;
  },

  view(state, ctx) {
    if (state.page === "main") {
      const item = DATA[state.category][state.index];
      const e = embed({
        title: "Find your yummy",
        description: `**${item.name}**\n${item.desc}`,
        color: "#1976d2", // blue
        footer: `Item ${state.index + 1} of ${DATA[state.category].length} · ${state.category === "breakfast" ? "Breakfast" : "Sweet Treats"}`,
      });
      return {
        embeds: [e],
        rows: [
          row(select("category", CATEGORIES, { placeholder: "Choose a category" })),
          row(
            button("prev", "← Prev", { style: "secondary" }),
            button("details", "Details", { style: "primary" }),
            button("next", "Next →", { style: "secondary" })
          ),
        ],
      };
    }

    // Detail page
    const item = findItem(state.detailId);
    const recs = recommend(item);
    const recText = recs.length
      ? recs.map((r) => `• ${r.name}`).join("\n")
      : "No similar items.";

    const e = embed({
      title: item.name,
      description: item.desc,
      color: "#ff9800", // orange
      fields: [{ name: "You may also like", value: recText, inline: false }],
    });

    const nutrientButtons = NUTRIENTS.map((n) => {
      const val = item.nutrition[n.key];
      const color = nutrientColor(n.key, val);
      return button(n.key, `${n.label}: ${val}${n.unit === "kcal" ? "" : " " + n.unit}`, {
        style: "secondary",
      });
    });

    return {
      embeds: [e],
      rows: [
        row(nutrientButtons.slice(0, 3)),
        row(nutrientButtons.slice(3), button("back", "← Back", { style: "primary" })),
      ],
    };
  },
});