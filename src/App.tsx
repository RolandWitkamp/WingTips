import { useState, useEffect, useRef, useMemo } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://sgdqckahseaebayuapgo.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNnZHFja2Foc2VhZWJheXVhcGdvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0NzIxOTUsImV4cCI6MjA5NjA0ODE5NX0.Yyy4K5VS6xkjKk9DTrsoDdL74n2STTACCF52NwNxXgk"
);
// Captured once, before Supabase processes/clears the URL hash, so a password-reset link's
// flow type survives even though it just looks like landing in a normal session otherwise.
const AUTH_HASH_TYPE = (() => { const m = window.location.hash.match(/type=([^&]+)/); return m ? m[1] : null; })();

const GOOGLE_MAPS_KEY = "AIzaSyAEa1VgflcuixX4DfcuyH9bwerXgJiQCBE";
const WEATHER_API_KEY = "105f28d6029a12181bc2527365a7e1d2";
// Bump this on every deploy — shown in the Profile screen so it's easy to confirm the latest
// build actually went live, same purpose as Pillow Report's "Version X.X.X" footer.
const APP_VERSION = "1.15.0";

const weatherCache: Record<string, { temp: string; desc: string; ts: number }> = {};
type ForecastDay = { date: string; min: number; max: number; main: string; desc: string };
const forecastCache: Record<string, { days: ForecastDay[]; ts: number }> = {};
const cityCenterCache: Record<string, { lat: number; lng: number }> = {};
async function geocodeCity(city: string, country: string): Promise<{ lat: number; lng: number } | null> {
  const key = `${city},${country}`;
  if (cityCenterCache[key]) return cityCenterCache[key];
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(key)}&format=json&limit=1`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const data = await res.json();
    if (data?.[0]) {
      const center = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
      cityCenterCache[key] = center;
      return center;
    }
  } catch {}
  return null;
}
async function geocodeHotel(crewHotel: string, city: string, country: string): Promise<{ lat: number; lng: number } | null> {
  if (!crewHotel) return null;
  // crewHotel sometimes carries a trailing "(crew rate: ...)" note -- strip it before geocoding.
  const name = crewHotel.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const key = `hotel:${name},${city},${country}`;
  if (cityCenterCache[key]) return cityCenterCache[key];
  // An audit of every destination's crew hotel found Nominatim/OSM simply has no data for ~30%
  // of them (Mexico City's among them) -- the map silently fell back to a city-wide view with no
  // indication why. Google Places' "Find Place" is built for resolving a named business like
  // this and covers hotels far more completely, so it goes first now.
  try {
    if (await loadGoogleMaps() && ensurePlacesServices()) {
      const found = await googleFindPlace(`${name}, ${city}, ${country}`);
      if (found?.geometry?.location) {
        const center = { lat: found.geometry.location.lat(), lng: found.geometry.location.lng() };
        cityCenterCache[key] = center;
        return center;
      }
    }
  } catch {}
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(`${name}, ${city}, ${country}`)}&format=json&limit=1`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const data = await res.json();
    if (data?.[0]) {
      const center = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
      cityCenterCache[key] = center;
      return center;
    }
  } catch {}
  return null;
}

let gmapsLoading: Promise<boolean> | null = null;
function loadGoogleMaps(): Promise<boolean> {
  if ((window as any).google?.maps?.places) return Promise.resolve(true);
  if (gmapsLoading) return gmapsLoading;
  gmapsLoading = new Promise(resolve => {
    try {
      if (document.getElementById("gmaps-js")) {
        const iv = setInterval(() => { if ((window as any).google?.maps?.places) { clearInterval(iv); resolve(true); } }, 100);
        return;
      }
      const s = document.createElement("script"); s.id = "gmaps-js";
      s.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_KEY}&libraries=places&language=en`;
      s.onload = () => resolve(!!(window as any).google?.maps?.places);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    } catch { resolve(false); }
  });
  return gmapsLoading;
}
let acService: any = null, placesService: any = null;
function ensurePlacesServices(): boolean {
  const google = (window as any).google;
  if (!google?.maps?.places) return false;
  try {
    if (!acService) acService = new google.maps.places.AutocompleteService();
    if (!placesService) placesService = new google.maps.places.PlacesService(document.createElement("div"));
    return true;
  } catch { return false; }
}
function googlePlacePredictions(query: string, destCity: string): Promise<any[]> {
  return new Promise(resolve => {
    try {
      acService.getPlacePredictions({ input: `${query}, ${destCity}` }, (preds: any, status: string) => {
        resolve(status === "OK" && preds ? preds : []);
      });
    } catch { resolve([]); }
  });
}
function googlePlaceDetails(placeId: string): Promise<any | null> {
  return new Promise(resolve => {
    try {
      placesService.getDetails({ placeId, fields: ["name", "formatted_address", "geometry", "opening_hours"] }, (place: any, status: string) => {
        resolve(status === "OK" ? place : null);
      });
    } catch { resolve(null); }
  });
}
function googleFindPlace(query: string): Promise<any | null> {
  return new Promise(resolve => {
    try {
      placesService.findPlaceFromQuery({ query, fields: ["place_id", "geometry"] }, (results: any, status: string) => {
        resolve(status === "OK" && results?.[0] ? results[0] : null);
      });
    } catch { resolve(null); }
  });
}

// Google's weekday_text is 7 full lines ("Monday: 12:00 – 4:00 PM, 5:00 – 10:15 PM", one per
// day) -- joined as-is that's a wall of text. Collapse consecutive days that share the exact
// same hours into a range ("Mon–Thu 12:00–4:00 PM, 5:00–10:15 PM · Fri 12:00–10:30 PM · ...")
// so it reads as a normal short badge instead of a full weekly schedule dump.
function condenseOpeningHours(weekdayText: string[]): string {
  const parsed = weekdayText.map(line => {
    const i = line.indexOf(":");
    return { day: line.slice(0, i).trim(), hours: line.slice(i + 1).trim() };
  });
  const groups: { days: string[]; hours: string }[] = [];
  for (const { day, hours } of parsed) {
    const last = groups[groups.length - 1];
    if (last && last.hours === hours) last.days.push(day);
    else groups.push({ days: [day], hours });
  }
  const abbr = (d: string) => d.slice(0, 3);
  return groups.map(g => {
    const label = g.days.length <= 2 ? g.days.map(abbr).join(", ") : `${abbr(g.days[0])}–${abbr(g.days[g.days.length - 1])}`;
    return `${label} ${g.hours}`;
  }).join(" · ");
}

function hhmmToMinutes(t: string): number {
  return parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(2), 10);
}
// Google's structured opening_hours.periods carry real 24hr open/close times local to the place
// -- used instead of parsing the free-text hours string, to flag "Jetlag Proof" places: ones
// useful for crew landing at odd hours (opens before 7am) or needing a late meal (kitchen open at
// or past 11pm, or open right through midnight).
function jetlagProofFromGooglePeriods(periods: any[] | undefined): boolean {
  if (!periods || !periods.length) return false;
  return periods.some(p => {
    if (!p.open) return false;
    if (!p.close) return true; // no close time listed = open 24 hours
    const open = hhmmToMinutes(p.open.time);
    const close = hhmmToMinutes(p.close.time);
    const spansMidnight = p.close.day !== p.open.day || close < open;
    return open < 420 || close >= 1380 || spansMidnight;
  });
}
// Best-effort equivalent for OSM-syntax opening_hours strings (e.g. "Mo-Su 06:00-02:00", "24/7")
// when a tip came from Nominatim instead of Google and there's no structured periods to read.
function jetlagProofFromOsmHours(osm: string | undefined): boolean {
  if (!osm) return false;
  if (/24\/7/.test(osm)) return true;
  const times = [...osm.matchAll(/(\d{1,2}):(\d{2})/g)].map(m => parseInt(m[1], 10) * 60 + parseInt(m[2], 10));
  for (let i = 0; i < times.length - 1; i += 2) {
    const open = times[i], close = times[i + 1];
    if (open < 420 || close >= 1380 || close < open) return true;
  }
  return false;
}
function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const sinLat = Math.sin(dLat / 2), sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * sinLng * sinLng;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
function fmtDistance(km: number): string {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}
function tipMapsUrl(tip: any, dest: any): string {
  if (tip.coords) return `https://www.google.com/maps/search/?api=1&query=${tip.coords.lat},${tip.coords.lon}`;
  const q = tip.text.startsWith("📍")
    ? tip.text.slice(2).split("—")[0].trim()
    : tip.text.replace(/[^\w\s,''-]/g, " ").slice(0, 60).trim();
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q + " " + dest.city)}`;
}
// Place tips are stored as "📍 Place — note"; on screen the place becomes a bold title instead.
function splitTipText(text: string): { title: string; body: string } {
  const t = text || "";
  if (!t.startsWith("📍")) return { title: "", body: t };
  const rest = t.replace(/^📍\s*/, "");
  const i = rest.indexOf("—");
  return i < 0 ? { title: rest.trim(), body: "" } : { title: rest.slice(0, i).trim(), body: rest.slice(i + 1).trim() };
}
function TipText({ text, className }: { text: string; className: string }) {
  const { title, body } = splitTipText(text);
  return (
    <>
      {title && <div className="tip-title">{title}</div>}
      {body && <p className={className}>{body}</p>}
    </>
  );
}
function buildTipShareText(tip: any, dest: any): string {
  const cat = CATEGORIES.find(c => c.id === tip.category);
  const lines = [`${dest.flag} ${dest.city} · ${cat?.label || tip.category}`, tip.text];
  if (tip.price) lines.push(`💰 ${tip.price}`);
  if (tip.hours) lines.push(`🕐 ${tip.hours}`);
  if (tip.discount) lines.push(`✂️ ${tip.discount === true ? "Crew discount" : `${tip.discount} crew discount`}`);
  lines.push(`📍 ${tipMapsUrl(tip, dest)}`);
  lines.push("— shared via WingTips");
  return lines.join("\n");
}
async function shareTip(tip: any, dest: any, onCopied?: () => void) {
  const text = buildTipShareText(tip, dest);
  const nav = navigator as any;
  if (nav.share) {
    try { await nav.share({ title: `${dest.city} — WingTips`, text }); } catch {}
    return;
  }
  try { await navigator.clipboard.writeText(text); onCopied?.(); } catch {}
}

function useWeather(code: string, city: string, country: string) {
  const [weather, setWeather] = useState<string | null>(null);
  useEffect(() => {
    if (!WEATHER_API_KEY) return;
    const cached = weatherCache[code];
    if (cached && Date.now() - cached.ts < 30 * 60 * 1000) {
      setWeather(`${cached.temp}°C / ${cached.desc}`);
      return;
    }
    fetch(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)},${encodeURIComponent(country)}&appid=${WEATHER_API_KEY}&units=metric`)
      .then(r => r.json())
      .then(d => {
        if (!d.main) return;
        const temp = Math.round(d.main.temp).toString();
        const desc = d.weather[0].description.replace(/\b\w/g, (c: string) => c.toUpperCase());
        weatherCache[code] = { temp, desc, ts: Date.now() };
        setWeather(`${temp}°C / ${desc}`);
      })
      .catch(() => {});
  }, [code, city, country]);
  return weather;
}

function weatherIcon(main: string): string {
  const m = (main || "").toLowerCase();
  if (m.includes("thunderstorm")) return "storm";
  if (m.includes("snow")) return "snow";
  if (m.includes("rain") || m.includes("drizzle")) return "rain";
  if (m.includes("mist") || m.includes("fog") || m.includes("haze")) return "fog";
  if (m.includes("clear")) return "sun";
  return "cloud";
}

// Only fetched when the weather overlay is actually opened (enabled), not on every destination
// page load -- the 5-day/3-hour forecast endpoint is a separate call from the current-weather one
// already used elsewhere, no need to spend that request unless someone actually wants to see it.
function useWeatherForecast(code: string, city: string, country: string, enabled: boolean) {
  const [forecast, setForecast] = useState<ForecastDay[] | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!enabled || !WEATHER_API_KEY) return;
    const cached = forecastCache[code];
    if (cached && Date.now() - cached.ts < 60 * 60 * 1000) { setForecast(cached.days); return; }
    setLoading(true);
    fetch(`https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(city)},${encodeURIComponent(country)}&appid=${WEATHER_API_KEY}&units=metric`)
      .then(r => r.json())
      .then(d => {
        if (!d.list) { setLoading(false); return; }
        const byDate: Record<string, any[]> = {};
        for (const entry of d.list) (byDate[entry.dt_txt.slice(0, 10)] ||= []).push(entry);
        const days: ForecastDay[] = Object.entries(byDate).slice(0, 6).map(([date, entries]) => {
          const temps = entries.map((e: any) => e.main.temp);
          // The entry closest to midday is the most representative icon/description for the day.
          const midday = entries.reduce((best: any, e: any) =>
            Math.abs(Number(e.dt_txt.slice(11, 13)) - 13) < Math.abs(Number(best.dt_txt.slice(11, 13)) - 13) ? e : best, entries[0]);
          return {
            date,
            min: Math.round(Math.min(...temps)),
            max: Math.round(Math.max(...temps)),
            main: midday.weather[0].main,
            desc: midday.weather[0].description.replace(/\b\w/g, (c: string) => c.toUpperCase()),
          };
        });
        forecastCache[code] = { days, ts: Date.now() };
        setForecast(days);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [code, city, country, enabled]);
  return { forecast, loading };
}

// Profile, favorites, connections and recently-visited destinations all used to live only in
// this browser's localStorage, so a second device (or a fresh browser) always started empty.
// This hook keeps the same shape every screen already expects, but backs it with the `profiles`,
// `favorites` and `connections` tables (see supabase_schema.sql) so it follows the account.
function useCloudProfile() {
  const [loaded, setLoaded] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [profile, setProfile] = useState({ name: "", role: "Cabin Crew", base: "AMS", bio: "" });
  const [recentDests, setRecentDests] = useState<string[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [favoritesSeen, setFavoritesSeen] = useState<string[]>([]);

  async function load() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    setUserId(user.id);
    setUserEmail(user.email || null);

    let { data: row, error: selectError } = await supabase.from("profiles").select("*").eq("id", user.id).maybeSingle();
    if (selectError) console.error("profiles select failed:", selectError);
    if (!row) {
      const { data: inserted, error: insertError } = await supabase.from("profiles").insert({ id: user.id }).select().maybeSingle();
      if (insertError) console.error("profiles insert failed:", insertError);
      row = inserted;
      if (!row) {
        // Insert can come back empty on a race (another device creating the same row at the same
        // moment) -- re-select once before giving up, instead of silently carrying on with no
        // row at all, which made every later save a no-op update against a row that never existed.
        const { data: retried, error: retryError } = await supabase.from("profiles").select("*").eq("id", user.id).maybeSingle();
        if (retryError) console.error("profiles re-select failed:", retryError);
        row = retried;
      }
    }
    if (row) {
      setProfile({ name: row.name || "", role: row.role || "Cabin Crew", base: row.base || "AMS", bio: row.bio || "" });
      setRecentDests(row.recent_destinations || []);
      setFavoritesSeen(row.favorites_seen || []);
    }

    const { data: favRows } = await supabase.from("favorites").select("tip_key").eq("user_id", user.id);
    setFavorites((favRows || []).map((r: any) => r.tip_key));
    setLoaded(true);
  }

  useEffect(() => { load(); }, []);

  async function updateProfile(updates: any): Promise<{ ok: boolean; message?: string }> {
    setProfile((p: any) => ({ ...p, ...updates }));
    // upsert, not update: an UPDATE against a row that doesn't exist (e.g. the initial insert on
    // first login never landed) silently matches zero rows and "succeeds" without saving
    // anything -- the profile looked saved locally but came back empty on every next login.
    if (!userId) { console.error("updateProfile: no userId yet, save skipped"); return { ok: false, message: "not signed in yet" }; }
    const { error } = await supabase.from("profiles").upsert({ id: userId, ...updates });
    if (error) { console.error("updateProfile failed:", error); return { ok: false, message: `${error.code || ""} ${error.message}`.trim() }; }
    return { ok: true };
  }

  function visitDest(code: string) {
    setRecentDests((prev: string[]) => {
      const next = [code, ...prev.filter((c: string) => c !== code)].slice(0, 8);
      if (userId) supabase.from("profiles").upsert({ id: userId, recent_destinations: next }).then(() => {});
      return next;
    });
  }

  async function toggleFavorite(key: string) {
    if (!userId) return;
    const has = favorites.includes(key);
    setFavorites((prev: string[]) => has ? prev.filter((k: string) => k !== key) : [...prev, key]);
    if (has) await supabase.from("favorites").delete().eq("user_id", userId).eq("tip_key", key);
    else await supabase.from("favorites").insert({ user_id: userId, tip_key: key });
  }

  function markFavoritesSeen() {
    setFavoritesSeen(favorites);
    if (userId) supabase.from("profiles").upsert({ id: userId, favorites_seen: favorites }).then(() => {});
  }
  const unseenFavorites = favorites.filter(k => !favoritesSeen.includes(k)).length;

  return {
    loaded, userId, userEmail, profile, updateProfile,
    recentDests, visitDest,
    favorites, toggleFavorite, unseenFavorites, markFavoritesSeen,
    reload: load,
  };
}

// Heads-up for the app owner when someone new signs up -- not an approval gate (there isn't one),
// just a notification. Reads admin_signup_log, which handle_new_user() (see supabase_schema.sql)
// writes to for every accepted signup; RLS on that table only returns rows to the owner's own
// account, so isAdmin here is really just "does the server actually hand me any rows", the email
// check is only to avoid firing the query for every other user.
const ADMIN_EMAIL = "roland.witkamp@klm.com";
function useAdminSignups(userEmail: string | null) {
  const isAdmin = (userEmail || "").toLowerCase() === ADMIN_EMAIL;
  const [events, setEvents] = useState<{ id: number; email: string; created_at: string }[]>([]);
  const [lastSeenId, setLastSeenId] = useState<number>(() => {
    try { return Number(localStorage.getItem("wt_admin_signups_seen") || 0); } catch { return 0; }
  });

  useEffect(() => {
    if (!isAdmin) return;
    supabase.from("admin_signup_log").select("*").order("created_at", { ascending: false }).limit(50)
      .then(({ data, error }) => { if (error) console.error("admin_signup_log load failed:", error); else setEvents(data || []); });
  }, [isAdmin]);

  const unseenCount = isAdmin ? events.filter(e => e.id > lastSeenId).length : 0;
  function markSeen() {
    if (!events.length) return;
    const maxId = Math.max(...events.map(e => e.id));
    setLastSeenId(maxId);
    try { localStorage.setItem("wt_admin_signups_seen", String(maxId)); } catch {}
  }

  return { isAdmin, events, unseenCount, lastSeenId, markSeen };
}

