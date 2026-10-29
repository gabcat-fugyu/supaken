/* 称号の札を作る部品。メン限ページと称号ラボで共通に使う(見た目は titles.css)。
 *
 *   Titles.html({ label, sub, year, design, shape }, { big })
 *   Titles.DESIGNS  … 選べるデザインの一覧
 *   Titles.SHAPES   … 選べる形の一覧
 */
window.Titles = (function () {
  const ICONS = {
    zap:   `<path d="M13.5 1 3.5 13.6h6.6L8.8 23l11.7-13.4h-7z"/>`,
    crown: `<path d="M3 7.5 7.5 11 12 4l4.5 7L21 7.5 19 18H5zM5 19.5h14V22H5z"/>`,
    flame: `<path d="M12 1.5c.8 3.4-1.7 5.2-2.9 7.3-1 1.7-.6 3.4.5 4.3-.3-1.6.6-2.8 1.8-3.8 1.4 2 3.9 3.2 3.9 6.3 0 1-.3 1.9-.8 2.6 2.4-.8 4-3.1 4-5.8 0-4.6-3.6-6.4-6.5-11zM12 22.5c-3.6 0-6.5-2.6-6.5-6 0-2 .9-3.6 2.2-4.8-.1 2.6 1.6 3.9 3.3 3.9-1-2.6 1-4.4 2.1-5.6.4 2.5 3.4 3.6 3.4 6.8 0 3.2-2 5.7-4.5 5.7z"/>`,
    snow:  `<path d="M11 1h2v4.2l2.6-1.6 1 1.7L13 7.6V11h3.4l2.3-3.6 1.7 1-1.6 2.6H23v2h-4.2l1.6 2.6-1.7 1-2.3-3.6H13v3.4l3.6 2.3-1 1.7-2.6-1.6V23h-2v-4.2l-2.6 1.6-1-1.7 3.6-2.3V13H7.6l-2.3 3.6-1.7-1L5.2 13H1v-2h4.2L3.6 8.4l1.7-1L7.6 11H11V7.6L7.4 5.3l1-1.7L11 5.2z"/>`,
    star:  `<path d="M12 1.5l2.9 6.6 7.1.6-5.4 4.7 1.6 7-6.2-3.7-6.2 3.7 1.6-7L2 8.7l7.1-.6z"/>`,
    gem:   `<path d="M6.5 3h11l4.5 6-10 12.5L2 9zm1 2.2L5.3 8.4h4.2zm9 0-2 3.2h4.2zM12 4.9l-2.1 3.5h4.2zM4.9 10.4l5.7 7.2-2-7.2zm9.2 0-2.1 7.4 5.9-7.4zm-3.5 0L12 15.6l1.5-5.2z"/>`,
    shield:`<path d="M12 1.5 3.5 5v6.2c0 5.3 3.6 9.8 8.5 11.3 4.9-1.5 8.5-6 8.5-11.3V5z"/>`,
    moon:  `<path d="M14.5 2A9.5 9.5 0 1 0 22 14.6 7.5 7.5 0 0 1 14.5 2z"/>`,
    sparkle:`<path d="M12 1l2.3 8.7L23 12l-8.7 2.3L12 23l-2.3-8.7L1 12l8.7-2.3z"/>`,
    flower:`<path d="M12 2.2c1.7 0 3 1.4 3 3 0 .4-.1.9-.3 1.3 1.6-.6 3.4.3 3.9 1.9.5 1.6-.3 3.3-1.8 3.9 1.4.8 2 2.6 1.3 4.1-.7 1.5-2.5 2.2-4 1.6-.2 1.6-1.6 2.8-3.2 2.7-1.6 0-2.9-1.3-3-2.8-1.5.6-3.3-.1-4-1.6-.7-1.5-.1-3.3 1.3-4.1-1.5-.6-2.3-2.3-1.8-3.9.5-1.6 2.3-2.5 3.9-1.9-.2-.4-.3-.9-.3-1.3 0-1.6 1.3-3 3-2.9zm0 7.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2z"/>`,
    sun:   `<path d="M12 6.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM11 0h2v4h-2zm0 20h2v4h-2zM0 11h4v2H0zm20 0h4v2h-4zM3.5 4.9l1.4-1.4 2.8 2.8-1.4 1.4zm12.8 12.8 1.4-1.4 2.8 2.8-1.4 1.4zM3.5 19.1l2.8-2.8 1.4 1.4-2.8 2.8zM16.3 6.3l2.8-2.8 1.4 1.4-2.8 2.8z"/>`,
  };

  // group: rarity … レアリティ(下から順に) / limited … 限定・一点もの / auto … 自動で付く称号
  const DESIGNS = [
    { id: "normal",   name: "ノーマル",     group: "rarity",  rank: 1, icon: "shield" },
    { id: "rare",     name: "レア",         group: "rarity",  rank: 2, icon: "star" },
    { id: "super",    name: "スーパーレア", group: "rarity",  rank: 3, icon: "gem" },
    { id: "platinum", name: "ウルトラレア(白銀)", group: "rarity", rank: 4, icon: "gem" },
    { id: "diamond",  name: "ウルトラレア(ダイヤ)", group: "rarity", rank: 4, icon: "gem" },
    { id: "emerald",  name: "ウルトラレア(翡翠)", group: "rarity", rank: 4, icon: "gem" },
    { id: "champion", name: "チャンピオン", group: "rarity",  rank: 5, icon: "crown" },
    { id: "zap",      name: "紫電撃",       group: "limited", rank: 6, icon: "zap" },
    { id: "flame",    name: "赤炎",         group: "limited", rank: 6, icon: "flame" },
    { id: "ice",      name: "青氷",         group: "limited", rank: 6, icon: "snow" },
    { id: "rainbow",  name: "虹",           group: "limited", rank: 6, icon: "star" },
    { id: "abyss",    name: "漆黒",         group: "limited", rank: 6, icon: "moon" },
    { id: "sakura",   name: "桜",           group: "limited", rank: 6, icon: "flower" },
    { id: "cosmos",   name: "星空",         group: "limited", rank: 6, icon: "sparkle" },
    { id: "thunder",  name: "雷光",         group: "limited", rank: 6, icon: "zap" },
    { id: "sunset",   name: "夕焼け",       group: "limited", rank: 6, icon: "sun" },
    { id: "std",      name: "標準(自動)",   group: "auto",    rank: 3, icon: "star" },
  ];
  const ALIASES = { gold: "champion" };   // 昔の名前

  const SHAPES = [
    { id: "rect",   name: "角丸" },
    { id: "point",  name: "両端とがり" },
    { id: "notch",  name: "角カット" },
    { id: "ribbon", name: "リボン" },
    { id: "blade",  name: "剣" },
    { id: "flame",  name: "右端が炎" },
  ];

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function html(t, opts = {}) {
    const id = ALIASES[t.design] || t.design;
    const d = DESIGNS.find((x) => x.id === id) || DESIGNS[0];
    const icon = ICONS[t.icon] || ICONS[d.icon];
    const subText = [t.sub, t.year].filter(Boolean).join(" · ");
    const shape = SHAPES.some((x) => x.id === t.shape) ? t.shape : "rect";
    const shaped = shape !== "rect";
    const inner =
      `<span class="ttl ttl-${d.id}${shaped ? ` shp shape-${shape}` : ""}${opts.big ? " big" : ""}" title="${esc(t.label)}">` +
      (shaped ? `<span class="ttl-bg"></span>` : "") +
      `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>` +
      `<span class="ttl-text">${subText ? `<span class="ttl-sub">${esc(subText)}</span>` : ""}` +
      `<b>${esc(t.label)}</b></span></span>`;
    // とがった形は切り抜くと光が消えるので、外側の箱で光らせる
    return shaped ? `<span class="ttl-wrap tw-${d.id}${opts.big ? " big-wrap" : ""}">${inner}</span>` : inner;
  }

  return { DESIGNS, SHAPES, ICONS, html };
})();
