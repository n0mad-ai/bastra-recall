/** Local weather as an ambient layer over the mindspace (#217) — the map's
 *  backdrop picks up the weather where the user actually is: rain thickens the
 *  streaks, a thunderstorm puts distant flashes at the horizon, cloud cover and
 *  humidity thicken the haze. The topbar chip shows the reading itself
 *  (temperature, condition, place) so the effect is attributable.
 *
 *  STRICTLY OPT-IN, off by default. Nothing here runs and no position is
 *  requested until the user opens the picker and chooses a place.
 *
 *  TWO WAYS IN, and BOTH stay available for good — neither works everywhere:
 *    - GPS. The browser puts up its own permission dialog, so the grant is the
 *      platform's, not ours. Denial is a normal outcome, not an error.
 *    - Typing a place name. Never hidden behind a GPS failure: a fix can be
 *      absent, refused, OR simply wrong (VPN, desktop without GPS, a laptop
 *      that thinks it is in the datacenter), and it also covers "give me the
 *      weather where I'm going". A place set by GPS can always be overtyped.
 *
 *  Privacy, in the order the data flows:
 *    1. Coordinates are rounded to ONE decimal (~11 km) before they leave the
 *       function that obtained them. Weather at that resolution is identical to
 *       weather at the doorstep; the difference is that ~11 km is a region, not
 *       an address. The precise fix is never stored and never sent.
 *    2. Requests go from the BROWSER to the services below, never through the
 *       daemon. The daemon stays egress-free and every call is visible in the
 *       user's own devtools.
 *    3. Neither service needs a key, an account or a cookie, so there is
 *       nothing to correlate the request with beyond the rounded position.
 *    4. Only the position leaves. No memory, no vault content, no id.
 *
 *  Three hosts, each with one job:
 *    - api.open-meteo.com           — the forecast itself
 *    - geocoding-api.open-meteo.com — typed name → coordinates
 *    - api.bigdatacloud.net         — GPS coordinates → place name. Open-Meteo
 *      is forward-only, and a chip reading "52.5, 13.4" is not a place. Purely
 *      cosmetic: if it fails, the rounded coordinates become the label and the
 *      weather still works.
 *
 *  Refetched every 10 minutes while a place is set — weather does not move
 *  faster, and a tighter poll would only widen the exposure for nothing.
 *  The interval alone is not enough: a background tab has its timers throttled
 *  to a crawl (and a sleeping machine runs none at all), so a map left open on
 *  a second screen showed a reading hours old. Coming back into view therefore
 *  refetches whatever the timer missed.
 *
 *  @param {() => void} onChange  called whenever conditions or place changed */

const PLACE_KEY = "bastra-vault-map-weather-place";
const REFRESH_MS = 10 * 60 * 1000;
const COORD_DECIMALS = 1; // ~11 km — a region, never an address
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const REVERSE_URL = "https://api.bigdatacloud.net/data/reverse-geocode-client";

/** Neutral conditions — also what a failed lookup falls back to, so a dead
 *  network looks like calm weather instead of a broken backdrop. */
const CALM = { rain: 0, thunder: 0, clouds: 0, fog: 0, temp: null, label: "", icon: "clear" };

/** WMO weather codes → the four dials the decor reads, plus the chip's icon.
 *  Deliberately coarse: the backdrop has four expressions, so resolving 28
 *  codes into anything finer would be precision the renderer throws away.
 *  @see https://open-meteo.com/en/docs — WMO 4677 code table */
/** Above this the wind is the thing you'd mention first (km/h). Beaufort 5,
 *  "fresh breeze" — branches sway, an umbrella becomes a problem. Gusts count
 *  from 40, because a calm average with 45 km/h gusts is still a windy day. */
const WINDY_KMH = 20;
const GUSTY_KMH = 40;

