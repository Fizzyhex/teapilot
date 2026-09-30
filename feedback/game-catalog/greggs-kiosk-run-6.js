import { app, embed, row, button, select, text } from "@teapilot/discord-play";

const DATA = [
  { id: "beef-pita", name: "Beef Pita", category: "breakfast", description: "A warm pita filled with seasoned beef, tomato, lettuce and garlic sauce. A GREGGS breakfast staple.", energy_kcal: 500, fat_g: 20, sat_fat_g: 8, sugar_g: 5, salt_g: 1.5 },
  { id: "chicken-shawarma-pita", name: "Chicken Shawarma Pita", category: "breakfast", description: "A pita packed with marinated chicken shawarma, garlic sauce, pickles and fresh vegetables.", energy_kcal: 480, fat_g: 18, sat_fat_g: 6, sugar_g: 4, salt_g: 1.4 },
  { id: "sausage-pita", name: "Sausage Pita", category: "breakfast", description: "A pita filled with a seasoned sausage, tomato, lettuce and garlic sauce.", energy_kcal: 520, fat_g: 22, sat_fat_g: 9, sugar_g: 4, salt_g: 1.6 },
  { id: "egg-cheese-pita", name: "Egg & Cheese Pita", category: "breakfast", description: "A pita with a fried egg, melted cheese, tomato and lettuce. A simple, filling breakfast.", energy_kcal: 450, fat_g: 24, sat_fat_g: 10, sugar_g: 3, salt_g: 1.3 },
  { id: "butter-croissant", name: "Butter Croissant", category: "sweet_treats", description: "A flaky, buttery croissant baked fresh. Lightly sweet and perfect with coffee.", energy_kcal: 260, fat_g: 14, sat_fat_g: 8, sugar_g: 5, salt_g: 0.4 },
  { id: "chocolate-croissant", name: "Chocolate Croissant", category: "sweet_treats", description: "A butter croissant filled with chocolate. A rich, indulgent sweet treat.", energy_kcal: 320, fat_g: 17, sat_fat_g: 10, sugar_g: 14, salt_g: 0.4 },
  { id: "knafeh", name: "Knafeh", category: "sweet_treats", description: "A Middle-Eastern dessert of crisp phyllo and cheese, sweetened with syrup and topped with pistachios.", energy_kcal: 380, fat_g: 18, sat_fat_g: 10, sugar_g: 28, salt_g: 0.3 },
  { id: "baklava", name: "Baklava", category: "sweet_treats", description: "Layers of phyllo pastry with nuts, soaked in honey syrup. A classic sweet treat.", energy_kcal: 350, fat_g: 16, sat_fat_g: 7, sugar_g: 24, salt_g: 0.2 },
];

// FSA traffic-light thresholds (per serving)
const THRESHOLDS = {
  fat:      { low: 3,  high: 17 },
  sat_fat:  { low: 1.5, high: 3 },
  sugar:    { low: 5,  high: 22.5 },
  salt:     { low: 0.3, high: 1.5 },
};

function nutrientStyle(key, value) {
  if (key === "energy") return { style: "secondary", emoji: "" };
  const t = THRESHOLDS[key];
  if (value <= t.low) return { style: "success", emoji: "" };
  if (value > t.high) return { style: "danger", emoji: "" };
  return { style: "secondary", emoji: "🟠" };
}

function itemsInCategory(category) {
  return DATA.filter(d => d.category === category);
}

function getItem(id) {
  return DATA.find(d => d.id === id);
}

function recommendations(selectedId) {
  const sel = getItem(selectedId);
  if (!sel) return [];
  const sameCat = DATA.filter(d => d.category === sel.category && d.id !== selectedId).slice(0, 2);
  const crossCat = DATA.filter(d => d.category !== sel.category && d.id !== selectedId).slice(0, 1);
  return [...sameCat, ...crossCat];
}

export default app({
  init(ctx) {
    return {
      page: "main",
      category: "breakfast",
      index: 0,
      selectedId: null,
    };
  },

  update(state, action, ctx) {
    if (action.kind === "select" && action.id === "category") {
      const cat = action.values[0];
      return { ...state, category: cat, index: 0, page: "main", selectedId: null };
    }

    if (action.kind === "button") {
      const items = itemsInCategory(state.category);
      const len = items.length;

      if (action.id === "prev") {
        return { ...state, index: (state.index - 1 + len) % len };
      }
      if (action.id === "next") {
        return { ...state, index: (state.index + 1) % len };
      }
      if (action.id === "view") {
        const item = items[state.index];
        return { ...state, page: "detail", selectedId: item.id };
      }
      if (action.id === "back") {
        return { ...state, page: "main", selectedId: null };
      }
      if (action.id.startsWith("rec:")) {
        const targetId = action.id.slice(4);
        return { ...state, selectedId: targetId };
      }
    }

    return state;
  },

  view(state, ctx) {
    if (state.page === "main") {
      const items = itemsInCategory(state.category);
      const item = items[state.index];
      const catLabel = state.category === "breakfast" ? "🥐 Breakfast" : "🍩 Sweet Treats";

      const e = embed({
        title: "Find your yummy",
        description: text([
          `**${catLabel}**`,
          "",
          `Now viewing: **${item.name}**`,
          "",
          "Use the controls below to browse or view details.",
        ]),
        color: "#0078D4",
        footer: `Item ${state.index + 1} of ${items.length} · GREGGS Kiosk`,
      });

      const catSelect = select("category", [
        { value: "breakfast", label: "🥐 Breakfast", default: state.category === "breakfast" },
        { value: "sweet_treats", label: "🍩 Sweet Treats", default: state.category === "sweet_treats" },
      ], { placeholder: "Choose a category" });

      const navRow = row(
        button("prev", "◀ Prev"),
        button("next", "▶ Next"),
        button("view", "🍽 View Item", { style: "primary" }),
      );

      return { embeds: [e], rows: [row(catSelect), navRow] };
    }

    // detail page
    const item = getItem(state.selectedId);
    if (!item) {
      return { embeds: [embed({ title: "Error", description: "Item not found.", color: "#FF0000" })] };
    }

    const e = embed({
      title: item.name,
      description: text([
        item.description,
        "",
        `**Category:** ${item.category === "breakfast" ? "🥐 Breakfast" : "🍩 Sweet Treats"}`,
        "",
        "Tap a nutrient button to see its value.",
      ]),
      color: "#FF8C00",
      footer: "GREGGS Kiosk · Nutrition per serving (approximate)",
    });

    const nutRow = row(
      button("nut_energy", `⚡ Energy ${item.energy_kcal}kcal`, { style: "secondary" }),
      button("nut_fat", `🧈 Fat ${item.fat_g}g`, { ...nutrientStyle("fat", item.fat_g) }),
      button("nut_sat", `🥛 Sat Fat ${item.sat_fat_g}g`, { ...nutrientStyle("sat_fat", item.sat_fat_g) }),
      button("nut_sugar", `🍬 Sugar ${item.sugar_g}g`, { ...nutrientStyle("sugar", item.sugar_g) }),
      button("nut_salt", `🧂 Salt ${item.salt_g}g`, { ...nutrientStyle("salt", item.salt_g) }),
    );

    const recs = recommendations(item.id);
    const recRow = recs.length > 0
      ? row(...recs.map(r => button(`rec:${r.id}`, `✨ ${r.name}`)))
      : null;

    const backRow = row(button("back", "⬅ Back", { style: "secondary" }));

    const rows = [nutRow, backRow];
    if (recRow) rows.push(recRow);

    return { embeds: [e], rows };
  },
});