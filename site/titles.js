/* 称号の札を作る部品。メン限ページと称号ラボで共通に使う(見た目は titles.css)。
 *
 *   Titles.html({ label, sub, year, design, shape }, { big })
 *   Titles.DESIGNS  … 選べるデザインの一覧
 *   Titles.SHAPES   … 選べる形の一覧
 *   Titles.RARITIES … レアリティ(下から順に)と、その色(デザイン)
 *   Titles.CATALOG  … 自動で付く称号の一覧(判定は collect.py の TITLE_RULES と同じ id)
 *   Titles.resolve(item) … 付いている称号 {id, ...} を、表示に使う形 {label, design, ...} にする
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
  const SHAPE_ALIASES = { flame: "blaze" };

  const SHAPES = [
    { id: "rect",   name: "角丸" },
    { id: "point",  name: "両端とがり" },
    { id: "notch",  name: "角カット" },
    { id: "ribbon", name: "リボン" },
    { id: "blade",  name: "剣" },
    { id: "blaze",  name: "炎の枠" },
  ];

  // レアリティ。下から順に。色はデザイン(DESIGNS の id)で決まる
  const RARITIES = [
    { id: "normal",   name: "ノーマル",     design: "normal",   rank: 1 },
    { id: "rare",     name: "レア",         design: "rare",     rank: 2 },
    { id: "super",    name: "スーパーレア", design: "super",    rank: 3 },
    { id: "ultra",    name: "ウルトラレア", design: "diamond",  rank: 4 },
    { id: "champion", name: "チャンピオン", design: "champion", rank: 5 },
    { id: "unique",   name: "ユニーク",     design: "zap",      rank: 6 },   // 管理人が付ける
  ];
  const RARITY = Object.fromEntries(RARITIES.map((r) => [r.id, r]));

  // 自動で付く称号。how は「どうすれば付くか」の説明
  const CATALOG = [
    { id: "tenkai",    cat: "rating", rarity: "normal",   label: "天界到達",         how: "天界に乗る" },
    { id: "rate2000",  cat: "rating", rarity: "rare",     label: "レート2000到達",   how: "天界でレート2000" },
    { id: "rate2500",  cat: "rating", rarity: "super",    label: "レート2500到達",   how: "天界でレート2500" },
    { id: "rate3000",  cat: "rating", rarity: "ultra",    label: "レート3000到達",   how: "天界でレート3000" },
    { id: "rate3500",  cat: "rating", rarity: "champion", label: "レート3500到達",   how: "天界でレート3500" },
    { id: "rate4000",  cat: "rating", rarity: "unique",   label: "レート4000到達",   how: "天界でレート4000(管理人が付けます)", manual: true },
    { id: "wins5000",  cat: "wins",   rarity: "normal",   label: "通算5000勝",       how: "通算で5000勝" },
    { id: "wins10000", cat: "wins",   rarity: "rare",     label: "通算10000勝",      how: "通算で10000勝" },
    { id: "wins15000", cat: "wins",   rarity: "super",    label: "通算15000勝",      how: "通算で15000勝" },
    { id: "wins20000", cat: "wins",   rarity: "ultra",    label: "通算20000勝",      how: "通算で20000勝" },
    { id: "wins30000", cat: "wins",   rarity: "champion", label: "通算30000勝",      how: "通算で30000勝" },
    { id: "streak5",   cat: "streak", rarity: "normal",   label: "5連勝達成",        how: "5連勝する" },
    { id: "streak10",  cat: "streak", rarity: "rare",     label: "10連勝達成",       how: "10連勝する" },
    { id: "streak20",  cat: "streak", rarity: "super",    label: "20連勝達成",       how: "20連勝する" },
    { id: "streak30",  cat: "streak", rarity: "ultra",    label: "30連勝達成",       how: "30連勝する" },
    { id: "streak50",  cat: "streak", rarity: "champion", label: "50連勝達成",       how: "50連勝する" },
    { id: "crl20",     cat: "crl20",  rarity: "champion", label: "20勝達成",         how: "CRL 20勝チャレンジで20勝(年ごと)" },
    { id: "top10000",  cat: "rank",   rarity: "rare",     label: "TOP10000",         how: "天界の世界ランキングで10000位以内" },
    { id: "top5000",   cat: "rank",   rarity: "super",    label: "TOP5000",          how: "天界の世界ランキングで5000位以内" },
    { id: "top1000",   cat: "rank",   rarity: "ultra",    label: "TOP1000",          how: "天界の世界ランキングで1000位以内" },
    { id: "top200",    cat: "rank",   rarity: "ultra",    label: "TOP200",           how: "天界の世界ランキングで200位以内" },
    { id: "top100",    cat: "rank",   rarity: "champion", label: "TOP100",           how: "天界の世界ランキングで100位以内" },
    { id: "classic",   cat: "challenge", rarity: "rare",  label: "クラシックチャレンジクリア", how: "クラシックチャレンジで12勝" },
    { id: "grand",     cat: "challenge", rarity: "super", label: "グランドチャレンジクリア",   how: "グランドチャレンジで12勝" },
  ];
  const CATS = [
    { id: "rating", name: "レート" }, { id: "wins", name: "通算勝利数" }, { id: "streak", name: "連勝" },
    { id: "crl20", name: "20勝チャレンジ" }, { id: "rank", name: "世界ランキング" }, { id: "challenge", name: "チャレンジ" },
  ];
  const BY_ID = Object.fromEntries(CATALOG.map((c) => [c.id, c]));

  // 付いている称号 → 表示に使う形。
  //   自動の称号は {id, at}、20勝は {id: "crl20-2026", year}、
  //   管理人が付けたもの・手書きのものは {id, label, sub, year, design, shape, rarity} を持っている
  function resolve(item) {
    if (!item || !item.id) return null;
    const m = /^crl20-(\d{4})$/.exec(item.id);
    const base = m ? BY_ID.crl20 : BY_ID[item.id];
    if (item.label || !base) {
      if (!item.label) return null;
      const r = RARITY[item.rarity] || RARITY.unique;
      return { id: item.id, label: item.label, sub: item.sub || "", year: item.year || "",
               rarity: r.id, rank: r.rank, design: item.design || r.design, fixedShape: item.shape || "" };
    }
    const r = RARITY[base.rarity];
    const year = m ? Number(m[1]) : null;
    return { id: item.id, label: m ? `20勝達成(${year})` : base.label, sub: m ? "CRL 20WIN" : "",
             year: "", rarity: r.id, rank: r.rank, design: r.design, fixedShape: "",
             order: CATALOG.indexOf(base) + (year ? year / 10000 : 0) };
  }

  // 一番レアな称号(同じならあとに並ぶ=条件のきびしい方、20勝は新しい年)
  function best(list) {
    return (list || []).map(resolve).filter(Boolean)
      .sort((a, b) => (b.rank - a.rank) || ((b.order ?? 99) - (a.order ?? 99)))[0] || null;
  }

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function html(t, opts = {}) {
    const id = ALIASES[t.design] || t.design;
    const d = DESIGNS.find((x) => x.id === id) || DESIGNS[0];
    const icon = ICONS[t.icon] || ICONS[d.icon];
    const subText = [t.sub, t.year].filter(Boolean).join(" · ");
    const sh = SHAPE_ALIASES[t.shape] || t.shape;
    const shape = SHAPES.some((x) => x.id === sh) ? sh : "rect";
    if (shape === "blaze") {
      // 炎の枠: 絵を3枚並べる。左の飾りに宝石があるのでアイコンは付けない
      return `<span class="bz bz-${d.id}${opts.big ? " big" : ""}" title="${esc(t.label)}">` +
        `<i class="bz-g"></i><i class="bz-l"></i><i class="bz-m"></i><i class="bz-r"></i>` +
        `<i class="bz-sh"></i><i class="bz-e"></i><i class="bz-e bz-e2"></i>` +
        `<span class="bz-text">${subText ? `<span class="ttl-sub">${esc(subText)}</span>` : ""}` +
        `<b>${esc(t.label)}</b></span></span>`;
    }
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

  return { DESIGNS, SHAPES, ICONS, RARITIES, RARITY, CATALOG, CATS, resolve, best, html };
})();