// Real crew-to-crew connections -- a request/accept relationship between two actual accounts
// (connection_requests table: requester_id, addressee_id, status), replacing the old `connections`
// table which just stored a free-typed name string with no link to a real account and no consent
// from the other side. That old table is left in place but unused; there's no reliable way to
// map its name strings onto real accounts, so existing "connections" need to be re-sent as real
// requests. A request from someone who already has a pending request in from you is auto-accepted
// instead of creating a second row, since that's just two people connecting at the same time.
function useConnections(userId: string | null) {
  const [loaded, setLoaded] = useState(false);
  const [accepted, setAccepted] = useState<{ userId: string; name: string; role: string }[]>([]);
  const [incoming, setIncoming] = useState<{ reqId: any; userId: string; name: string; role: string }[]>([]);
  const [outgoing, setOutgoing] = useState<{ reqId: any; userId: string; name: string; role: string }[]>([]);

  async function load() {
    if (!userId) return;
    const { data: reqRows, error } = await supabase.from("connection_requests").select("*")
      .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`);
    if (error) { console.error("connection_requests load failed:", error); return; }
    const rows = reqRows || [];
    const otherIds = Array.from(new Set(rows.map((r: any) => r.requester_id === userId ? r.addressee_id : r.requester_id)));
    const profilesById: Record<string, any> = {};
    if (otherIds.length) {
      const { data: profRows } = await supabase.from("profiles").select("id,name,role").in("id", otherIds);
      for (const p of profRows || []) profilesById[p.id] = p;
    }
    const acc: any[] = [], inc: any[] = [], out: any[] = [];
    for (const r of rows) {
      const otherId = r.requester_id === userId ? r.addressee_id : r.requester_id;
      const prof = profilesById[otherId];
      const entry = { reqId: r.id, userId: otherId, name: prof?.name || "Crew member", role: prof?.role || "Cabin Crew" };
      if (r.status === "accepted") acc.push(entry);
      else if (r.addressee_id === userId) inc.push(entry);
      else out.push(entry);
    }
    setAccepted(acc); setIncoming(inc); setOutgoing(out);
    setLoaded(true);
  }

  useEffect(() => { load(); }, [userId]);

  async function sendRequest(otherUserId: string) {
    if (!userId || otherUserId === userId) return;
    const already = incoming.find(r => r.userId === otherUserId);
    if (already) { await acceptRequest(already.reqId); return; }
    const { error } = await supabase.from("connection_requests").insert({ requester_id: userId, addressee_id: otherUserId });
    if (error) { console.error("send connection request failed:", error); return; }
    await load();
  }
  async function acceptRequest(reqId: any) {
    const { error } = await supabase.from("connection_requests").update({ status: "accepted", responded_at: new Date().toISOString() }).eq("id", reqId);
    if (error) { console.error("accept connection request failed:", error); return; }
    await load();
  }
  async function declineRequest(reqId: any) {
    const { error } = await supabase.from("connection_requests").delete().eq("id", reqId);
    if (error) { console.error("decline/remove connection failed:", error); return; }
    await load();
  }
  function relation(otherUserId: string | null | undefined): "self" | "none" | "outgoing" | "incoming" | "accepted" {
    if (!otherUserId || !userId) return "none";
    if (otherUserId === userId) return "self";
    if (accepted.some(r => r.userId === otherUserId)) return "accepted";
    if (incoming.some(r => r.userId === otherUserId)) return "incoming";
    if (outgoing.some(r => r.userId === otherUserId)) return "outgoing";
    return "none";
  }
  // Searches every crew profile by name, not just existing connections -- profiles are readable
  // by any signed-in user already (see profiles_select_all in supabase_schema.sql, broadened
  // because tips already show the author's name to everyone), so this needs no new RLS policy.
  async function searchUsers(query: string): Promise<{ userId: string; name: string; role: string }[]> {
    const q = query.trim();
    if (!q || !userId) return [];
    const { data, error } = await supabase.from("profiles").select("id,name,role")
      .ilike("name", `%${q}%`).neq("id", userId).limit(20);
    if (error) { console.error("searchUsers failed:", error); return []; }
    return (data || []).map((p: any) => ({ userId: p.id, name: p.name || "Crew member", role: p.role || "Cabin Crew" }));
  }

  return { loaded, userId, accepted, incoming, outgoing, sendRequest, acceptRequest, declineRequest, relation, searchUsers, reload: load };
}

// Recommendations ("crew tips") used to be written only to this browser's localStorage, so no
// one else ever saw a tip someone added -- the whole point of a crew-shared guide. Now backed by
// the `recommendations`/`recommendation_comments`/`recommendation_likes` tables: every signed-in
// crew member reads the same data, and a like/comment is a real row instead of local-only state.
function useRecommendations() {
  const [recs, setRecs] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);

  async function reload() {
    const { data: { user } } = await supabase.auth.getUser();
    const uid = user?.id || null;
    const [{ data: recRows }, { data: commentRows }, { data: likeRows }] = await Promise.all([
      supabase.from("recommendations").select("*").order("created_at", { ascending: false }),
      supabase.from("recommendation_comments").select("*").order("created_at", { ascending: true }),
      supabase.from("recommendation_likes").select("recommendation_id, user_id"),
    ]);
    const commentsByRec: Record<string, any[]> = {};
    (commentRows || []).forEach((c: any) => {
      (commentsByRec[c.recommendation_id] ||= []).push({ id: c.id, name: c.name, role: c.role, text: c.text, date: (c.created_at || "").slice(0, 10) });
    });
    const likesByRec: Record<string, { count: number; mine: boolean }> = {};
    (likeRows || []).forEach((l: any) => {
      const bucket = (likesByRec[l.recommendation_id] ||= { count: 0, mine: false });
      bucket.count++;
      if (l.user_id === uid) bucket.mine = true;
    });
    const mapped = (recRows || []).map((r: any) => ({
      id: r.id,
      destCode: r.destination_code,
      category: r.category,
      authorId: r.author_id,
      name: r.author_name,
      role: r.author_role,
      text: r.text,
      date: (r.created_at || "").slice(0, 10),
      price: r.price || undefined,
      hours: r.hours || undefined,
      discount: r.discount === "true" ? true : (r.discount || undefined),
      jetlagProof: r.jetlag_proof || undefined,
      soloFriendly: r.solo_friendly || undefined,
      quickBite: r.quick_bite || undefined,
      visibility: r.visibility || "public",
      tags: r.tags || undefined,
      photo: r.photo || undefined,
      coords: r.coords || undefined,
      comments: commentsByRec[r.id] || [],
      likes: likesByRec[r.id]?.count || 0,
      likedByMe: likesByRec[r.id]?.mine || false,
    }));
    setRecs(mapped);
    setLoaded(true);
  }

  useEffect(() => { reload(); }, []);

  const byDest = useMemo(() => {
    const grouped: Record<string, any[]> = {};
    for (const r of recs) (grouped[r.destCode] ||= []).push(r);
    return grouped;
  }, [recs]);

  async function addRecommendation(destCode: string, tipData: any, profile: any) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;
    const row = {
      destination_code: destCode,
      category: tipData.category,
      author_id: user.id,
      author_name: profile.name,
      author_role: profile.role,
      text: tipData.text,
      price: tipData.price || null,
      hours: tipData.hours || null,
      discount: tipData.discount === true ? "true" : (tipData.discount || null),
      jetlag_proof: tipData.jetlagProof || false,
      solo_friendly: tipData.soloFriendly || false,
      quick_bite: tipData.quickBite || false,
      visibility: tipData.visibility || "public",
      tags: tipData.tags || null,
      photo: tipData.photo || null,
      coords: tipData.coords || null,
    };
    const { data, error } = await supabase.from("recommendations").insert(row).select().maybeSingle();
    if (error || !data) return null;
    const newTip = {
      id: data.id, destCode, category: data.category, authorId: data.author_id, name: data.author_name, role: data.author_role,
      text: data.text, date: (data.created_at || "").slice(0, 10),
      price: data.price || undefined, hours: data.hours || undefined,
      discount: data.discount === "true" ? true : (data.discount || undefined),
      jetlagProof: data.jetlag_proof || undefined, soloFriendly: data.solo_friendly || undefined, quickBite: data.quick_bite || undefined,
      visibility: data.visibility || "public",
      tags: data.tags || undefined, photo: data.photo || undefined, coords: data.coords || undefined,
      comments: [] as any[], likes: 0, likedByMe: false,
    };
    setRecs(prev => [newTip, ...prev]);
    return newTip;
  }

  async function toggleLike(tipId: any) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const tip = recs.find(r => r.id === tipId);
    if (!tip) return;
    if (tip.likedByMe) {
      await supabase.from("recommendation_likes").delete().eq("recommendation_id", tipId).eq("user_id", user.id);
      setRecs(prev => prev.map(r => r.id === tipId ? { ...r, likes: r.likes - 1, likedByMe: false } : r));
    } else {
      await supabase.from("recommendation_likes").insert({ recommendation_id: tipId, user_id: user.id });
      setRecs(prev => prev.map(r => r.id === tipId ? { ...r, likes: r.likes + 1, likedByMe: true } : r));
    }
  }

  async function addComment(tipId: any, comment: { name: string; role: string; text: string }) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const row = { recommendation_id: tipId, author_id: user.id, name: comment.name, role: comment.role, text: comment.text };
    const { data } = await supabase.from("recommendation_comments").insert(row).select().maybeSingle();
    const newComment = { id: data?.id ?? Date.now(), name: comment.name, role: comment.role, text: comment.text, date: new Date().toISOString().split("T")[0] };
    setRecs(prev => prev.map(r => r.id === tipId ? { ...r, comments: [...r.comments, newComment] } : r));
  }

  return { byDest, loaded, addRecommendation, toggleLike, addComment, reload };
}

// One-time import: everyone who used the app before cross-device sync shipped has real data
// sitting in this browser's localStorage (profile, favorites, connections, the recommendations
// they added) that the new Supabase tables never saw -- a fresh account there looks empty even
// though "everything is on the server" from here on. Runs once per browser (wt_migrated_to_cloud
// flag), only fills in what the server doesn't already have, and never overwrites real server
// data with stale local data.
async function migrateLocalDataToCloud(userId: string, serverProfile: { name: string }): Promise<boolean> {
  let wroteAnything = false;
  function readLocal<T>(key: string, fallback: T): T {
    try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; } catch { return fallback; }
  }

  if (!serverProfile.name) {
    const old = readLocal<any>("wt_profile", null);
    if (old && old.name) {
      const { error } = await supabase.from("profiles").upsert({ id: userId, name: old.name, role: old.role || "Cabin Crew", base: old.base || "AMS", bio: old.bio || "" });
      if (error) console.error("migrate profile failed:", error); else wroteAnything = true;
    }
  }

  const oldFavorites = readLocal<string[]>("wt_favorites", []);
  if (oldFavorites.length) {
    const { error } = await supabase.from("favorites").upsert(oldFavorites.map(key => ({ user_id: userId, tip_key: key })), { onConflict: "user_id,tip_key" });
    if (error) console.error("migrate favorites failed:", error); else wroteAnything = true;
  }

  // No migration for old localStorage connections (wt_connections): those were just typed-in
  // name strings with no link to a real account, so there's nothing reliable to map them onto in
  // the new request/accept system -- anyone who had them will need to re-send a real request.

  const oldRecent = readLocal<string[]>("wt_recent_destinations", []);
  const oldSeen = readLocal<string[]>("wt_favorites_seen", []);
  if (oldRecent.length || oldSeen.length) {
    const updates: any = { id: userId };
    if (oldRecent.length) updates.recent_destinations = oldRecent;
    if (oldSeen.length) updates.favorites_seen = oldSeen;
    const { error } = await supabase.from("profiles").upsert(updates);
    if (error) console.error("migrate recent/seen failed:", error); else wroteAnything = true;
  }

  const oldTips = readLocal<Record<string, any[]>>("wt_added_tips", {});
  const rows: any[] = [];
  for (const [code, tips] of Object.entries(oldTips)) {
    for (const t of tips) {
      rows.push({
        destination_code: code, category: t.category, author_id: userId,
        author_name: t.name, author_role: t.role, text: t.text,
        price: t.price || null, hours: t.hours || null,
        discount: t.discount === true ? "true" : (t.discount || null),
        jetlag_proof: t.jetlagProof || false, solo_friendly: t.soloFriendly || false, quick_bite: t.quickBite || false,
        visibility: t.visibility || "public",
        tags: t.tags || null, photo: t.photo || null, coords: t.coords || null,
        created_at: t.date ? new Date(t.date).toISOString() : new Date().toISOString(),
      });
    }
  }
  if (rows.length) {
    try { await supabase.from("recommendations").insert(rows); wroteAnything = true; } catch {}
  }

  return wroteAnything;
}

const DESTINATIONS = {
  DXB: { code:"DXB", city:"Dubai", country:"United Arab Emirates", flag:"🇦🇪", crewHotel:"JW Marriott Dubai", layoverHours:18, weather:"38°C / Sunny", localTime:"14:32", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  NRT: { code:"NRT", city:"Tokyo", country:"Japan", flag:"🇯🇵", crewHotel:"Hyatt Regency Tokyo", layoverHours:24, weather:"18°C / Overcast", localTime:"09:15", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  JFK: { code:"JFK", city:"New York", country:"United States", flag:"🇺🇸", crewHotel:"Hyatt Regency Times Square", layoverHours:22, weather:"12°C / Partly Cloudy", localTime:"22:48", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  // ─── KLM / KLM CITYHOPPER NETWORK (April 2026) ─────────────────────────────
  AMS: { code:"AMS", city:"Amsterdam", country:"Netherlands", flag:"🇳🇱", crewHotel:"Novotel Amsterdam City", layoverHours:12, weather:"13°C / Cloudy", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  VIE: { code:"VIE", city:"Vienna", country:"Austria", flag:"🇦🇹", crewHotel:"Imperial Riding School", layoverHours:14, weather:"11°C / Partly Cloudy", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  BRU: { code:"BRU", city:"Brussels", country:"Belgium", flag:"🇧🇪", crewHotel:"Park Inn by Radisson", layoverHours:16, weather:"12°C / Overcast", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  GVA: { code:"GVA", city:"Geneva", country:"Switzerland", flag:"🇨🇭", crewHotel:"Moevenpick", layoverHours:14, weather:"14°C / Clear", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  ZRH: { code:"ZRH", city:"Zürich", country:"Switzerland", flag:"🇨🇭", crewHotel:"Moevenpick Regensdorf", layoverHours:16, weather:"12°C / Cloudy", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  CPH: { code:"CPH", city:"Copenhagen", country:"Denmark", flag:"🇩🇰", crewHotel:"Scandic Copenhagen", layoverHours:18, weather:"9°C / Windy", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  ARN: { code:"ARN", city:"Stockholm", country:"Sweden", flag:"🇸🇪", crewHotel:"Courtyard by Marriott", layoverHours:16, weather:"7°C / Clear", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  OSL: { code:"OSL", city:"Oslo", country:"Norway", flag:"🇳🇴", crewHotel:"Clarion the Hub", layoverHours:14, weather:"6°C / Cloudy", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  HEL: { code:"HEL", city:"Helsinki", country:"Finland", flag:"🇫🇮", crewHotel:"Original Sokos Hotel Presidentti", layoverHours:14, weather:"5°C / Overcast", localTime:"11:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  WAW: { code:"WAW", city:"Warsaw", country:"Poland", flag:"🇵🇱", crewHotel:"Hilton Warsaw", layoverHours:16, weather:"10°C / Cloudy", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  PRG: { code:"PRG", city:"Prague", country:"Czech Republic", flag:"🇨🇿", crewHotel:"Hilton Hotel Prague", layoverHours:18, weather:"11°C / Clear", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  BUD: { code:"BUD", city:"Budapest", country:"Hungary", flag:"🇭🇺", crewHotel:"Mercure Korona", layoverHours:18, weather:"12°C / Sunny", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  BCN: { code:"BCN", city:"Barcelona", country:"Spain", flag:"🇪🇸", crewHotel:"Four Points by Sheraton", layoverHours:20, weather:"19°C / Sunny", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  MAD: { code:"MAD", city:"Madrid", country:"Spain", flag:"🇪🇸", crewHotel:"Westin Cuzco", layoverHours:20, weather:"17°C / Sunny", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  LIS: { code:"LIS", city:"Lisbon", country:"Portugal", flag:"🇵🇹", crewHotel:"Sheraton Lisbon", layoverHours:20, weather:"18°C / Sunny", localTime:"09:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  FCO: { code:"FCO", city:"Rome", country:"Italy", flag:"🇮🇹", crewHotel:"Radisson Blu GHR Rome", layoverHours:18, weather:"18°C / Clear", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  MXP: { code:"MXP", city:"Milan", country:"Italy", flag:"🇮🇹", crewHotel:"NH Touring", layoverHours:16, weather:"14°C / Partly Cloudy", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  LHR: { code:"LHR", city:"London", country:"United Kingdom", flag:"🇬🇧", crewHotel:"Marriott Kensington", layoverHours:20, weather:"13°C / Overcast", localTime:"09:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  MAN: { code:"MAN", city:"Manchester", country:"United Kingdom", flag:"🇬🇧", crewHotel:"Maldron Hotel", layoverHours:16, weather:"11°C / Rainy", localTime:"09:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  SIN: { code:"SIN", city:"Singapore", country:"Singapore", flag:"🇸🇬", crewHotel:"Swissotel The Stamford", layoverHours:22, weather:"30°C / Humid", localTime:"17:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  BKK: { code:"BKK", city:"Bangkok", country:"Thailand", flag:"🇹🇭", crewHotel:"Sheraton Royal Orchid", layoverHours:20, weather:"33°C / Humid", localTime:"16:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  NBO: { code:"NBO", city:"Nairobi", country:"Kenya", flag:"🇰🇪", crewHotel:"Crowne Plaza Lazizi", layoverHours:20, weather:"22°C / Clear", localTime:"12:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  JNB: { code:"JNB", city:"Johannesburg", country:"South Africa", flag:"🇿🇦", crewHotel:"Balalaika", layoverHours:18, weather:"20°C / Sunny", localTime:"11:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  GRU: { code:"GRU", city:"Sao Paulo", country:"Brazil", flag:"🇧🇷", crewHotel:"Grand Mercure Ibirapuera", layoverHours:20, weather:"24°C / Humid", localTime:"06:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  EZE: { code:"EZE", city:"Buenos Aires", country:"Argentina", flag:"🇦🇷", crewHotel:"Hotel Emperador", layoverHours:22, weather:"16°C / Partly Cloudy", localTime:"06:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  SYD: { code:"SYD", city:"Sydney", country:"Australia", flag:"🇦🇺", crewHotel:"Rydges Sydney Airport", layoverHours:24, weather:"22°C / Sunny", localTime:"20:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  ORD: { code:"ORD", city:"Chicago", country:"United States", flag:"🇺🇸", crewHotel:"Sheraton Grand Chicago Riverwalk", layoverHours:18, weather:"8°C / Windy", localTime:"04:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  BOS: { code:"BOS", city:"Boston", country:"United States", flag:"🇺🇸", crewHotel:"Hilton Boston Back Bay", layoverHours:18, weather:"10°C / Cloudy", localTime:"04:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  IAD: { code:"IAD", city:"Washington DC", country:"United States", flag:"🇺🇸", crewHotel:"Omni Shoreham", layoverHours:20, weather:"14°C / Clear", localTime:"04:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  LAX: { code:"LAX", city:"Los Angeles", country:"United States", flag:"🇺🇸", crewHotel:"Marriott Torrance South Bay", layoverHours:20, weather:"22°C / Sunny", localTime:"01:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  SFO: { code:"SFO", city:"San Francisco", country:"United States", flag:"🇺🇸", crewHotel:"Stanford Court Hotel", layoverHours:20, weather:"15°C / Foggy", localTime:"01:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  HKG: { code:"HKG", city:"Hong Kong", country:"China (SAR)", flag:"🇭🇰", crewHotel:"The Park Lane, a Autograph Collection", layoverHours:20, weather:"24°C / Hazy", localTime:"17:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  PVG: { code:"PVG", city:"Shanghai", country:"China", flag:"🇨🇳", crewHotel:"Crowne Plaza", layoverHours:20, weather:"18°C / Overcast", localTime:"17:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  DEL: { code:"DEL", city:"Delhi", country:"India", flag:"🇮🇳", crewHotel:"ITC Sheraton New Delhi", layoverHours:20, weather:"28°C / Hazy", localTime:"14:30", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  BOM: { code:"BOM", city:"Mumbai", country:"India", flag:"🇮🇳", crewHotel:"ITC Maratha", layoverHours:20, weather:"30°C / Humid", localTime:"14:30", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  RUH: { code:"RUH", city:"Riyadh", country:"Saudi Arabia", flag:"🇸🇦", crewHotel:"Marriott Executive Apartments Riyadh", layoverHours:16, weather:"35°C / Sunny", localTime:"12:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  YYZ: { code:"YYZ", city:"Toronto", country:"Canada", flag:"🇨🇦", crewHotel:"Sheraton Downtown", layoverHours:18, weather:"10°C / Overcast", localTime:"04:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  YVR: { code:"YVR", city:"Vancouver", country:"Canada", flag:"🇨🇦", crewHotel:"Marriott Pinnacle", layoverHours:20, weather:"13°C / Rainy", localTime:"01:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  MEX: { code:"MEX", city:"Mexico City", country:"Mexico", flag:"🇲🇽", crewHotel:"Intercontinental El Presidente", layoverHours:18, weather:"19°C / Partly Cloudy", localTime:"03:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  SCL: { code:"SCL", city:"Santiago", country:"Chile", flag:"🇨🇱", crewHotel:"Hilton Santiago Airport", layoverHours:18, weather:"18°C / Clear", localTime:"06:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  LIM: { code:"LIM", city:"Lima", country:"Peru", flag:"🇵🇪", crewHotel:"Pullman Miraflores", layoverHours:18, weather:"22°C / Overcast", localTime:"04:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  BOG: { code:"BOG", city:"Bogota", country:"Colombia", flag:"🇨🇴", crewHotel:"NH Collection Teleport", layoverHours:16, weather:"14°C / Cloudy", localTime:"04:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  PTY: { code:"PTY", city:"Panama City", country:"Panama", flag:"🇵🇦", crewHotel:"RIU Plaza Panama", layoverHours:18, weather:"30°C / Humid", localTime:"04:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  CTG: { code:"CTG", city:"Cartagena", country:"Colombia", flag:"🇨🇴", crewHotel:"InterContinental", layoverHours:16, weather:"32°C / Sunny", localTime:"05:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  GYE: { code:"GYE", city:"Guayaquil", country:"Ecuador", flag:"🇪🇨", crewHotel:"Hotel Oro Verde", layoverHours:16, weather:"28°C / Humid", localTime:"05:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  UIO: { code:"UIO", city:"Quito", country:"Ecuador", flag:"🇪🇨", crewHotel:"Dann Carlton Quito", layoverHours:16, weather:"17°C / Clear", localTime:"05:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  KGL: { code:"KGL", city:"Kigali", country:"Rwanda", flag:"🇷🇼", crewHotel:"Kigali Marriott Hotel", layoverHours:16, weather:"22°C / Clear", localTime:"11:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  DAR: { code:"DAR", city:"Dar es Salaam", country:"Tanzania", flag:"🇹🇿", crewHotel:"Hyatt Regency", layoverHours:16, weather:"30°C / Humid", localTime:"12:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  EBB: { code:"EBB", city:"Entebbe", country:"Uganda", flag:"🇺🇬", crewHotel:"Protea Entebbe", layoverHours:16, weather:"24°C / Partly Cloudy", localTime:"12:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  LOS: { code:"LOS", city:"Lagos", country:"Nigeria", flag:"🇳🇬", crewHotel:"Sheraton Lagos Hotel & Towers", layoverHours:16, weather:"30°C / Humid", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  ACC: { code:"ACC", city:"Accra", country:"Ghana", flag:"🇬🇭", crewHotel:"Moevenpick Ambassador", layoverHours:16, weather:"28°C / Sunny", localTime:"09:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  BEG: { code:"BEG", city:"Belgrade", country:"Serbia", flag:"🇷🇸", crewHotel:"Hilton Belgrade", layoverHours:14, weather:"13°C / Clear", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  LJU: { code:"LJU", city:"Ljubljana", country:"Slovenia", flag:"🇸🇮", crewHotel:"City Hotel Ljubljana", layoverHours:14, weather:"12°C / Cloudy", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  ZAG: { code:"ZAG", city:"Zagreb", country:"Croatia", flag:"🇭🇷", crewHotel:"Sheraton Zagreb", layoverHours:14, weather:"13°C / Partly Cloudy", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  SKP: { code:"SKP", city:"Skopje", country:"North Macedonia", flag:"🇲🇰", crewHotel:"Marriott Skopje", layoverHours:14, weather:"14°C / Clear", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },


  GEO: { code:"GEO", city:"Georgetown", country:"Guyana", flag:"🇬🇾", crewHotel:"Cara Lodge Georgetown", layoverHours:16, weather:"28°C / Humid", localTime:"05:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  PBM: { code:"PBM", city:"Paramaribo", country:"Suriname", flag:"🇸🇷", crewHotel:"Torarica", layoverHours:16, weather:"29°C / Partly Cloudy", localTime:"05:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  ATL: { code:"ATL", city:"Atlanta", country:"United States", flag:"🇺🇸", crewHotel:"JW Marriott Atlanta Buckhead", layoverHours:18, weather:"20°C / Partly Cloudy", localTime:"04:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  AUS: { code:"AUS", city:"Austin", country:"United States", flag:"🇺🇸", crewHotel:"Fairmont Austin", layoverHours:18, weather:"25°C / Sunny", localTime:"03:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  DTW: { code:"DTW", city:"Detroit", country:"United States", flag:"🇺🇸", crewHotel:"Detroit Marriott at the Renaissance Center", layoverHours:16, weather:"8°C / Cloudy", localTime:"04:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  IAH: { code:"IAH", city:"Houston", country:"United States", flag:"🇺🇸", crewHotel:"The Chifley", layoverHours:18, weather:"27°C / Humid", localTime:"03:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  LAS: { code:"LAS", city:"Las Vegas", country:"United States", flag:"🇺🇸", crewHotel:"The Westin Las Vegas", layoverHours:16, weather:"32°C / Sunny", localTime:"01:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  MIA: { code:"MIA", city:"Miami", country:"United States", flag:"🇺🇸", crewHotel:"Kimpton EPIC", layoverHours:20, weather:"28°C / Sunny", localTime:"04:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  MSP: { code:"MSP", city:"Minneapolis", country:"United States", flag:"🇺🇸", crewHotel:"The Royal Sonesta Downtown", layoverHours:18, weather:"5°C / Cloudy", localTime:"04:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  PDX: { code:"PDX", city:"Portland", country:"United States", flag:"🇺🇸", crewHotel:"Canopy by Hilton Pearl District", layoverHours:18, weather:"13°C / Rainy", localTime:"01:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  SAN: { code:"SAN", city:"San Diego", country:"United States", flag:"🇺🇸", crewHotel:"InterContinental San Diego", layoverHours:20, weather:"22°C / Sunny", localTime:"01:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  SLC: { code:"SLC", city:"Salt Lake City", country:"United States", flag:"🇺🇸", crewHotel:"Marriott City Creek", layoverHours:16, weather:"10°C / Sunny", localTime:"02:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  YEG: { code:"YEG", city:"Edmonton", country:"Canada", flag:"🇨🇦", crewHotel:"The Westin Edmonton", layoverHours:16, weather:"4°C / Clear", localTime:"02:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  YUL: { code:"YUL", city:"Montreal", country:"Canada", flag:"🇨🇦", crewHotel:"Le Cantlie Suites", layoverHours:20, weather:"9°C / Cloudy", localTime:"04:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  YYC: { code:"YYC", city:"Calgary", country:"Canada", flag:"🇨🇦", crewHotel:"Westin Calgary", layoverHours:18, weather:"7°C / Sunny", localTime:"02:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  KUL: { code:"KUL", city:"Kuala Lumpur", country:"Malaysia", flag:"🇲🇾", crewHotel:"Renaissance", layoverHours:18, weather:"31°C / Humid", localTime:"17:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  DMM: { code:"DMM", city:"Dammam", country:"Saudi Arabia", flag:"🇸🇦", crewHotel:"Dana Rayhaan by Rotana", layoverHours:16, weather:"35°C / Sunny", localTime:"12:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  JRO: { code:"JRO", city:"Kilimanjaro / Arusha", country:"Tanzania", flag:"🇹🇿", crewHotel:"Gran Melia Arusha", layoverHours:14, weather:"26°C / Partly Cloudy", localTime:"12:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  CPT: { code:"CPT", city:"Cape Town", country:"South Africa", flag:"🇿🇦", crewHotel:"The Westin", layoverHours:22, weather:"20°C / Sunny", localTime:"11:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  GIG: { code:"GIG", city:"Rio de Janeiro", country:"Brazil", flag:"🇧🇷", crewHotel:"Sheraton Grand Rio", layoverHours:20, weather:"27°C / Sunny", localTime:"06:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  CUR: { code:"CUR", city:"Willemstad", country:"Curaçao", flag:"🇨🇼", crewHotel:"Papagayo Beach Hotel", layoverHours:18, weather:"29°C / Sunny", localTime:"05:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  SJO: { code:"SJO", city:"San José", country:"Costa Rica", flag:"🇨🇷", crewHotel:"Crowne Plaza Corobici", layoverHours:16, weather:"22°C / Partly Cloudy", localTime:"04:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  AUA: { code:"AUA", city:"Oranjestad", country:"Aruba", flag:"🇦🇼", crewHotel:"Amsterdam Manor Boutique Hotel", layoverHours:18, weather:"28°C / Sunny", localTime:"05:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  BON: { code:"BON", city:"Kralendijk", country:"Bonaire", flag:"🇧🇶", crewHotel:"Divi Flamingo Resort", layoverHours:18, weather:"28°C / Sunny", localTime:"05:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  SXM: { code:"SXM", city:"Philipsburg / Marigot", country:"Sint Maarten / Saint-Martin", flag:"🇸🇽", crewHotel:"Hommage Hotel", layoverHours:18, weather:"29°C / Sunny", localTime:"05:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  POS: { code:"POS", city:"Port of Spain", country:"Trinidad & Tobago", flag:"🇹🇹", crewHotel:"Hyatt Regency", layoverHours:16, weather:"29°C / Partly Cloudy", localTime:"05:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  TPE: { code:"TPE", city:"Taipei", country:"Taiwan", flag:"🇹🇼", crewHotel:"Grand Hyatt", layoverHours:20, weather:"26°C / Partly Cloudy", localTime:"17:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  MNL: { code:"MNL", city:"Manila", country:"Philippines", flag:"🇵🇭", crewHotel:"Marriott Manila Hotel", layoverHours:20, weather:"30°C / Humid", localTime:"17:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  CGK: { code:"CGK", city:"Jakarta", country:"Indonesia", flag:"🇮🇩", crewHotel:"JW Marriott Hotel Jakarta", layoverHours:18, weather:"30°C / Humid", localTime:"16:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  DPS: { code:"DPS", city:"Bali (Denpasar)", country:"Indonesia", flag:"🇮🇩", crewHotel:"Kuta Paradiso Hotel Bali", layoverHours:22, weather:"29°C / Sunny", localTime:"16:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  ICN: { code:"ICN", city:"Seoul", country:"South Korea", flag:"🇰🇷", crewHotel:"Swiss Grand", layoverHours:22, weather:"15°C / Clear", localTime:"18:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  KIX: { code:"KIX", city:"Osaka", country:"Japan", flag:"🇯🇵", crewHotel:"Hilton Osaka", layoverHours:22, weather:"18°C / Clear", localTime:"17:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  HYD: { code:"HYD", city:"Hyderabad", country:"India", flag:"🇮🇳", crewHotel:"ITC Kakatiya", layoverHours:18, weather:"30°C / Sunny", localTime:"14:30", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  BLR: { code:"BLR", city:"Bangalore", country:"India", flag:"🇮🇳", crewHotel:"Conrad by Hilton", layoverHours:18, weather:"25°C / Partly Cloudy", localTime:"14:30", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  PEK: { code:"PEK", city:"Beijing", country:"China", flag:"🇨🇳", crewHotel:"Crowne Plaza Sun Palace", layoverHours:20, weather:"15°C / Hazy", localTime:"17:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  ABZ: { code:"ABZ", city:"Aberdeen", country:"United Kingdom", flag:"🇬🇧", crewHotel:"Park Inn by Radisson", layoverHours:14, weather:"10°C / Cloudy", localTime:"09:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  AES: { code:"AES", city:"Ålesund", country:"Norway", flag:"🇳🇴", crewHotel:"Thon Hotel Alesund", layoverHours:12, weather:"9°C / Overcast", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  BER: { code:"BER", city:"Berlin", country:"Germany", flag:"🇩🇪", crewHotel:"NH Berlin Mitte", layoverHours:18, weather:"13°C / Partly Cloudy", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  BHD: { code:"BHD", city:"Belfast", country:"United Kingdom", flag:"🇬🇧", crewHotel:"Maldron", layoverHours:14, weather:"10°C / Rainy", localTime:"09:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  BHX: { code:"BHX", city:"Birmingham", country:"United Kingdom", flag:"🇬🇧", crewHotel:"Crowne Plaza", layoverHours:16, weather:"11°C / Cloudy", localTime:"09:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  BLL: { code:"BLL", city:"Billund", country:"Denmark", flag:"🇩🇰", crewHotel:"Four Points Flex by Sheraton Vejle", layoverHours:14, weather:"9°C / Cloudy", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  BLQ: { code:"BLQ", city:"Bologna", country:"Italy", flag:"🇮🇹", crewHotel:"Aemelia Hotel Bologna", layoverHours:16, weather:"16°C / Partly Cloudy", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  BRS: { code:"BRS", city:"Bristol", country:"United Kingdom", flag:"🇬🇧", crewHotel:"Hilton Garden Inn Bristol Centre", layoverHours:16, weather:"12°C / Cloudy", localTime:"09:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  CWL: { code:"CWL", city:"Cardiff", country:"United Kingdom", flag:"🇬🇧", crewHotel:"Marriott", layoverHours:14, weather:"11°C / Rainy", localTime:"09:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  DUS: { code:"DUS", city:"Düsseldorf", country:"Germany", flag:"🇩🇪", crewHotel:"Hotel Indigo", layoverHours:16, weather:"12°C / Cloudy", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  EDI: { code:"EDI", city:"Edinburgh", country:"United Kingdom", flag:"🇬🇧", crewHotel:"Courtyard by Marriott", layoverHours:18, weather:"10°C / Cloudy", localTime:"09:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  EXT: { code:"EXT", city:"Exeter", country:"United Kingdom", flag:"🇬🇧", crewHotel:"Southgate Hotel Exeter", layoverHours:12, weather:"12°C / Cloudy", localTime:"09:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  FRA: { code:"FRA", city:"Frankfurt", country:"Germany", flag:"🇩🇪", crewHotel:"Avani Frankfurt", layoverHours:18, weather:"13°C / Partly Cloudy", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  GDN: { code:"GDN", city:"Gdańsk", country:"Poland", flag:"🇵🇱", crewHotel:"Mercure Stare Miasto", layoverHours:14, weather:"10°C / Partly Cloudy", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  GLA: { code:"GLA", city:"Glasgow", country:"United Kingdom", flag:"🇬🇧", crewHotel:"Clayton Hotel", layoverHours:16, weather:"10°C / Rainy", localTime:"09:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  HAJ: { code:"HAJ", city:"Hannover", country:"Germany", flag:"🇩🇪", crewHotel:"Novotel", layoverHours:14, weather:"11°C / Cloudy", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  HAM: { code:"HAM", city:"Hamburg", country:"Germany", flag:"🇩🇪", crewHotel:"Radisson Blu Hamburg", layoverHours:16, weather:"11°C / Cloudy", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  HUY: { code:"HUY", city:"Humberside", country:"United Kingdom", flag:"🇬🇧", crewHotel:"Doubletree Hull", layoverHours:12, weather:"10°C / Windy", localTime:"09:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  INV: { code:"INV", city:"Inverness", country:"United Kingdom", flag:"🇬🇧", crewHotel:"AC by Marriott", layoverHours:12, weather:"8°C / Cloudy", localTime:"09:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  LBA: { code:"LBA", city:"Leeds Bradford", country:"United Kingdom", flag:"🇬🇧", crewHotel:"DoubleTree by Hilton", layoverHours:14, weather:"11°C / Cloudy", localTime:"09:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  LUX: { code:"LUX", city:"Luxembourg City", country:"Luxembourg", flag:"🇱🇺", crewHotel:"Novotel Luxemburg", layoverHours:14, weather:"12°C / Partly Cloudy", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  MME: { code:"MME", city:"Teesside", country:"United Kingdom", flag:"🇬🇧", crewHotel:"Leonardo Hotel Middlesbrough", layoverHours:12, weather:"10°C / Cloudy", localTime:"09:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  NCL: { code:"NCL", city:"Newcastle", country:"United Kingdom", flag:"🇬🇧", crewHotel:"Maldron Hotel", layoverHours:14, weather:"10°C / Cloudy", localTime:"09:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  NWI: { code:"NWI", city:"Norwich", country:"United Kingdom", flag:"🇬🇧", crewHotel:"Holiday Inn City", layoverHours:12, weather:"11°C / Partly Cloudy", localTime:"09:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  ORK: { code:"ORK", city:"Cork", country:"Ireland", flag:"🇮🇪", crewHotel:"Maldron South Mall", layoverHours:14, weather:"12°C / Rainy", localTime:"09:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  POZ: { code:"POZ", city:"Poznań", country:"Poland", flag:"🇵🇱", crewHotel:"Sheraton Poznan", layoverHours:14, weather:"11°C / Partly Cloudy", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  SOU: { code:"SOU", city:"Southampton", country:"United Kingdom", flag:"🇬🇧", crewHotel:"Southampton Harbour Hotel", layoverHours:14, weather:"12°C / Partly Cloudy", localTime:"09:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },

  SVG: { code:"SVG", city:"Stavanger", country:"Norway", flag:"🇳🇴", crewHotel:"Clarion Stavanger", layoverHours:14, weather:"10°C / Partly Cloudy", localTime:"10:00", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  AAL: { code:"AAL", city:"Aalborg", country:"Denmark", flag:"🇩🇰", crewHotel:"Comwell Hvide Hus", layoverHours:0, weather:"", localTime:"", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  BIO: { code:"BIO", city:"Bilbao", country:"Spain", flag:"🇪🇸", crewHotel:"Occidental Bilbao", layoverHours:0, weather:"", localTime:"", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  BRE: { code:"BRE", city:"Bremen", country:"Germany", flag:"🇩🇪", crewHotel:"Courtyard Bremen", layoverHours:0, weather:"", localTime:"", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  BSL: { code:"BSL", city:"Basel", country:"Switzerland", flag:"🇨🇭", crewHotel:"Courtyard Basel", layoverHours:0, weather:"", localTime:"", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  DBV: { code:"DBV", city:"Dubrovnik", country:"Croatia", flag:"🇭🇷", crewHotel:"", layoverHours:0, weather:"", localTime:"", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  DUB: { code:"DUB", city:"Dublin", country:"Ireland", flag:"🇮🇪", crewHotel:"Radisson Blu Royal", layoverHours:0, weather:"", localTime:"", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  FLR: { code:"FLR", city:"Florence", country:"Italy", flag:"🇮🇹", crewHotel:"The Social Hub Belfiore", layoverHours:0, weather:"", localTime:"", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  GOT: { code:"GOT", city:"Gothenburg", country:"Sweden", flag:"🇸🇪", crewHotel:"Gothia Towers", layoverHours:0, weather:"", localTime:"", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  KRK: { code:"KRK", city:"Krakow", country:"Poland", flag:"🇵🇱", crewHotel:"Park Inn by Radisson", layoverHours:0, weather:"", localTime:"", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  KRS: { code:"KRS", city:"Kristiansand", country:"Norway", flag:"🇳🇴", crewHotel:"Scandic Bystranda", layoverHours:0, weather:"", localTime:"", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  LCY: { code:"LCY", city:"London (City)", country:"United Kingdom", flag:"🇬🇧", crewHotel:"", layoverHours:0, weather:"", localTime:"", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  LPI: { code:"LPI", city:"Linköping", country:"Sweden", flag:"🇸🇪", crewHotel:"Scandic Linköping", layoverHours:0, weather:"", localTime:"", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  MUC: { code:"MUC", city:"Munich", country:"Germany", flag:"🇩🇪", crewHotel:"Novotel Munich City", layoverHours:0, weather:"", localTime:"", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  NTE: { code:"NTE", city:"Nantes", country:"France", flag:"🇫🇷", crewHotel:"", layoverHours:0, weather:"", localTime:"", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  NUE: { code:"NUE", city:"Nuremberg", country:"Germany", flag:"🇩🇪", crewHotel:"NH Collection", layoverHours:0, weather:"", localTime:"", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  STR: { code:"STR", city:"Stuttgart", country:"Germany", flag:"🇩🇪", crewHotel:"Jaz hotel in the City", layoverHours:0, weather:"", localTime:"", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  TLS: { code:"TLS", city:"Toulouse", country:"France", flag:"🇫🇷", crewHotel:"Mercure Toulouse Centre Compans", layoverHours:0, weather:"", localTime:"", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  TRD: { code:"TRD", city:"Trondheim", country:"Norway", flag:"🇳🇴", crewHotel:"Clarion Trondheim", layoverHours:0, weather:"", localTime:"", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  TRN: { code:"TRN", city:"Turin", country:"Italy", flag:"🇮🇹", crewHotel:"Hilton Turin Center", layoverHours:0, weather:"", localTime:"", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  VLC: { code:"VLC", city:"Valencia", country:"Spain", flag:"🇪🇸", crewHotel:"Melia Valencia", layoverHours:0, weather:"", localTime:"", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
  WRO: { code:"WRO", city:"Wroclaw", country:"Poland", flag:"🇵🇱", crewHotel:"Wyndham Wroclaw Old Town", layoverHours:0, weather:"", localTime:"", categories:{ food:{headline:"",tips:[]}, fitness:{headline:"",tips:[]}, beauty:{headline:"",tips:[]}, wellness:{headline:"",tips:[]}, shopping:{headline:"",tips:[]}, nightlife:{headline:"",tips:[]}, accommodation:{headline:"",tips:[]}, working:{headline:"",tips:[]}, gems:{headline:"",tips:[]}, other:{headline:"",tips:[]} }, crewTips:[] },
};

const CONTINENT_ORDER = ["Europe", "Africa", "Middle East", "Asia", "Oceania", "North America", "Caribbean & Central America", "South America"];
const COUNTRY_CONTINENT: Record<string, string> = {
  "Austria":"Europe","Belgium":"Europe","Croatia":"Europe","Czech Republic":"Europe","Denmark":"Europe","Finland":"Europe","France":"Europe","Germany":"Europe","Hungary":"Europe","Ireland":"Europe","Italy":"Europe","Luxembourg":"Europe","Netherlands":"Europe","North Macedonia":"Europe","Norway":"Europe","Poland":"Europe","Portugal":"Europe","Serbia":"Europe","Slovenia":"Europe","Spain":"Europe","Sweden":"Europe","Switzerland":"Europe","United Kingdom":"Europe",
  "Ghana":"Africa","Kenya":"Africa","Nigeria":"Africa","Rwanda":"Africa","South Africa":"Africa","Tanzania":"Africa","Uganda":"Africa",
  "Saudi Arabia":"Middle East","United Arab Emirates":"Middle East",
  "China":"Asia","China (SAR)":"Asia","India":"Asia","Indonesia":"Asia","Japan":"Asia","Malaysia":"Asia","Philippines":"Asia","Singapore":"Asia","South Korea":"Asia","Taiwan":"Asia","Thailand":"Asia",
  "Australia":"Oceania",
  "Canada":"North America","Mexico":"North America","United States":"North America",
  "Aruba":"Caribbean & Central America","Bonaire":"Caribbean & Central America","Costa Rica":"Caribbean & Central America","Curaçao":"Caribbean & Central America","Panama":"Caribbean & Central America","Sint Maarten / Saint-Martin":"Caribbean & Central America","Trinidad & Tobago":"Caribbean & Central America",
  "Argentina":"South America","Brazil":"South America","Chile":"South America","Colombia":"South America","Ecuador":"South America","Guyana":"South America","Peru":"South America","Suriname":"South America",
};
const CONTINENT_COLORS: Record<string, string> = {
  "Europe":"#4A90D9","Africa":"#F1C40F","Middle East":"#9B59B6","Asia":"#E67E22",
  "Oceania":"#16A085","North America":"#27AE60","Caribbean & Central America":"#00BCD4","South America":"#2ECC71",
};
function groupDestsByContinentCountry(dests: any[]) {
  return CONTINENT_ORDER.map(continent => {
    const continentDests = dests.filter(d => (COUNTRY_CONTINENT[d.country] || "Other") === continent);
    if (continentDests.length === 0) return null;
    const countryNames = Array.from(new Set(continentDests.map(d => d.country))).sort();
    return {
      continent,
      color: CONTINENT_COLORS[continent] || "#94A3B8",
      count: continentDests.length,
      countries: countryNames.map(country => ({
        country,
        flag: continentDests.find(d => d.country === country)?.flag,
        dests: continentDests.filter(d => d.country === country).sort((a, b) => a.city.localeCompare(b.city)),
      })),
    };
  }).filter(Boolean) as any[];
}

const CATEGORIES = [
  { id: "food",          label: "Food & Drink",    color: "#F97316" },
  { id: "supermarket",   label: "Supermarket",     color: "#84CC16" },
  { id: "fitness",       label: "Fitness",         color: "#22C55E" },
  { id: "beauty",        label: "Beauty",          color: "#EC4899" },
  { id: "wellness",      label: "Wellness & Spa",  color: "#14B8A6" },
  { id: "shopping",      label: "Shopping",        color: "#A855F7" },
  { id: "nightlife",     label: "Nightlife",       color: "#6366F1" },
  { id: "accommodation", label: "Accommodation",   color: "#0EA5E9" },
  { id: "working",       label: "Working",         color: "#64748B" },
  { id: "gems",          label: "Hidden Gems",     color: "#D946EF" },
  { id: "roadtrip",      label: "Road Trip",       color: "#F59E0B" },
  { id: "other",         label: "Other",           color: "#78716C" },
];

// Single source of truth for the sleek line-icon set used across category chips, the
// category menu and the map markers -- one 24x24 glyph (inner SVG markup) per category id.
const CATEGORY_ICON_PATHS: Record<string, string> = {
  food: '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>',
  supermarket: '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
  fitness: '<rect x="2" y="9" width="3" height="6" rx="1"/><rect x="19" y="9" width="3" height="6" rx="1"/><line x1="5" y1="12" x2="19" y2="12"/><rect x="6" y="7" width="2" height="10" rx="1"/><rect x="16" y="7" width="2" height="10" rx="1"/>',
  beauty: '<path d="M12 3 9.5 9.5 3 12l6.5 2.5L12 21l2.5-6.5L21 12l-6.5-2.5Z"/><path d="M19 3v4M21 5h-4"/>',
  wellness: '<path d="M12 3c-3 4-6 7.5-6 11a6 6 0 0 0 12 0c0-3.5-3-7-6-11Z"/>',
  shopping: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  nightlife: '<path d="M4 4h16l-8 9z"/><path d="M12 13v7"/><path d="M8 20h8"/>',
  accommodation: '<path d="M3 18v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5"/><path d="M3 18v2M21 18v2"/><path d="M7 11V8a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v3"/>',
  working: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M2 20h20"/>',
  gems: '<path d="M6 3h12l4 6-10 12L2 9Z"/><path d="M2 9h20M9 3l-2 6M15 3l2 6"/>',
  roadtrip: '<path d="M3 16V12a2 2 0 0 1 .4-1.2L6 7h12l2.6 3.8A2 2 0 0 1 21 12v4"/><path d="M3 16h18"/><circle cx="7" cy="17.5" r="1.5"/><circle cx="17" cy="17.5" r="1.5"/>',
  other: '<path d="M12 21s-7-6.5-7-11a7 7 0 1 1 14 0c0 4.5-7 11-7 11Z"/><circle cx="12" cy="10" r="2.5"/>',
};

function CategoryIcon({ id, size = 20, color = "currentColor", strokeWidth = 1.8 }: { id: string; size?: number; color?: string; strokeWidth?: number }) {
  const inner = CATEGORY_ICON_PATHS[id] || CATEGORY_ICON_PATHS.other;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}
      dangerouslySetInnerHTML={{ __html: inner }} />
  );
}

// Builds a colored-pin Google Maps marker icon (data URI) from a 24x24 glyph's inner SVG
// markup -- shared by the category markers and the crew-hotel marker so every pin on the
// map uses the same sleek line-icon treatment.
function pinMarkerIconUrl(innerGlyph: string, color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34">` +
    `<circle cx="17" cy="17" r="15" fill="${color}" stroke="#fff" stroke-width="2"/>` +
    `<g transform="translate(8,8) scale(0.75)" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${innerGlyph}</g>` +
    `</svg>`;
  return "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg);
}

const CLOUD_HIGH = '<path d="M7 15h10a4 4 0 0 0 0-8 6 6 0 0 0-11.3 2A3 3 0 0 0 7 15z"/>';
const UI_ICON_PATHS: Record<string, string> = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  chevronUp: '<path d="M18 15l-6-6-6 6"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  share: '<path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><path d="M12 3v12M7 8l5-5 5 5"/>',
  heart: '<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"/>',
  comment: '<path d="M4 5h16v11H9l-5 4z"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  pin: '<path d="M12 21s-7-6.5-7-11a7 7 0 1 1 14 0c0 4.5-7 11-7 11Z"/><circle cx="12" cy="10" r="2.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  plane: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
  hotel: '<rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M9 21v-5h6v5"/><circle cx="9" cy="8" r="1"/><circle cx="15" cy="8" r="1"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/>',
  sparkle: '<path d="M12 3 9.5 9.5 3 12l6.5 2.5L12 21l2.5-6.5L21 12l-6.5-2.5Z"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M18 14a6.5 6.5 0 0 1 3.5 6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  map: '<polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/><path d="M9 3v15M15 6v15"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
  bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>',
  loader: '<path d="M12 3a9 9 0 1 0 9 9"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 0-8 6 6 0 0 0-11.3 2A3 3 0 0 0 7 18z"/>',
  rain: CLOUD_HIGH + '<path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/>',
  snow: CLOUD_HIGH + '<path d="M8 19h.01M12 19h.01M16 19h.01M10 22h.01M14 22h.01"/>',
  storm: CLOUD_HIGH + '<path d="m13 14-2 4h3l-2 4"/>',
  fog: '<path d="M4 10h16M4 14h16M6 18h12M7 6h10"/>',
};

