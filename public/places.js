// Turns GPS coordinates into place names, entirely on this device, using a
// built-in list of about 49,000 towns and cities of 5,000+ people
// (cities.tsv, from GeoNames, CC BY 4.0). Nothing is sent to an outside service.

let cells = null; // "lat,lon" (whole degrees) -> cities in that square
let loading = null;
const countryNames = (() => {
  try {
    return new Intl.DisplayNames([navigator.language || "en", "en"], { type: "region" });
  } catch {
    return null;
  }
})();
// English country names, built in so they work even where the browser can't name countries.
const COUNTRIES = {"AD": "Andorra", "AE": "United Arab Emirates", "AF": "Afghanistan", "AG": "Antigua & Barbuda", "AL": "Albania", "AM": "Armenia", "AO": "Angola", "AR": "Argentina", "AS": "American Samoa", "AT": "Austria", "AU": "Australia", "AW": "Aruba", "AX": "Åland Islands", "AZ": "Azerbaijan", "BA": "Bosnia & Herzegovina", "BB": "Barbados", "BD": "Bangladesh", "BE": "Belgium", "BF": "Burkina Faso", "BG": "Bulgaria", "BH": "Bahrain", "BI": "Burundi", "BJ": "Benin", "BL": "St. Barthélemy", "BN": "Brunei", "BO": "Bolivia", "BR": "Brazil", "BS": "Bahamas", "BT": "Bhutan", "BW": "Botswana", "BY": "Belarus", "BZ": "Belize", "CA": "Canada", "CD": "Congo - Kinshasa", "CF": "Central African Republic", "CG": "Congo - Brazzaville", "CH": "Switzerland", "CI": "Côte d’Ivoire", "CK": "Cook Islands", "CL": "Chile", "CM": "Cameroon", "CN": "China", "CO": "Colombia", "CR": "Costa Rica", "CU": "Cuba", "CV": "Cape Verde", "CW": "Curaçao", "CY": "Cyprus", "CZ": "Czechia", "DE": "Germany", "DJ": "Djibouti", "DK": "Denmark", "DM": "Dominica", "DO": "Dominican Republic", "DZ": "Algeria", "EC": "Ecuador", "EE": "Estonia", "EG": "Egypt", "EH": "Western Sahara", "ER": "Eritrea", "ES": "Spain", "ET": "Ethiopia", "FI": "Finland", "FJ": "Fiji", "FM": "Micronesia", "FO": "Faroe Islands", "FR": "France", "GA": "Gabon", "GB": "United Kingdom", "GD": "Grenada", "GE": "Georgia", "GF": "French Guiana", "GG": "Guernsey", "GH": "Ghana", "GI": "Gibraltar", "GL": "Greenland", "GM": "Gambia", "GN": "Guinea", "GP": "Guadeloupe", "GQ": "Equatorial Guinea", "GR": "Greece", "GT": "Guatemala", "GU": "Guam", "GW": "Guinea-Bissau", "GY": "Guyana", "HK": "Hong Kong SAR China", "HN": "Honduras", "HR": "Croatia", "HT": "Haiti", "HU": "Hungary", "ID": "Indonesia", "IE": "Ireland", "IL": "Israel", "IM": "Isle of Man", "IN": "India", "IQ": "Iraq", "IR": "Iran", "IS": "Iceland", "IT": "Italy", "JE": "Jersey", "JM": "Jamaica", "JO": "Jordan", "JP": "Japan", "KE": "Kenya", "KG": "Kyrgyzstan", "KH": "Cambodia", "KI": "Kiribati", "KM": "Comoros", "KN": "St. Kitts & Nevis", "KP": "North Korea", "KR": "South Korea", "KW": "Kuwait", "KY": "Cayman Islands", "KZ": "Kazakhstan", "LA": "Laos", "LB": "Lebanon", "LC": "St. Lucia", "LI": "Liechtenstein", "LK": "Sri Lanka", "LR": "Liberia", "LS": "Lesotho", "LT": "Lithuania", "LU": "Luxembourg", "LV": "Latvia", "LY": "Libya", "MA": "Morocco", "MC": "Monaco", "MD": "Moldova", "ME": "Montenegro", "MF": "St. Martin", "MG": "Madagascar", "MH": "Marshall Islands", "MK": "North Macedonia", "ML": "Mali", "MM": "Myanmar (Burma)", "MN": "Mongolia", "MO": "Macao SAR China", "MP": "Northern Mariana Islands", "MQ": "Martinique", "MR": "Mauritania", "MT": "Malta", "MU": "Mauritius", "MV": "Maldives", "MW": "Malawi", "MX": "Mexico", "MY": "Malaysia", "MZ": "Mozambique", "NA": "Namibia", "NC": "New Caledonia", "NE": "Niger", "NG": "Nigeria", "NI": "Nicaragua", "NL": "Netherlands", "NO": "Norway", "NP": "Nepal", "NZ": "New Zealand", "OM": "Oman", "PA": "Panama", "PE": "Peru", "PF": "French Polynesia", "PG": "Papua New Guinea", "PH": "Philippines", "PK": "Pakistan", "PL": "Poland", "PM": "St. Pierre & Miquelon", "PR": "Puerto Rico", "PS": "Palestinian Territories", "PT": "Portugal", "PW": "Palau", "PY": "Paraguay", "QA": "Qatar", "RE": "Réunion", "RO": "Romania", "RS": "Serbia", "RU": "Russia", "RW": "Rwanda", "SA": "Saudi Arabia", "SB": "Solomon Islands", "SC": "Seychelles", "SD": "Sudan", "SE": "Sweden", "SG": "Singapore", "SI": "Slovenia", "SK": "Slovakia", "SL": "Sierra Leone", "SM": "San Marino", "SN": "Senegal", "SO": "Somalia", "SR": "Suriname", "SS": "South Sudan", "ST": "São Tomé & Príncipe", "SV": "El Salvador", "SX": "Sint Maarten", "SY": "Syria", "SZ": "Eswatini", "TD": "Chad", "TG": "Togo", "TH": "Thailand", "TJ": "Tajikistan", "TL": "Timor-Leste", "TM": "Turkmenistan", "TN": "Tunisia", "TO": "Tonga", "TR": "Türkiye", "TT": "Trinidad & Tobago", "TW": "Taiwan", "TZ": "Tanzania", "UA": "Ukraine", "UG": "Uganda", "US": "United States", "UY": "Uruguay", "UZ": "Uzbekistan", "VC": "St. Vincent & Grenadines", "VE": "Venezuela", "VG": "British Virgin Islands", "VI": "U.S. Virgin Islands", "VN": "Vietnam", "VU": "Vanuatu", "WS": "Samoa", "XK": "Kosovo", "YE": "Yemen", "YT": "Mayotte", "ZA": "South Africa", "ZM": "Zambia", "ZW": "Zimbabwe"};
export const countryName = (cc) => {
  try {
    const n = countryNames?.of(cc);
    if (n && n !== cc) return n;
  } catch {}
  return COUNTRIES[cc] || cc;
};

