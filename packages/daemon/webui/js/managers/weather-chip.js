/** Weather chip + place picker (#217) — the topbar face of managers/weather.js.
 *  That module owns the data (place, conditions, the three services); this one
 *  owns the pixels and never fetches anything itself.
 *
 *  The chip is the FIRST element in .topbar-right and it is the only way in:
 *  weather is off until a place is chosen here, so opting in is a deliberate
 *  act with a visible result rather than a switch whose effect you have to
 *  hunt for on the map.
 *
 *  Picker layout is deliberate: GPS and search are shown TOGETHER, always.
 *  A fix can be missing, refused, or plain wrong (VPN, desktop, a laptop that
 *  believes it lives in a datacenter), so the search box is never gated behind
 *  a GPS failure — and it stays reachable afterwards to correct a bad fix.
 *
 *  @param {object} deps
 *  @param {object} deps.weather  the weather manager (data layer) */

const $ = (sel) => document.querySelector(sel);
const SEARCH_DEBOUNCE_MS = 300; // one request per pause in typing, not per key

/** Condition → inline SVG path set. Kept here rather than in index.html: the
 *  icon IS the reading, so it has to change with the conditions. */
/** Condition → inline SVG. The icon IS the reading, so it has to change with
 *  the conditions — and it has to change ENOUGH: the hand-drawn set before this
 *  shared one cloud shape across rain, snow and storm, so in everyday weather
 *  the chip sat on the same picture for days.
 *
 *  Paths are Lucide (ISC, © Lucide Icons and Contributors), inlined rather than
 *  loaded: the CSP allows no external hosts, and bastra.io already draws from
 *  the same set. Stroke width dialled from 2 to 1.8 to sit with the topbar's
 *  other icons.
 *  @see https://lucide.dev */
const ICONS = {
  "sun":
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  "cloud-sun":
    '<path d="M12 2v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="M20 12h2"/><path d="m19.07 4.93-1.41 1.41"/><path d="M15.947 12.65a4 4 0 0 0-5.925-4.128"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/>',
  "cloud": '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  "cloudy":
    '<path d="M17.5 12a1 1 0 1 1 0 9H9.006a7 7 0 1 1 6.702-9z"/><path d="M21.832 9A3 3 0 0 0 19 7h-2.207a5.5 5.5 0 0 0-10.72.61"/>',
  "cloud-drizzle":
    '<path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M8 19v1"/><path d="M8 14v1"/><path d="M16 19v1"/><path d="M16 14v1"/><path d="M12 21v1"/><path d="M12 16v1"/>',
  "cloud-rain":
    '<path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M16 14v6"/><path d="M8 14v6"/><path d="M12 16v6"/>',
  "cloud-rain-wind":
    '<path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="m9.2 22 3-7"/><path d="m9 13-3 7"/><path d="m17 13-3 7"/>',
  "cloud-lightning": '<path d="M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973"/><path d="m13 12-3 5h4l-3 5"/>',
  "cloud-snow":
    '<path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M8 15h.01"/><path d="M8 19h.01"/><path d="M12 17h.01"/><path d="M12 21h.01"/><path d="M16 15h.01"/><path d="M16 19h.01"/>',
  "cloud-fog":
    '<path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M16 17H7"/><path d="M17 21H9"/>',
  "wind":
    '<path d="M12.8 19.6A2 2 0 1 0 14 16H2"/><path d="M17.5 8a2.5 2.5 0 1 1 2 4H2"/><path d="M9.8 4.4A2 2 0 1 1 11 8H2"/>',
};

const ICON_FOR = {
  clear: "sun",
  partly: "cloud-sun",
  cloudy: "cloud",
  overcast: "cloudy",
  drizzle: "cloud-drizzle",
  rain: "cloud-rain",
  "rain-wind": "cloud-rain-wind",
  storm: "cloud-lightning",
  snow: "cloud-snow",
  fog: "cloud-fog",
  wind: "wind",
};

export function createWeatherChip({ weather }) {
  const chip = $("#weather-chip");
  const readout = $("#weather-readout");
  const icon = $("#weather-icon");
  const picker = $("#weather-picker");
  const gpsBtn = $("#wp-gps");
  const searchInput = $("#wp-search");
  const results = $("#wp-results");
  const note = $("#wp-note");
  const current = $("#wp-current");
  const currentName = $("#wp-current-name");
  let searchTimer = 0;

  function render() {
    const r = weather.readout();
    chip.classList.toggle("on", weather.isOn());
    icon.innerHTML = ICONS[ICON_FOR[r?.icon ?? "clear"]] ?? ICONS.cloud;

    if (!r) {
      readout.hidden = true;
      readout.textContent = "";
      chip.title = "Local weather — off. Pick a place to tint the mindspace.";
    } else {
      // temperature and place LEFT of the icon; the icon carries the condition,
      // so the reading needs no second symbol
      readout.hidden = false;
      readout.innerHTML = "";
      if (r.temp !== null) {
        const t = document.createElement("span");
        t.className = "wr-temp";
        t.textContent = `${r.temp}°`;
        readout.append(t, " ");
      }
      const p = document.createElement("span");
      p.className = "wr-place";
      p.textContent = r.place;
      readout.append(p);
      const status = weather.status();
      chip.title =
        `${r.place}${status ? ` — ${status}` : ""}. Position rounded to ~11 km, ` +
        `sent only to the weather service. Click to change or turn off.`;
    }

    const place = weather.getPlace();
    current.hidden = !place;
    if (place) currentName.textContent = place.name;
  }

  function openPicker(open) {
    picker.hidden = !open;
    chip.setAttribute("aria-expanded", String(open));
    if (open) {
      note.textContent = "";
      searchInput.focus();
    }
  }

  function renderResults(list) {
    results.replaceChildren(
      ...list.map((p) => {
        const li = document.createElement("li");
        li.textContent = p.name;
        if (p.detail) {
          const d = document.createElement("span");
          d.className = "wr-detail";
          d.textContent = p.detail;
          li.append(d);
        }
        li.addEventListener("click", async () => {
          await weather.setPlace(p);
          results.replaceChildren();
          searchInput.value = "";
          openPicker(false);
        });
        return li;
      })
    );
  }

  chip.addEventListener("click", (ev) => {
    ev.stopPropagation();
    openPicker(picker.hidden);
  });
  picker.addEventListener("click", (ev) => ev.stopPropagation());
  // click-away and Escape both close it — a popover that only closes via its
  // own trigger is a trap
  document.addEventListener("click", () => {
    if (!picker.hidden) openPicker(false);
  });
  addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !picker.hidden) openPicker(false);
  });

  gpsBtn.addEventListener("click", async () => {
    gpsBtn.classList.add("busy");
    note.textContent = "asking the browser for your location…";
    try {
      await weather.useGps();
      openPicker(false);
    } catch (err) {
      // never a dead end: the message names the search box right below it
      note.textContent = err.message;
    } finally {
      gpsBtn.classList.remove("busy");
    }
  });

  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = searchInput.value;
    if (q.trim().length < 2) {
      results.replaceChildren();
      return;
    }
    searchTimer = setTimeout(async () => {
      const list = await weather.search(q);
      renderResults(list);
      note.textContent = list.length === 0 ? "nothing found — try another spelling" : "";
    }, SEARCH_DEBOUNCE_MS);
  });

  $("#wp-clear").addEventListener("click", async () => {
    await weather.clear();
    openPicker(false);
  });

  render();
  return { render };
}
