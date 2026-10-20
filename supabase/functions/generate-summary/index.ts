// AI Briefing: summarizes the real crew tips posted for one destination + category.
// Grounded entirely in what crew actually submitted -- the prompt explicitly forbids inventing
// anything not present in the tips, so this never reintroduces the fabricated content that was
// stripped from the app earlier.
//
// Deploy: npx supabase functions deploy generate-summary
// Secret: npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { destCode, category } = await req.json();
    if (!destCode || !category) return json({ error: "destCode and category are required" }, 400);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: tips, error: tipsError } = await supabase
      .from("recommendations")
      .select("text")
      .eq("destination_code", destCode)
      .eq("category", category)
      .order("created_at", { ascending: false })
      .limit(30);
    if (tipsError) return json({ error: tipsError.message }, 500);
    if (!tips || tips.length === 0) return json({ summary: null });

    const { data: cached } = await supabase
      .from("destination_summaries")
      .select("summary, tip_count")
      .eq("destination_code", destCode)
      .eq("category", category)
      .maybeSingle();
    if (cached && cached.tip_count === tips.length) return json({ summary: cached.summary });

    const tipsText = tips.map((t: { text: string }, i: number) => `${i + 1}. ${t.text}`).join("\n");
    const prompt = `You are writing a short briefing for KLM cabin/cockpit crew about to land, based only on tips other crew members have actually posted. Category: "${category}".

Write 2-3 plain sentences that synthesize the tips below into practical, specific advice. Only use what's in the tips -- never invent a place, price, or detail that isn't there. If the tips disagree or are too thin to generalize, say so briefly instead of papering over it. No preamble, no "Based on the tips" framing, just the briefing itself.

Tips:
${tipsText}`;

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!aiRes.ok) return json({ error: "AI request failed", detail: await aiRes.text() }, 502);

    const aiData = await aiRes.json();
    const summary = aiData?.content?.[0]?.text?.trim();
    if (!summary) return json({ error: "No summary generated" }, 502);

    await supabase.from("destination_summaries").upsert({
      destination_code: destCode,
      category,
      summary,
      tip_count: tips.length,
      updated_at: new Date().toISOString(),
    });

    return json({ summary });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