export function loadCities() {
  loading ||= fetch("/cities.tsv")
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error("The place list didn't load."))))
    .then((text) => {
      const map = new Map();
      for (const line of text.split("\n")) {
        const [name, cc, la, lo, pop] = line.split("\t");
        const lat = Number(la), lon = Number(lo);
        if (!name || Number.isNaN(lat)) continue;
        const key = `${Math.floor(lat)},${Math.floor(lon)}`;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push({ name, cc, lat, lon, pop: Number(pop) || 1 });
      }
      cells = map;
    })
    .catch((err) => {
      loading = null;
      throw err;
    });
  return loading;
}
export const citiesReady = () => !!cells;

function km(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180;
  const x = (bLon - aLon) * r * Math.cos(((aLat + bLat) / 2) * r);
  const y = (bLat - aLat) * r;
  return Math.sqrt(x * x + y * y) * 6371;
}

// The town or city for a spot. A photo taken in a suburb or a few kilometres
// outside a big city is named after the big city, the way people describe it.
const placeCache = new Map();
export function placeAt(lat, lon) {
  if (!cells) return null;
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (placeCache.has(key)) return placeCache.get(key);
  const near = [];
  const la = Math.floor(lat), lo = Math.floor(lon);
  for (let ring = 1; ring <= 3 && !near.length; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (const c of cells.get(`${la + dy},${lo + dx}`) || []) near.push({ c, d: km(lat, lon, c.lat, c.lon) });
      }
    }
  }
  let place = null;
  if (near.length) {
    near.sort((a, b) => a.d - b.d);
    const best = near[0];
    const reach = (c) => (c.pop >= 1000 ? 15 : c.pop >= 300 ? 12 : Math.min(12, Math.max(8, best.d * 2.5)));
    const bigger = near.filter((n) => n.d <= reach(n.c) && n.c.pop >= best.c.pop * 5).sort((a, b) => b.c.pop - a.c.pop)[0];
    const c = (bigger || best).c;
    place = { city: c.name, cc: c.cc, country: countryName(c.cc), lat: c.lat, lon: c.lon, label: `${c.name}, ${countryName(c.cc)}` };
  }
  placeCache.set(key, place);
  return place;
}

