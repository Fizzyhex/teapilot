import { app, embed, row, button, select } from "@teapilot/discord-play";

const DATA = {
  breakfast: [
    { id: "b1", name: "Beef Poutine", desc: "Crispy fries topped with gravy, cheese curds and seasoned beef.", nutrition: { energy_kcal: 520, fat_g: 28, sat_g: 12, sugar_g: 4, salt_g: 1.8 } },
    { id: "b2", name: "Maple Bacon Donut", desc: "Glazed donut topped with maple syrup and crispy bacon bits.", nutrition: { energy_kcal: 380, fat_g: 18, sat_g: 8, sugar_g: 22, salt_g: 0.9 } },
    { id: "b3", name: "Chicken & Waffles", desc: "Crispy fried chicken on golden waffles with maple syrup.", nutrition: { energy_kcal: 680, fat_g: 32, sat_g: 14, sugar_g: 18, salt_g: 1.5 } },
    { id: "b4", name: "Blueberry Pie", desc: "Flaky crust filled with sweet blueberries and a hint of lemon.", nutrition: { energy_kcal: 450, fat_g: 20, sat_g: 10, sugar_g: 30, salt_g: 0.6 } }
  ],
  sweet_treats: [
    { id: "s1", name: "Cinnamon Roll", desc: "Soft roll with cinnamon filling and cream cheese frosting.", nutrition: { energy_kcal: 410, fat_g: 16, sat_g: 9, sugar_g: 28, salt_g: 0.7 } },
    { id: "s2", name: "Blueberry Muffin", desc: "Fluffy muffin studded with fresh blueberries.", nutrition: { energy_kcal: 350, fat_g: 14, sat_g: 6, sugar_g: 20, salt_g: 0.8 } },
    { id: "s3", name: "Maple Bacon Donut", desc: "Glazed donut topped with maple syrup and crispy bacon bits.", nutrition: { energy_kcal: 380, fat_g: 18, sat_g: 8, sugar_g: 22, salt_g: 0.9 } },
    { id: "s4", name: "Chocolate Frosted Donut", desc: "Classic ring donut dipped in rich chocolate frosting.", nutrition: { energy_kcal: 320, fat_g: 12, sat_g: 6, sugar_g: 24, salt_g: 0.5 } }
  ]
};

// thresholds: [low, medLow, medHigh] — value < low => low, < medLow => med-low, < medHigh => med-high, else high
const THRESHOLDS = {
  fat_g:   { label: "Fat",   low: 10,  medLow: 20,  medHigh: 30 },
  sat_g:   { label: "Sat",   low: 5,   medLow: 10,  medHigh: 15 },
  sugar_g: { label: "Sugar", low: 10,  medLow: 20,  medHigh: 30 },
  salt_g:  { label: "Salt",  low: 0.5, medLow: 1.0, medHigh: 2.0 }
};

function nutrientButton(key, value) {
  const t = THRESHOLDS[key];
  let style, emoji;
  if (value < t.low)        { style = "success"; emoji = "🟢"; }
  else if (value < t.medLow) { style = "primary"; emoji = "🟡"; }
  else if (value < t.medHigh) { style = "danger";  emoji = "🟠"; }
  else                       { style = "danger";  emoji = "🔴"; }
  return button(`nutr-${key}`, `${emoji} ${t.label} ${value}g`, { style });
}

function currentItem(state) {
  const items = DATA[state.category];
  return items[state.index % items.length];
}

function findItem(id) {
  for (const cat of Object.keys(DATA)) {
    for (const item of DATA[cat]) {
      if (item.id === id) return { item, cat };
    }
  }
  return null;
}

export default app({
  init() {
    return { page: "browse", category: "breakfast", index: 0, detailId: null };
  },

  update(state, action) {
    if (action.kind === "select" && action.id === "category") {
      return { ...state, category: action.values[0], index: 0, page: "browse" };
    }
    if (action.kind !== "button") return state;

    const id = action.id;
    if (id === "prev") {
      const len = DATA[state.category].length;
      return { ...state, index: (state.index - 1 + len) % len };
    }
    if (id === "next") {
      const len = DATA[state.category].length;
      return { ...state, index: (state.index + 1) % len };
    }
    if (id === "details") {
      return { ...state, page: "detail", detailId: currentItem(state).id };
    }
    if (id === "back") {
      return { ...state, page: "browse", detailId: null };
    }
    if (id.startsWith("also-")) {
      const n = parseInt(id.slice(5), 10);
      const others = DATA[state.category].filter(i => i.id !== state.detailId).slice(0, 3);
      const target = others[n];
      if (target) return { ...state, page: "detail", detailId: target.id };
    }
    return state;
  },

  view(state) {
    if (state.page === "browse") {
      const item = currentItem(state);
      return {
        embeds: [embed({
          title: "Find your yummy 🟠",
          description: `**${item.name}**\n${item.desc}`,
          color: 0x0078D4
        })],
        rows: [
          row(select("category", [
            { value: "breakfast", label: "Breakfast" },
            { value: "sweet_treats", label: "Sweet Treats" }
          ], { placeholder: "Pick a category" })),
          row(button("prev", "◀ Prev"), button("next", "Next ▶"), button("details", "Details"))
        ]
      };
    }

    // detail page
    const found = findItem(state.detailId);
    if (!found) return { embeds: [embed({ title: "Not found", description: "Item not found.", color: 0x0078D4 })] };
    const { item } = found;
    const n = item.nutrition;

    const rows = [
      row(
        button("nutr-energy", `⚡ ${n.energy_kcal} kcal`, { style: "secondary" }),
        nutrientButton("fat_g", n.fat_g),
        nutrientButton("sat_g", n.sat_g),
        nutrientButton("sugar_g", n.sugar_g),
        nutrientButton("salt_g", n.salt_g)
      ),
      row(button("back", "◀ Back"))
    ];

    const others = DATA[state.category].filter(i => i.id !== state.detailId).slice(0, 3);
    if (others.length > 0) {
      rows.push(row(...others.map((o, i) => button(`also-${i}`, o.name))));
    }

    return {
      embeds: [embed({
        title: item.name,
        description: item.desc,
        color: 0x0078D4
      })],
      rows
    };
  }
});