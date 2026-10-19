import { useState, useEffect, useRef } from "react";
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
const APP_VERSION = "0.12.1";

const weatherCache: Record<string, { temp: string; desc: string; ts: number }> = {};
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

function useConnections() {
  const [connections, setConnections] = useState(() => {
    try { return JSON.parse(localStorage.getItem("wt_connections") || "[]") as string[]; }
    catch { return [] as string[]; }
  });
  useEffect(() => {
    localStorage.setItem("wt_connections", JSON.stringify(connections));
  }, [connections]);
  function toggle(name: string) {
    setConnections((prev: string[]) =>
      prev.includes(name) ? prev.filter((n: string) => n !== name) : [...prev, name]
    );
  }
  return { connections, toggle };
}

function useProfile() {
  const [profile, setProfile] = useState(() => {
    try { return JSON.parse(localStorage.getItem("wt_profile") || "null") || { name: "", role: "Cabin Crew", base: "AMS", bio: "" }; }
    catch { return { name: "", role: "Cabin Crew", base: "AMS", bio: "" }; }
  });
  function updateProfile(updates: any) {
    const next = { ...profile, ...updates };
    setProfile(next);
    localStorage.setItem("wt_profile", JSON.stringify(next));
  }
  return { profile, updateProfile };
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

const CATEGORIES = [
  { id: "food",          label: "Food & Drink",    icon: "🍽️" },
  { id: "fitness",       label: "Fitness",         icon: "🏋️" },
  { id: "beauty",        label: "Beauty",          icon: "💅" },
  { id: "wellness",      label: "Wellness & Spa",  icon: "🧘" },
  { id: "shopping",      label: "Shopping",        icon: "🛍️" },
  { id: "nightlife",     label: "Nightlife",       icon: "🍸" },
  { id: "accommodation", label: "Accommodation",   icon: "🏨" },
  { id: "working",       label: "Working",         icon: "💻" },
  { id: "gems",          label: "Hidden Gems",     icon: "💎" },
  { id: "other",         label: "Other",           icon: "📌" },
];

const CONTINENT_GROUPS = [
  { id: "europe",   label: "Europe",                    color: "#4A90D9", codes: ["AMS","VIE","BRU","GVA","ZRH","CPH","ARN","OSL","HEL","WAW","PRG","BUD","BCN","MAD","LIS","FCO","MXP","LHR","MAN","BEG","LJU","ZAG","SKP","ABZ","AES","BER","BHD","BHX","BLL","BLQ","BRS","CWL","DUS","EDI","EXT","FRA","GDN","GLA","HAJ","HAM","HUY","INV","LBA","LUX","MME","NCL","NWI","ORK","POZ","SOU","SVG"] },
  { id: "namerica", label: "North America",              color: "#27AE60", codes: ["JFK","ATL","BOS","DTW","IAD","IAH","LAS","LAX","MIA","MSP","ORD","PDX","SAN","SFO","SLC","AUS","YEG","YUL","YVR","YYC","YYZ","MEX"] },
  { id: "samerica", label: "South & Central America",    color: "#2ECC71", codes: ["GRU","GIG","EZE","SCL","LIM","BOG","CTG","PTY","SJO","GYE","UIO","GEO","PBM"] },
  { id: "caribbean",label: "Caribbean",                  color: "#00BCD4", codes: ["CUR","AUA","BON","SXM","POS"] },
  { id: "asia",     label: "Asia & Pacific",             color: "#E67E22", codes: ["NRT","KIX","ICN","TPE","DXB","SIN","BKK","KUL","CGK","DPS","MNL","HKG","PVG","PEK","DEL","BOM","HYD","BLR","SYD"] },
  { id: "africa",   label: "Africa",                     color: "#F1C40F", codes: ["NBO","JNB","CPT","KGL","JRO","DAR","EBB","LOS","ACC"] },
  { id: "mideast",  label: "Middle East",                color: "#9B59B6", codes: ["RUH","DMM"] },
];

const NOTIFICATIONS: Array<{ id: number; text: string; time: string; read: boolean; destCode: string; category?: string; tipId?: number }> = [];

// ─── HOME ──────────────────────────────────────────────────────────────────────
function HomeScreen({ onSearch, onDestClick, addedTips }) {
  const [query, setQuery] = useState("");
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
            <span className="search-icon">🔍</span>
            <input className="search-field" placeholder="City or IATA code — NRT, DXB, JFK…"
              value={query} onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === "Enter" && onSearch(query)} />
            <button className="search-go" onClick={() => onSearch(query)}>→</button>
          </div>
        </div>
      </div>
      <div className="section-block">
        <div className="section-label">QUICK ACCESS</div>
        <div className="dest-row">
          {["DXB","NRT","JFK"].map(code => {
            const d = DESTINATIONS[code];
            return (
              <button key={code} className="dest-pill" onClick={() => onDestClick(code)}>
                <img className="pill-flag" src={`https://flagcdn.com/w40/${flagToCode(d.flag)}.png`} alt={d.country} />
                <div><div className="pill-city">{d.city}</div><div className="pill-code">{code}</div></div>
              </button>
            );
          })}
        </div>
      </div>
      {latestTip && (
        <div className="section-block">
          <div className="section-label">LATEST FROM THE CREW</div>
          <button className="top-tip-card" onClick={() => onDestClick(latestTip.destCode)}>
            <div className="top-tip-dest">{latestTip.destFlag} {latestTip.destCity}</div>
            <div className="top-tip-text">{latestTip.tip.text}</div>
            <div className="top-tip-author">— {latestTip.tip.name}, {latestTip.tip.role} · 👍 {latestTip.tip.likes || 0}</div>
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

function useFavorites() {
  const [favorites, setFavorites] = useState(() => {
    try { return JSON.parse(localStorage.getItem("wt_favorites") || "[]") as string[]; }
    catch { return [] as string[]; }
  });
  useEffect(() => {
    localStorage.setItem("wt_favorites", JSON.stringify(favorites));
  }, [favorites]);
  function toggle(key: string) {
    setFavorites((prev: string[]) =>
      prev.includes(key) ? prev.filter((k: string) => k !== key) : [...prev, key]
    );
  }
  return { favorites, toggle };
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

function fmtTime(utcOffset: number) {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const d = new Date(utcMs + utcOffset * 3600000);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

// ─── DESTINATION ───────────────────────────────────────────────────────────────
function DestScreen({ code, onBack, onAddTip, activeCategory, setActiveCategory, connections, onToggleConnection, favorites, onToggleFavorite, extraTips, focusTipId, onFocusConsumed, onCrewClick }) {
  const dest = DESTINATIONS[code];
  const liveWeather = useWeather(code, dest.city, dest.country);
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

  useEffect(() => {
    let cancelled = false;
    setHotelCoords(null);
    geocodeHotel(dest.crewHotel, dest.city, dest.country).then(c => { if (!cancelled) setHotelCoords(c); });
    return () => { cancelled = true; };
  }, [code]);

  useEffect(() => {
    if (!showMap) return;
    const tipsWithCoords = crewTips.filter((t: any) => t.coords);

    const initMap = async () => {
      const google = (window as any).google;
      if (!google || !mapContainerRef.current) return;
      mapInstanceRef.current = null;

      const hotelCenter = await geocodeHotel(dest.crewHotel, dest.city, dest.country);
      if (!mapContainerRef.current) return; // screen could have closed while awaiting

      let lat = 52.3676, lng = 4.9041, zoom = 14;
      if (tipsWithCoords.length > 0) {
        lat = tipsWithCoords.reduce((s: number, t: any) => s + parseFloat(t.coords.lat), 0) / tipsWithCoords.length;
        lng = tipsWithCoords.reduce((s: number, t: any) => s + parseFloat(t.coords.lon), 0) / tipsWithCoords.length;
      } else if (hotelCenter) {
        lat = hotelCenter.lat; lng = hotelCenter.lng; zoom = 14;
      } else {
        const center = await geocodeCity(dest.city, dest.country);
        if (center) { lat = center.lat; lng = center.lng; zoom = 12; }
        if (!mapContainerRef.current) return; // screen could have closed while awaiting
      }

      const map = new google.maps.Map(mapContainerRef.current, {
        center: { lat, lng }, zoom,
        mapTypeControl: false, streetViewControl: false, fullscreenControl: false,
      });

      tipsWithCoords.forEach((tip: any) => {
        const cat = CATEGORIES.find(c => c.id === tip.category);
        const marker = new google.maps.Marker({
          position: { lat: parseFloat(tip.coords.lat), lng: parseFloat(tip.coords.lon) },
          map,
          icon: { path: google.maps.SymbolPath.CIRCLE, scale: 10, fillColor: "#00A1DE", fillOpacity: 0.85, strokeColor: "#003082", strokeWeight: 2 }
        });
        const infoWindow = new google.maps.InfoWindow({
          content: `<strong>${tip.text.split("—")[0].replace("📍","").trim()}</strong><br/><span style="font-size:11px;color:#4A7C9E">${cat?.label || ""}</span>`
        });
        marker.addListener("click", () => infoWindow.open(map, marker));
      });

      if (hotelCenter) {
        const hotelMarker = new google.maps.Marker({
          position: hotelCenter,
          map,
          zIndex: 999,
          icon: { path: "M12,17.27L18.18,21L16.54,13.97L22,9.24L14.81,8.63L12,2L9.19,8.63L2,9.24L7.46,13.97L5.82,21L12,17.27Z", fillColor: "#F59E0B", fillOpacity: 1, strokeColor: "#92400E", strokeWeight: 1, scale: 1.5, anchor: new google.maps.Point(12, 12) }
        });
        const hotelInfo = new google.maps.InfoWindow({
          content: `<strong>${dest.crewHotel.replace(/\s*\([^)]*\)\s*$/, "").trim()}</strong><br/><span style="font-size:11px;color:#4A7C9E">Crew hotel</span>`
        });
        hotelMarker.addListener("click", () => hotelInfo.open(map, hotelMarker));
      }

      mapInstanceRef.current = map;
    };

    if ((window as any).google?.maps) { setTimeout(initMap, 50); return; }
    if (!document.getElementById("gmaps-js")) {
      const s = document.createElement("script"); s.id = "gmaps-js";
      s.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_KEY}`;
      s.onload = () => setTimeout(initMap, 50);
      document.head.appendChild(s);
    } else { const iv = setInterval(() => { if ((window as any).google?.maps) { clearInterval(iv); initMap(); } }, 100); }
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

  if (!dest) return <div className="screen"><button onClick={onBack}>← Back</button></div>;

  const [sortBy, setSortBy] = useState<"recent" | "liked">("recent");
  const [filterRole, setFilterRole] = useState("all");

  const tipsForCat = crewTips
    .filter(t => t.category === activeCategory)
    .filter(t => filterRole === "all" || t.role === filterRole)
    .slice()
    .sort((a, b) => sortBy === "liked"
      ? b.likes - a.likes
      : new Date(b.date).getTime() - new Date(a.date).getTime()
    );

  function handleLike(id) {
    setCrewTips(tips => tips.map(t => t.id === id ? { ...t, likes: t.likes + 1 } : t));
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
  }

  function updateCommentForm(tipId, field, value) {
    setCommentForms(f => ({ ...f, [tipId]: { ...f[tipId], [field]: value } }));
  }

  return (
    <div className="screen">
      {showMap && (
        <div className="map-overlay">
          <div className="map-header">
            <div className="map-header-title">{dest.city} — recommendations</div>
            <button className="map-close-btn" onClick={() => setShowMap(false)}>✕ Close</button>
          </div>
          {crewTips.filter((t: any) => t.coords).length === 0 && (
            <div className="map-hint-banner">No pinned recommendations yet{dest.crewHotel ? " — showing the crew hotel" : ` — showing ${dest.city}`}. Add a tip with a place name to pin it here.</div>
          )}
          <div className="map-container" ref={mapContainerRef} />
        </div>
      )}
      <div className="dest-hero">
        <button className="back-btn" onClick={onBack}>← Back</button>
        <img className="dest-flag-big" src={`https://flagcdn.com/w80/${flagToCode(dest.flag)}.png`} alt={dest.country} />
        <div className="dest-hero-name">{dest.city}</div>
        <div className="dest-hero-country">{dest.country}</div>
        {(() => {
          const offset = TZ_OFFSETS[code] ?? 0;
          const diff = offset - 2;
          const diffStr = diff === 0 ? "= AMS" : `${diff > 0 ? "+" : ""}${diff}h vs AMS`;
          return (
            <>
              <div className="dest-meta-row">
                <span className="dest-meta-chip">🌡 {liveWeather ?? dest.weather}</span>
                <span className="dest-meta-chip">🕐 {fmtTime(offset)}</span>
                <span className="dest-meta-chip">✈️ {diffStr}</span>
              </div>
              <button className="map-view-btn" onClick={() => setShowMap(true)}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{marginRight:5}}><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/><line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/></svg>
                Map view
              </button>
            </>
          );
        })()}
      </div>
      <div className="crew-hotel-bar">
        <span>🏨</span><span className="hotel-text">{dest.crewHotel}</span>
      </div>
      <div className="cat-scroll">
        {CATEGORIES.map(cat => {
          const count = crewTips.filter(t => t.category === cat.id).length;
          return (
            <button key={cat.id} className={`cat-chip${activeCategory === cat.id ? " active" : ""}`}
              onClick={() => setActiveCategory(cat.id)}>
              {cat.label}
              {count > 0 && <span className="cat-badge">{count}</span>}
            </button>
          );
        })}
      </div>
      <div className="content-pad">
        <div className="ai-panel">
          <div className="ai-panel-label">🤖 AI BRIEFING</div>
          {dest.categories[activeCategory] ? (
            <>
              <div className="ai-panel-headline">{dest.categories[activeCategory].headline}</div>
              {dest.categories[activeCategory].tips.map((tip, i) => (
                <div key={i} className="ai-tip-row">
                  <div className="ai-tip-dot" />
                  <p className="ai-tip-text">{tip}</p>
                </div>
              ))}
            </>
          ) : (
            <div className="ai-panel-headline" style={{color:"var(--text2)",fontWeight:400}}>No briefing available for this category yet.</div>
          )}
        </div>
        <div className="divider-rule" />
        <div className="crew-tips-header">
          <div className="section-label" style={{ margin: 0 }}>
            👥 FROM THE CREW
            {tipsForCat.length > 0 && <span className="section-count"> · {tipsForCat.length}</span>}
          </div>
          <button className="add-btn" onClick={() => onAddTip(code, activeCategory)}>+ Add tip</button>
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
        {tipsForCat.length === 0
          ? <div className="no-tips">No crew tips yet here. Be the first!</div>
          : tipsForCat.map(tip => {
            const isExpanded = expandedTip === tip.id;
            const form = commentForms[tip.id] || { name: "", role: "Cabin Crew", text: "" };
            return (
              <div key={tip.id} ref={(el: any) => { tipRefs.current[tip.id] = el; }} className={`crew-card${String(tip.id) === String(focusTipId) ? " crew-card-focused" : ""}`}>
                <div className="crew-card-top">
                  <button className="crew-av crew-av-btn" onClick={() => onCrewClick && onCrewClick({ name: tip.name, role: tip.role })}>{tip.name[0]}</button>
                  <div>
                    <div className="crew-card-name crew-card-name-link" onClick={() => onCrewClick && onCrewClick({ name: tip.name, role: tip.role })}>{tip.name}</div>
                    <div className="crew-card-role">{tip.role}</div>
                  </div>
                  <div className="crew-card-date">{tip.date}</div>
                </div>
                {tip.photo && <img className="tip-photo" src={tip.photo} alt="tip photo" />}
                <p className="crew-card-text">{tip.text}</p>
                {tip.tags && tip.tags.length > 0 && (
                  <div className="tip-tags-row">{tip.tags.map((tag: string, ti: number) => <span key={ti} className="tip-tag">#{tag}</span>)}</div>
                )}
                {(tip.price || tip.hours || tip.discount || (tip.coords && hotelCoords)) && (
                  <div className="tip-meta-row">
                    {tip.price && <span className="tip-price-badge">{tip.price === "Free" ? "Free" : tip.price}</span>}
                    {tip.hours && <span className="tip-hours-badge">🕐 {tip.hours}</span>}
                    {tip.discount && <span className="tip-discount-badge">✂️ {tip.discount === true ? "Crew discount" : `${tip.discount} crew`}</span>}
                    {tip.coords && hotelCoords && (
                      <span className="tip-distance-badge">🏨 {fmtDistance(distanceKm({ lat: parseFloat(tip.coords.lat), lng: parseFloat(tip.coords.lon) }, hotelCoords))} from crew hotel</span>
                    )}
                  </div>
                )}
                <div className="tip-actions">
                  <button className="like-btn" onClick={() => handleLike(tip.id)}>❤ {tip.likes}</button>
                  {(() => {
                    const url = tip.coords
                      ? `https://www.google.com/maps/search/?api=1&query=${tip.coords.lat},${tip.coords.lon}`
                      : (() => {
                          const q = tip.text.startsWith("📍")
                            ? tip.text.slice(2).split("—")[0].trim()
                            : tip.text.replace(/[^\w\s,''-]/g, " ").slice(0, 60).trim();
                          return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q + " " + dest.city)}`;
                        })();
                    return <a href={url} target="_blank" rel="noreferrer" className="maps-link">📍 Maps</a>;
                  })()}
                  <button
                    className={`comment-toggle-btn${isExpanded ? " active" : ""}`}
                    onClick={() => setExpandedTip(isExpanded ? null : tip.id)}>
                    💬 {tip.comments.length > 0 ? tip.comments.length : "Comment"}
                  </button>
                  <button
                    className={`connect-btn${connections.includes(tip.name) ? " connected" : ""}`}
                    onClick={() => onToggleConnection(tip.name)}>
                    {connections.includes(tip.name) ? "✓ Connected" : "+ Connect"}
                  </button>
                  <button
                    className={`fav-btn${favorites.includes(`${code}-${tip.id}`) ? " saved" : ""}`}
                    onClick={() => onToggleFavorite(`${code}-${tip.id}`)}>
                    {favorites.includes(`${code}-${tip.id}`) ? "★" : "☆"}
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
                          ↑
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
  const destsByContinentCountry = CONTINENT_ORDER.map(continent => {
    const dests = allDests.filter(d => (COUNTRY_CONTINENT[d.country] || "Other") === continent);
    if (dests.length === 0) return null;
    const countryNames = Array.from(new Set(dests.map(d => d.country))).sort();
    return {
      continent,
      color: CONTINENT_COLORS[continent] || "#94A3B8",
      count: dests.length,
      countries: countryNames.map(country => ({
        country,
        flag: dests.find(d => d.country === country)?.flag,
        dests: dests.filter(d => d.country === country).sort((a, b) => a.city.localeCompare(b.city)),
      })),
    };
  }).filter(Boolean) as any[];
  const [destCode, setDestCode] = useState(selectedDest || "");
  const [showDestPicker, setShowDestPicker] = useState(false);
  const [openContinent, setOpenContinent] = useState<string | null>(null);
  const [place, setPlace] = useState("");
  const [category, setCategory] = useState(defaultCategory || "food");
  const [note, setNote] = useState("");
  const name = profile?.name || "";
  const role = profile?.role || "Cabin Crew";
  const [price, setPrice] = useState("");
  const [openingHours, setOpeningHours] = useState("");
  const [crewDiscount, setCrewDiscount] = useState(false);
  const [discountPct, setDiscountPct] = useState("");
  const [tags, setTags] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [showDonation, setShowDonation] = useState(false);
  const [pendingTip, setPendingTip] = useState<any>(null);
  const [donationAmount, setDonationAmount] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<any[]>([]);
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
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(place + " " + dest.city)}&format=json&limit=6&addressdetails=1&extratags=1&namedetails=1`;
        const res = await fetch(url, { headers: { "Accept-Language": "en" } });
        const data = await res.json();
        setSuggestions(data);
        setShowDropdown(data.length > 0);
      } catch { setSuggestions([]); }
      setLoadingSugg(false);
    }, 400);
    return () => clearTimeout(timer);
  }, [place, destCode]);

  function pickSuggestion(s: any) {
    justPickedRef.current = true;
    const shortName = s.namedetails?.name || s.name || s.display_name.split(",")[0];
    setPlace(shortName);
    setPlaceCoords({ lat: s.lat, lon: s.lon });
    setCategory(osmCategoryGuess(s.class, s.type));
    setOpeningHours(s.extratags?.opening_hours || "");
    setSuggestions([]);
    setShowDropdown(false);
  }

  function handlePlaceChange(e: any) {
    setPlace(e.target.value);
    setPlaceCoords(null);
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
    if (photo) newTip.photo = photo;
    const parsedTags = tags.split(/[\s,#]+/).map((t: string) => t.replace(/^#/, "").trim()).filter(Boolean);
    if (parsedTags.length > 0) newTip.tags = parsedTags;
    setPendingTip(newTip);
    setShowDonation(true);
  }

  function finalize(donated: boolean) {
    setShowDonation(false);
    onSubmit(destCode, pendingTip);
    setSubmitted(true);
  }

  if (submitted) return (
    <div className="screen screen-center">
      <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
      <div className="success-title">Recommendation added!</div>
      <p className="success-sub">Your tip for {dest?.city} is now visible to all WingTips crew.</p>
    </div>
  );

  return (
    <div className="screen">
      {showDonation && (
        <div className="donation-backdrop">
          <div className="donation-modal">
            <div className="donation-wings-logo">🕊️</div>
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
            <button className="donation-btn-primary" onClick={() => finalize(true)} disabled={!donationAmount}>
              {donationAmount ? `Donate €${donationAmount} & Post` : "Select an amount"}
            </button>
            <button className="donation-btn-skip" onClick={() => finalize(false)}>
              Skip and post without donating
            </button>
          </div>
        </div>
      )}
      <div className="form-header">
        <button className="back-btn-flat" onClick={onBack}>← Cancel</button>
        <div className="form-header-title">Add Recommendation</div>
      </div>
      <div className="form-body">

        <div className="form-group">
          <label className="form-lbl">Destination</label>
          <button type="button" className="form-sel dest-picker-trigger" onClick={() => setShowDestPicker(true)}>
            <span>{dest ? `${dest.flag} ${dest.city}` : "— Select city —"}</span>
            <span className="dest-picker-chevron">▼</span>
          </button>
        </div>

        {showDestPicker && (
          <div className="cat-menu-backdrop" onClick={() => setShowDestPicker(false)}>
            <div className="cat-menu-sheet dest-sheet" onClick={e => e.stopPropagation()}>
              <div className="cat-menu-handle" />
              <div className="cat-menu-title">Select destination</div>
              <div className="cat-menu-dest">{allDests.length} destinations · grouped by continent &amp; country</div>
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
                        <span className="continent-chevron">{isOpen ? "▲" : "▼"}</span>
                      </button>
                      {isOpen && (
                        <div className="dest-list-inner">
                          {group.countries.map((c: any) => (
                            <div key={c.country} className="country-group">
                              <div className="country-header">
                                <span className="country-flag-chip">{c.flag}</span>
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
                                  {destCode === d.code && <span className="dli-tick">✓</span>}
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
            {loadingSugg && <span className="sugg-spinner">⏳</span>}
            {mapsUrl && (
              <a href={mapsUrl} target="_blank" rel="noreferrer" className="maps-btn">
                🗺 Maps
              </a>
            )}
          </div>
          {showDropdown && suggestions.length > 0 && (
            <div className="sugg-dropdown">
              {suggestions.map((s, i) => {
                const primary = s.namedetails?.name || s.name || s.display_name.split(",")[0];
                const addr = s.display_name.split(",").slice(1, 3).join(",").trim();
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
          {distanceToHotel && <div className="maps-hint">🏨 {distanceToHotel} from the crew hotel ({dest.crewHotel || "unknown"})</div>}
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

        <div className="form-group">
          <label className="form-lbl">Category</label>
          <div className="rec-cat-row">
            {CATEGORIES.map(c => (
              <button key={c.id}
                className={`rec-cat-chip${category === c.id ? " active" : ""}`}
                onClick={() => setCategory(c.id)}>
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
              <button className="photo-remove-btn" onClick={() => setPhoto(null)}>✕ Remove</button>
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
        <button className="back-btn-flat" onClick={onBack}>← Back</button>
        <div className="screen-topbar-title">Saved Tips</div>
      </div>
      {savedTips.length === 0
        ? <div className="screen-center">
            <div style={{ fontSize: 40, marginBottom: 16 }}>☆</div>
            <div style={{ color: "var(--text2)", fontSize: 14 }}>No saved tips yet.</div>
            <div style={{ color: "var(--text2)", fontSize: 12, marginTop: 6 }}>Tap ☆ on any crew tip to save it here.</div>
          </div>
        : <div className="content-pad">
            {savedTips.map(({ key, code, dest, tip }) => (
              <div key={key} className="crew-card">
                <button className="fav-dest-label" onClick={() => onDestClick(code)}>
                  {dest.flag} {dest.city}
                </button>
                <div className="crew-card-top" style={{ marginTop: 8 }}>
                  <div className="crew-av">{tip.name[0]}</div>
                  <div>
                    <div className="crew-card-name">{tip.name}</div>
                    <div className="crew-card-role">{tip.role}</div>
                  </div>
                  <div className="crew-card-date">{tip.date}</div>
                </div>
                <p className="crew-card-text">{tip.text}</p>
                <button className="fav-btn saved" onClick={() => onToggleFavorite(key)}>★ Remove</button>
              </div>
            ))}
          </div>
      }
    </div>
  );
}

// ─── NOTIFICATIONS ─────────────────────────────────────────────────────────────
function NotificationsScreen({ onBack, notes, onMarkAllRead, onNotificationClick }) {
  return (
    <div className="screen">
      <div className="screen-topbar">
        <button className="back-btn-flat" onClick={onBack}>← Back</button>
        <div className="screen-topbar-title">Notifications</div>
        {notes.length > 0 && <button className="mark-read-btn" onClick={onMarkAllRead}>Mark all read</button>}
      </div>
      <div className="content-pad">
        {notes.length === 0
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
function ProfileScreen({ onBack, connections, onToggleConnection, addedTips, profile, updateProfile, onCrewClick }) {
  const [tab, setTab] = useState("tips");
  const [editing, setEditing] = useState(!profile.name);
  const [connSearch, setConnSearch] = useState("");
  const [draft, setDraft] = useState({ ...profile });

  const myTips = Object.entries(addedTips as Record<string, any[]>).flatMap(([code, tips]) =>
    tips.map(t => ({ ...t, destCode: code, destCity: (DESTINATIONS as any)[code]?.city || code }))
  );
  const totalLikes = myTips.reduce((s, t) => s + (t.likes || 0), 0);
  const initials = profile.name ? profile.name.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase() : "?";

  function saveProfile() {
    if (!draft.name.trim()) return;
    updateProfile(draft);
    setEditing(false);
  }

  return (
    <div className="screen">
      <div className="screen-topbar">
        <button className="back-btn-flat" onClick={onBack}>← Back</button>
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
          <button className="pef-save-btn" onClick={saveProfile} disabled={!draft.name.trim()}>Save profile</button>
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
              [String(connections.length), "Connections"],
            ].map(([v, l]) => (
              <div key={l} className="stat-box"><div className="stat-val">{v}</div><div className="stat-lbl">{l}</div></div>
            ))}
          </div>
          <div className="profile-tabs">
            <button className={`profile-tab${tab === "tips" ? " active" : ""}`} onClick={() => setTab("tips")}>My Tips</button>
            <button className={`profile-tab${tab === "connections" ? " active" : ""}`} onClick={() => setTab("connections")}>
              Connections {connections.length > 0 && <span className="tab-badge">{connections.length}</span>}
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
                        <div className="my-tip-meta">{t.destCity} · {cat?.label || t.category}</div>
                        <p className="my-tip-text">{t.text}</p>
                        <div className="my-tip-likes">❤ {t.likes || 0}</div>
                      </div>
                    );
                  })
            )}
            {tab === "connections" && (
              <>
                {connections.length > 0 && (
                  <input
                    className="conn-search-input"
                    placeholder="Search connections..."
                    value={connSearch}
                    onChange={(e: any) => setConnSearch(e.target.value)}
                  />
                )}
                {connections.length === 0
                  ? <div className="no-tips">No connections yet — tap Connect on a crew tip to add someone.</div>
                  : connections
                      .filter((name: string) => name.toLowerCase().includes(connSearch.toLowerCase()))
                      .map((name: string) => (
                        <div key={name} className="connection-card">
                          <button className="crew-av crew-av-btn" onClick={() => onCrewClick && onCrewClick({ name, role: "Crew member" })}>{name[0]}</button>
                          <div className="connection-info" style={{cursor:"pointer"}} onClick={() => onCrewClick && onCrewClick({ name, role: "Crew member" })}>
                            <div className="crew-card-name crew-card-name-link">{name}</div>
                            <div className="crew-card-role">Crew member</div>
                          </div>
                          <button className="disconnect-btn" onClick={() => onToggleConnection(name)}>Remove</button>
                        </div>
                      ))
                }
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
function CrewProfileScreen({ crew, onBack, connections, onToggleConnection, addedTips }) {
  const isConnected = connections.includes(crew.name);
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
        <button className="back-btn-flat" onClick={onBack}>← Back</button>
        <div className="screen-topbar-title">Crew Profile</div>
      </div>
      <div className="profile-hero">
        <div className="profile-av profile-av-large">{initials}</div>
        <div className="profile-name">{crew.name}</div>
        <div className="profile-role">{crew.role}</div>
        <button className={`crew-connect-btn${isConnected ? " connected" : ""}`} onClick={() => onToggleConnection(crew.name)}>
          {isConnected ? "✓ Connected" : "+ Connect"}
        </button>
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
                  <div className="my-tip-meta">{t.destFlag} {t.destCity} · {cat?.label || t.category}</div>
                  <p className="my-tip-text">{t.text}</p>
                  <div className="my-tip-likes">❤ {t.likes || 0}</div>
                </div>
              );
            })
        }
      </div>
    </div>
  );
}

function DestinationsMenu({ onClose, onSelect, selectedDest }) {
  const [openContinent, setOpenContinent] = useState(null);
  return (
    <div className="cat-menu-backdrop" onClick={onClose}>
      <div className="cat-menu-sheet dest-sheet" onClick={e => e.stopPropagation()}>
        <div className="cat-menu-handle" />
        <div className="cat-menu-title">All Destinations</div>
        <div className="cat-menu-dest">105 destinations · KLM &amp; KLM Cityhopper network</div>
        <div className="dest-continent-list">
          {CONTINENT_GROUPS.map(group => {
            const isOpen = openContinent === group.id;
            const dests = group.codes.map(c => DESTINATIONS[c]).filter(Boolean);
            return (
              <div key={group.id} className="continent-block">
                <button className={`continent-header${isOpen ? " open" : ""}`}
                  onClick={() => setOpenContinent(isOpen ? null : group.id)}>
                  <span className="continent-dot" style={{background: group.color}} />
                  <span className="continent-label">{group.label}</span>
                  <span className="continent-count">{dests.length}</span>
                  <span className="continent-chevron">{isOpen ? "▲" : "▼"}</span>
                </button>
                {isOpen && (
                  <div className="dest-list-inner">
                    {dests.map(d => (
                      <button key={d.code}
                        className={`dest-list-item${selectedDest === d.code ? " active" : ""}`}
                        onClick={() => { onSelect(d.code); onClose(); }}>
                        <span className="dli-flag">{d.flag}</span>
                        <div className="dli-text">
                          <span className="dli-city">{d.city}</span>
                          <span className="dli-country">{d.country}</span>
                        </div>
                        <span className="dli-code">{d.code}</span>
                        {selectedDest === d.code && <span className="dli-tick">✓</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── CATEGORY MENU ─────────────────────────────────────────────────────────────
function CategoryMenu({ onClose, activeCategory, onSelectCategory, addedTips }) {
  return (
    <div className="cat-menu-backdrop" onClick={onClose}>
      <div className="cat-menu-sheet" onClick={e => e.stopPropagation()}>
        <div className="cat-menu-handle" />
        <div className="cat-menu-title">Browse by Category</div>
        <div className="cat-menu-dest">Latest tips across every destination</div>
        <div className="cat-menu-list">
          {CATEGORIES.map(cat => {
            const count = (Object.values(DESTINATIONS) as any[]).reduce(
              (sum, d) => sum + [...(d.crewTips || []), ...((addedTips[d.code]) || [])].filter((t: any) => t.category === cat.id).length,
              0
            );
            const isActive = activeCategory === cat.id;
            return (
              <button key={cat.id}
                className={`cat-menu-item${isActive ? " active" : ""}`}
                onClick={() => { onSelectCategory(cat.id); onClose(); }}
              >
                <span className="cat-menu-icon">{cat.icon}</span>
                <span className="cat-menu-label">{cat.label}</span>
                {count > 0 && <span className="cat-menu-badge">{count} crew tips</span>}
                {isActive && <span className="cat-menu-tick">✓</span>}
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
  const results: Array<{ tip: any; destCode: string; destCity: string }> = [];
  for (const dest of Object.values(DESTINATIONS) as any[]) {
    const allTips = [...(dest.crewTips || []), ...((addedTips[dest.code]) || [])];
    for (const tip of allTips) {
      if (tip.category === category) results.push({ tip, destCode: dest.code, destCity: dest.city });
    }
  }
  results.sort((a, b) => (b.tip.date || "").localeCompare(a.tip.date || ""));

  return (
    <div className="screen">
      <div className="screen-topbar">
        <button className="back-btn-flat" onClick={onBack}>← Back</button>
        <div className="screen-topbar-title">{cat?.icon} {cat?.label}</div>
      </div>
      <div className="content-pad">
        <div className="search-results-meta">{results.length} recent tip{results.length !== 1 ? "s" : ""}, every destination mixed together</div>
        {results.length === 0
          ? <div className="no-tips">No {cat?.label.toLowerCase()} tips yet. Be the first to add one!</div>
          : results.map((r, i) => (
            <div key={i} className="search-result-item">
              <button className="search-result-dest" onClick={() => onDestClick(r.destCode)}>
                {(DESTINATIONS as any)[r.destCode]?.flag} {r.destCity} · {r.destCode}
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
                <p className="crew-card-text">{r.tip.text}</p>
                {r.tip.tags && r.tip.tags.length > 0 && (
                  <div className="tip-tags-row">{r.tip.tags.map((tag: string, ti: number) => <span key={ti} className="tip-tag">#{tag}</span>)}</div>
                )}
                <div className="search-result-cta">View recommendation →</div>
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
        <button className="back-btn-flat" onClick={onBack}>← Back</button>
        <div className="screen-topbar-title">Search results</div>
      </div>
      <div className="content-pad">
        <div className="search-results-meta">{results.length} result{results.length !== 1 ? "s" : ""} for <em>"{query}"</em></div>
        {results.length === 0
          ? <div className="no-tips">No recommendations found. Try different keywords.</div>
          : results.map((r, i) => (
            <div key={i} className="search-result-item">
              <button className="search-result-dest" onClick={() => onDestClick(r.destCode)}>
                {(DESTINATIONS as any)[r.destCode]?.flag} {r.destCity} · {r.destCode}
              </button>
              <button className="crew-card search-result-card" onClick={() => onTipClick(r.destCode, r.tip.id, r.tip.category)}>
                <p className="crew-card-text">{r.tip.text}</p>
                {r.tip.tags && r.tip.tags.length > 0 && (
                  <div className="tip-tags-row">{r.tip.tags.map((tag: string, ti: number) => <span key={ti} className="tip-tag">#{tag}</span>)}</div>
                )}
                <div className="search-result-cta">View recommendation →</div>
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
        <div className="landing-logo">✈ WingTips</div>
        <div className="landing-badge">KLM crew only</div>
        <h1 className="landing-headline">Know before you land.</h1>
        <p className="landing-sub">The layover guide written by crew, for crew — {destCount} destinations, zero guesswork.</p>
        <button className="landing-cta" onClick={onGetStarted}>Get started — it's free</button>
        <button className="landing-signin-link" onClick={onSignIn}>Already have an account? Sign in</button>
      </div>

      <div className="landing-features">
        <div className="landing-feature">
          <div className="landing-feature-icon">🌍</div>
          <div className="landing-feature-title">{destCount} destinations, and counting</div>
          <div className="landing-feature-text">From Aberdeen to Tokyo — crew hotel rates, local weather, and exactly how many hours you've got on the ground.</div>
        </div>
        <div className="landing-feature">
          <div className="landing-feature-icon">🍽️</div>
          <div className="landing-feature-title">Tips you can actually trust</div>
          <div className="landing-feature-text">Food, fitness, beauty, wellness and shopping — recommended by colleagues who were really there, not a travel blog.</div>
        </div>
        <div className="landing-feature">
          <div className="landing-feature-icon">🤝</div>
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
        <div className="auth-logo">✈ WingTips</div>
        {forgotSent ? (
          <>
            <div className="auth-verify-icon">📧</div>
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
        <div className="auth-logo">✈ WingTips</div>
        <div className="auth-verify-icon">📧</div>
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
        {onBack && <button className="auth-back-btn" onClick={onBack}>← Back</button>}
        <div className="auth-logo">✈ WingTips</div>
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
        <div className="auth-logo">✈ WingTips</div>
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
  if (authUser === "loading") return <div className="app-shell"><div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",color:"var(--accent)",fontSize:24}}>✈</div></div>;
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
  const [selectedCrew, setSelectedCrew] = useState<{ name: string; role: string } | null>(null);
  const [showCatMenu, setShowCatMenu] = useState(false);
  const [showDestMenu, setShowDestMenu] = useState(false);
  const { notes: notifications, markAllRead } = useNotifications();
  const unreadCount = notifications.filter(n => !n.read).length;
  const { connections, toggle: toggleConnection } = useConnections();
  const { favorites, toggle: toggleFavorite } = useFavorites();
  const { profile, updateProfile } = useProfile();
  const [addedTips, setAddedTips] = useState<Record<string, any[]>>(() => {
    try { return JSON.parse(localStorage.getItem("wt_added_tips") || "{}"); }
    catch { return {}; }
  });
  const [searchQuery, setSearchQuery] = useState("");

  function handleRecommendationSubmitted(code: string, tip: any) {
    setAddedTips((prev: Record<string, any[]>) => {
      const updated = { ...prev, [code]: [...(prev[code] || []), tip] };
      localStorage.setItem("wt_added_tips", JSON.stringify(updated));
      return updated;
    });
    setSelectedDest(code);
    setScreen("dest");
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

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", flexDirection: "column", fontFamily: "'Inter', sans-serif", color: "var(--text)", maxWidth: 480, margin: "0 auto", position: "relative" }}>
      {/* TOP NAV */}
      <div className="top-nav">
        <div className="nav-title">WingTips</div>
        <div className="nav-right">
          <button className="nav-icon-btn" onClick={() => setScreen("notifications")}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
            {unreadCount > 0 && <div className="notif-badge">{unreadCount}</div>}
          </button>
          <button className="nav-icon-btn" onClick={() => setScreen("profile")}>👤</button>
          <button className="nav-icon-btn" aria-label="Log out" onClick={() => { if (confirm("Log out?")) supabase.auth.signOut(); }}>
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          </button>
        </div>
      </div>

      {/* SCREENS */}
      {screen === "home"          && <HomeScreen onSearch={handleSearch} onDestClick={code => { setSelectedDest(code); setScreen("dest"); }} addedTips={addedTips} />}
      {screen === "dest"          && selectedDest && <DestScreen key={selectedDest + (addedTips[selectedDest]?.length || 0)} code={selectedDest} onBack={() => setScreen("home")} onAddTip={handleAddTip} activeCategory={activeCategory} setActiveCategory={setActiveCategory} connections={connections} onToggleConnection={toggleConnection} favorites={favorites} onToggleFavorite={toggleFavorite} extraTips={addedTips[selectedDest] || []} focusTipId={focusTipId} onFocusConsumed={() => setFocusTipId(null)} onCrewClick={(crew: any) => { setSelectedCrew(crew); setScreen("crewprofile"); }} />}
      {screen === "addrecommendation" && <AddRecommendationScreen onBack={() => addTipContext.code ? setScreen("dest") : setScreen("home")} selectedDest={selectedDest} onSubmit={handleRecommendationSubmitted} profile={profile} defaultCategory={addTipContext.category} />}
      {screen === "search"        && <SearchResultsScreen query={searchQuery} addedTips={addedTips} onDestClick={(code: string) => { setSelectedDest(code); setScreen("dest"); }} onBack={() => setScreen("home")} onTipClick={(code: string, tipId: any, category: string) => { setSelectedDest(code); setActiveCategory(category); setFocusTipId(tipId); setScreen("dest"); }} />}
      {screen === "categoryfeed"  && <CategoryFeedScreen category={activeCategory} addedTips={addedTips} onBack={() => setScreen("home")} onDestClick={(code: string) => { setSelectedDest(code); setScreen("dest"); }} onTipClick={(code: string, tipId: any, category: string) => { setSelectedDest(code); setActiveCategory(category); setFocusTipId(tipId); setScreen("dest"); }} />}
      {screen === "notifications" && <NotificationsScreen onBack={() => setScreen("home")} notes={notifications} onMarkAllRead={markAllRead} onNotificationClick={(n: any) => { setSelectedDest(n.destCode); if (n.category) setActiveCategory(n.category); if (n.tipId != null) setFocusTipId(n.tipId); setScreen("dest"); }} />}
      {screen === "favorites"     && <FavoritesScreen onBack={() => setScreen("home")} favorites={favorites} onToggleFavorite={toggleFavorite} onDestClick={(code: string) => { setSelectedDest(code); setScreen("dest"); }} addedTips={addedTips} />}
      {screen === "profile"       && <ProfileScreen onBack={() => setScreen("home")} connections={connections} onToggleConnection={toggleConnection} addedTips={addedTips} profile={profile} updateProfile={updateProfile} onCrewClick={(crew: any) => { setSelectedCrew(crew); setScreen("crewprofile"); }} />}
      {screen === "crewprofile"   && selectedCrew && <CrewProfileScreen crew={selectedCrew} onBack={() => setScreen("dest")} connections={connections} onToggleConnection={toggleConnection} addedTips={addedTips} />}

      {/* BOTTOM NAV */}
      <div className="bottom-nav">
        <button className={`bnav-item${screen === "home" ? " active" : ""}`} onClick={() => setScreen("home")}>
          Home
        </button>
        <button className={`bnav-item${showDestMenu ? " active" : ""}`} onClick={() => { setShowDestMenu(v => !v); setShowCatMenu(false); }}>
          Explore
        </button>
        <div className="bnav-fab-wrap">
          <button className="bnav-fab" onClick={() => { setAddTipContext({ code: null, category: null }); setScreen("addrecommendation"); }}>+</button>
        </div>
        <button className={`bnav-item${showCatMenu || screen === "categoryfeed" ? " active" : ""}`} onClick={() => { setShowCatMenu(v => !v); setShowDestMenu(false); }}>
          Categories
        </button>
        <button className={`bnav-item${screen === "favorites" ? " active" : ""}`} onClick={() => setScreen("favorites")}>
          Saved {favorites.length > 0 && <span className="bnav-badge">{favorites.length}</span>}
        </button>
      </div>

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
  );
}