// A short name for a group of photos: the city if most were taken there, else
// the country, else the two main countries.
export function describe(places) {
  const list = places.filter(Boolean);
  if (!list.length) return null;
  const count = (key) => {
    const m = new Map();
    for (const p of list) m.set(p[key], (m.get(p[key]) || 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  };
  const cities = count("city");
  if (cities[0][1] >= list.length * 0.75) return cities[0][0];
  const countries = count("country");
  if (countries[0][1] >= list.length * 0.8) return countries[0][0];
  if (countries.length >= 2 && countries[0][1] + countries[1][1] >= list.length * 0.8) {
    return [countries[0][0], countries[1][0]].sort().join(" and ");
  }
  return null;
}

const DAY = 86400000;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function monthSpan(a, b) {
  const A = new Date(a), B = new Date(b);
  if (A.getFullYear() === B.getFullYear() && A.getMonth() === B.getMonth()) return `${MONTHS[A.getMonth()]} ${A.getFullYear()}`;
  if (A.getFullYear() === B.getFullYear()) return `${MONTHS[A.getMonth()]}–${MONTHS[B.getMonth()]} ${B.getFullYear()}`;
  return `${MONTHS[A.getMonth()].slice(0, 3)} ${A.getFullYear()} – ${MONTHS[B.getMonth()].slice(0, 3)} ${B.getFullYear()}`;
}

// Trips: stretches of time spent away from home. Home is where most photos were
// taken; a trip is photos more than 80 km from it, with gaps of 3 days or less.
// photosAsc: oldest first. placeOf(photo) -> place or null.
export function findTrips(photosAsc, placeOf) {
  const located = photosAsc.map((p) => [p, placeOf(p)]).filter(([, pl]) => pl);
  const trips = [];
  if (located.length >= 20) {
    const tally = new Map();
    for (const [, pl] of located) {
      const entry = tally.get(pl.label) || [0, pl];
      entry[0]++;
      tally.set(pl.label, entry);
    }
    const home = [...tally.values()].sort((a, b) => b[0] - a[0])[0][1];
    let cur = null;
    for (const [p, pl] of located) {
      const away = km(home.lat, home.lon, pl.lat, pl.lon) > 80;
      if (!away) continue;
      if (cur && p.t - cur.end <= 3 * DAY) cur.end = p.t;
      else {
        if (cur) trips.push(cur);
        cur = { start: p.t, end: p.t };
      }
    }
    if (cur) trips.push(cur);
  }
  // Without locations there's no way to tell a trip from a busy week at home,
  // so trips only appear once photos have locations (Memories covers the rest).
  return trips
    .map((tr) => {
      const photos = photosAsc.filter((p) => p.t >= tr.start && p.t <= tr.end);
      const where = describe(photos.map(placeOf));
      const when = monthSpan(tr.start, tr.end);
      return { key: `trip-${tr.start}`, name: where ? `${where}, ${when}` : `Trip, ${when}`, photos, start: tr.start };
    })
    .filter((tr) => tr.photos.length >= 8)
    .sort((a, b) => b.start - a.start);
}