function Icon({ name, size = 18, color = "currentColor", strokeWidth = 1.8, className }: { name: string; size?: number; color?: string; strokeWidth?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" className={className} style={{ flexShrink: 0 }} aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: UI_ICON_PATHS[name] || "" }} />
  );
}

// Same glyph set, rendered as a colored pin for Google Maps markers so map pins match the
// category icons shown everywhere else in the app.
function categoryMarkerIconUrl(cat: { id: string; color: string }): string {
  return pinMarkerIconUrl(CATEGORY_ICON_PATHS[cat.id] || CATEGORY_ICON_PATHS.other, cat.color);
}

const HOTEL_ICON_PATH = '<rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M9 21v-5h6v5"/><circle cx="9" cy="8" r="1"/><circle cx="15" cy="8" r="1"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/>';
function hotelMarkerIconUrl(): string {
  return pinMarkerIconUrl(HOTEL_ICON_PATH, "#F59E0B");
}

const NOTIFICATIONS: Array<{ id: number; text: string; time: string; read: boolean; destCode: string; category?: string; tipId?: number }> = [];

// ─── HOME ──────────────────────────────────────────────────────────────────────
function HomeScreen({ onSearch, onDestClick, addedTips, recentDests }) {
  const [query, setQuery] = useState("");
  const [showSugg, setShowSugg] = useState(false);
  const q = query.trim().toLowerCase();
  const suggestions = q.length < 2 ? [] : (Object.values(DESTINATIONS) as any[])
    .filter(d => d.city.toLowerCase().includes(q) || d.code.toLowerCase() === q || d.country.toLowerCase().includes(q))
    .sort((a, b) => {
      const aStarts = a.city.toLowerCase().startsWith(q) ? 0 : 1;
      const bStarts = b.city.toLowerCase().startsWith(q) ? 0 : 1;
      return aStarts - bStarts || a.city.localeCompare(b.city);
    })
    .slice(0, 6);
  function pickSuggestion(code: string) {
    setQuery("");
    setShowSugg(false);
    onDestClick(code);
  }
  const latestTip = (() => {
    let best: { tip: any; destCode: string; destCity: string; destFlag: string } | null = null;
    for (const dest of Object.values(DESTINATIONS) as any[]) {
      for (const tip of [...(dest.crewTips || []), ...((addedTips[dest.code]) || [])]) {
        if (!best || (tip.date || "") > (best.tip.date || "")) {
          best = { tip, destCode: dest.code, destCity: dest.city, destFlag: dest.flag };
        }
      }
    }
    return best;
  })();
  return (
    <div className="screen">
      <div className="hero-section">
        <div className="hero-glow" />
      
        <h1 className="hero-title">Wing<span>Tips</span></h1>
       
        <div className="search-wrap">
          <div className="search-box">
            <span className="search-icon"><Icon name="search" size={18} /></span>
            <input className="search-field" placeholder="City or IATA code — NRT, DXB, JFK…"
              value={query}
              onChange={e => { setQuery(e.target.value); setShowSugg(true); }}
              onFocus={() => suggestions.length > 0 && setShowSugg(true)}
              onKeyDown={e => e.key === "Enter" && (setShowSugg(false), onSearch(query))} />
            <button className="search-go" aria-label="Search" onClick={() => { setShowSugg(false); onSearch(query); }}><Icon name="arrowRight" size={18} strokeWidth={2.2} /></button>
          </div>
          {showSugg && suggestions.length > 0 && (
            <div className="sugg-dropdown">
              {suggestions.map((d: any) => (
                <button key={d.code} className="sugg-item" onMouseDown={() => pickSuggestion(d.code)}>
                  <span className="sugg-primary"><Flag emoji={d.flag} />{d.city}</span>
                  <span className="sugg-addr">{d.country} · {d.code}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {recentDests.length > 0 && (
        <div className="section-block">
          <div className="section-label">Quick access</div>
          <div className="dest-row">
            {recentDests.slice(0, 3).map((code: string) => {
              const d = (DESTINATIONS as any)[code];
              if (!d) return null;
              return (
                <button key={code} className="dest-pill" onClick={() => onDestClick(code)}>
                  <img className="pill-flag" src={`https://flagcdn.com/${flagToCode(d.flag)}.svg`} alt={d.country} loading="lazy" />
                  <div><div className="pill-city">{d.city}</div><div className="pill-code">{code}</div></div>
                </button>
              );
            })}
          </div>
        </div>
      )}
      {latestTip && (
        <div className="section-block">
          <div className="section-label">Latest from the crew</div>
          <button className="top-tip-card" onClick={() => onDestClick(latestTip.destCode)}>
            <div className="top-tip-dest"><CategoryIcon id={latestTip.tip.category || "other"} color={CATEGORIES.find(c => c.id === latestTip.tip.category)?.color} size={16} />{latestTip.destCity}</div>
            <TipText text={latestTip.tip.text} className="top-tip-text" />
            <div className="top-tip-author">{latestTip.tip.name}, {latestTip.tip.role}<span className="top-tip-likes"><Icon name="heart" size={14} />{latestTip.tip.likes || 0}</span></div>
          </button>
        </div>
      )}
    </div>
  );
}

function useNotifications() {
  // The badge in the top bar and the Notifications screen used to each keep their own copy of
  // "read" state, so marking all read there never updated the count here. Read status now lives
  // in one shared, persisted place.
  const [readIds, setReadIds] = useState<number[]>(() => {
    try { return JSON.parse(localStorage.getItem("wt_notifications_read") || "[]") as number[]; }
    catch { return [] as number[]; }
  });
  useEffect(() => {
    localStorage.setItem("wt_notifications_read", JSON.stringify(readIds));
  }, [readIds]);
  const notes = NOTIFICATIONS.map(n => ({ ...n, read: n.read || readIds.includes(n.id) }));
  function markAllRead() { setReadIds(NOTIFICATIONS.map(n => n.id)); }
  return { notes, markAllRead };
}

// ─── TIMEZONE OFFSETS (UTC, summer/CEST reference) ────────────────────────────
const TZ_OFFSETS: Record<string, number> = {
  // Europe CEST +2
  AMS:2,VIE:2,BRU:2,GVA:2,ZRH:2,CPH:2,ARN:2,OSL:2,WAW:2,PRG:2,BUD:2,BCN:2,MAD:2,FCO:2,MXP:2,BEG:2,LJU:2,ZAG:2,SKP:2,AES:2,BER:2,BLL:2,BLQ:2,DUS:2,FRA:2,GDN:2,HAJ:2,HAM:2,LUX:2,POZ:2,SVG:2,
  AAL:2,BIO:2,BRE:2,BSL:2,DBV:2,FLR:2,GOT:2,KRK:2,KRS:2,LPI:2,MUC:2,NTE:2,NUE:2,STR:2,TLS:2,TRD:2,TRN:2,VLC:2,WRO:2,
  // Europe BST/IST +1
  LHR:1,MAN:1,ABZ:1,BHD:1,BHX:1,BRS:1,CWL:1,EDI:1,EXT:1,GLA:1,HUY:1,INV:1,LBA:1,MME:1,NCL:1,NWI:1,SOU:1,ORK:1,LIS:1,DUB:1,LCY:1,
  // Helsinki EEST +3
  HEL:3,
  // North America EDT -4
  JFK:-4,ATL:-4,BOS:-4,DTW:-4,IAD:-4,MIA:-4,YUL:-4,YYZ:-4,
  // North America CDT -5
  IAH:-5,AUS:-5,ORD:-5,MSP:-5,MEX:-5,
  // North America MDT -6
  SLC:-6,YEG:-6,YYC:-6,
  // North America PDT -7
  LAS:-7,LAX:-7,PDX:-7,SAN:-7,SFO:-7,YVR:-7,
  // South & Central America
  GRU:-3,GIG:-3,EZE:-3,PBM:-3,
  GEO:-4,SCL:-4,CUR:-4,AUA:-4,BON:-4,SXM:-4,POS:-4,
  LIM:-5,BOG:-5,CTG:-5,PTY:-5,GYE:-5,UIO:-5,
  SJO:-6,
  // Middle East
  DXB:4,RUH:3,DMM:3,
  // Africa
  NBO:3,JRO:3,DAR:3,EBB:3,JNB:2,CPT:2,KGL:2,LOS:1,ACC:0,
  // Asia & Pacific
  NRT:9,KIX:9,ICN:9,TPE:8,SIN:8,KUL:8,DPS:8,MNL:8,HKG:8,PVG:8,PEK:8,BKK:7,CGK:7,
  DEL:5.5,BOM:5.5,HYD:5.5,BLR:5.5,
  SYD:10,
};

function flagToCode(emoji: string): string {
  return [...emoji].map(c => String.fromCodePoint(c.codePointAt(0)! - 0x1F1E6 + 65)).join("").toLowerCase();
}

function Flag({ emoji }: { emoji?: string }) {
  if (!emoji) return null;
  return <img className="flag-mini" src={`https://flagcdn.com/${flagToCode(emoji)}.svg`} alt="" loading="lazy" />;
}

function fmtTime(utcOffset: number) {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const d = new Date(utcMs + utcOffset * 3600000);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

// ─── DESTINATION ───────────────────────────────────────────────────────────────
// Shared connect/request/accept button for a tip card or a crew profile -- authorId is only
// present on real Supabase-backed tips (see useRecommendations), never on the bundled editorial
// crewTips seed data, so it renders nothing for those (there's no real account to connect to).
function ConnectButton({ authorId, connections, className }: any) {
  if (!authorId || !connections?.userId) return null;
  const rel = connections.relation(authorId);
  if (rel === "self") return null;
  if (rel === "accepted") return <button className={`${className} connected`} disabled><Icon name="check" size={14} strokeWidth={2.2} />Connected</button>;
  if (rel === "outgoing") return <button className={className} disabled>Pending</button>;
  if (rel === "incoming") {
    const req = connections.incoming.find((r: any) => r.userId === authorId);
    return <button className={className} onClick={(e: any) => { e.stopPropagation(); req && connections.acceptRequest(req.reqId); }}>Accept request</button>;
  }
  return <button className={className} onClick={(e: any) => { e.stopPropagation(); connections.sendRequest(authorId); }}><Icon name="plus" size={14} strokeWidth={2.2} />Connect</button>;
}

function DestScreen({ code, onBack, onAddTip, activeCategory, setActiveCategory, connections, favorites, onToggleFavorite, extraTips, focusTipId, onFocusConsumed, onCrewClick, onToggleLike, onAddComment }) {
  const dest = DESTINATIONS[code];
  const liveWeather = useWeather(code, dest.city, dest.country);
  const [showWeather, setShowWeather] = useState(false);
  const { forecast, loading: forecastLoading } = useWeatherForecast(code, dest.city, dest.country, showWeather);
  const [crewTips, setCrewTips] = useState(
    [...dest.crewTips, ...(extraTips || [])].map(t => ({ ...t, comments: t.comments || [] }))
  );
  const [expandedTip, setExpandedTip] = useState(null);
  const [commentForms, setCommentForms] = useState({});
  const tipRefs = useRef<Record<string | number, HTMLDivElement | null>>({});
  const [showMap, setShowMap] = useState(false);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<any>(null);
  const [hotelCoords, setHotelCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [copiedTipId, setCopiedTipId] = useState<string | number | null>(null);
  const [showCatPicker, setShowCatPicker] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setHotelCoords(null);
    geocodeHotel(dest.crewHotel, dest.city, dest.country).then(c => { if (!cancelled) setHotelCoords(c); });
    return () => { cancelled = true; };
  }, [code]);

  function goToTip(tip: any) {
    setShowMap(false);
    setActiveCategory(tip.category);
    setTimeout(() => {
      const el = tipRefs.current[tip.id];
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 150);
  }

  function zoomBy(delta: number) {
    const map = mapInstanceRef.current;
    if (map) map.setZoom((map.getZoom() || 14) + delta);
  }

  useEffect(() => {
    if (!showMap) return;
    const tipsWithCoords = crewTips.filter((t: any) => t.coords);

    const initMap = async () => {
      const google = (window as any).google;
      if (!google || !mapContainerRef.current) return;
      mapInstanceRef.current = null;

      const hotelCenter = await geocodeHotel(dest.crewHotel, dest.city, dest.country);
      if (!mapContainerRef.current) return; // screen could have closed while awaiting

      let lat = 52.3676, lng = 4.9041;
      if (!hotelCenter && tipsWithCoords.length === 0) {
        const center = await geocodeCity(dest.city, dest.country);
        if (center) { lat = center.lat; lng = center.lng; }
        if (!mapContainerRef.current) return; // screen could have closed while awaiting
      }

      const map = new google.maps.Map(mapContainerRef.current, {
        center: { lat, lng }, zoom: 12,
        mapTypeControl: false, streetViewControl: false, fullscreenControl: false, zoomControl: false,
      });

      tipsWithCoords.forEach((tip: any) => {
        const cat = CATEGORIES.find(c => c.id === tip.category);
        const marker = new google.maps.Marker({
          position: { lat: parseFloat(tip.coords.lat), lng: parseFloat(tip.coords.lon) },
          map,
          icon: { url: categoryMarkerIconUrl(cat || { id: "other", color: "#00A1DE" }), scaledSize: new google.maps.Size(34, 34), anchor: new google.maps.Point(17, 17) }
        });
        const viewBtnId = `map-view-tip-${tip.id}`;
        const infoWindow = new google.maps.InfoWindow({
          content: `<div style="min-width:160px;font-family:'Plus Jakarta Sans',sans-serif;color:#10233F"><strong style="font-size:14px">${tip.text.split("—")[0].replace("📍","").trim()}</strong><br/><span style="font-size:12px;color:#4A6A8C">${cat?.label || ""}</span><br/><button id="${viewBtnId}" style="margin-top:8px;background:#003082;color:#fff;border:none;border-radius:14px;padding:7px 12px;font-size:12px;font-family:inherit;font-weight:700;cursor:pointer;">View recommendation</button></div>`
        });
        marker.addListener("click", () => infoWindow.open(map, marker));
        infoWindow.addListener("domready", () => {
          const btn = document.getElementById(viewBtnId);
          if (btn) btn.onclick = () => { infoWindow.close(); goToTip(tip); };
        });
      });

      if (hotelCenter) {
        const hotelMarker = new google.maps.Marker({
          position: hotelCenter,
          map,
          zIndex: 999,
          icon: { url: hotelMarkerIconUrl(), scaledSize: new google.maps.Size(34, 34), anchor: new google.maps.Point(17, 17) }
        });
        const hotelInfo = new google.maps.InfoWindow({
          content: `<div style="font-family:'Plus Jakarta Sans',sans-serif;color:#10233F"><strong style="font-size:14px">${dest.crewHotel.replace(/\s*\([^)]*\)\s*$/, "").trim()}</strong><br/><span style="font-size:12px;color:#4A6A8C">Crew hotel</span></div>`
        });
        hotelMarker.addListener("click", () => hotelInfo.open(map, hotelMarker));
      }

      const bounds = new google.maps.LatLngBounds();
      let hasPoints = false;
      if (hotelCenter) { bounds.extend(hotelCenter); hasPoints = true; }
      tipsWithCoords.forEach((tip: any) => { bounds.extend({ lat: parseFloat(tip.coords.lat), lng: parseFloat(tip.coords.lon) }); hasPoints = true; });
      if (hasPoints) {
        map.fitBounds(bounds, 48);
        google.maps.event.addListenerOnce(map, "bounds_changed", () => {
          if ((map.getZoom() || 0) > 15) map.setZoom(15);
        });
      }

      mapInstanceRef.current = map;
    };

    loadGoogleMaps().then(() => setTimeout(initMap, 50));
  }, [showMap]);

  useEffect(() => {
    if (!focusTipId) return;
    const tip = crewTips.find(t => String(t.id) === String(focusTipId));
    if (tip) setActiveCategory(tip.category);
  }, [focusTipId]);

  useEffect(() => {
    if (!focusTipId) return;
    const el = tipRefs.current[focusTipId];
    if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); onFocusConsumed?.(); }
  }, [activeCategory, focusTipId]);

  if (!dest) return <div className="screen"><button className="back-btn-flat" onClick={onBack}><Icon name="back" size={18} />Back</button></div>;

  const [sortBy, setSortBy] = useState<"recent" | "liked">("recent");
  const [filterRole, setFilterRole] = useState("all");
  const [filterJetlag, setFilterJetlag] = useState(false);
  const [filterSolo, setFilterSolo] = useState(false);
  const [filterQuickBite, setFilterQuickBite] = useState(false);
  // Jetlag Proof / Solo Friendly / Quick Bite only ever make sense for food -- clear them if the
  // crew member switches category with one still active, so it can't silently keep filtering a
  // category where it no longer shows as an option.
  useEffect(() => { if (activeCategory !== "food") { setFilterJetlag(false); setFilterSolo(false); setFilterQuickBite(false); } }, [activeCategory]);

  const tipsForCat = crewTips
    .filter(t => t.category === activeCategory)
    .filter(t => filterRole === "all" || t.role === filterRole)
    .filter(t => !filterJetlag || t.jetlagProof)
    .filter(t => !filterSolo || t.soloFriendly)
    .filter(t => !filterQuickBite || t.quickBite)
    .slice()
    .sort((a, b) => sortBy === "liked"
      ? b.likes - a.likes
      : new Date(b.date).getTime() - new Date(a.date).getTime()
    );

  const categoryTipCount = crewTips.filter(t => t.category === activeCategory).length;
  const [summaries, setSummaries] = useState<Record<string, { text: string | null; loading: boolean; error: boolean }>>({});
  useEffect(() => {
    const key = `${code}:${activeCategory}`;
    if (categoryTipCount === 0 || summaries[key]) return;
    setSummaries(prev => ({ ...prev, [key]: { text: null, loading: true, error: false } }));
    supabase.functions.invoke("generate-summary", { body: { destCode: code, category: activeCategory } })
      .then(({ data, error }: any) => {
        setSummaries(prev => ({ ...prev, [key]: error || !data?.summary ? { text: null, loading: false, error: true } : { text: data.summary, loading: false, error: false } }));
      });
  }, [code, activeCategory, categoryTipCount]);

  function handleLike(id) {
    setCrewTips(tips => tips.map(t => t.id === id ? { ...t, likes: t.likedByMe ? t.likes - 1 : t.likes + 1, likedByMe: !t.likedByMe } : t));
    onToggleLike?.(id);
  }

  function handleAddComment(tipId) {
    const form = commentForms[tipId];
    if (!form?.name?.trim() || !form?.text?.trim()) return;
    const newComment = {
      id: Date.now(),
      name: form.name.trim(),
      role: form.role || "Cabin Crew",
      text: form.text.trim(),
      date: new Date().toISOString().split("T")[0],
    };
    setCrewTips(tips => tips.map(t =>
      t.id === tipId ? { ...t, comments: [...t.comments, newComment] } : t
    ));
    setCommentForms(f => ({ ...f, [tipId]: { name: "", role: "Cabin Crew", text: "" } }));
    onAddComment?.(tipId, { name: form.name.trim(), role: form.role || "Cabin Crew", text: form.text.trim() });
  }

  function updateCommentForm(tipId, field, value) {
    setCommentForms(f => ({ ...f, [tipId]: { ...f[tipId], [field]: value } }));
  }

  return (
    <div className="screen">
      {showWeather && (
        <div className="map-overlay">
          <div className="map-header">
            <div className="map-header-title">{dest.city} — weather</div>
            <button className="map-close-btn" onClick={() => setShowWeather(false)}><Icon name="close" size={14} strokeWidth={2.2} />Close</button>
          </div>
          <div className="weather-overlay-body">
            <div className="weather-today">
              <Icon name={weatherIcon(forecast?.[0]?.main || "")} size={52} color="var(--accent)" strokeWidth={1.5} />
              <div className="weather-today-temp">{liveWeather ?? dest.weather}</div>
              <div className="weather-today-label">Right now</div>
            </div>
            {!WEATHER_API_KEY && <div className="no-tips">Live forecast isn't set up for this app.</div>}
            {!!WEATHER_API_KEY && forecastLoading && <div className="no-tips">Loading forecast…</div>}
            {!!WEATHER_API_KEY && !forecastLoading && !forecast && <div className="no-tips">Couldn't load the forecast right now.</div>}
            {forecast && forecast.length > 0 && (
              <div className="forecast-list">
                {forecast.map(day => (
                  <div key={day.date} className="forecast-day">
                    <div className="forecast-day-date">{new Date(day.date).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}</div>
                    <div className="forecast-day-emoji"><Icon name={weatherIcon(day.main)} size={22} color="var(--accent)" /></div>
                    <div className="forecast-day-desc">{day.desc}</div>
                    <div className="forecast-day-temps"><b>{day.max}°</b> / {day.min}°</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {showMap && (
        <div className="map-overlay">
          <div className="map-header">
            <div className="map-header-title">{dest.city} — recommendations</div>
            <button className="map-close-btn" onClick={() => setShowMap(false)}><Icon name="close" size={14} strokeWidth={2.2} />Close</button>
          </div>
          {crewTips.filter((t: any) => t.coords).length === 0 && (
            <div className="map-hint-banner">No pinned recommendations yet{dest.crewHotel ? " — showing the crew hotel" : ` — showing ${dest.city}`}. Add a tip with a place name to pin it here.</div>
          )}
          <div className="map-container" ref={mapContainerRef} />
          <div className="map-zoom-controls">
            <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1)}>+</button>
            <button type="button" aria-label="Zoom out" onClick={() => zoomBy(-1)}>−</button>
          </div>
          {(() => {
            const presentIds = Array.from(new Set(crewTips.filter((t: any) => t.coords).map((t: any) => t.category)));
            if (presentIds.length === 0) return null;
            return (
              <div className="map-legend">
                {presentIds.map(id => {
                  const cat = CATEGORIES.find(c => c.id === id);
                  if (!cat) return null;
                  return (
                    <div key={id} className="map-legend-item">
                      <span className="map-legend-dot" style={{ background: cat.color }}><CategoryIcon id={cat.id} color="#fff" size={11} strokeWidth={2.4} /></span>
                      {cat.label}
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      )}
      <div className="dest-hero">
        <button className="back-btn" onClick={onBack} aria-label="Back"><Icon name="back" size={20} strokeWidth={2} /></button>
        <div className="dest-hero-country">
          <img className="dest-flag-big" src={`https://flagcdn.com/${flagToCode(dest.flag)}.svg`} alt="" />
          {dest.country} · {code}
        </div>
        <div className="dest-hero-name">{dest.city}</div>
        {(() => {
          const offset = TZ_OFFSETS[code] ?? 0;
          const diff = offset - 2;
          const diffStr = diff === 0 ? "= AMS" : `${diff > 0 ? "+" : "−"}${Math.abs(diff)}h`;
          return (
            <div className="dest-meta-row">
              <button className="dest-meta-chip dest-meta-chip-btn" onClick={() => setShowWeather(true)}><Icon name="cloud" size={16} color="var(--accent)" />{liveWeather ?? dest.weather}</button>
              <span className="dest-meta-chip"><Icon name="clock" size={16} color="var(--accent)" />{fmtTime(offset)} <span className="dest-meta-sub">{diffStr}</span></span>
              {dest.crewHotel && (
                <button className="dest-meta-chip dest-meta-chip-btn dest-meta-chip-hotel" onClick={() => setShowMap(true)}><Icon name="hotel" size={16} color="var(--accent)" /><span className="dest-meta-ellipsis">{dest.crewHotel}</span></button>
              )}
            </div>
          );
        })()}
      </div>
      {(() => {
        const activeCat = CATEGORIES.find(c => c.id === activeCategory);
        const activeCount = crewTips.filter(t => t.category === activeCategory).length;
        return (
          <div className="dest-action-row">
            <button className="cat-picker-btn" onClick={() => setShowCatPicker(true)}>
              {activeCat && <CategoryIcon id={activeCat.id} color="#fff" size={18} />}
              <span className="cat-picker-label">{activeCat?.label || "Category"}</span>
              {activeCount > 0 && <span className="cat-picker-count">{activeCount}</span>}
              <Icon name="chevronDown" size={16} strokeWidth={2.2} className="cat-picker-chevron" />
            </button>
            <button className="map-view-btn" onClick={() => setShowMap(true)} aria-label="Map view"><Icon name="map" size={20} /></button>
          </div>
        );
      })()}
      {showCatPicker && (
        <CategoryMenu
          onClose={() => setShowCatPicker(false)}
          activeCategory={activeCategory}
          onSelectCategory={(catId: string) => setActiveCategory(catId)}
          tips={crewTips}
          title={dest.city}
          subtitle="Browse by category"
        />
      )}
      <div className="content-pad">
        <div className="ai-panel">
          <div className="ai-panel-label"><Icon name="sparkle" size={16} />AI briefing</div>
          {(() => {
            const sum = summaries[`${code}:${activeCategory}`];
            if (categoryTipCount === 0) return <div className="ai-panel-headline" style={{color:"var(--text2)",fontWeight:400}}>No crew tips yet in this category — nothing to summarize.</div>;
            if (!sum || sum.loading) return <div className="ai-panel-headline" style={{color:"var(--text2)",fontWeight:400}}>Summarizing crew tips…</div>;
            if (sum.error || !sum.text) return <div className="ai-panel-headline" style={{color:"var(--text2)",fontWeight:400}}>Couldn't generate a briefing right now.</div>;
            return <p className="ai-tip-text" style={{margin:0}}>{sum.text}</p>;
          })()}
        </div>
        <div className="crew-tips-header">
          <div className="section-label" style={{ margin: 0 }}>
            From the crew
            {tipsForCat.length > 0 && <span className="section-count"> · {tipsForCat.length}</span>}
          </div>
          <button className="add-btn" onClick={() => onAddTip(code, activeCategory)}><Icon name="plus" size={15} strokeWidth={2.2} />Add tip</button>
        </div>
        <div className="sort-filter-bar">
          <div className="sort-filter-group">
            <button className={`sf-btn${sortBy === "recent" ? " active" : ""}`} onClick={() => setSortBy("recent")}>Recent</button>
            <button className={`sf-btn${sortBy === "liked" ? " active" : ""}`} onClick={() => setSortBy("liked")}>Most liked</button>
          </div>
          <select className="sf-select" value={filterRole} onChange={e => setFilterRole(e.target.value)}>
            <option value="all">All roles</option>
            <option value="Captain">Captain</option>
            <option value="First Officer">First Officer</option>
            <option value="Senior Purser">Senior Purser</option>
            <option value="Cabin Crew">Cabin Crew</option>
          </select>
        </div>
        {activeCategory === "food" && (
          <div className="sort-filter-bar crew-filter-bar">
            <button className={`sf-btn${filterJetlag ? " active" : ""}`} onClick={() => setFilterJetlag(v => !v)}><Icon name="moon" size={14} />Jetlag proof</button>
            <button className={`sf-btn${filterSolo ? " active" : ""}`} onClick={() => setFilterSolo(v => !v)}><Icon name="user" size={14} />Solo friendly</button>
            <button className={`sf-btn${filterQuickBite ? " active" : ""}`} onClick={() => setFilterQuickBite(v => !v)}><Icon name="bolt" size={14} />Quick bite</button>
          </div>
        )}
        {tipsForCat.length === 0
          ? <div className="no-tips">No crew tips yet here. Be the first!</div>
          : tipsForCat.map(tip => {
            const isExpanded = expandedTip === tip.id;
            const form = commentForms[tip.id] || { name: "", role: "Cabin Crew", text: "" };
            return (
              <div key={tip.id} ref={(el: any) => { tipRefs.current[tip.id] = el; }} className={`crew-card${String(tip.id) === String(focusTipId) ? " crew-card-focused" : ""}`}>
                <div className="crew-card-top">
                  <button className="crew-av crew-av-btn" onClick={() => onCrewClick && onCrewClick({ name: tip.name, role: tip.role, authorId: tip.authorId })}>{tip.name[0]}</button>
                  <div>
                    <div className="crew-card-name crew-card-name-link" onClick={() => onCrewClick && onCrewClick({ name: tip.name, role: tip.role, authorId: tip.authorId })}>{tip.name}</div>
                    <div className="crew-card-role">{tip.role}</div>
                  </div>
                  <div className="crew-card-date">{tip.date}</div>
                </div>
                {tip.photo && <img className="tip-photo" src={tip.photo} alt="tip photo" />}
                <TipText text={tip.text} className="crew-card-text" />
                {tip.tags && tip.tags.length > 0 && (
                  <div className="tip-tags-row">{tip.tags.map((tag: string, ti: number) => <span key={ti} className="tip-tag">#{tag}</span>)}</div>
                )}
                {(tip.price || tip.hours || tip.discount || (tip.category === "food" && (tip.jetlagProof || tip.soloFriendly || tip.quickBite)) || tip.visibility === "connections" || (tip.coords && hotelCoords)) && (
                  <div className="tip-meta-row">
                    {tip.price && <span className="tip-price-badge">{tip.price === "Free" ? "Free" : tip.price}</span>}
                    {tip.hours && <span className="tip-hours-badge"><Icon name="clock" size={13} />{tip.hours}</span>}
                    {tip.discount && <span className="tip-discount-badge"><Icon name="tag" size={13} />{tip.discount === true ? "Crew discount" : `${tip.discount} crew`}</span>}
                    {tip.category === "food" && tip.jetlagProof && <span className="tip-jetlag-badge"><Icon name="moon" size={13} />Jetlag proof</span>}
                    {tip.category === "food" && tip.soloFriendly && <span className="tip-solo-badge"><Icon name="user" size={13} />Solo friendly</span>}
                    {tip.category === "food" && tip.quickBite && <span className="tip-quickbite-badge"><Icon name="bolt" size={13} />Quick bite</span>}
                    {tip.visibility === "connections" && <span className="tip-private-badge"><Icon name="lock" size={13} />Connections only</span>}
                    {tip.coords && hotelCoords && (
                      <span className="tip-distance-badge"><Icon name="hotel" size={13} />{fmtDistance(distanceKm({ lat: parseFloat(tip.coords.lat), lng: parseFloat(tip.coords.lon) }, hotelCoords))} from crew hotel</span>
                    )}
                  </div>
                )}
                <div className="tip-actions">
                  <button className={`like-btn${tip.likedByMe ? " liked" : ""}`} onClick={() => handleLike(tip.id)} aria-label="Like"><Icon name="heart" size={16} />{tip.likes}</button>
                  <button
                    className={`comment-toggle-btn${isExpanded ? " active" : ""}`}
                    onClick={() => setExpandedTip(isExpanded ? null : tip.id)} aria-label="Comments">
                    <Icon name="comment" size={16} />{tip.comments.length > 0 ? tip.comments.length : "Comment"}
                  </button>
                  <a href={tipMapsUrl(tip, dest)} target="_blank" rel="noreferrer" className="maps-link"><Icon name="pin" size={16} />Maps</a>
                  <button className="share-btn" onClick={() => shareTip(tip, dest, () => { setCopiedTipId(tip.id); setTimeout(() => setCopiedTipId((id: any) => id === tip.id ? null : id), 1800); })}>
                    {copiedTipId === tip.id ? <><Icon name="check" size={16} />Copied</> : <><Icon name="share" size={16} />Share</>}
                  </button>
                  <ConnectButton authorId={tip.authorId} connections={connections} className="connect-btn" />
                  <button
                    className={`fav-btn${favorites.includes(`${code}-${tip.id}`) ? " saved" : ""}`}
                    onClick={() => onToggleFavorite(`${code}-${tip.id}`)}
                    aria-label={favorites.includes(`${code}-${tip.id}`) ? "Remove from saved" : "Save"}>
                    <Icon name="bookmark" size={18} />
                  </button>
                </div>

                {isExpanded && (
                  <div className="comments-section">
                    {tip.comments.length > 0 && (
                      <div className="comments-list">
                        {tip.comments.map(c => (
                          <div key={c.id} className="comment-item">
                            <div className="comment-av">{c.name[0]}</div>
                            <div className="comment-body">
                              <div className="comment-meta">
                                <span className="comment-name">{c.name}</span>
                                <span className="comment-role">{c.role}</span>
                                <span className="comment-date">{c.date}</span>
                              </div>
                              <p className="comment-text">{c.text}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="comment-form">
                      <input className="comment-inp" placeholder="Your name"
                        value={form.name}
                        onChange={e => updateCommentForm(tip.id, "name", e.target.value)} />
                      <select className="comment-sel"
                        value={form.role}
                        onChange={e => updateCommentForm(tip.id, "role", e.target.value)}>
                        <option>Cabin Crew</option>
                        <option>Senior Purser</option>
                        <option>First Officer</option>
                        <option>Captain</option>
                        <option>Ground Staff</option>
                      </select>
                      <div className="comment-input-row">
                        <input className="comment-inp comment-text-inp" placeholder="Add a comment…"
                          value={form.text}
                          onChange={e => updateCommentForm(tip.id, "text", e.target.value)}
                          onKeyDown={e => e.key === "Enter" && handleAddComment(tip.id)} />
                        <button className="comment-submit-btn"
                          onClick={() => handleAddComment(tip.id)}
                          disabled={!form.name?.trim() || !form.text?.trim()}>
                          <Icon name="arrowUp" size={18} strokeWidth={2.2} />
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        }
      </div>
    </div>
  );
}

// ─── ADD RECOMMENDATION ────────────────────────────────────────────────────────
function osmCategoryGuess(cls: string, type: string): string {
  if (cls === "amenity") {
    if (["restaurant","cafe","bar","fast_food","food_court","pub","biergarten"].includes(type)) return "food";
    if (["hotel","hostel","guest_house","motel"].includes(type)) return "rest";
    if (["bus_station","taxi","ferry_terminal","car_rental"].includes(type)) return "transport";
    if (["hospital","pharmacy","police","clinic","doctors"].includes(type)) return "safety";
    if (["nightclub","theatre","cinema","arts_centre"].includes(type)) return "gems";
  }
  if (cls === "tourism") {
    if (["hotel","hostel","motel","apartment"].includes(type)) return "rest";
    if (["attraction","museum","gallery","viewpoint","zoo","theme_park"].includes(type)) return "gems";
  }
  if (cls === "railway" || cls === "aeroway" || (cls === "public_transport")) return "transport";
  if (cls === "leisure") return "gems";
  if (cls === "shop") return "food";
  return "gems";
}

function AddRecommendationScreen({ onBack, selectedDest, onSubmit, profile, defaultCategory }) {
  const allDests = Object.values(DESTINATIONS) as any[];
  const destsByContinentCountry = groupDestsByContinentCountry(allDests);
  const [destCode, setDestCode] = useState(selectedDest || "");
  const [showDestPicker, setShowDestPicker] = useState(false);
  const [openContinent, setOpenContinent] = useState<string | null>(null);
  const [destQuery, setDestQuery] = useState("");
  const destSearchQ = destQuery.trim().toLowerCase();
  const destSearchResults = destSearchQ.length === 0 ? null : allDests
    .filter(d => d.city.toLowerCase().includes(destSearchQ) || d.country.toLowerCase().includes(destSearchQ) || d.code.toLowerCase() === destSearchQ)
    .sort((a, b) => {
      const aStarts = a.city.toLowerCase().startsWith(destSearchQ) ? 0 : 1;
      const bStarts = b.city.toLowerCase().startsWith(destSearchQ) ? 0 : 1;
      return aStarts - bStarts || a.city.localeCompare(b.city);
    });
  const [place, setPlace] = useState("");
  const [category, setCategory] = useState(defaultCategory || "food");
  const [note, setNote] = useState("");
  const name = profile?.name || "";
  const role = profile?.role || "Cabin Crew";
  const [price, setPrice] = useState("");
  const [openingHours, setOpeningHours] = useState("");
  const [crewDiscount, setCrewDiscount] = useState(false);
  const [discountPct, setDiscountPct] = useState("");
  const [jetlagProof, setJetlagProof] = useState(false);
  const [soloFriendly, setSoloFriendly] = useState(false);
  const [quickBite, setQuickBite] = useState(false);
  const [visibility, setVisibility] = useState<"public" | "connections">("public");
  const [tags, setTags] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(false);
  const [showDonation, setShowDonation] = useState(false);
  const [pendingTip, setPendingTip] = useState<any>(null);
  const [donationAmount, setDonationAmount] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [suggSource, setSuggSource] = useState<"google" | "nominatim">("nominatim");
  const [loadingSugg, setLoadingSugg] = useState(false);
  const [placeCoords, setPlaceCoords] = useState<{ lat: string; lon: string } | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const justPickedRef = useRef(false);

  const dest = (DESTINATIONS as any)[destCode];
  const mapsUrl = placeCoords
    ? `https://www.google.com/maps/search/?api=1&query=${placeCoords.lat},${placeCoords.lon}`
    : place && dest
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place + " " + dest.city)}`
      : null;

  const [hotelCoords, setHotelCoords] = useState<{ lat: number; lng: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setHotelCoords(null);
    if (dest) geocodeHotel(dest.crewHotel, dest.city, dest.country).then(c => { if (!cancelled) setHotelCoords(c); });
    return () => { cancelled = true; };
  }, [destCode]);
  const distanceToHotel = placeCoords && hotelCoords
    ? fmtDistance(distanceKm({ lat: parseFloat(placeCoords.lat), lng: parseFloat(placeCoords.lon) }, hotelCoords))
    : null;

  useEffect(() => {
    if (justPickedRef.current) { justPickedRef.current = false; return; }
    if (place.length < 3 || !dest) { setSuggestions([]); setShowDropdown(false); return; }
    const timer = setTimeout(async () => {
      setLoadingSugg(true);
      try {
        // Google Places has far more reliable opening-hours data than OSM for most businesses
        // (spas, restaurants, ...) -- try it first, fall back to Nominatim if it's unavailable or
        // comes up empty, same two-tier approach used for hotel search in Pillow Report.
        if (await loadGoogleMaps() && ensurePlacesServices()) {
          const preds = await googlePlacePredictions(place, dest.city);
          if (place.length >= 3 && preds.length) {
            setSuggSource("google");
            setSuggestions(preds);
            setShowDropdown(true);
            setLoadingSugg(false);
            return;
          }
        }
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(place + " " + dest.city)}&format=json&limit=6&addressdetails=1&extratags=1&namedetails=1`;
        const res = await fetch(url, { headers: { "Accept-Language": "en" } });
        const data = await res.json();
        setSuggSource("nominatim");
        setSuggestions(data);
        setShowDropdown(data.length > 0);
      } catch { setSuggestions([]); }
      setLoadingSugg(false);
    }, 400);
    return () => clearTimeout(timer);
  }, [place, destCode]);

  async function pickSuggestion(s: any) {
    justPickedRef.current = true;
    setSuggestions([]);
    setShowDropdown(false);
    if (suggSource === "google") {
      const place_ = await googlePlaceDetails(s.place_id);
      const shortName = place_?.name || s.structured_formatting?.main_text || s.description || "";
      setPlace(shortName);
      if (place_?.geometry?.location) setPlaceCoords({ lat: String(place_.geometry.location.lat()), lon: String(place_.geometry.location.lng()) });
      if (place_?.opening_hours?.weekday_text) setOpeningHours(condenseOpeningHours(place_.opening_hours.weekday_text));
      setJetlagProof(jetlagProofFromGooglePeriods(place_?.opening_hours?.periods));
      return;
    }
    const shortName = s.namedetails?.name || s.name || s.display_name.split(",")[0];
    setPlace(shortName);
    setPlaceCoords({ lat: s.lat, lon: s.lon });
    setCategory(osmCategoryGuess(s.class, s.type));
    setOpeningHours(s.extratags?.opening_hours || "");
    setJetlagProof(jetlagProofFromOsmHours(s.extratags?.opening_hours));
  }

  function handlePlaceChange(e: any) {
    setPlace(e.target.value);
    setPlaceCoords(null);
    setJetlagProof(false);
  }

  function handleSubmit() {
    if (!place.trim() || !destCode || !note.trim() || !name.trim()) return;
    const newTip: any = {
      id: Date.now(),
      name: name.trim(),
      role,
      category,
      text: `📍 ${place.trim()} — ${note.trim()}`,
      date: new Date().toISOString().split("T")[0],
      likes: 0,
      comments: [],
    };
    if (price) newTip.price = price;
    if (openingHours.trim()) newTip.hours = openingHours.trim();
    if (placeCoords) newTip.coords = placeCoords;
    if (crewDiscount) newTip.discount = discountPct ? `${discountPct}%` : true;
    if (category === "food" && jetlagProof) newTip.jetlagProof = true;
    if (category === "food" && soloFriendly) newTip.soloFriendly = true;
    if (category === "food" && quickBite) newTip.quickBite = true;
    newTip.visibility = visibility;
    if (photo) newTip.photo = photo;
    const parsedTags = tags.split(/[\s,#]+/).map((t: string) => t.replace(/^#/, "").trim()).filter(Boolean);
    if (parsedTags.length > 0) newTip.tags = parsedTags;
    setPendingTip(newTip);
    setShowDonation(true);
  }

  async function finalize(donated: boolean) {
    if (submitting) return;
    setSubmitting(true);
    const ok = await onSubmit(destCode, pendingTip);
    setSubmitting(false);
    if (!ok) { setSubmitError(true); return; }
    setShowDonation(false);
    setSubmitted(true);
  }

  if (submitted) return (
    <div className="screen screen-center">
      <div className="success-icon"><Icon name="checkCircle" size={56} color="#059669" strokeWidth={1.6} /></div>
      <div className="success-title">Recommendation added!</div>
      <p className="success-sub">Your tip for {dest?.city} is now visible to all WingTips crew.</p>
    </div>
  );

  return (
    <div className="screen">
      {showDonation && (
        <div className="donation-backdrop">
          <div className="donation-modal">
            <div className="donation-wings-logo"><Icon name="heart" size={44} color="var(--accent)" strokeWidth={1.6} /></div>
            <div className="donation-title">Before you post…</div>
            <p className="donation-body">
              WingTips is free — and so is sharing knowledge. If this community has saved you time or money on a layover, consider leaving a small token.<br /><br />
              <strong>50% of every donation</strong> goes directly to <strong>Wings of Support</strong>, a foundation supporting KLM crew and their families in need.
            </p>
            <div className="donation-amounts">
              {[2, 5, 10].map(amt => (
                <button key={amt} className={`donation-chip${donationAmount === amt ? " active" : ""}`} onClick={() => setDonationAmount(donationAmount === amt ? null : amt)}>
                  €{amt}
                </button>
              ))}
            </div>
            {submitError && <p className="donation-error">Couldn't post your recommendation — check your connection and try again.</p>}
            <button className="donation-btn-primary" onClick={() => finalize(true)} disabled={!donationAmount || submitting}>
              {submitting ? "Posting…" : donationAmount ? `Donate €${donationAmount} & Post` : "Select an amount"}
            </button>
            <button className="donation-btn-skip" onClick={() => finalize(false)} disabled={submitting}>
              {submitting ? "Posting…" : "Skip and post without donating"}
            </button>
          </div>
        </div>
      )}
      <div className="form-header">
        <button className="back-btn-flat" onClick={onBack}><Icon name="back" size={18} />Cancel</button>
        <div className="form-header-title">Add Recommendation</div>
      </div>
      <div className="form-body">

        <div className="form-group">
          <label className="form-lbl">Destination</label>
          <button type="button" className="form-sel dest-picker-trigger" onClick={() => setShowDestPicker(true)}>
            <span className="dest-picker-value">{dest ? <><Flag emoji={dest.flag} />{dest.city}</> : "Select city"}</span>
            <span className="dest-picker-chevron"><Icon name="chevronDown" size={18} /></span>
          </button>
        </div>

        {showDestPicker && (
          <div className="cat-menu-backdrop" onClick={() => setShowDestPicker(false)}>
            <div className="cat-menu-sheet dest-sheet" onClick={e => e.stopPropagation()}>
              <div className="cat-menu-handle" />
              <div className="cat-menu-title">Select destination</div>
              <div className="cat-menu-dest">{allDests.length} destinations · grouped by continent &amp; country</div>
              <div className="dest-search-row">
                <input className="dest-search-inp" placeholder="Search city, country or code…"
                  value={destQuery} onChange={e => setDestQuery(e.target.value)} autoComplete="off" />
                {destQuery && <button type="button" className="dest-search-clear" onClick={() => setDestQuery("")} aria-label="Clear"><Icon name="close" size={16} /></button>}
              </div>
              {destSearchResults && (
                <div className="dest-continent-list">
                  {destSearchResults.length === 0
                    ? <div className="no-tips" style={{ padding: "0 16px" }}>No destinations match "{destQuery}".</div>
                    : <div className="dest-list-inner">
                        {destSearchResults.map((d: any) => (
                          <button key={d.code} type="button"
                            className={`dest-list-item${destCode === d.code ? " active" : ""}`}
                            onClick={() => { setDestCode(d.code); setPlace(""); setPlaceCoords(null); setSuggestions([]); setShowDestPicker(false); setDestQuery(""); }}>
                            <div className="dli-text">
                              <span className="dli-city"><Flag emoji={d.flag} />{d.city}</span>
                              <span className="dli-sub">{d.country}</span>
                            </div>
                            <span className="dli-code">{d.code}</span>
                            {destCode === d.code && <span className="dli-tick"><Icon name="check" size={16} strokeWidth={2.2} /></span>}
                          </button>
                        ))}
                      </div>
                  }
                </div>
              )}
              {!destSearchResults && (
              <div className="dest-continent-list">
                {destsByContinentCountry.map(group => {
                  const isOpen = openContinent === group.continent;
                  return (
                    <div key={group.continent} className="continent-block">
                      <button type="button" className={`continent-header${isOpen ? " open" : ""}`}
                        onClick={() => setOpenContinent(isOpen ? null : group.continent)}>
                        <span className="continent-dot" style={{background: group.color}} />
                        <span className="continent-label">{group.continent}</span>
                        <span className="continent-count">{group.count}</span>
                        <span className="continent-chevron"><Icon name={isOpen ? "chevronUp" : "chevronDown"} size={18} /></span>
                      </button>
                      {isOpen && (
                        <div className="dest-list-inner">
                          {group.countries.map((c: any) => (
                            <div key={c.country} className="country-group">
                              <div className="country-header">
                                <Flag emoji={c.flag} />
                                <span className="country-name">{c.country}</span>
                              </div>
                              {c.dests.map((d: any) => (
                                <button key={d.code} type="button"
                                  className={`dest-list-item no-flag${destCode === d.code ? " active" : ""}`}
                                  onClick={() => { setDestCode(d.code); setPlace(""); setPlaceCoords(null); setSuggestions([]); setShowDestPicker(false); }}>
                                  <div className="dli-text">
                                    <span className="dli-city">{d.city}</span>
                                  </div>
                                  <span className="dli-code">{d.code}</span>
                                  {destCode === d.code && <span className="dli-tick"><Icon name="check" size={16} strokeWidth={2.2} /></span>}
                                </button>
                              ))}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              )}
            </div>
          </div>
        )}

        <div className="form-group" style={{ position: "relative" }}>
          <label className="form-lbl">Place name</label>
          <div className="place-search-row">
            <input className="form-inp" placeholder="e.g. Ravi Restaurant, Alserkal Avenue…"
              value={place} onChange={handlePlaceChange}
              onFocus={() => suggestions.length > 0 && setShowDropdown(true)}
              autoComplete="off"
              style={{ flex: 1 }} />
            {loadingSugg && <span className="sugg-spinner"><Icon name="loader" size={18} color="var(--accent)" className="spin" /></span>}
            {mapsUrl && (
              <a href={mapsUrl} target="_blank" rel="noreferrer" className="maps-btn">
                <Icon name="map" size={16} />Maps
              </a>
            )}
          </div>
          {showDropdown && suggestions.length > 0 && (
            <div className="sugg-dropdown">
              {suggestions.map((s, i) => {
                const primary = suggSource === "google"
                  ? (s.structured_formatting?.main_text || s.description)
                  : (s.namedetails?.name || s.name || s.display_name.split(",")[0]);
                const addr = suggSource === "google"
                  ? (s.structured_formatting?.secondary_text || "")
                  : s.display_name.split(",").slice(1, 3).join(",").trim();
                return (
                  <button key={i} className="sugg-item" onMouseDown={() => pickSuggestion(s)}>
                    <span className="sugg-primary">{primary}</span>
                    <span className="sugg-addr">{addr}</span>
                  </button>
                );
              })}
            </div>
          )}
          {mapsUrl && <div className="maps-hint">Tap Maps to verify the location in Google Maps</div>}
          {distanceToHotel && <div className="maps-hint"><Icon name="hotel" size={14} />{distanceToHotel} from the crew hotel ({dest.crewHotel || "unknown"})</div>}
        </div>

        <div className="form-group">
          <label className="form-lbl">Price level</label>
          <div className="price-chip-row">
            {(["", "Free", "$", "$$", "$$$"] as const).map(p => (
              <button key={p || "none"} className={`price-chip${price === p ? " active" : ""}`} onClick={() => setPrice(p)}>
                {p || "Not specified"}
              </button>
            ))}
          </div>
        </div>

        <div className="form-group">
          <label className="form-lbl">Opening hours <span className="form-lbl-hint">(auto-filled if available)</span></label>
          <input className="form-inp" placeholder="e.g. Mo-Fr 09:00-22:00, Sa-Su 10:00-23:00"
            value={openingHours} onChange={e => setOpeningHours(e.target.value)} />
          {category === "food" && jetlagProof && (
            <div className="jetlag-detected-badge"><Icon name="moon" size={14} />Jetlag proof, detected from opening hours (opens early or stays open late)</div>
          )}
        </div>

        <div className="form-group">
          <div className="toggle-row">
            <div>
              <div className="form-lbl">Crew discount</div>
              <div className="toggle-sub">Show a discount badge on this tip</div>
            </div>
            <label className="toggle-switch">
              <input type="checkbox" checked={crewDiscount} onChange={e => { setCrewDiscount(e.target.checked); if (!e.target.checked) setDiscountPct(""); }} />
              <span className="toggle-track"><span className="toggle-thumb" /></span>
            </label>
          </div>
          {crewDiscount && (
            <div className="discount-field-row">
              <input
                className="form-inp discount-inp"
                type="number"
                min="1"
                max="100"
                placeholder="e.g. 15"
                value={discountPct}
                onChange={e => setDiscountPct(e.target.value)}
              />
              <span className="discount-pct-label">%</span>
              <span className="discount-hint">Leave blank if amount is unknown</span>
            </div>
          )}
        </div>

        {category === "food" && (
          <>
            <div className="form-group">
              <div className="toggle-row">
                <div>
                  <div className="form-lbl">Solo dining friendly</div>
                  <div className="toggle-sub">Good for crew eating alone — bar/counter seating, no awkward family tables</div>
                </div>
                <label className="toggle-switch">
                  <input type="checkbox" checked={soloFriendly} onChange={e => setSoloFriendly(e.target.checked)} />
                  <span className="toggle-track"><span className="toggle-thumb" /></span>
                </label>
              </div>
            </div>

            <div className="form-group">
              <div className="toggle-row">
                <div>
                  <div className="form-lbl">Quick bite</div>
                  <div className="toggle-sub">Good food, but not a long sit-down meal — in and out fast</div>
                </div>
                <label className="toggle-switch">
                  <input type="checkbox" checked={quickBite} onChange={e => setQuickBite(e.target.checked)} />
                  <span className="toggle-track"><span className="toggle-thumb" /></span>
                </label>
              </div>
            </div>
          </>
        )}

        <div className="form-group">
          <label className="form-lbl">Who can see this tip?</label>
          <div className="price-chip-row">
            <button className={`price-chip${visibility === "public" ? " active" : ""}`} onClick={() => setVisibility("public")}><Icon name="globe" size={15} />Public, everyone</button>
            <button className={`price-chip${visibility === "connections" ? " active" : ""}`} onClick={() => setVisibility("connections")}><Icon name="lock" size={15} />Connections only</button>
          </div>
        </div>

        <div className="form-group">
          <label className="form-lbl">Category</label>
          <div className="rec-cat-row">
            {CATEGORIES.map(c => (
              <button key={c.id}
                className={`rec-cat-chip${category === c.id ? " active" : ""}`}
                onClick={() => setCategory(c.id)}>
                <CategoryIcon id={c.id} color={category === c.id ? "#fff" : c.color} size={16} />
                {c.label}
              </button>
            ))}
          </div>
        </div>

        <div className="form-group">
          <label className="form-lbl">Photo <span className="form-lbl-hint">(optional)</span></label>
          {photo ? (
            <div className="photo-preview-wrap">
              <img className="photo-preview" src={photo} alt="preview" />
              <button className="photo-remove-btn" onClick={() => setPhoto(null)}><Icon name="close" size={13} strokeWidth={2.2} />Remove</button>
            </div>
          ) : (
            <label className="photo-upload-btn">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{marginRight:6}}><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
              Add photo
              <input type="file" accept="image/*" style={{display:"none"}} onChange={(e: any) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = ev => setPhoto(ev.target?.result as string);
                reader.readAsDataURL(file);
              }} />
            </label>
          )}
        </div>

        <div className="form-group">
          <label className="form-lbl">Keywords / hashtags <span className="form-lbl-hint">(helps others find this tip)</span></label>
          <input className="form-inp" placeholder="e.g. #spa facial relaxing rooftop" value={tags} onChange={(e: any) => setTags(e.target.value)} />
          <div className="form-lbl-hint" style={{marginLeft:0, marginTop:4}}>Separate by space or comma — # is optional</div>
          {tags.trim() && (
            <div className="tip-tags-row" style={{marginTop:6}}>
              {tags.split(/[\s,#]+/).filter(Boolean).map((t, i) => <span key={i} className="tip-tag">#{t.replace(/^#/,"")}</span>)}
            </div>
          )}
        </div>

        <div className="form-group">
          <label className="form-lbl">Your tip about this place</label>
          <textarea className="form-ta" rows={3}
            placeholder="What makes it worth the visit? Price, hours, what to order…"
            value={note} onChange={e => setNote(e.target.value)} />
        </div>

        <div className="form-group">
          <label className="form-lbl">Posting as</label>
          <div className="form-author-locked">
            <div className="crew-av" style={{width:32,height:32,fontSize:13}}>{name ? name[0] : "?"}</div>
            <div><div style={{fontSize:13,fontWeight:600,color:"var(--text)"}}>{name || "Set up your profile first"}</div><div style={{fontSize:11,color:"var(--text2)"}}>{role}</div></div>
          </div>
        </div>

        <button className="submit-btn" onClick={handleSubmit}
          disabled={!place.trim() || !destCode || !note.trim() || !name.trim()}>
          Post Recommendation
        </button>
      </div>
    </div>
  );
}

// ─── FAVORITES ─────────────────────────────────────────────────────────────────
function FavoritesScreen({ onBack, favorites, onToggleFavorite, onDestClick, addedTips }) {
  const savedTips = favorites.map((key: string) => {
    const [code, idStr] = key.split("-");
    const dest = (DESTINATIONS as any)[code];
    if (!dest) return null;
    const allTips = [...(dest.crewTips || []), ...((addedTips[code]) || [])];
    const tip = allTips.find(t => String(t.id) === idStr);
    if (!tip) return null;
    return { key, code, dest, tip };
  }).filter(Boolean);

  return (
    <div className="screen">
      <div className="screen-topbar">
        <button className="back-btn-flat" onClick={onBack}><Icon name="back" size={18} />Back</button>
        <div className="screen-topbar-title">Saved Tips</div>
      </div>
      {savedTips.length === 0
        ? <div className="screen-center">
            <div style={{ marginBottom: 16 }}><Icon name="bookmark" size={40} color="var(--accent)" strokeWidth={1.6} /></div>
            <div style={{ color: "var(--text2)", fontSize: 14 }}>No saved tips yet.</div>
            <div style={{ color: "var(--text2)", fontSize: 12, marginTop: 6 }}>Tap the bookmark on any crew tip to save it here.</div>
          </div>
        : <div className="content-pad">
            {savedTips.map(({ key, code, dest, tip }) => (
              <div key={key} className="crew-card">
                <button className="fav-dest-label" onClick={() => onDestClick(code)}>
                  <CategoryIcon id={tip.category || "other"} color={CATEGORIES.find(c => c.id === tip.category)?.color} size={15} />{dest.city}
                </button>
                <div className="crew-card-top" style={{ marginTop: 8 }}>
                  <div className="crew-av">{tip.name[0]}</div>
                  <div>
                    <div className="crew-card-name">{tip.name}</div>
                    <div className="crew-card-role">{tip.role}</div>
                  </div>
                  <div className="crew-card-date">{tip.date}</div>
                </div>
                <TipText text={tip.text} className="crew-card-text" />
                <button className="fav-btn saved" onClick={() => onToggleFavorite(key)}><Icon name="bookmark" size={16} />Remove</button>
              </div>
            ))}
          </div>
      }
    </div>
  );
}

// ─── NOTIFICATIONS ─────────────────────────────────────────────────────────────
function NotificationsScreen({ onBack, notes, onMarkAllRead, adminSignups, onNotificationClick }) {
  const showAdminBlock = adminSignups?.isAdmin && adminSignups.events.length > 0;
  // Opening this screen IS reading it -- no separate "Mark all read" action needed. Fires once on
  // mount; the still-unread styling below still shows on this first render (state hasn't updated
  // yet), then clears once the mark lands, so a freshly-opened notification is still visible as
  // new for a moment instead of disappearing before it's even seen.
  useEffect(() => { onMarkAllRead(); adminSignups?.markSeen?.(); }, []);
  return (
    <div className="screen">
      <div className="screen-topbar">
        <button className="back-btn-flat" onClick={onBack}><Icon name="back" size={18} />Back</button>
        <div className="screen-topbar-title">Notifications</div>
      </div>
      <div className="content-pad">
        {showAdminBlock && (
          <div className="conn-requests-block">
            <div className="conn-requests-label">🆕 New sign-ups</div>
            {adminSignups.events.map((e: any) => (
              <div key={e.id} className={`my-tip-card${e.id > adminSignups.lastSeenId ? " signup-unread" : ""}`}>
                <div className="my-tip-meta">{new Date(e.created_at).toLocaleString()}</div>
                <p className="my-tip-text">{e.email} created an account</p>
              </div>
            ))}
          </div>
        )}
        {notes.length === 0 && !showAdminBlock
          ? <div className="no-tips">No notifications yet.</div>
          : notes.map(n => (
            <button key={n.id} className={`notif-item${n.read ? "" : " unread"}`} onClick={() => n.destCode && onNotificationClick(n)} disabled={!n.destCode}>
              <div className="notif-dot" style={{ opacity: n.read ? 0 : 1 }} />
              <div className="notif-text">{n.text}</div>
              <div className="notif-time">{n.time}</div>
            </button>
          ))}
      </div>
    </div>
  );
}

function AccountSection() {
  const [email, setEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwError, setPwError] = useState("");
  const [pwSuccess, setPwSuccess] = useState("");
  const [pwLoading, setPwLoading] = useState(false);
  const [delConfirmText, setDelConfirmText] = useState("");
  const [delError, setDelError] = useState("");
  const [delLoading, setDelLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email || ""));
  }, []);

  async function handleChangePassword() {
    setPwError(""); setPwSuccess("");
    if (newPassword.length < 8) { setPwError("Password must be at least 8 characters."); return; }
    if (newPassword !== confirmPassword) { setPwError("Passwords do not match."); return; }
    setPwLoading(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setPwLoading(false);
    if (error) setPwError(error.message);
    else { setPwSuccess("Password updated."); setNewPassword(""); setConfirmPassword(""); }
  }

  async function handleDeleteAccount() {
    setDelError("");
    if (delConfirmText !== "DELETE") { setDelError('Type "DELETE" to confirm.'); return; }
    if (!confirm("This permanently deletes your account and cannot be undone. Continue?")) return;
    setDelLoading(true);
    const { error } = await supabase.rpc("delete_own_account");
    setDelLoading(false);
    if (error) { setDelError(error.message); return; }
    await supabase.auth.signOut();
  }

  return (
    <div className="account-section">
      {email && <div className="account-email">Logged in as <strong>{email}</strong></div>}

      <div className="account-block">
        <div className="account-block-title">Change password</div>
        <div className="auth-form">
          <input className="auth-input" type="password" placeholder="New password" value={newPassword} onChange={(e: any) => setNewPassword(e.target.value)} />
          <input className="auth-input" type="password" placeholder="Confirm new password" value={confirmPassword} onChange={(e: any) => setConfirmPassword(e.target.value)} />
          {pwError && <div className="auth-error">{pwError}</div>}
          {pwSuccess && <div className="account-success">{pwSuccess}</div>}
          <button className="auth-btn" onClick={handleChangePassword} disabled={pwLoading}>{pwLoading ? "Please wait…" : "Update password"}</button>
        </div>
      </div>

      <button className="account-logout-btn" onClick={() => { if (confirm("Log out?")) supabase.auth.signOut(); }}>Log out</button>

      <div className="account-block account-danger">
        <div className="account-block-title">Delete account</div>
        <div className="account-danger-text">This permanently deletes your account and everything tied to it. This cannot be undone.</div>
        <input className="auth-input" placeholder='Type "DELETE" to confirm' value={delConfirmText} onChange={(e: any) => setDelConfirmText(e.target.value)} />
        {delError && <div className="auth-error">{delError}</div>}
        <button className="account-delete-btn" onClick={handleDeleteAccount} disabled={delLoading}>{delLoading ? "Please wait…" : "Delete my account"}</button>
      </div>
    </div>
  );
}

// ─── PROFILE ───────────────────────────────────────────────────────────────────
function ProfileScreen({ onBack, connections, addedTips, profile, updateProfile, onCrewClick }) {
  const [tab, setTab] = useState("tips");
  const [editing, setEditing] = useState(!profile.name);
  const [connSearch, setConnSearch] = useState("");
  const [userSearchResults, setUserSearchResults] = useState<{ userId: string; name: string; role: string }[] | null>(null);
  const [userSearchLoading, setUserSearchLoading] = useState(false);
  const [draft, setDraft] = useState({ ...profile });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Searches every crew member by name once there's enough to search for, not just people
  // already connected -- debounced so it doesn't fire a query on every keystroke.
  useEffect(() => {
    const q = connSearch.trim();
    if (q.length < 2) { setUserSearchResults(null); return; }
    setUserSearchLoading(true);
    const timer = setTimeout(() => {
      connections.searchUsers(q).then((results: any) => { setUserSearchResults(results); setUserSearchLoading(false); });
    }, 300);
    return () => clearTimeout(timer);
  }, [connSearch]);

  const myTips = Object.entries(addedTips as Record<string, any[]>).flatMap(([code, tips]) =>
    tips.filter((t: any) => t.name === profile.name).map(t => ({ ...t, destCode: code, destCity: (DESTINATIONS as any)[code]?.city || code }))
  );
  const totalLikes = myTips.reduce((s, t) => s + (t.likes || 0), 0);
  const initials = profile.name ? profile.name.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase() : "?";

  async function saveProfile() {
    if (!draft.name.trim() || saving) return;
    setSaving(true);
    setSaveError(null);
    const result = await updateProfile(draft);
    setSaving(false);
    if (!result.ok) { setSaveError(result.message || "unknown error"); return; }
    setEditing(false);
  }

  return (
    <div className="screen">
      <div className="screen-topbar">
        <button className="back-btn-flat" onClick={onBack}><Icon name="back" size={18} />Back</button>
        <div className="screen-topbar-title">My Profile</div>
        {!editing && <button className="profile-edit-btn" onClick={() => { setDraft({ ...profile }); setEditing(true); }}>Edit</button>}
      </div>

      {editing ? (
        <div className="profile-edit-form">
          <div className="profile-av profile-av-large">{draft.name ? draft.name.split(" ").map((w: string) => w[0]).join("").slice(0,2).toUpperCase() : "?"}</div>
          <div className="pef-field">
            <label className="pef-label">Full name</label>
            <input className="pef-input" value={draft.name} onChange={(e: any) => setDraft((p: any) => ({ ...p, name: e.target.value }))} placeholder="e.g. Maria K." />
          </div>
          <div className="pef-field">
            <label className="pef-label">Role</label>
            <select className="pef-input" value={draft.role} onChange={(e: any) => setDraft((p: any) => ({ ...p, role: e.target.value }))}>
              <option>Captain</option>
              <option>First Officer</option>
              <option>Senior Purser</option>
              <option>Cabin Crew</option>
            </select>
          </div>
          <div className="pef-field">
            <label className="pef-label">Home base</label>
            <select className="pef-input" value={draft.base} onChange={(e: any) => setDraft((p: any) => ({ ...p, base: e.target.value }))}>
              {["AMS","RTM","EIN","GRQ","MST"].map(b => <option key={b}>{b}</option>)}
            </select>
          </div>
          <div className="pef-field">
            <label className="pef-label">Bio <span style={{color:"var(--text3)",fontWeight:400}}>(optional)</span></label>
            <textarea className="pef-input pef-textarea" value={draft.bio} onChange={(e: any) => setDraft((p: any) => ({ ...p, bio: e.target.value }))} placeholder="Short intro about yourself..." rows={3} />
          </div>
          {saveError && <p className="pef-error">Couldn't save your profile: {saveError}</p>}
          <button className="pef-save-btn" onClick={saveProfile} disabled={!draft.name.trim() || saving}>{saving ? "Saving…" : "Save profile"}</button>
        </div>
      ) : (
        <>
          <div className="profile-hero">
            <div className="profile-av profile-av-large">{initials}</div>
            <div className="profile-name">{profile.name}</div>
            <div className="profile-role">{profile.role} · {profile.base}</div>
            {profile.bio && <div className="profile-bio">{profile.bio}</div>}
          </div>
          <div className="stats-row">
            {[
              [String(myTips.length), "Tips Posted"],
              [String(totalLikes), "Likes Received"],
              [String(connections.accepted.length), "Connections"],
            ].map(([v, l]) => (
              <div key={l} className="stat-box"><div className="stat-val">{v}</div><div className="stat-lbl">{l}</div></div>
            ))}
          </div>
          <div className="profile-tabs">
            <button className={`profile-tab${tab === "tips" ? " active" : ""}`} onClick={() => setTab("tips")}>My Tips</button>
            <button className={`profile-tab${tab === "connections" ? " active" : ""}`} onClick={() => setTab("connections")}>
              Connections
              {connections.incoming.length > 0 && <span className="tab-badge tab-badge-alert">{connections.incoming.length}</span>}
            </button>
            <button className={`profile-tab${tab === "account" ? " active" : ""}`} onClick={() => setTab("account")}>Account</button>
          </div>
          <div className="content-pad">
            {tab === "tips" && (
              myTips.length === 0
                ? <div className="no-tips">No tips posted yet — add your first tip from a destination page.</div>
                : myTips.map((t, i) => {
                    const cat = CATEGORIES.find(c => c.id === t.category);
                    return (
                      <div key={i} className="my-tip-card">
                        <div className="my-tip-meta"><CategoryIcon id={t.category || "other"} color={cat?.color} size={15} />{t.destCity} · {cat?.label || t.category}</div>
                        <TipText text={t.text} className="my-tip-text" />
                        <div className="my-tip-likes"><Icon name="heart" size={14} />{t.likes || 0}</div>
                      </div>
                    );
                  })
            )}
            {tab === "connections" && (
              <>
                {connections.incoming.length > 0 && (
                  <div className="conn-requests-block">
                    <div className="conn-requests-label">Connection requests</div>
                    {connections.incoming.map((r: any) => (
                      <div key={r.reqId} className="connection-card">
                        <button className="crew-av crew-av-btn" onClick={() => onCrewClick && onCrewClick({ name: r.name, role: r.role, authorId: r.userId })}>{r.name[0]}</button>
                        <div className="connection-info" style={{cursor:"pointer"}} onClick={() => onCrewClick && onCrewClick({ name: r.name, role: r.role, authorId: r.userId })}>
                          <div className="crew-card-name crew-card-name-link">{r.name}</div>
                          <div className="crew-card-role">{r.role}</div>
                        </div>
                        <button className="disconnect-btn" onClick={() => connections.declineRequest(r.reqId)}>Decline</button>
                        <button className="pef-save-btn conn-accept-btn" onClick={() => connections.acceptRequest(r.reqId)}>Accept</button>
                      </div>
                    ))}
                  </div>
                )}
                <input
                  className="conn-search-input"
                  placeholder="Search all crew members..."
                  value={connSearch}
                  onChange={(e: any) => setConnSearch(e.target.value)}
                />
                {connSearch.trim().length >= 2 ? (
                  <>
                    {userSearchLoading && <div className="no-tips">Searching…</div>}
                    {!userSearchLoading && userSearchResults?.length === 0 && <div className="no-tips">No crew members found for "{connSearch.trim()}".</div>}
                    {!userSearchLoading && userSearchResults?.map((r: any) => (
                      <div key={r.userId} className="connection-card">
                        <button className="crew-av crew-av-btn" onClick={() => onCrewClick && onCrewClick({ name: r.name, role: r.role, authorId: r.userId })}>{r.name[0]}</button>
                        <div className="connection-info" style={{cursor:"pointer"}} onClick={() => onCrewClick && onCrewClick({ name: r.name, role: r.role, authorId: r.userId })}>
                          <div className="crew-card-name crew-card-name-link">{r.name}</div>
                          <div className="crew-card-role">{r.role}</div>
                        </div>
                        <ConnectButton authorId={r.userId} connections={connections} className="connect-btn" />
                      </div>
                    ))}
                  </>
                ) : (
                  <>
                    {connections.accepted.length === 0 && connections.outgoing.length === 0 && connections.incoming.length === 0
                      ? <div className="no-tips">No connections yet — search above, or tap Connect on a crew tip to add someone.</div>
                      : connections.accepted.map((r: any) => (
                          <div key={r.reqId} className="connection-card">
                            <button className="crew-av crew-av-btn" onClick={() => onCrewClick && onCrewClick({ name: r.name, role: r.role, authorId: r.userId })}>{r.name[0]}</button>
                            <div className="connection-info" style={{cursor:"pointer"}} onClick={() => onCrewClick && onCrewClick({ name: r.name, role: r.role, authorId: r.userId })}>
                              <div className="crew-card-name crew-card-name-link">{r.name}</div>
                              <div className="crew-card-role">{r.role}</div>
                            </div>
                            <button className="disconnect-btn" onClick={() => connections.declineRequest(r.reqId)}>Remove</button>
                          </div>
                        ))
                    }
                    {connections.outgoing.length > 0 && (
                      <>
                        <div className="conn-requests-label" style={{marginTop:18}}>Pending — waiting for them to accept</div>
                        {connections.outgoing.map((r: any) => (
                          <div key={r.reqId} className="connection-card">
                            <button className="crew-av crew-av-btn" onClick={() => onCrewClick && onCrewClick({ name: r.name, role: r.role, authorId: r.userId })}>{r.name[0]}</button>
                            <div className="connection-info" style={{cursor:"pointer"}} onClick={() => onCrewClick && onCrewClick({ name: r.name, role: r.role, authorId: r.userId })}>
                              <div className="crew-card-name crew-card-name-link">{r.name}</div>
                              <div className="crew-card-role">{r.role}</div>
                            </div>
                            <button className="disconnect-btn" onClick={() => connections.declineRequest(r.reqId)}>Cancel</button>
                          </div>
                        ))}
                      </>
                    )}
                  </>
                )}
              </>
            )}
            {tab === "account" && <AccountSection />}
          </div>
        </>
      )}
      <div style={{textAlign:"center",padding:"16px 0",fontSize:12,color:"var(--text3)"}}>Version {APP_VERSION}</div>
    </div>
  );
}

// ─── DESTINATIONS MENU ────────────────────────────────────────────────────────
function CrewProfileScreen({ crew, onBack, connections, addedTips }) {
  const allTips = [
    ...Object.values(DESTINATIONS as any).flatMap((dest: any) =>
      (dest.crewTips || []).filter((t: any) => t.name === crew.name).map((t: any) => ({ ...t, destCity: dest.city, destFlag: dest.flag }))
    ),
    ...Object.entries(addedTips as Record<string, any[]>).flatMap(([code, tips]) =>
      tips.filter((t: any) => t.name === crew.name).map((t: any) => ({ ...t, destCity: (DESTINATIONS as any)[code]?.city || code, destFlag: (DESTINATIONS as any)[code]?.flag || "" }))
    ),
  ];
  const totalLikes = allTips.reduce((s, t) => s + (t.likes || 0), 0);
  const initials = crew.name.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div className="screen">
      <div className="screen-topbar">
        <button className="back-btn-flat" onClick={onBack}><Icon name="back" size={18} />Back</button>
        <div className="screen-topbar-title">Crew Profile</div>
      </div>
      <div className="profile-hero">
        <div className="profile-av profile-av-large">{initials}</div>
        <div className="profile-name">{crew.name}</div>
        <div className="profile-role">{crew.role}</div>
        <ConnectButton authorId={crew.authorId} connections={connections} className="crew-connect-btn" />
      </div>
      <div className="stats-row">
        {[[String(allTips.length), "Tips Posted"], [String(totalLikes), "Likes Received"]].map(([v, l]) => (
          <div key={l} className="stat-box"><div className="stat-val">{v}</div><div className="stat-lbl">{l}</div></div>
        ))}
      </div>
      <div className="content-pad">
        {allTips.length === 0
          ? <div className="no-tips">No tips posted yet.</div>
          : allTips.map((t, i) => {
              const cat = CATEGORIES.find(c => c.id === t.category);
              return (
                <div key={i} className="my-tip-card">
                  <div className="my-tip-meta"><CategoryIcon id={t.category || "other"} color={cat?.color} size={15} />{t.destCity} · {cat?.label || t.category}</div>
                  <TipText text={t.text} className="my-tip-text" />
                  <div className="my-tip-likes"><Icon name="heart" size={14} />{t.likes || 0}</div>
                </div>
              );
            })
        }
      </div>
    </div>
  );
}

function DestinationsMenu({ onClose, onSelect, selectedDest }) {
  const [openContinent, setOpenContinent] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const allDests = Object.values(DESTINATIONS) as any[];
  const groups = groupDestsByContinentCountry(allDests);
  const q = query.trim().toLowerCase();
  const searchResults = q.length === 0 ? null : allDests
    .filter(d => d.city.toLowerCase().includes(q) || d.country.toLowerCase().includes(q) || d.code.toLowerCase() === q)
    .sort((a, b) => {
      const aStarts = a.city.toLowerCase().startsWith(q) ? 0 : 1;
      const bStarts = b.city.toLowerCase().startsWith(q) ? 0 : 1;
      return aStarts - bStarts || a.city.localeCompare(b.city);
    });
  return (
    <div className="cat-menu-backdrop" onClick={onClose}>
      <div className="cat-menu-sheet dest-sheet" onClick={e => e.stopPropagation()}>
        <div className="cat-menu-handle" />
        <div className="cat-menu-title">All Destinations</div>
        <div className="cat-menu-dest">{allDests.length} destinations · KLM &amp; KLM Cityhopper network</div>
        <div className="dest-search-row">
          <input className="dest-search-inp" placeholder="Search city, country or code…"
            value={query} onChange={e => setQuery(e.target.value)} autoComplete="off" />
          {query && <button className="dest-search-clear" onClick={() => setQuery("")} aria-label="Clear"><Icon name="close" size={16} /></button>}
        </div>
        {searchResults && (
          <div className="dest-continent-list">
            {searchResults.length === 0
              ? <div className="no-tips" style={{ padding: "0 16px" }}>No destinations match "{query}".</div>
              : <div className="dest-list-inner">
                  {searchResults.map((d: any) => (
                    <button key={d.code}
                      className={`dest-list-item${selectedDest === d.code ? " active" : ""}`}
                      onClick={() => { onSelect(d.code); onClose(); }}>
                      <div className="dli-text">
                        <span className="dli-city"><Flag emoji={d.flag} />{d.city}</span>
                        <span className="dli-sub">{d.country}</span>
                      </div>
                      <span className="dli-code">{d.code}</span>
                      {selectedDest === d.code && <span className="dli-tick"><Icon name="check" size={16} strokeWidth={2.2} /></span>}
                    </button>
                  ))}
                </div>
            }
          </div>
        )}
        {!searchResults && (
        <div className="dest-continent-list">
          {groups.map(group => {
            const isOpen = openContinent === group.continent;
            return (
              <div key={group.continent} className="continent-block">
                <button className={`continent-header${isOpen ? " open" : ""}`}
                  onClick={() => setOpenContinent(isOpen ? null : group.continent)}>
                  <span className="continent-dot" style={{background: group.color}} />
                  <span className="continent-label">{group.continent}</span>
                  <span className="continent-count">{group.count}</span>
                  <span className="continent-chevron"><Icon name={isOpen ? "chevronUp" : "chevronDown"} size={18} /></span>
                </button>
                {isOpen && (
                  <div className="dest-list-inner">
                    {group.countries.map((c: any) => (
                      <div key={c.country} className="country-group">
                        <div className="country-header">
                          <Flag emoji={c.flag} />
                          <span className="country-name">{c.country}</span>
                        </div>
                        {c.dests.map((d: any) => (
                          <button key={d.code}
                            className={`dest-list-item no-flag${selectedDest === d.code ? " active" : ""}`}
                            onClick={() => { onSelect(d.code); onClose(); }}>
                            <div className="dli-text">
                              <span className="dli-city">{d.city}</span>
                            </div>
                            <span className="dli-code">{d.code}</span>
                            {selectedDest === d.code && <span className="dli-tick"><Icon name="check" size={16} strokeWidth={2.2} /></span>}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        )}
      </div>
    </div>
  );
}

// ─── CATEGORY MENU ─────────────────────────────────────────────────────────────
function CategoryMenu({ onClose, activeCategory, onSelectCategory, addedTips, tips, title, subtitle }: {
  onClose: () => void; activeCategory: string; onSelectCategory: (id: string) => void;
  addedTips?: Record<string, any[]>; tips?: any[]; title?: string; subtitle?: string;
}) {
  return (
    <div className="cat-menu-backdrop" onClick={onClose}>
      <div className="cat-menu-sheet" onClick={e => e.stopPropagation()}>
        <div className="cat-menu-handle" />
        <div className="cat-menu-title">{title || "Browse by Category"}</div>
        <div className="cat-menu-dest">{subtitle || "Latest tips across every destination"}</div>
        <div className="cat-menu-list">
          {CATEGORIES.map(cat => {
            const count = tips
              ? tips.filter((t: any) => t.category === cat.id).length
              : (Object.values(DESTINATIONS) as any[]).reduce(
                  (sum, d) => sum + [...(d.crewTips || []), ...(((addedTips || {})[d.code]) || [])].filter((t: any) => t.category === cat.id).length,
                  0
                );
            const isActive = activeCategory === cat.id;
            return (
              <button key={cat.id}
                className={`cat-menu-item${isActive ? " active" : ""}`}
                onClick={() => { onSelectCategory(cat.id); onClose(); }}
              >
                <span className="cat-menu-icon"><CategoryIcon id={cat.id} color={cat.color} size={22} /></span>
                <span className="cat-menu-label">{cat.label}</span>
                {count > 0 && <span className="cat-menu-badge">{count} crew tips</span>}
                {isActive && <span className="cat-menu-tick"><Icon name="check" size={18} strokeWidth={2.2} /></span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── CATEGORY FEED ─────────────────────────────────────────────────────────────
function CategoryFeedScreen({ category, addedTips, onBack, onDestClick, onTipClick }) {
  const cat = CATEGORIES.find(c => c.id === category);
  const [filterJetlag, setFilterJetlag] = useState(false);
  const [filterSolo, setFilterSolo] = useState(false);
  const [filterQuickBite, setFilterQuickBite] = useState(false);
  const isFood = category === "food";
  const results: Array<{ tip: any; destCode: string; destCity: string }> = [];
  for (const dest of Object.values(DESTINATIONS) as any[]) {
    const allTips = [...(dest.crewTips || []), ...((addedTips[dest.code]) || [])];
    for (const tip of allTips) {
      if (tip.category === category) results.push({ tip, destCode: dest.code, destCity: dest.city });
    }
  }
  results.sort((a, b) => (b.tip.date || "").localeCompare(a.tip.date || ""));
  const filteredResults = results
    .filter(r => !isFood || !filterJetlag || r.tip.jetlagProof)
    .filter(r => !isFood || !filterSolo || r.tip.soloFriendly)
    .filter(r => !isFood || !filterQuickBite || r.tip.quickBite);

  return (
    <div className="screen">
      <div className="screen-topbar">
        <button className="back-btn-flat" onClick={onBack}><Icon name="back" size={18} />Back</button>
        <div className="screen-topbar-title"><CategoryIcon id={cat?.id || "other"} color={cat?.color} size={18} />{cat?.label}</div>
      </div>
      <div className="content-pad">
        <div className="search-results-meta">{filteredResults.length} recent tip{filteredResults.length !== 1 ? "s" : ""}, every destination mixed together</div>
        {isFood && (
          <div className="sort-filter-bar crew-filter-bar">
            <button className={`sf-btn${filterJetlag ? " active" : ""}`} onClick={() => setFilterJetlag(v => !v)}><Icon name="moon" size={14} />Jetlag proof</button>
            <button className={`sf-btn${filterSolo ? " active" : ""}`} onClick={() => setFilterSolo(v => !v)}><Icon name="user" size={14} />Solo friendly</button>
            <button className={`sf-btn${filterQuickBite ? " active" : ""}`} onClick={() => setFilterQuickBite(v => !v)}><Icon name="bolt" size={14} />Quick bite</button>
          </div>
        )}
        {filteredResults.length === 0
          ? <div className="no-tips">No {cat?.label.toLowerCase()} tips match yet. Try different filters.</div>
          : filteredResults.map((r, i) => (
            <div key={i} className="search-result-item">
              <button className="search-result-dest" onClick={() => onDestClick(r.destCode)}>
                <Flag emoji={(DESTINATIONS as any)[r.destCode]?.flag} />{r.destCity} · {r.destCode}
              </button>
              <button className="crew-card search-result-card" onClick={() => onTipClick(r.destCode, r.tip.id, r.tip.category)}>
                <div className="crew-card-top">
                  <div className="crew-av">{r.tip.name?.[0]}</div>
                  <div>
                    <div className="crew-card-name">{r.tip.name}</div>
                    <div className="crew-card-role">{r.tip.role}</div>
                  </div>
                  <div className="crew-card-date">{r.tip.date}</div>
                </div>
                <TipText text={r.tip.text} className="crew-card-text" />
                {r.tip.tags && r.tip.tags.length > 0 && (
                  <div className="tip-tags-row">{r.tip.tags.map((tag: string, ti: number) => <span key={ti} className="tip-tag">#{tag}</span>)}</div>
                )}
                {((isFood && (r.tip.jetlagProof || r.tip.soloFriendly || r.tip.quickBite)) || r.tip.visibility === "connections") && (
                  <div className="tip-meta-row">
                    {isFood && r.tip.jetlagProof && <span className="tip-jetlag-badge"><Icon name="moon" size={13} />Jetlag proof</span>}
                    {isFood && r.tip.soloFriendly && <span className="tip-solo-badge"><Icon name="user" size={13} />Solo friendly</span>}
                    {isFood && r.tip.quickBite && <span className="tip-quickbite-badge"><Icon name="bolt" size={13} />Quick bite</span>}
                    {r.tip.visibility === "connections" && <span className="tip-private-badge"><Icon name="lock" size={13} />Connections only</span>}
                  </div>
                )}
                <div className="search-result-cta">View recommendation<Icon name="chevronRight" size={14} strokeWidth={2.2} /></div>
              </button>
            </div>
          ))
        }
      </div>
    </div>
  );
}

// ─── SEARCH RESULTS ────────────────────────────────────────────────────────────
function SearchResultsScreen({ query, addedTips, onDestClick, onBack, onTipClick }) {
  const words = query.trim().split(/\s+/);
  const destFilter = words.find(w => (DESTINATIONS as any)[w.toUpperCase()])?.toUpperCase() || null;
  const keywords = words.filter(w => !(DESTINATIONS as any)[w.toUpperCase()]).map(w => w.toLowerCase().replace(/^#/, ""));

  const results: Array<{ tip: any; destCode: string; destCity: string }> = [];
  const dests = destFilter ? [(DESTINATIONS as any)[destFilter]] : Object.values(DESTINATIONS);

  for (const dest of dests as any[]) {
    const allTips = [...(dest.crewTips || []), ...((addedTips[dest.code]) || [])];
    for (const tip of allTips) {
      if (keywords.length === 0) { results.push({ tip, destCode: dest.code, destCity: dest.city }); continue; }
      const haystack = [tip.text, tip.name, tip.category, ...(tip.tags || [])].join(" ").toLowerCase();
      if (keywords.every((kw: string) => haystack.includes(kw))) results.push({ tip, destCode: dest.code, destCity: dest.city });
    }
    if (keywords.length > 0) {
      for (const [catId, cat] of Object.entries(dest.categories || {})) {
        for (const tipText of (cat as any).tips || []) {
          if (keywords.every((kw: string) => tipText.toLowerCase().includes(kw)))
            results.push({ tip: { id: `${dest.code}-${catId}-${tipText.slice(0,15)}`, text: tipText, category: catId, name: "WingTips Guide", role: "Editorial", date: "", likes: 0, comments: [] }, destCode: dest.code, destCity: dest.city });
        }
      }
    }
  }

  return (
    <div className="screen">
      <div className="screen-topbar">
        <button className="back-btn-flat" onClick={onBack}><Icon name="back" size={18} />Back</button>
        <div className="screen-topbar-title">Search results</div>
      </div>
      <div className="content-pad">
        <div className="search-results-meta">{results.length} result{results.length !== 1 ? "s" : ""} for <em>"{query}"</em></div>
        {results.length === 0
          ? <div className="no-tips">No recommendations found. Try different keywords.</div>
          : results.map((r, i) => (
            <div key={i} className="search-result-item">
              <button className="search-result-dest" onClick={() => onDestClick(r.destCode)}>
                <Flag emoji={(DESTINATIONS as any)[r.destCode]?.flag} />{r.destCity} · {r.destCode}
              </button>
              <button className="crew-card search-result-card" onClick={() => onTipClick(r.destCode, r.tip.id, r.tip.category)}>
                <div className="tip-cat-line"><CategoryIcon id={r.tip.category || "other"} color={CATEGORIES.find(c => c.id === r.tip.category)?.color} size={15} />{CATEGORIES.find(c => c.id === r.tip.category)?.label || r.tip.category}</div>
                <TipText text={r.tip.text} className="crew-card-text" />
                {r.tip.tags && r.tip.tags.length > 0 && (
                  <div className="tip-tags-row">{r.tip.tags.map((tag: string, ti: number) => <span key={ti} className="tip-tag">#{tag}</span>)}</div>
                )}
                <div className="search-result-cta">View recommendation<Icon name="chevronRight" size={14} strokeWidth={2.2} /></div>
              </button>
            </div>
          ))
        }
      </div>
    </div>
  );
}

// ─── LANDING ───────────────────────────────────────────────────────────────────
function LandingScreen({ onGetStarted, onSignIn }: { onGetStarted: () => void; onSignIn: () => void }) {
  const destCount = Object.keys(DESTINATIONS).length;
  return (
    <div className="landing-screen">
      <div className="landing-hero">
        <div className="landing-logo">Wing<span>Tips</span></div>
        <div className="landing-badge">KLM crew only</div>
        <h1 className="landing-headline">Know before you land.</h1>
        <p className="landing-sub">The layover guide written by crew, for crew — {destCount} destinations, zero guesswork.</p>
        <button className="landing-cta" onClick={onGetStarted}>Get started — it's free</button>
        <button className="landing-signin-link" onClick={onSignIn}>Already have an account? Sign in</button>
      </div>

      <div className="landing-features">
        <div className="landing-feature">
          <div className="landing-feature-icon"><Icon name="globe" size={24} /></div>
          <div className="landing-feature-title">{destCount} destinations, and counting</div>
          <div className="landing-feature-text">From Aberdeen to Tokyo — crew hotel rates, local weather, and exactly how many hours you've got on the ground.</div>
        </div>
        <div className="landing-feature">
          <div className="landing-feature-icon"><CategoryIcon id="food" size={24} /></div>
          <div className="landing-feature-title">Tips you can actually trust</div>
          <div className="landing-feature-text">Food, fitness, beauty, wellness and shopping — recommended by colleagues who were really there, not a travel blog.</div>
        </div>
        <div className="landing-feature">
          <div className="landing-feature-icon"><Icon name="users" size={24} /></div>
          <div className="landing-feature-title">Connect with crew</div>
          <div className="landing-feature-text">Save contacts, see who's been where, and build your own layover network.</div>
        </div>
      </div>

      <div className="landing-footer">
        <div className="landing-footer-text">Only for KLM employees — sign up with your @klm.com address.</div>
      </div>
    </div>
  );
}

// ─── AUTH ──────────────────────────────────────────────────────────────────────
function AuthScreen({ initialTab = "signin", onBack }: { initialTab?: "signin" | "signup"; onBack?: () => void }) {
  const [tab, setTab] = useState<"signin" | "signup">(initialTab);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [verifyScreen, setVerifyScreen] = useState(false);
  const [forgotScreen, setForgotScreen] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);

  async function handleSignUp() {
    setError("");
    if (!email.toLowerCase().endsWith("@klm.com")) { setError("Only @klm.com email addresses are allowed."); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (password !== confirm) { setError("Passwords do not match."); return; }
    setLoading(true);
    const { error: err } = await supabase.auth.signUp({ email, password });
    if (err) setError(err.message);
    else setVerifyScreen(true);
    setLoading(false);
  }

  async function handleSignIn() {
    setError("");
    setLoading(true);
    const { error: err } = await supabase.auth.signInWithPassword({ email, password });
    if (err) setError(err.message);
    setLoading(false);
  }

  async function resendVerification() {
    const { error: err } = await supabase.auth.resend({ type: "signup", email });
    setError(err ? err.message : "Verification email resent.");
  }

  async function handleForgotPassword() {
    setError("");
    if (!email) { setError("Enter your e-mail above first."); return; }
    setLoading(true);
    const { error: err } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
    setLoading(false);
    if (err) setError(err.message); else setForgotSent(true);
  }

  if (forgotScreen) return (
    <div className="app-shell">
      <div className="auth-screen">
        <div className="auth-logo">Wing<span>Tips</span></div>
        {forgotSent ? (
          <>
            <div className="auth-verify-icon"><Icon name="mail" size={48} color="var(--accent)" strokeWidth={1.6} /></div>
            <div className="auth-title">Check your inbox</div>
            <div className="auth-subtitle">If an account exists for <strong>{email}</strong>, a reset link is on its way.</div>
          </>
        ) : (
          <>
            <div className="auth-title">Reset your password</div>
            <div className="auth-subtitle">Enter your @klm.com address and we'll send you a reset link.</div>
            <div className="auth-form">
              <input className="auth-input" type="email" placeholder="your.name@klm.com" value={email} onChange={(e: any) => setEmail(e.target.value)} />
              {error && <div className="auth-error">{error}</div>}
              <button className="auth-btn" onClick={handleForgotPassword} disabled={loading}>{loading ? "Please wait…" : "Send reset link"}</button>
            </div>
          </>
        )}
        <button className="auth-link-btn" onClick={() => { setForgotScreen(false); setForgotSent(false); setError(""); }}>Back to sign in</button>
      </div>
    </div>
  );

  if (verifyScreen) return (
    <div className="app-shell">
      <div className="auth-screen">
        <div className="auth-logo">Wing<span>Tips</span></div>
        <div className="auth-verify-icon"><Icon name="mail" size={48} color="var(--accent)" strokeWidth={1.6} /></div>
        <div className="auth-title">Check your inbox</div>
        <div className="auth-subtitle">We sent a verification link to <strong>{email}</strong>. Click it to activate your account, then come back and sign in.</div>
        <button className="auth-link-btn" onClick={resendVerification}>Resend email</button>
        <button className="auth-link-btn" onClick={() => { setVerifyScreen(false); setTab("signin"); }}>Back to sign in</button>
        {error && <div className="auth-error">{error}</div>}
      </div>
    </div>
  );

  return (
    <div className="app-shell">
      <div className="auth-screen">
        {onBack && <button className="auth-back-btn" onClick={onBack}><Icon name="back" size={18} />Back</button>}
        <div className="auth-logo">Wing<span>Tips</span></div>
        <div className="auth-title">{tab === "signin" ? "Welcome back" : "Create account"}</div>
        <div className="auth-subtitle">KLM crew only — use your @klm.com address</div>
        <div className="auth-tabs">
          <button className={`auth-tab${tab === "signin" ? " active" : ""}`} onClick={() => { setTab("signin"); setError(""); }}>Sign in</button>
          <button className={`auth-tab${tab === "signup" ? " active" : ""}`} onClick={() => { setTab("signup"); setError(""); }}>Sign up</button>
        </div>
        <div className="auth-form">
          <input className="auth-input" type="email" placeholder="your.name@klm.com" value={email} onChange={(e: any) => setEmail(e.target.value)} />
          <input className="auth-input" type="password" placeholder="Password" value={password} onChange={(e: any) => setPassword(e.target.value)} />
          {tab === "signup" && <input className="auth-input" type="password" placeholder="Confirm password" value={confirm} onChange={(e: any) => setConfirm(e.target.value)} />}
          {error && <div className="auth-error">{error}</div>}
          <button className="auth-btn" onClick={tab === "signin" ? handleSignIn : handleSignUp} disabled={loading}>
            {loading ? "Please wait…" : tab === "signin" ? "Sign in" : "Create account"}
          </button>
          {tab === "signin" && <button type="button" className="auth-link-btn" onClick={() => { setForgotScreen(true); setError(""); }}>Forgot password?</button>}
        </div>
      </div>
    </div>
  );
}

function ResetPasswordScreen({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSave() {
    setError("");
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (password !== confirm) { setError("Passwords do not match."); return; }
    setLoading(true);
    const { error: err } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (err) { setError(err.message); return; }
    try { window.history.replaceState(null, "", window.location.pathname + window.location.search); } catch {}
    onDone();
  }

  return (
    <div className="app-shell">
      <div className="auth-screen">
        <div className="auth-logo">Wing<span>Tips</span></div>
        <div className="auth-title">Set a new password</div>
        <div className="auth-subtitle">Choose a new password for your account.</div>
        <div className="auth-form">
          <input className="auth-input" type="password" placeholder="New password" value={password} onChange={(e: any) => setPassword(e.target.value)} />
          <input className="auth-input" type="password" placeholder="Confirm new password" value={confirm} onChange={(e: any) => setConfirm(e.target.value)} />
          {error && <div className="auth-error">{error}</div>}
          <button className="auth-btn" onClick={handleSave} disabled={loading}>{loading ? "Please wait…" : "Save password"}</button>
        </div>
      </div>
    </div>
  );
}

// ─── MAIN APP ──────────────────────────────────────────────────────────────────
export default function WingTipsApp() {
  const [authUser, setAuthUser] = useState<any>("loading");
  const [authView, setAuthView] = useState<"landing" | "signin" | "signup">("landing");
  const [showResetPassword, setShowResetPassword] = useState(AUTH_HASH_TYPE === "recovery");
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setAuthUser(data.session?.user ?? null));
    // PASSWORD_RECOVERY fires whenever a session was established from a reset-password link,
    // regardless of whether Supabase used the older hash-based flow (#access_token=...&type=
    // recovery, what AUTH_HASH_TYPE checks for) or the newer default PKCE flow (?code=...,
    // which carries no such hash) -- this is the flow-agnostic way to catch both.
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      setAuthUser(session?.user ?? null);
      if (event === "PASSWORD_RECOVERY") setShowResetPassword(true);
    });
    return () => listener.subscription.unsubscribe();
  }, []);
  if (authUser === "loading") return <div className="app-shell"><div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",color:"var(--accent)"}}><Icon name="loader" size={28} className="spin" /></div></div>;
  if (showResetPassword && authUser) return <ResetPasswordScreen onDone={() => setShowResetPassword(false)} />;
  if (!authUser) {
    if (authView === "landing") return <LandingScreen onGetStarted={() => setAuthView("signup")} onSignIn={() => setAuthView("signin")} />;
    return <AuthScreen initialTab={authView} onBack={() => setAuthView("landing")} />;
  }
  return <AppContent />;
}

function AppContent() {
  const [screen, setScreen] = useState("home");
  const [selectedDest, setSelectedDest] = useState(null);
  const [addTipContext, setAddTipContext] = useState({ code: null, category: null });
  const [activeCategory, setActiveCategory] = useState("food");
  const [focusTipId, setFocusTipId] = useState<string | number | null>(null);
  const [selectedCrew, setSelectedCrew] = useState<{ name: string; role: string; authorId?: string } | null>(null);
  const [showCatMenu, setShowCatMenu] = useState(false);
  const [showDestMenu, setShowDestMenu] = useState(false);
  const topNavRef = useRef<HTMLDivElement | null>(null);
  const { notes: notifications, markAllRead } = useNotifications();
  const {
    loaded: profileLoaded, userId, userEmail, profile, updateProfile,
    recentDests, visitDest,
    favorites, toggleFavorite, unseenFavorites, markFavoritesSeen,
    reload: reloadProfile,
  } = useCloudProfile();
  const adminSignups = useAdminSignups(userEmail);
  const unreadCount = notifications.filter(n => !n.read).length + adminSignups.unseenCount;
  const connections = useConnections(userId);
  const { byDest: addedTips, loaded: recsLoaded, addRecommendation, toggleLike, addComment, reload: reloadRecs } = useRecommendations();

  useEffect(() => {
    if (!profileLoaded || !recsLoaded || !userId) return;
    if (localStorage.getItem("wt_migrated_to_cloud")) return;
    (async () => {
      const migrated = await migrateLocalDataToCloud(userId, profile);
      localStorage.setItem("wt_migrated_to_cloud", "1");
      if (migrated) { await Promise.all([reloadProfile(), reloadRecs()]); }
    })();
  }, [profileLoaded, recsLoaded, userId]);

  useEffect(() => {
    if (screen === "dest" && selectedDest) visitDest(selectedDest);
  }, [screen, selectedDest]);

  useEffect(() => {
    if (screen === "favorites") markFavoritesSeen();
  }, [screen]);
  const [searchQuery, setSearchQuery] = useState("");

  async function handleRecommendationSubmitted(code: string, tip: any) {
    const saved = await addRecommendation(code, tip, profile);
    if (!saved) return false;
    setSelectedDest(code);
    setScreen("dest");
    return true;
  }

  function handleSearch(q: string) {
    const trimmed = q.trim();
    if (!trimmed) return;
    const words = trimmed.split(/\s+/);
    const destCodes = words.filter((w: string) => (DESTINATIONS as any)[w.toUpperCase()]);
    const keywords = words.filter((w: string) => !(DESTINATIONS as any)[w.toUpperCase()]);
    if (destCodes.length === 1 && keywords.length === 0) { setSelectedDest(destCodes[0].toUpperCase()); setScreen("dest"); return; }
    if (destCodes.length === 0 && keywords.length > 0) {
      const cityMatch = (Object.values(DESTINATIONS) as any[]).find(d => d.city.toLowerCase().includes(trimmed.toLowerCase()));
      if (cityMatch) { setSelectedDest(cityMatch.code); setScreen("dest"); return; }
    }
    setSearchQuery(trimmed);
    setScreen("search");
  }

  function handleAddTip(code, category) { setSelectedDest(code); setAddTipContext({ code, category }); setScreen("addrecommendation"); }

  // The Categories/Explore sheet and the map overlay both need to stop short of the top nav
  // instead of covering it -- a guessed pixel height (first try: 56px) came up a few pixels
  // short of the real thing and still clipped it on an iPhone. Measuring the actual rendered
  // height here and feeding it back in as a CSS variable is exact regardless of device/font
  // rendering, and self-corrects if the nav's own content or padding ever changes.
  useEffect(() => {
    function measure() {
      if (topNavRef.current) document.documentElement.style.setProperty("--topnav-h", `${topNavRef.current.offsetHeight}px`);
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [profileLoaded, recsLoaded]);

  if (!profileLoaded || !recsLoaded) {
    return <div className="app-shell"><div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",color:"var(--accent)"}}><Icon name="loader" size={28} className="spin" /></div></div>;
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", flexDirection: "column", color: "var(--text)", maxWidth: 480, margin: "0 auto", position: "relative" }}>
      {/* TOP NAV */}
      <div className="top-nav" ref={topNavRef}>
        <button className="nav-title" onClick={() => { setScreen("home"); setShowCatMenu(false); setShowDestMenu(false); }}>Wing<span>Tips</span></button>
        <div className="nav-right">
          <button className="nav-icon-btn" aria-label="Notifications" onClick={() => { setScreen("notifications"); setShowCatMenu(false); setShowDestMenu(false); }}>
            <Icon name="bell" size={20} />
            {unreadCount > 0 && <div className="notif-badge">{unreadCount}</div>}
          </button>
          <button className="nav-icon-btn" aria-label="Profile" onClick={() => { setScreen("profile"); setShowCatMenu(false); setShowDestMenu(false); }}>
            <div className="nav-avatar">{profile.name ? profile.name.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase() : "?"}</div>
          </button>
          <button className="nav-icon-btn" aria-label="Log out" onClick={() => { if (confirm("Log out?")) supabase.auth.signOut(); }}>
            <Icon name="logout" size={19} />
          </button>
        </div>
      </div>

      {/* SCREENS -- wrapped in its own flex:1 + position:relative box so the slide-up
          menus below can be position:absolute;inset:0 within exactly the space between
          the top and bottom nav, the same way DestScreen's own .map-overlay is bounded
          by .screen -- instead of position:fixed with a guessed/measured viewport offset. */}
      <div style={{ position: "relative", flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        {screen === "home"          && <HomeScreen onSearch={handleSearch} onDestClick={code => { setSelectedDest(code); setScreen("dest"); }} addedTips={addedTips} recentDests={recentDests} />}
        {screen === "dest"          && selectedDest && <DestScreen key={selectedDest + (addedTips[selectedDest]?.length || 0)} code={selectedDest} onBack={() => setScreen("home")} onAddTip={handleAddTip} activeCategory={activeCategory} setActiveCategory={setActiveCategory} connections={connections} favorites={favorites} onToggleFavorite={toggleFavorite} extraTips={addedTips[selectedDest] || []} focusTipId={focusTipId} onFocusConsumed={() => setFocusTipId(null)} onCrewClick={(crew: any) => { setSelectedCrew(crew); setScreen("crewprofile"); }} onToggleLike={toggleLike} onAddComment={addComment} />}
        {screen === "addrecommendation" && <AddRecommendationScreen onBack={() => addTipContext.code ? setScreen("dest") : setScreen("home")} selectedDest={selectedDest} onSubmit={handleRecommendationSubmitted} profile={profile} defaultCategory={addTipContext.category} />}
        {screen === "search"        && <SearchResultsScreen query={searchQuery} addedTips={addedTips} onDestClick={(code: string) => { setSelectedDest(code); setScreen("dest"); }} onBack={() => setScreen("home")} onTipClick={(code: string, tipId: any, category: string) => { setSelectedDest(code); setActiveCategory(category); setFocusTipId(tipId); setScreen("dest"); }} />}
        {screen === "categoryfeed"  && <CategoryFeedScreen category={activeCategory} addedTips={addedTips} onBack={() => setScreen("home")} onDestClick={(code: string) => { setSelectedDest(code); setScreen("dest"); }} onTipClick={(code: string, tipId: any, category: string) => { setSelectedDest(code); setActiveCategory(category); setFocusTipId(tipId); setScreen("dest"); }} />}
        {screen === "notifications" && <NotificationsScreen onBack={() => setScreen("home")} notes={notifications} onMarkAllRead={markAllRead} adminSignups={adminSignups} onNotificationClick={(n: any) => { setSelectedDest(n.destCode); if (n.category) setActiveCategory(n.category); if (n.tipId != null) setFocusTipId(n.tipId); setScreen("dest"); }} />}
        {screen === "favorites"     && <FavoritesScreen onBack={() => setScreen("home")} favorites={favorites} onToggleFavorite={toggleFavorite} onDestClick={(code: string) => { setSelectedDest(code); setScreen("dest"); }} addedTips={addedTips} />}
        {screen === "profile"       && <ProfileScreen onBack={() => setScreen("home")} connections={connections} addedTips={addedTips} profile={profile} updateProfile={updateProfile} onCrewClick={(crew: any) => { setSelectedCrew(crew); setScreen("crewprofile"); }} />}
        {screen === "crewprofile"   && selectedCrew && <CrewProfileScreen crew={selectedCrew} onBack={() => setScreen("dest")} connections={connections} addedTips={addedTips} />}

        {/* DESTINATIONS SLIDE-UP MENU */}
        {showDestMenu && (
          <DestinationsMenu
            onClose={() => setShowDestMenu(false)}
            onSelect={code => { setSelectedDest(code); setScreen("dest"); }}
            selectedDest={selectedDest}
          />
        )}

        {/* CATEGORY SLIDE-UP MENU */}
        {showCatMenu && (
          <CategoryMenu
            onClose={() => setShowCatMenu(false)}
            activeCategory={activeCategory}
            addedTips={addedTips}
            onSelectCategory={(catId: string) => { setActiveCategory(catId); setScreen("categoryfeed"); }}
          />
        )}
      </div>

      {/* BOTTOM NAV */}
      <nav className="bottom-nav" aria-label="Main">
        <button className={`bnav-item${screen === "home" ? " active" : ""}`} onClick={() => { setScreen("home"); setShowCatMenu(false); setShowDestMenu(false); }}>
          <Icon name="home" size={22} />Home
        </button>
        <button className={`bnav-item${showDestMenu ? " active" : ""}`} onClick={() => { setShowDestMenu(v => !v); setShowCatMenu(false); }}>
          <Icon name="compass" size={22} />Explore
        </button>
        <div className="bnav-fab-wrap">
          <button className="bnav-fab" aria-label="Add tip" onClick={() => { setAddTipContext({ code: null, category: null }); setScreen("addrecommendation"); setShowCatMenu(false); setShowDestMenu(false); }}><Icon name="plus" size={26} strokeWidth={2.2} /></button>
        </div>
        <button className={`bnav-item${showCatMenu || screen === "categoryfeed" ? " active" : ""}`} onClick={() => { setShowCatMenu(v => !v); setShowDestMenu(false); }}>
          <Icon name="grid" size={22} />Categories
        </button>
        <button className={`bnav-item${screen === "favorites" ? " active" : ""}`} onClick={() => { setScreen("favorites"); setShowCatMenu(false); setShowDestMenu(false); }}>
          <span className="bnav-icon-wrap"><Icon name="bookmark" size={22} />{unseenFavorites > 0 && <span className="bnav-badge">{unseenFavorites}</span>}</span>Saved
        </button>
      </nav>
    </div>
  );
}
