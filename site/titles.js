/* 称号の札を作る部品。メン限ページと称号ラボで共通に使う(見た目は titles.css)。
 *
 *   Titles.html({ label, sub, year, design }, { big })
 *   Titles.DESIGNS  … 選べるデザインの一覧
 */
window.Titles = (function () {
  const ICONS = {
    zap:   `<path d="M13.5 1 3.5 13.6h6.6L8.8 23l11.7-13.4h-7z"/>`,
    crown: `<path d="M3 7.5 7.5 11 12 4l4.5 7L21 7.5 19 18H5zM5 19.5h14V22H5z"/>`,
    flame: `<path d="M12 1.5c.8 3.4-1.7 5.2-2.9 7.3-1 1.7-.6 3.4.5 4.3-.3-1.6.6-2.8 1.8-3.8 1.4 2 3.9 3.2 3.9 6.3 0 1-.3 1.9-.8 2.6 2.4-.8 4-3.1 4-5.8 0-4.6-3.6-6.4-6.5-11zM12 22.5c-3.6 0-6.5-2.6-6.5-6 0-2 .9-3.6 2.2-4.8-.1 2.6 1.6 3.9 3.3 3.9-1-2.6 1-4.4 2.1-5.6.4 2.5 3.4 3.6 3.4 6.8 0 3.2-2 5.7-4.5 5.7z"/>`,
    snow:  `<path d="M11 1h2v4.2l2.6-1.6 1 1.7L13 7.6V11h3.4l2.3-3.6 1.7 1-1.6 2.6H23v2h-4.2l1.6 2.6-1.7 1-2.3-3.6H13v3.4l3.6 2.3-1 1.7-2.6-1.6V23h-2v-4.2l-2.6 1.6-1-1.7 3.6-2.3V13H7.6l-2.3 3.6-1.7-1L5.2 13H1v-2h4.2L3.6 8.4l1.7-1L7.6 11H11V7.6L7.4 5.3l1-1.7L11 5.2z"/>`,
    star:  `<path d="M12 1.5l2.9 6.6 7.1.6-5.4 4.7 1.6 7-6.2-3.7-6.2 3.7 1.6-7L2 8.7l7.1-.6z"/>`,
  };

  const DESIGNS = [
    { id: "zap",     name: "紫電撃", icon: "zap" },
    { id: "gold",    name: "金",     icon: "crown" },
    { id: "flame",   name: "赤炎",   icon: "flame" },
    { id: "ice",     name: "青氷",   icon: "snow" },
    { id: "rainbow", name: "虹",     icon: "star" },
    { id: "std",     name: "標準",   icon: "star" },   // 自動の称号(20勝達成など)
  ];

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function html(t, opts = {}) {
    const d = DESIGNS.find((x) => x.id === t.design) || DESIGNS[0];
    const icon = ICONS[t.icon] || ICONS[d.icon];
    const subText = [t.sub, t.year].filter(Boolean).join(" · ");
    return `<span class="ttl ttl-${d.id}${opts.big ? " big" : ""}" title="${esc(t.label)}">` +
      `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>` +
      `<span class="ttl-text">${subText ? `<span class="ttl-sub">${esc(subText)}</span>` : ""}` +
      `<b>${esc(t.label)}</b></span></span>`;
  }

  return { DESIGNS, ICONS, html };
})();
