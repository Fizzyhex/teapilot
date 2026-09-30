// GREGGS kiosk — discord.play app
import { app, embed, button, select, row, text, step, ephemeral } from "@teapilot/discord-play";

const DATA = {
  breakfast: [
    { id: "bacon-roll", name: "Bacon Roll", description: "A classic Greggs bacon roll", energy: 350, fat: 15.0, sat_fat: 6.0, sugar: 3.0, salt: 1.2 },
    { id: "sausage-roll", name: "Sausage Roll", description: "A classic Greggs sausage roll", energy: 280, fat: 14.0, sat_fat: 5.5, sugar: 1.0, salt: 1.5 },
    { id: "chicken-roll", name: "Chicken Roll", description: "A classic Greggs chicken roll", energy: 320, fat: 12.0, sat_fat: 4.5, sugar: 2.0, salt: 1.3 },
    { id: "pork-pie", name: "Pork Pie", description: "A classic Greggs pork pie", energy: 380, fat: 18.0, sat_fat: 7.0, sugar: 2.0, salt: 1.4 },
    { id: "beef-pie", name: "Beef Pie", description: "A classic Greggs beef pie", energy: 360, fat: 16.0, sat_fat: 6.5, sugar: 2.0, salt: 1.3 },
  ],
  sweet_treats: [
    { id: "doughnut", name: "Doughnut", description: "A classic Greggs doughnut", energy: 250, fat: 10.0, sat_fat: 4.0, sugar: 20.0, salt: 0.3 },
    { id: "lemonade", name: "Lemonade", description: "A classic Greggs lemonade", energy: 80, fat: 0.0, sat_fat: 0.0, sugar: 18.0, salt: 0.0 },
    { id: "muffin", name: "Muffin", description: "A classic Greggs muffin", energy: 300, fat: 12.0, sat_fat: 5.0, sugar: 22.0, salt: 0.4 },
    { id: "danish", name: "Danish", description: "A classic Greggs danish", energy: 280, fat: 11.0, sat_fat: 5.0, sugar: 18.0, salt: 0.3 },
    { id: "croissant", name: "Croissant", description: "A classic Greggs croissant", energy: 320, fat: 15.0, sat_fat: 9.0, sugar: 8.0, salt: 0.5 },
  ],
};
const CATS = ["breakfast", "sweet_treats"];
const BLUE = 0x2b6cb0, ORANGE = 0xed8936;

// UK traffic-light thresholds (per serving)
const TL = {
  fat:     { low: 3,  high: 17 },
  sat_fat: { low: 1.5, high: 3 },
  sugar:   { low: 5,  high: 22.5 },
  salt:    { low: 0.3, high: 1.5 },
};
function light(key, val) {
  const t = TL[key];
  return val <= t.low ? "🟢" : val >= t.high ? "🔴" : "🟡";
}
function nutrientLines(p) {
  return [
    `⚪ Energy: ${p.energy} kcal`,
    `${light("fat", p.fat)} Fat: ${p.fat} g`,
    `${light("sat_fat", p.sat_fat)} Sat fat: ${p.sat_fat} g`,
    `${light("sugar", p.sugar)} Sugar: ${p.sugar} g`,
    `${light("salt", p.salt)} Salt: ${p.salt} g`,
  ];
}
function recs(cat, current) {
  const same = DATA[cat].filter(p => p.id !== current.id);
  const out = same.slice(0, 3);
  if (out.length < 3) {
    const other = CATS.find(c => c !== cat);
    for (const p of DATA[other]) {
      if (out.length >= 3) break;
      if (!out.some(q => q.id === p.id)) out.push(p);
    }
  }
  return out;
}

export default app({
  init(ctx) {
    return { cat: "breakfast", idx: 0, page: "list" };
  },

  update(state, action, ctx) {
    if (action.kind === "select" && action.id === "cat") {
      const cat = action.values[0];
      return { ...state, cat, idx: 0, page: "list" };
    }
    if (action.kind === "button" && (action.id === "prev" || action.id === "next")) {
      const list = DATA[state.cat];
      const delta = action.id === "next" ? 1 : -1;
      const idx = Math.max(0, Math.min(list.length - 1, state.idx + delta));
      return { ...state, idx };
    }
    if (action.kind === "button" && action.id === "open") {
      return { ...state, page: "item" };
    }
    if (action.kind === "button" && action.id === "back") {
      return { ...state, page: "list" };
    }
    if (action.kind === "button" && action.id.startsWith("like_")) {
      const id = action.id.slice(5);
      const all = [...DATA.breakfast, ...DATA.sweet_treats];
      const p = all.find(x => x.id === id);
      if (!p) return state;
      const cat = DATA.breakfast.some(x => x.id === id) ? "breakfast" : "sweet_treats";
      const idx = DATA[cat].findIndex(x => x.id === id);
      return { ...state, cat, idx, page: "item" };
    }
    return state;
  },

  view(state, ctx) {
    if (state.page === "item") {
      const p = DATA[state.cat][state.idx];
      const likes = recs(state.cat, p);
      return {
        embeds: [embed({
          title: p.name,
          description: p.description,
          color: ORANGE,
          fields: [
            { name: "Nutrition (per serving)", value: text(...nutrientLines(p)) },
            { name: "You may also like", value: likes.length ? likes.map(l => l.name).join("\n") : "none" },
          ],
          footer: { text: `Greggs kiosk • ${state.cat} • ${state.idx + 1}/${DATA[state.cat].length}` },
        })],
        rows: [row(
          button("back", "back to list", { style: "secondary" }),
          ...likes.map(l => button("like_" + l.id, l.name, { style: "secondary" })),
        )],
      };
    }
    const list = DATA[state.cat];
    const p = list[state.idx];
    return {
      embeds: [embed({
        title: `GREGGS — ${state.cat} (${list.length} items)`,
        description: `Showing ${p.name}. Use prev/next to browse.`,
        color: BLUE,
        fields: [
          { name: "Current", value: p.name },
          { name: "Position", value: `${state.idx + 1} / ${list.length}` },
        ],
        footer: { text: "Greggs kiosk • list view" },
      })],
      rows: [
        row(select("cat", [
          { label: "breakfast", value: "breakfast" },
          { label: "sweet_treats", value: "sweet_treats" },
        ], { placeholder: "choose a category", min: 1, max: 1 })),
        row(
          button("prev", "prev", { style: "secondary", disabled: state.idx === 0 }),
          button("next", "next", { style: "secondary", disabled: state.idx === list.length - 1 }),
          button("open", "view item", { style: "primary" }),
        ),
      ],
    };
  },
});