function conditionsFrom(code, cloudPct, humidityPct, tempC, windKmh, gustKmh) {
  const c = {
    rain: 0,
    thunder: 0,
    clouds: Math.min((cloudPct ?? 0) / 100, 1),
    fog: 0,
    temp: typeof tempC === "number" ? Math.round(tempC) : null,
    label: "clear",
    icon: "clear",
    wind: Math.round(windKmh ?? 0),
    gust: Math.round(gustKmh ?? 0),
  };
  const windy = (windKmh ?? 0) >= WINDY_KMH || (gustKmh ?? 0) >= GUSTY_KMH;
  // Humidity carries the fog undertone even without a fog code — otherwise a
  // muggy, overcast day looks exactly as dry as a clear one.
  if ((humidityPct ?? 0) > 80) c.fog = Math.min((humidityPct - 80) / 20, 1) * 0.5;

  if (code >= 95) {
    c.thunder = code >= 96 ? 1 : 0.7;
    c.rain = 0.8;
    c.label = "thunderstorm";
    c.icon = "storm";
  } else if (code >= 80) {
    c.rain = 0.9;
    c.label = windy ? "showers, windy" : "showers";
    c.icon = windy ? "rain-wind" : "rain";
  } else if (code >= 71 && code <= 77) {
    c.rain = 0.5; // snow falls slower — carried as a thinner streak stream
    c.label = "snow";
    c.icon = "snow";
  } else if (code >= 51) {
    const heavy = code >= 61;
    c.rain = heavy ? 0.7 : 0.35; // rain vs. drizzle
    c.label = (heavy ? "rain" : "drizzle") + (windy ? ", windy" : "");
    // Nieselregen bekommt sein eigenes Bild — vorher trug er dasselbe wie ein
    // Landregen, und genau diese Gleichmacherei ließ den Chip stillstehen.
    c.icon = windy ? "rain-wind" : heavy ? "rain" : "drizzle";
  } else if (code === 45 || code === 48) {
    c.fog = 1;
    c.label = "fog";
    c.icon = "fog";
  } else if (windy) {
    // Kein Niederschlag, aber es weht: dann ist der Wind die Nachricht. Auch
    // unter geschlossener Decke — eine Wolke sieht man aus dem Fenster, den
    // Wind merkt man erst draußen, und genau das soll der Chip vorher sagen.
    // Die Bewölkung bleibt im Label, damit sie nicht verschwiegen wird.
    const gustier = (gustKmh ?? 0) >= GUSTY_KMH;
    const sky = c.clouds > 0.85 ? "overcast, " : c.clouds > 0.55 ? "cloudy, " : "";
    c.label = sky + (gustier ? "gusty" : "windy");
    c.icon = "wind";
  } else if (code >= 1 || c.clouds > 0.25) {
    // Dreistufig statt zweistufig: zwischen 70% und 100% Bedeckung sah der
    // Chip vorher identisch aus, und das ist der Bereich, in dem mitteleuro-
    // päisches Wetter die meiste Zeit steht.
    if (c.clouds > 0.85) {
      c.label = windy ? "overcast, windy" : "overcast";
      c.icon = "overcast";
    } else if (c.clouds > 0.55) {
      c.label = windy ? "cloudy, windy" : "cloudy";
      c.icon = "cloudy";
    } else {
      c.label = windy ? "partly cloudy, windy" : "partly cloudy";
      c.icon = "partly";
    }
  }
  return c;
}

const round = (n) => Number(n).toFixed(COORD_DECIMALS);

