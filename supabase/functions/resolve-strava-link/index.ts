// Turns a Strava share link (usually a short https://strava.app.link/... redirect) into the
// strava.com/activities/<id> or /routes/<id> URL behind it, so the app can open that activity's
// GPX export. Browsers can't follow those redirects themselves (cross-origin), hence this.
// Only Strava hosts are ever fetched, so it can't be used as a general proxy.
//
// Deploy: npx supabase functions deploy resolve-strava-link

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const ALLOWED_HOST = /(^|\.)(strava\.app\.link|strava\.com)$/i;
const TARGET = /https?:\/\/(?:www\.)?strava\.com\/(activities|routes)\/(\d+)/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { url } = await req.json();
    let current = new URL(String(url || ""));
    for (let hop = 0; hop < 6; hop++) {
      if (current.protocol !== "https:" || !ALLOWED_HOST.test(current.hostname)) return json({ error: "not a Strava link" }, 400);
      const found = current.href.match(TARGET);
      if (found) return json({ url: `https://www.strava.com/${found[1].toLowerCase()}/${found[2]}` });
      const res = await fetch(current.href, { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0 (WingTips link resolver)" } });
      const loc = res.headers.get("location");
      if (loc) { await res.body?.cancel(); current = new URL(loc, current); continue; }
      // Branch.io link pages sometimes redirect with script instead of a header: look in the page.
      const inPage = (await res.text()).match(TARGET);
      if (inPage) return json({ url: `https://www.strava.com/${inPage[1].toLowerCase()}/${inPage[2]}` });
      break;
    }
    return json({ error: "no activity or route found behind this link" }, 404);
  } catch {
    return json({ error: "bad request" }, 400);
  }
});
