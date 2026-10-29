// member.supaken.com の入口。
//   /api/data/...  → R2 の members/... を返す(戦績データ)
//   それ以外        → site/member の画面ファイル
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/data/")) {
      const rel = decodeURIComponent(url.pathname.slice("/api/data/".length));
      if (!rel || rel.includes("..") || rel.startsWith("/")) {
        return new Response("bad path", { status: 400 });
      }
      const obj = await env.DATA.get("members/" + rel);
      if (!obj) return new Response("not found", { status: 404 });
      return new Response(obj.body, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    return env.ASSETS.fetch(request);
  },
};