export function createWeather(onChange) {
  /** { name, lat, lon } — the chosen place, or null while switched off. Both
   *  coordinates are ALREADY rounded here; nothing finer is ever stored. */
  let place = readPlace();
  let conditions = { ...CALM };
  let timer = 0;
  let lastError = "";
  let lastFetch = 0; // ms epoch of the last attempt — the catch-up check reads it

  function readPlace() {
    try {
      const p = JSON.parse(localStorage.getItem(PLACE_KEY) ?? "null");
      return p && p.lat && p.lon ? p : null;
    } catch {
      return null;
    }
  }

  /** Ask the browser for a position. The dialog is the platform's; a refusal
   *  is a normal outcome and says so rather than throwing a stack trace. Every
   *  message points at the search box, which always remains open. */
  const position = () =>
    new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("no location support — search for a place instead"));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (p) => resolve(p.coords),
        (err) =>
          reject(
            new Error(
              err.code === err.PERMISSION_DENIED
                ? "location denied — search for a place instead"
                : "location unavailable — search for a place instead"
            )
          ),
        { maximumAge: REFRESH_MS, timeout: 10000, enableHighAccuracy: false }
      );
    });

  /** GPS → a place. Rounds FIRST, then asks for a name; the reverse lookup is
   *  cosmetic, so its failure downgrades the label instead of the feature. */
  async function useGps() {
    const coords = await position();
    const lat = round(coords.latitude);
    const lon = round(coords.longitude);
    let name = `${lat}, ${lon}`;
    try {
      const res = await fetch(`${REVERSE_URL}?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
      if (res.ok) {
        const d = await res.json();
        name = d.city || d.locality || d.principalSubdivision || name;
      }
    } catch {
      /* keep the coordinates as the label — the weather itself is unaffected */
    }
    await setPlace({ name, lat, lon });
  }

  /** Typed name → candidate places. Returns [] on any failure: an empty result
   *  list and a dead network look the same to the user, and both mean "try
   *  another spelling". */
  async function search(query) {
    const q = query.trim();
    if (q.length < 2) return [];
    try {
      const res = await fetch(`${GEOCODE_URL}?name=${encodeURIComponent(q)}&count=6&format=json`);
      if (!res.ok) return [];
      const d = await res.json();
      return (d.results ?? []).map((r) => ({
        name: r.name,
        detail: [r.admin1, r.country].filter(Boolean).join(", "),
        lat: round(r.latitude),
        lon: round(r.longitude),
      }));
    } catch {
      return [];
    }
  }

  async function fetchWeather() {
    if (!place) return;
    lastFetch = Date.now();
    try {
      const url =
        `${FORECAST_URL}?latitude=${place.lat}&longitude=${place.lon}` +
        `&current=temperature_2m,weather_code,cloud_cover,relative_humidity_2m,wind_speed_10m,wind_gusts_10m`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`weather service answered ${res.status}`);
      const cur = (await res.json()).current ?? {};
      conditions = conditionsFrom(
        cur.weather_code ?? 0,
        cur.cloud_cover,
        cur.relative_humidity_2m,
        cur.temperature_2m,
        cur.wind_speed_10m,
        cur.wind_gusts_10m
      );
      lastError = "";
    } catch (err) {
      // Weather is decoration. A failure must never disturb the map — it falls
      // back to calm and surfaces only in the chip's tooltip.
      conditions = { ...CALM };
      lastError = err.message;
    }
    onChange?.();
  }

  function arm() {
    clearInterval(timer);
    if (!place) return;
    void fetchWeather();
    timer = setInterval(() => void fetchWeather(), REFRESH_MS);
  }

  async function setPlace(p) {
    place = p ? { name: p.name, lat: p.lat, lon: p.lon } : null;
    if (place) localStorage.setItem(PLACE_KEY, JSON.stringify(place));
    else localStorage.removeItem(PLACE_KEY);
    conditions = { ...CALM };
    lastError = "";
    clearInterval(timer);
    onChange?.();
    if (place) {
      await fetchWeather();
      timer = setInterval(() => void fetchWeather(), REFRESH_MS);
    }
  }

  arm();

  // The timer is the plan; this is the correction. Chrome throttles interval
  // timers in hidden tabs and a sleeping machine fires none at all, so the
  // reading silently goes stale. Whenever the map becomes visible again, catch
  // up on anything the timer slept through — bounded by the same interval, so
  // switching tabs in a working session costs no extra requests.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !place) return;
    if (Date.now() - lastFetch >= REFRESH_MS) void fetchWeather();
  });

  return {
    /** The four dials for the decor layer; all zero while no place is set. */
    get: () => (place ? conditions : CALM),
    isOn: () => place !== null,
    getPlace: () => place,
    /** What the topbar chip renders: temperature, condition icon, place. */
    readout: () =>
      place ? { temp: conditions.temp, icon: conditions.icon, label: conditions.label, place: place.name } : null,
    /** Tooltip detail — the error wins, because it explains a dead chip. */
    status: () => (!place ? "" : lastError || conditions.label),
    useGps,
    search,
    setPlace,
    clear: () => setPlace(null),
  };
}
