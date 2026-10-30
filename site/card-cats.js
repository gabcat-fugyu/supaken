/* カードの分け方(主軸 / スペル / その他)と並べ方。使い手ランキングと天界デッキランキングで共通。
 * 主軸はメン限ページの「よく当たるデッキ」の一覧+ガーゴイルジャイアント(名前は API の英語名)。 */
window.CardCats = (function () {
  const WIN = new Set([
    "Hog Rider", "Royal Giant", "Giant", "Golem", "Lava Hound", "Balloon",
    "X-Bow", "Mortar", "Graveyard", "Miner", "Goblin Barrel", "Ram Rider",
    "Battle Ram", "Royal Hogs", "Elixir Golem", "Electro Giant", "Goblin Giant",
    "Giant Skeleton", "Three Musketeers", "Sparky", "Wall Breakers",
    "Skeleton Barrel", "Goblin Drill", "Mega Knight", "P.E.K.K.A",
    "Royal Recruits", "Rocket", "Minion Giant",
  ]);
  // レアリティの順(ノーマル → レア → スーパーレア → ウルトラレア → チャンピオン)
  const RARITY = { common: 1, rare: 2, epic: 3, legendary: 4, champion: 5 };
  const isTower = (id) => Number(id) >= 159000000;
  const isSpell = (id) => String(id).startsWith("28");
  const cat = (id, name) => (WIN.has(name) ? "win" : isSpell(id) ? "spell" : "other");
  const rarityRank = (r) => RARITY[String(r || "").toLowerCase()] || 0;
  return { WIN, isTower, isSpell, cat, rarityRank };
})();
