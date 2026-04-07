import { useState, useCallback, useEffect, useRef } from "react";

// ─── API KEYS (from .env) ─────────────────────────────────────────────────────
const GOOGLE_KEY     = import.meta.env.VITE_GOOGLE_KEY;

// Pre-load the Maps JS SDK immediately so Places autocomplete is ready by the
// time the user starts typing — not deferred until the map renders.
// eslint-disable-next-line no-use-before-define
setTimeout(() => loadMapsJs(GOOGLE_KEY), 0);

// Fixed transit fare (TransLink Zone 1)
const TRANSIT_FARE = 3.15;

// Driving cost: Vancouver avg gas ~$1.75/L, ~10L/100km = $0.175/km
// + ~$0.05/km wear & tear = $0.225/km total
const DRIVING_COST_PER_KM = 0.225;

// CO₂ kg per km by mode
const CO2_PER_KM = { driving: 0.21, transit: 0.04, walking: 0, bicycling: 0 };

// ─── GEOCODING ────────────────────────────────────────────────────────────────

async function geocode(address) {
  const url = `/maps-api/maps/api/geocode/json?address=${encodeURIComponent(address)}&region=ca&key=${GOOGLE_KEY}`;
  const res  = await fetch(url);
  const data = await res.json();
  if (data.status !== "OK") throw new Error(`Geocode failed: ${data.status}`);
  const loc = data.results[0].geometry.location;
  return { lat: loc.lat, lng: loc.lng, formatted: data.results[0].formatted_address };
}

// ─── GOOGLE DIRECTIONS ────────────────────────────────────────────────────────

async function fetchGoogleDirections(originStr, destStr, mode, extra = {}) {
  const params = new URLSearchParams({
    origin:       originStr,
    destination:  destStr,
    mode,
    alternatives: "true",
    region:       "ca",
    key:          GOOGLE_KEY,
    ...(mode === "transit" ? { transit_mode: "bus|subway|rail" } : {}),
    ...extra,
  });
  const res  = await fetch(`/maps-api/maps/api/directions/json?${params}`);
  const data = await res.json();
  if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
    throw new Error(`Directions API: ${data.status}`);
  }
  return data.routes || [];
}

// ─── ROUTE PARSER ─────────────────────────────────────────────────────────────

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function modeIcon(travelMode, vehicleType) {
  if (travelMode === "WALKING")   return "🚶";
  if (travelMode === "DRIVING")   return "🚗";
  if (travelMode === "BICYCLING") return "🚴";
  if (travelMode === "TRANSIT") {
    const t = (vehicleType || "").toLowerCase();
    if (t.includes("subway") || t.includes("metro") || t.includes("skytrain")) return "🚇";
    if (t.includes("rail") || t.includes("commuter")) return "🚆";
    return "🚌";
  }
  return "🚌";
}

function parseGoogleRoute(googleRoute, routeType, idPrefix) {
  const leg = googleRoute.legs[0];

  const steps = leg.steps.map(step => {
    const td          = step.transit_details;
    const vehicleType = td?.line?.vehicle?.type;
    const lineName    = td?.line?.short_name || td?.line?.name || "";
    const headsign    = td?.headsign || "";
    const desc = td
      ? `${lineName ? lineName + " – " : ""}${headsign || stripHtml(step.html_instructions)}`
      : stripHtml(step.html_instructions);

    return {
      mode:          step.travel_mode.toLowerCase(),
      desc,
      duration:      Math.round(step.duration.value / 60),
      distanceKm:    Math.round(step.distance.value / 100) / 10,
      icon:          modeIcon(step.travel_mode, vehicleType),
      transitLine:   lineName,
      departureStop: td?.departure_stop?.name,
      arrivalStop:   td?.arrival_stop?.name,
    };
  });

  const walkMin   = steps.filter(s => s.mode === "walking").reduce((s, x) => s + x.duration, 0);
  const transfers = Math.max(0, steps.filter(s => s.mode === "transit").length - 1);

  const co2 = leg.steps.reduce((sum, step) => {
    const km     = step.distance.value / 1000;
    const factor = CO2_PER_KM[step.travel_mode.toLowerCase()] ?? 0.1;
    return sum + km * factor;
  }, 0);

  return {
    id:           `${idPrefix}_${Math.random().toString(36).slice(2, 7)}`,
    label:        googleRoute.summary || `${routeType} route`,
    type:         routeType,
    duration:     Math.round(leg.duration.value / 60),
    distanceKm:   Math.round(leg.distance.value / 100) / 10,
    walkMin,
    cost:         routeType === "transit" ? TRANSIT_FARE
                : routeType === "driving"  ? Math.round(leg.distance.value / 1000 * DRIVING_COST_PER_KM * 100) / 100
                : TRANSIT_FARE,
    transfers,
    steps,
    co2:          Math.round(co2 * 10) / 10,
    source:       "google",
    departureTime: leg.departure_time?.text || null,
    arrivalTime:   leg.arrival_time?.text   || null,
    rawRoute:     googleRoute,
  };
}

// ─── MAIN ROUTE FETCHER ───────────────────────────────────────────────────────

async function fetchAllRoutes(originStr, destStr, setLoadingMsg) {
  const routes = [];

  setLoadingMsg("Geocoding addresses…");
  const [originCoords, destCoords] = await Promise.all([
    geocode(originStr),
    geocode(destStr),
  ]);

  setLoadingMsg("Fetching transit & driving routes from Google Maps…");
  const [transitRes, drivingRes] = await Promise.allSettled([
    fetchGoogleDirections(originStr, destStr, "transit"),
    fetchGoogleDirections(originStr, destStr, "driving"),
  ]);

  if (transitRes.status === "fulfilled")
    transitRes.value.forEach(r => routes.push(parseGoogleRoute(r, "transit", "transit")));
  if (drivingRes.status === "fulfilled")
    drivingRes.value.forEach(r => routes.push(parseGoogleRoute(r, "driving", "driving")));

  if (routes.length === 0) throw new Error("No routes found between those locations.");

  return { routes, originCoords, destCoords };
}

// ─── WEIGHTED COST FUNCTION ───────────────────────────────────────────────────

function computeRouteCost(route, prefs, w) {
  const timeScore     = route.duration / 90;
  const walkScore     = route.walkMin  / 30;
  const moneyScore    = route.cost / 20;
  const transferScore = route.transfers / 4;
  const ecoScore      = route.co2 / 15;
  return w.time * timeScore + w.walk * walkScore + w.money * moneyScore
       + w.transfers * transferScore + w.eco * ecoScore;
}

function buildWeights(prefs) {
  const total = prefs.timeWeight + prefs.walkWeight + prefs.costWeight + prefs.ecoWeight;
  return {
    time: prefs.timeWeight / total, walk: prefs.walkWeight / total,
    money: prefs.costWeight / total, eco: prefs.ecoWeight / total,
    transfers: 0.08,
  };
}

function rankRoutes(routes, prefs, w) {
  return [...routes].map(r => ({ ...r, score: computeRouteCost(r, prefs, w) }))
    .sort((a, b) => a.score - b.score);
}

// ─── BAYESIAN UPDATE ──────────────────────────────────────────────────────────

function bayesianUpdate(prefs, chosen, all) {
  const np = { ...prefs };
  const STEP = 6, DECAY = 0.97;
  if (chosen.walkMin <= 5)
    np.walkWeight = Math.min(100, np.walkWeight + STEP);
  if (chosen.duration === Math.min(...all.map(r => r.duration)))
    np.timeWeight = Math.min(100, np.timeWeight + STEP);
  if (chosen.co2 < 1.5)
    np.ecoWeight = Math.min(100, np.ecoWeight + STEP);
  if (chosen.cost === Math.min(...all.map(r => r.cost)))
    np.costWeight = Math.min(100, np.costWeight + STEP);
  ["timeWeight","walkWeight","costWeight","ecoWeight"].forEach(k => {
    np[k] = np[k] * DECAY + prefs[k] * (1 - DECAY);
  });
  return np;
}

// ─── DEFAULT PREFERENCES ─────────────────────────────────────────────────────

const DEFAULT_PREFS = {
  timeWeight: 60, walkWeight: 40, costWeight: 50, ecoWeight: 20,
};

// ─── GOOGLE MAPS JS API LOADER ────────────────────────────────────────────────

let _mapsApiPromise = null;
function loadMapsJs(key) {
  if (_mapsApiPromise) return _mapsApiPromise;
  _mapsApiPromise = new Promise(resolve => {
    if (window.google?.maps?.Map) { resolve(); return; }
    window.__gmapsReady = resolve;
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places&callback=__gmapsReady&loading=async`;
    document.head.appendChild(s);
  });
  return _mapsApiPromise;
}

const DARK_MAP_STYLES = [
  { elementType: "geometry",                stylers: [{ color: "#0d1b2a" }] },
  { elementType: "labels.text.fill",        stylers: [{ color: "#64748b" }] },
  { elementType: "labels.text.stroke",      stylers: [{ color: "#0a1628" }] },
  { featureType: "road",                    elementType: "geometry",          stylers: [{ color: "#1e3348" }] },
  { featureType: "road.highway",            elementType: "geometry",          stylers: [{ color: "#253f5a" }] },
  { featureType: "road",                    elementType: "labels.text.fill",  stylers: [{ color: "#94a3b8" }] },
  { featureType: "water",                   elementType: "geometry",          stylers: [{ color: "#050d1a" }] },
  { featureType: "transit",                 elementType: "geometry",          stylers: [{ color: "#1e3348" }] },
  { featureType: "poi",                     stylers: [{ visibility: "off" }] },
  { featureType: "administrative",          elementType: "geometry",          stylers: [{ color: "#1e3348" }] },
  { featureType: "administrative.locality", elementType: "labels.text.fill",  stylers: [{ color: "#94a3b8" }] },
  { featureType: "landscape",               elementType: "geometry",          stylers: [{ color: "#0d1b2a" }] },
];

// ─── POLYLINE DECODER ─────────────────────────────────────────────────────────

function decodePolyline(encoded) {
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

// ─── GOOGLE MAPS ROUTE MAP ────────────────────────────────────────────────────

function RouteMap({ route, userLocation, bottomPadding = 50 }) {
  const containerRef      = useRef(null);
  const mapRef            = useRef(null);
  const locMarkerRef      = useRef(null);
  const locCircleRef      = useRef(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadMapsJs(GOOGLE_KEY).then(() => {
      if (cancelled || !containerRef.current || mapRef.current) return;
      mapRef.current = new window.google.maps.Map(containerRef.current, {
        zoom: 12,
        center: { lat: 49.2827, lng: -123.1207 },
        styles: DARK_MAP_STYLES,
        zoomControl: true,
        streetViewControl: false,
        mapTypeControl: false,
        fullscreenControl: false,
      });
      setReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!ready || !route?.rawRoute || !mapRef.current) return;
    const map = mapRef.current;
    const leg = route.rawRoute.legs[0];
    const overlays = [];

    if (route.type === "transit") {
      leg.steps.forEach(step => {
        const pts = step.polyline?.points ? decodePolyline(step.polyline.points) : [];
        if (!pts.length) return;
        const isWalk = step.travel_mode === "WALKING";
        overlays.push(new window.google.maps.Polyline({
          path: pts,
          strokeColor:   isWalk ? "#64748b" : "#3b82f6",
          strokeWeight:  isWalk ? 3 : 5,
          strokeOpacity: isWalk ? 0.55 : 0.9,
          map,
        }));
      });
    } else {
      const pts = route.rawRoute.overview_polyline?.points
        ? decodePolyline(route.rawRoute.overview_polyline.points) : [];
      if (pts.length) {
        overlays.push(new window.google.maps.Polyline({
          path: pts, strokeColor: "#f59e0b",
          strokeWeight: 5, strokeOpacity: 0.9, map,
        }));
      }
    }

    [
      { pos: leg.start_location, color: "#22c55e" },
      { pos: leg.end_location,   color: "#ef4444" },
    ].forEach(({ pos, color }) => {
      overlays.push(new window.google.maps.Marker({
        position: pos, map,
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE,
          scale: 8, fillColor: color, fillOpacity: 1,
          strokeColor: "#fff", strokeWeight: 2,
        },
      }));
    });

    const bounds = new window.google.maps.LatLngBounds();
    const overviewPts = route.rawRoute.overview_polyline?.points
      ? decodePolyline(route.rawRoute.overview_polyline.points) : [];
    (overviewPts.length ? overviewPts : [leg.start_location, leg.end_location])
      .forEach(p => bounds.extend(p));
    map.fitBounds(bounds, { top: 50, right: 50, bottom: bottomPadding, left: 50 });

    return () => overlays.forEach(o => o.setMap(null));
  }, [ready, route, bottomPadding]);

  useEffect(() => {
    if (!ready || !userLocation || !mapRef.current) return;
    const pos = { lat: userLocation.lat, lng: userLocation.lng };
    if (locMarkerRef.current) {
      locMarkerRef.current.setPosition(pos);
    } else {
      locMarkerRef.current = new window.google.maps.Marker({
        position: pos, map: mapRef.current, title: "Your location", zIndex: 999,
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE,
          scale: 9, fillColor: "#3b82f6", fillOpacity: 1,
          strokeColor: "#ffffff", strokeWeight: 2.5,
        },
      });
    }
    if (locCircleRef.current) {
      locCircleRef.current.setCenter(pos);
      locCircleRef.current.setRadius(userLocation.accuracy ?? 40);
    } else {
      locCircleRef.current = new window.google.maps.Circle({
        center: pos, radius: userLocation.accuracy ?? 40, map: mapRef.current,
        fillColor: "#3b82f6", fillOpacity: 0.12,
        strokeColor: "#3b82f6", strokeOpacity: 0.35, strokeWeight: 1, zIndex: 998,
      });
    }
  }, [ready, userLocation]);

  return (
    <div ref={containerRef} style={{ width:"100%", height:"100%", background:"#0d1b2a" }} />
  );
}

// ─── SLIDER ───────────────────────────────────────────────────────────────────

function Slider({ label, value, onChange, color, icon, desc }) {
  return (
    <div style={{ marginBottom:"20px" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"5px" }}>
        <div style={{ display:"flex", alignItems:"center", gap:"8px" }}>
          <span>{icon}</span>
          <span style={{ fontSize:"13px", fontWeight:"600", color:"#cbd5e1" }}>{label}</span>
        </div>
        <span style={{ fontSize:"12px", fontWeight:"700", color, background:`${color}20`, padding:"2px 8px", borderRadius:"20px" }}>{value}</span>
      </div>
      {desc && <p style={{ fontSize:"11px", color:"#475569", margin:"0 0 7px 24px" }}>{desc}</p>}
      <div style={{ position:"relative", height:"6px" }}>
        <div style={{ position:"absolute", inset:0, background:"#1e293b", borderRadius:"3px" }} />
        <div style={{ position:"absolute", left:0, top:0, bottom:0, width:`${value}%`,
          background:`linear-gradient(90deg,${color}80,${color})`, borderRadius:"3px", transition:"width .15s" }} />
        <input type="range" min={0} max={100} value={value} onChange={e=>onChange(+e.target.value)}
          style={{ position:"absolute", inset:0, width:"100%", height:"100%", opacity:0, cursor:"pointer", margin:0 }} />
      </div>
    </div>
  );
}

// ─── ROUTE CARD ───────────────────────────────────────────────────────────────

function RouteCard({ route, isOptimal, isSelected, onSelect, onConfirm }) {
  const [open, setOpen] = useState(false);
  const colors = { transit:"#3b82f6", driving:"#f59e0b", "drive+transit":"#10b981" };
  const col = colors[route.type] || "#64748b";

  return (
    <div onClick={()=>onSelect(route)} style={{
      background: isSelected?"#0f2235":"#0d1b2a",
      border:`1.5px solid ${isSelected?col:isOptimal?`${col}55`:"#1e3348"}`,
      borderRadius:"10px", padding:"8px 10px", cursor:"pointer",
      transition:"all .2s", position:"relative",
      boxShadow: isSelected?`0 0 18px ${col}30`:isOptimal?`0 0 10px ${col}15`:"none",
    }}>
      {isOptimal && (
        <div style={{ position:"absolute", top:0, right:0,
          background:`linear-gradient(135deg,${col},${col}bb)`,
          color:"#000", fontSize:"9px", fontWeight:"800",
          padding:"3px 8px", borderBottomLeftRadius:"8px",
          letterSpacing:".05em", fontFamily:"monospace" }}>★ OPTIMAL</div>
      )}

      <div style={{ display:"flex", alignItems:"center", gap:"8px", marginBottom:"6px" }}>
        <div style={{ width:"26px", height:"26px", borderRadius:"6px", background:`${col}20`,
          display:"flex", alignItems:"center", justifyContent:"center", fontSize:"14px", flexShrink:0 }}>
          {route.steps[0]?.icon}
        </div>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:"12px", fontWeight:"700", color:"#e2e8f0",
            overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{route.label}</div>
          <div style={{ fontSize:"10px", color:"#64748b" }}>
            {[...new Set(route.steps.map(s=>s.mode))].join(" → ")}
          </div>
        </div>
        <div style={{ textAlign:"right", flexShrink:0 }}>
          <div style={{ fontSize:"15px", fontWeight:"800", color:col, fontFamily:"monospace" }}>
            {route.duration}<span style={{ fontSize:"10px", fontWeight:"400", color:"#64748b" }}> min</span>
          </div>
          {route.arrivalTime && (
            <div style={{ fontSize:"10px", color:"#475569" }}>arr. {route.arrivalTime}</div>
          )}
        </div>
      </div>

      <div style={{ display:"flex", gap:"4px", flexWrap:"wrap" }}>
        {[
          [`${route.walkMin} min walk`, "#94a3b8"],
          [`${route.co2} kg CO₂`, route.co2<2?"#34d399":"#94a3b8"],
          [route.transfers===0?"Direct":`${route.transfers} transfer${route.transfers>1?"s":""}`, "#94a3b8"],
          [route.type === "driving"
            ? `⛽ $${route.cost.toFixed(2)}`
            : `🎟 $${route.cost.toFixed(2)}`,
           route.type === "driving" ? "#f59e0b" : "#94a3b8"],
        ].map(([label,color],i)=>(
          <div key={i} style={{ fontSize:"10px", color, background:"#0a1628",
            padding:"2px 6px", borderRadius:"5px" }}>{label}</div>
        ))}
      </div>

      <div style={{ marginTop:"6px", display:"flex", alignItems:"center", gap:"8px" }}>
        <span style={{ fontSize:"10px", color:"#475569", fontFamily:"monospace", width:"62px" }}>
          {(1-route.score).toFixed(3)}
        </span>
        <div style={{ flex:1, height:"3px", background:"#1e293b", borderRadius:"2px" }}>
          <div style={{ height:"100%", width:`${(1-route.score)*100}%`,
            background:`linear-gradient(90deg,${col}60,${col})`,
            borderRadius:"2px", transition:"width .5s" }} />
        </div>
      </div>

      <button onClick={e=>{e.stopPropagation();setOpen(!open)}} style={{
        marginTop:"6px", background:"none", border:"none", color:"#475569",
        fontSize:"10px", cursor:"pointer", display:"flex", alignItems:"center", gap:"4px", padding:0
      }}>
        <span style={{ display:"inline-block", transition:"transform .2s", transform:open?"rotate(180deg)":"none" }}>▾</span>
        {open?"Hide":"Show"} steps
      </button>

      {open && (
        <div style={{ marginTop:"6px", borderTop:"1px solid #1e293b", paddingTop:"8px" }}>
          {route.steps.map((s,i)=>(
            <div key={i} style={{ display:"flex", gap:"8px", marginBottom:"6px", alignItems:"flex-start" }}>
              <div style={{ width:"22px", height:"22px", borderRadius:"5px", background:"#0a1628",
                display:"flex", alignItems:"center", justifyContent:"center", fontSize:"12px", flexShrink:0 }}>
                {s.icon}
              </div>
              <div>
                <div style={{ fontSize:"11px", color:"#cbd5e1" }}>{s.desc}</div>
                <div style={{ fontSize:"10px", color:"#475569" }}>
                  {s.duration > 0 ? `${s.duration} min` : ""}
                  {s.departureStop ? ` · from ${s.departureStop}` : ""}
                  {s.arrivalStop   ? ` → ${s.arrivalStop}` : ""}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {isSelected && onConfirm && (
        <button
          onClick={e => { e.stopPropagation(); onConfirm(); }}
          style={{ marginTop:"8px", width:"100%", padding:"9px",
            background:`linear-gradient(135deg,${col},${col}cc)`,
            border:"none", borderRadius:"8px", color:"#fff",
            fontSize:"12px", fontWeight:"700", cursor:"pointer",
            boxShadow:`0 3px 12px ${col}40` }}>
          ✓ Go with this route
        </button>
      )}
    </div>
  );
}

// ─── SMALL HELPERS ────────────────────────────────────────────────────────────

function Notif({ msg, color }) {
  return (
    <div style={{ position:"fixed", top:"14px", left:"50%", transform:"translateX(-50%)",
      background:color, color:"#000", padding:"9px 18px", borderRadius:"10px",
      fontSize:"13px", fontWeight:"600", zIndex:1000,
      boxShadow:"0 4px 20px #00000060", whiteSpace:"nowrap", pointerEvents:"none" }}>
      {msg}
    </div>
  );
}

function NavBtn({ onClick, children, title }) {
  return (
    <button onClick={onClick} title={title} style={{ background:"#0d1b2a", border:"1px solid #1e3348",
      color:"#94a3b8", borderRadius:"10px", padding:"8px 10px",
      cursor:"pointer", fontSize:"16px", lineHeight:1 }}>{children}</button>
  );
}

function LocInput({ label, dot, value, onChange, placeholder }) {
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen]               = useState(false);
  const [activeIdx, setActiveIdx]     = useState(-1);
  const svcRef      = useRef(null);
  const debounceRef = useRef(null);

  const VANCOUVER_CENTER = { lat: 49.2827, lng: -123.1207 };

  function getSvc() {
    if (!svcRef.current && window.google?.maps?.places)
      svcRef.current = new window.google.maps.places.AutocompleteService();
    return svcRef.current;
  }

  function fetchSuggestions(input) {
    clearTimeout(debounceRef.current);
    if (!input || input.length < 2) { setSuggestions([]); return; }
    debounceRef.current = setTimeout(() => {
      const svc = getSvc();
      if (!svc) return;
      svc.getPlacePredictions(
        { input, componentRestrictions: { country: "ca" },
          locationBias: { center: VANCOUVER_CENTER, radius: 60000 } },
        (predictions, status) => {
          const ok = window.google.maps.places.PlacesServiceStatus.OK;
          setSuggestions(status === ok && predictions ? predictions.slice(0, 5) : []);
          setActiveIdx(-1);
        }
      );
    }, 200);
  }

  function pick(description) {
    onChange(description);
    setSuggestions([]);
    setOpen(false);
  }

  function handleKey(e) {
    if (!suggestions.length) return;
    if (e.key === "ArrowDown")  { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, suggestions.length - 1)); }
    if (e.key === "ArrowUp")    { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); }
    if (e.key === "Enter" && activeIdx >= 0) { e.preventDefault(); pick(suggestions[activeIdx].description); }
    if (e.key === "Escape")     { setSuggestions([]); setOpen(false); }
  }

  const showDrop = open && suggestions.length > 0;

  return (
    <div style={{ marginBottom:"4px", position:"relative" }}>
      <label style={{ fontSize:"10px", color:"#475569", display:"block",
        marginBottom:"5px", fontFamily:"monospace" }}>{label}</label>
      <div style={{ position:"relative" }}>
        <div style={{ position:"absolute", left:"12px", top:"50%", transform:"translateY(-50%)",
          width:"7px", height:"7px", borderRadius:"50%",
          background:dot, boxShadow:`0 0 7px ${dot}`, zIndex:1 }} />
        <input
          value={value} placeholder={placeholder}
          onChange={e => { onChange(e.target.value); fetchSuggestions(e.target.value); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={handleKey}
          style={{ width:"100%", padding:"11px 11px 11px 30px", background:"#0a1628",
            border:"1px solid #1e3348", borderRadius:"9px", color:"#e2e8f0",
            fontSize:"13px", outline:"none", boxSizing:"border-box",
            fontFamily:"'DM Sans',sans-serif" }}
        />
      </div>
      {showDrop && (
        <div style={{ position:"absolute", top:"100%", left:0, right:0, marginTop:"4px",
          background:"#0d1b2a", border:"1px solid #1e3348", borderRadius:"10px",
          overflow:"hidden", zIndex:200, boxShadow:"0 8px 30px #00000070" }}>
          {suggestions.map((s, i) => (
            <div key={s.place_id} onMouseDown={() => pick(s.description)}
              style={{ padding:"9px 12px", cursor:"pointer",
                background: i === activeIdx ? "#1e3348" : "transparent",
                borderBottom: i < suggestions.length - 1 ? "1px solid #1e334840" : "none" }}>
              <div style={{ fontSize:"13px", color:"#e2e8f0", fontWeight:"600" }}>
                {s.structured_formatting.main_text}
              </div>
              <div style={{ fontSize:"11px", color:"#475569", marginTop:"1px" }}>
                {s.structured_formatting.secondary_text}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <span style={{ display:"inline-block", width:"13px", height:"13px",
      border:"2px solid #ffffff30", borderTopColor:"#fff",
      borderRadius:"50%", animation:"spin .8s linear infinite" }} />
  );
}

const globalStyles = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700;800&family=DM+Mono&display=swap');
  *, *::before, *::after { box-sizing: border-box; }
  html, body, #root { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; -webkit-overflow-scrolling: touch; }
  input::placeholder { color: #334155; }
  input { caret-color: #3b82f6; }
  @keyframes spin { to { transform: rotate(360deg); } }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: #0a1628; }
  ::-webkit-scrollbar-thumb { background: #1e3348; border-radius: 2px; }
`;

// ─── LOCAL STORAGE HOOK ───────────────────────────────────────────────────────

function useLocalStorage(key, defaultValue) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored !== null ? JSON.parse(stored) : defaultValue;
    } catch { return defaultValue; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }, [key, value]);
  return [value, setValue];
}

// ─── MOBILE HOOK ──────────────────────────────────────────────────────────────

function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.innerWidth < 640);
  useEffect(() => {
    const fn = () => setMobile(window.innerWidth < 640);
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, []);
  return mobile;
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────

export default function App() {
  const [prefs,        setPrefs]        = useLocalStorage("vt_prefs",    DEFAULT_PREFS);
  const [history,      setHistory]      = useLocalStorage("vt_history",   []);
  const [bayesLog,     setBayesLog]     = useLocalStorage("vt_bayeslog",  []);
  const [tripCount,    setTripCount]    = useLocalStorage("vt_tripcount", 0);
  const [activeTrip,   setActiveTrip]   = useLocalStorage("vt_activetrip", null);

  // Restore screen: results if active trip exists, main if returning user, setup if first time
  const [screen,       setScreen]       = useState(() =>
    activeTrip ? "results" : tripCount > 0 ? "main" : "setup"
  );
  const [origin,       setOrigin]       = useState(() => activeTrip?.origin ?? "");
  const [dest,         setDest]         = useState(() => activeTrip?.dest ?? "");
  const [loading,      setLoading]      = useState(false);
  const [loadingMsg,   setLoadingMsg]   = useState("");
  const [error,        setError]        = useState(null);
  const [routes,       setRoutes]       = useState(() => activeTrip?.routes ?? []);
  const [selected,     setSelected]     = useState(() => activeTrip?.selected ?? null);
  const [originCoords, setOriginCoords] = useState(() => activeTrip?.originCoords ?? null);
  const [notif,        setNotif]        = useState(null);
  const [userLocation, setUserLocation] = useState(null);
  const [geoError,     setGeoError]     = useState(null);
  const [sheetOpen,    setSheetOpen]    = useState(false);
  // "selecting" = choosing a route | "navigating" = confirmed, watching map
  const [tripState,    setTripState]    = useState(() => activeTrip?.tripState ?? "selecting");
  const isMobile  = useIsMobile();
  const sheetRef  = useRef(null);
  const dragRef   = useRef({ active: false, startY: 0, startH: 0 });

  const geoFilledRef = useRef(false);
  useEffect(() => {
    if (!navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      pos => {
        setUserLocation({
          lat:      pos.coords.latitude,
          lng:      pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
        setGeoError(null);
        // Auto-fill origin with reverse-geocoded address on first fix
        if (!geoFilledRef.current) {
          geoFilledRef.current = true;
          const latlng = `${pos.coords.latitude},${pos.coords.longitude}`;
          fetch(`/maps-api/maps/api/geocode/json?latlng=${latlng}&key=${GOOGLE_KEY}`)
            .then(r => r.json())
            .then(data => {
              if (data.results?.[0]) {
                setOrigin(prev => prev ? prev : data.results[0].formatted_address);
              }
            })
            .catch(() => {});
        }
      },
      err => {
        console.warn("Geolocation:", err.message);
        setGeoError(err.code === 1 ? null : "GPS unavailable");
      },
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 10000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  const weights = buildWeights(prefs);
  const setPref = key => val => setPrefs(p => ({ ...p, [key]: val }));

  const notify = (msg, color = "#22c55e") => {
    setNotif({ msg, color });
    setTimeout(() => setNotif(null), 4000);
  };

  // ── SEARCH ──────────────────────────────────────────────────────────────────
  const search = useCallback(async () => {
    if (!origin || !dest) return;
    setLoading(true); setError(null); setRoutes([]); setSelected(null);
    setTripState("selecting");
    try {
      const { routes: raw, originCoords: oc } =
        await fetchAllRoutes(origin, dest, setLoadingMsg);
      const ranked = rankRoutes(raw, prefs, weights);
      setRoutes(ranked);
      setSelected(ranked[0]);
      setOriginCoords(oc);
      setSheetOpen(false);
      setScreen("results");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false); setLoadingMsg("");
    }
  }, [origin, dest, prefs, weights]);

  // ── CONFIRM — stays on results screen, switches to navigating state ──────────
  const confirm = useCallback(() => {
    if (!selected) return;
    const updated = bayesianUpdate(prefs, selected, routes);
    const changes = [];
    ["timeWeight","walkWeight","costWeight","ecoWeight"].forEach(k => {
      if (Math.abs(updated[k] - prefs[k]) > 0.5)
        changes.push(`${k}: ${prefs[k].toFixed(1)} → ${updated[k].toFixed(1)}`);
    });
    setPrefs(updated);
    setBayesLog(l => [...l, {
      trip: tripCount + 1, route: selected.label, changes,
      date: new Date().toLocaleDateString("en-CA", { month:"short", day:"numeric" }),
    }]);
    setHistory(h => [{
      from: origin, to: dest,
      date: new Date().toLocaleDateString("en-CA", { month:"short", day:"numeric" }),
      chosen: selected.label,
    }, ...h]);
    setTripCount(t => t + 1);
    // Show notification, switch to navigating mode — do NOT leave the results screen
    notify("Preferences updated 🧠");
    setTripState("navigating");
    setSheetOpen(false);
    // Persist active trip so it survives refresh
    setActiveTrip({ origin, dest, routes, selected, originCoords, tripState: "navigating" });
  }, [selected, prefs, routes, origin, dest, tripCount, originCoords]);

  // ── NEW TRIP — resets back to main search screen ─────────────────────────────
  const startNewTrip = useCallback(() => {
    setScreen("main");
    setOrigin("");
    setDest("");
    setRoutes([]);
    setSelected(null);
    setTripState("selecting");
    setActiveTrip(null);
  }, []);

  const SUGGESTIONS = [
    ["Burnaby, BC",              "Vancouver General Hospital, Vancouver"],
    ["Metrotown, Burnaby, BC",   "Downtown Vancouver, BC"],
    ["Richmond Centre, BC",      "SFU Burnaby, BC"],
    ["Lougheed Town Centre, BC", "Vancouver International Airport"],
  ];

  // ── SETUP ────────────────────────────────────────────────────────────────────
  if (screen === "setup") return (
    <div style={{ height:"100vh", background:"#050d1a", display:"flex",
      alignItems:"flex-start", justifyContent:"center",
      padding:"20px", fontFamily:"'DM Sans',sans-serif",
      backgroundImage:"radial-gradient(ellipse at 20% 50%,#0d2040 0%,transparent 60%)",
      overflowY:"auto", WebkitOverflowScrolling:"touch" }}>
      <div style={{ width:"100%", maxWidth:"420px", margin:"auto 0" }}>
        <div style={{ textAlign:"center", marginBottom:"28px" }}>
          <div style={{ display:"inline-flex", alignItems:"center", justifyContent:"center",
            width:"60px", height:"60px", borderRadius:"16px",
            background:"linear-gradient(135deg,#1d4ed8,#0ea5e9)",
            marginBottom:"14px", boxShadow:"0 0 40px #1d4ed840", fontSize:"26px" }}>🚇</div>
          <h1 style={{ fontSize:"26px", fontWeight:"800", color:"#f1f5f9", margin:0, letterSpacing:"-0.02em" }}>TransitAI</h1>
          <p style={{ color:"#475569", fontSize:"12px", margin:"5px 0 0" }}>Metro Vancouver · Live Personalized Routes</p>
        </div>
        <div style={{ background:"#0d1b2a", borderRadius:"20px", border:"1px solid #1e3348",
          padding:"26px", boxShadow:"0 20px 60px #00000060" }}>
          <h2 style={{ fontSize:"15px", fontWeight:"700", color:"#e2e8f0", margin:"0 0 4px" }}>Set your preferences</h2>
          <p style={{ fontSize:"12px", color:"#475569", margin:"0 0 20px" }}>
            These define your cost function. The app adapts weights via Bayesian updates as you use it.
          </p>
          <Slider label="Speed Priority"   value={prefs.timeWeight}  onChange={setPref("timeWeight")}  color="#3b82f6" icon="⚡" desc="Prefer faster routes?" />
          <Slider label="Minimize Walking" value={prefs.walkWeight}  onChange={setPref("walkWeight")}  color="#f59e0b" icon="🚶" desc="Avoid long walks?" />
          <Slider label="Cost Sensitivity" value={prefs.costWeight}  onChange={setPref("costWeight")}  color="#22c55e" icon="💸" desc="Avoid expensive options?" />
          <Slider label="Eco Preference"   value={prefs.ecoWeight}   onChange={setPref("ecoWeight")}   color="#34d399" icon="🌱" desc="Prefer lower CO₂?" />
          <div style={{ background:"#0a1628", borderRadius:"10px", padding:"10px 12px",
            marginBottom:"18px", border:"1px solid #1e3348" }}>
            <div style={{ fontSize:"10px", color:"#475569", marginBottom:"7px", fontFamily:"monospace" }}>NORMALIZED COST WEIGHTS</div>
            <div style={{ display:"flex", gap:"6px", flexWrap:"wrap" }}>
              {[["time",weights.time,"#3b82f6"],["walk",weights.walk,"#f59e0b"],
                ["cost",weights.money,"#22c55e"],["eco",weights.eco,"#34d399"]].map(([k,v,c])=>(
                <div key={k} style={{ fontSize:"11px", color:c, background:`${c}15`,
                  padding:"2px 8px", borderRadius:"6px", fontFamily:"monospace" }}>
                  {k}: {v.toFixed(3)}
                </div>
              ))}
            </div>
          </div>
          <button onClick={()=>setScreen("main")} style={{
            width:"100%", padding:"13px",
            background:"linear-gradient(135deg,#1d4ed8,#0ea5e9)",
            border:"none", borderRadius:"12px", color:"#fff",
            fontSize:"14px", fontWeight:"700", cursor:"pointer", boxShadow:"0 4px 20px #1d4ed840"
          }}>Start Navigating →</button>
        </div>
      </div>
      <style>{globalStyles}</style>
    </div>
  );

  // ── HISTORY ──────────────────────────────────────────────────────────────────
  if (screen === "history") return (
    <div style={{ height:"100vh", background:"#050d1a", padding:"20px",
      fontFamily:"'DM Sans',sans-serif",
      backgroundImage:"radial-gradient(ellipse at 20% 50%,#0d2040 0%,transparent 60%)",
      overflowY:"auto", WebkitOverflowScrolling:"touch" }}>
      <div style={{ maxWidth:"480px", margin:"0 auto" }}>
        <div style={{ display:"flex", alignItems:"center", gap:"12px", marginBottom:"22px" }}>
          <button onClick={()=>setScreen("main")} style={{ background:"#0d1b2a",
            border:"1px solid #1e3348", color:"#94a3b8", borderRadius:"10px",
            padding:"7px 12px", cursor:"pointer", fontSize:"13px" }}>← Back</button>
          <h2 style={{ fontSize:"17px", fontWeight:"700", color:"#e2e8f0", margin:0 }}>Trip History</h2>
        </div>
        {bayesLog.length > 0 && (
          <div style={{ background:"#0d1b2a", borderRadius:"16px", border:"1px solid #1e3348",
            padding:"14px", marginBottom:"18px" }}>
            <div style={{ fontSize:"12px", fontWeight:"700", color:"#a78bfa", marginBottom:"10px" }}>
              🧠 Bayesian Learning Log
            </div>
            {bayesLog.map((e,i)=>(
              <div key={i} style={{ background:"#0a1628", borderRadius:"10px",
                padding:"9px 11px", marginBottom:"7px", border:"1px solid #1e3348" }}>
                <div style={{ fontSize:"12px", fontWeight:"600", color:"#cbd5e1" }}>
                  Trip #{e.trip} — {e.route}{" "}
                  <span style={{ color:"#475569", fontWeight:"400" }}>({e.date})</span>
                </div>
                {e.changes.length > 0
                  ? e.changes.map((c,j)=>(
                    <div key={j} style={{ fontSize:"11px", color:"#22c55e",
                      marginTop:"3px", fontFamily:"monospace" }}>↑ {c}</div>
                  ))
                  : <div style={{ fontSize:"11px", color:"#475569", marginTop:"3px" }}>No significant weight changes</div>
                }
              </div>
            ))}
          </div>
        )}
        <div style={{ background:"#0d1b2a", borderRadius:"16px", border:"1px solid #1e3348",
          padding:"14px", marginBottom:"18px" }}>
          <div style={{ fontSize:"11px", color:"#475569", marginBottom:"10px", fontFamily:"monospace" }}>
            CURRENT WEIGHTS ({tripCount} trips learned)
          </div>
          {[["Speed",prefs.timeWeight,"#3b82f6"],["Min Walk",prefs.walkWeight,"#f59e0b"],
            ["Cost",prefs.costWeight,"#22c55e"],["Eco",prefs.ecoWeight,"#34d399"]].map(([l,v,c])=>(
            <div key={l} style={{ marginBottom:"8px" }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:"3px" }}>
                <span style={{ fontSize:"12px", color:"#94a3b8" }}>{l}</span>
                <span style={{ fontSize:"12px", color:c, fontFamily:"monospace" }}>{v.toFixed(1)}</span>
              </div>
              <div style={{ height:"3px", background:"#1e293b", borderRadius:"2px" }}>
                <div style={{ height:"100%", width:`${v}%`, background:c, borderRadius:"2px" }} />
              </div>
            </div>
          ))}
        </div>
        {history.length > 0 && (
          <>
            <div style={{ fontSize:"11px", color:"#475569", marginBottom:"9px", fontFamily:"monospace" }}>
              PAST TRIPS ({history.length})
            </div>
            {history.map((t,i)=>(
              <div key={i} style={{ background:"#0d1b2a", borderRadius:"12px",
                border:"1px solid #1e3348", padding:"11px 13px", marginBottom:"7px",
                display:"flex", alignItems:"center", gap:"11px" }}>
                <div style={{ width:"34px", height:"34px", borderRadius:"9px", background:"#0a1628",
                  display:"flex", alignItems:"center", justifyContent:"center", fontSize:"17px" }}>
                  {t.chosen.includes("Drive")?"🚗":"🚇"}
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:"12px", fontWeight:"600", color:"#e2e8f0" }}>{t.from} → {t.to}</div>
                  <div style={{ fontSize:"11px", color:"#475569", marginTop:"2px" }}>{t.chosen}</div>
                </div>
                <div style={{ fontSize:"11px", color:"#475569" }}>{t.date}</div>
              </div>
            ))}
          </>
        )}
      </div>
      <style>{globalStyles}</style>
    </div>
  );

  // ── RESULTS ──────────────────────────────────────────────────────────────────
  if (screen === "results") {
    const isNavigating  = tripState === "navigating";
    const SHEET_PEEK_PX = 160;
    const SHEET_FULL_PX = Math.round(window.innerHeight * 0.70);
    const SHEET_PEEK    = `${SHEET_PEEK_PX}px`;
    const SHEET_FULL    = `${SHEET_FULL_PX}px`;

    function onDragStart(e) {
      const touch = e.touches[0];
      dragRef.current = {
        active: true,
        startY: touch.clientY,
        startH: sheetOpen ? SHEET_FULL_PX : SHEET_PEEK_PX,
      };
      if (sheetRef.current) sheetRef.current.style.transition = "none";
    }
    function onDragMove(e) {
      if (!dragRef.current.active) return;
      const delta = e.touches[0].clientY - dragRef.current.startY;
      const newH  = Math.max(80, Math.min(window.innerHeight * 0.92,
                      dragRef.current.startH - delta));
      if (sheetRef.current) sheetRef.current.style.height = `${newH}px`;
    }
    function onDragEnd(e) {
      if (!dragRef.current.active) return;
      dragRef.current.active = false;
      if (sheetRef.current) sheetRef.current.style.transition = "";
      const delta = e.changedTouches[0].clientY - dragRef.current.startY;
      // Small movement = tap → toggle; large movement = drag → snap
      if      (Math.abs(delta) < 8)              setSheetOpen(v => !v);
      else if (delta < -40 && !sheetOpen)        setSheetOpen(true);
      else if (delta >  40 &&  sheetOpen)        setSheetOpen(false);
      // else intermediate drag — snap back via React re-render
    }

    // Bottom action bar — changes based on tripState
    const actionBar = isNavigating ? (
      // Navigating state: show "navigating" status + new trip button
      <div style={{ display:"flex", flexDirection:"column", gap:"8px",
        padding:"12px 14px", paddingBottom:"calc(env(safe-area-inset-bottom, 0px) + 14px)",
        borderTop:"1px solid #1e3348",
        background:"#0a1628", flexShrink:0 }}>
        <div style={{ display:"flex", alignItems:"center", gap:"10px",
          padding:"10px 12px", background:"#0d2a0d", borderRadius:"10px",
          border:"1px solid #22c55e40" }}>
          <span style={{ fontSize:"16px" }}>🧭</span>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:"12px", fontWeight:"700", color:"#22c55e" }}>
              Navigating · {selected?.label}
            </div>
            <div style={{ fontSize:"11px", color:"#475569", marginTop:"1px" }}>
              {selected?.duration} min · {selected?.distanceKm} km
            </div>
          </div>
        </div>
        <button onClick={startNewTrip} style={{
          width:"100%", padding:"12px",
          background:"linear-gradient(135deg,#1d4ed8,#0ea5e9)",
          border:"none", borderRadius:"12px", color:"#fff",
          fontSize:"14px", fontWeight:"700", cursor:"pointer",
          boxShadow:"0 4px 20px #1d4ed840",
          display:"flex", alignItems:"center", justifyContent:"center", gap:"8px"
        }}>
          ＋ New Trip
        </button>
      </div>
    ) : (
      // Selecting state: show confirm button
      <div style={{ padding:"12px 14px", borderTop:"1px solid #1e3348",
        background:"#0a1628", flexShrink:0 }}>
        <button onClick={confirm} style={{
          width:"100%", padding:"13px",
          background:"linear-gradient(135deg,#1d4ed8,#0ea5e9)",
          border:"none", borderRadius:"12px", color:"#fff",
          fontSize:"14px", fontWeight:"700", cursor:"pointer",
          boxShadow:"0 4px 24px #1d4ed840"
        }}>✓ Go with {selected?.label}</button>
        {!isMobile && (
          <p style={{ textAlign:"center", fontSize:"11px", color:"#475569", margin:"7px 0 0" }}>
            Your choice updates your Bayesian preference weights
          </p>
        )}
      </div>
    );

    // Route list (read-only when navigating)
    const routeList = (
      <div style={{ flex:1, minHeight:0, overflowY:"auto", padding:"14px",
        display:"flex", flexDirection:"column", gap:"10px" }}>
        {routes.map((r,i) => (
          <RouteCard key={r.id} route={r} isOptimal={i===0}
            isSelected={selected?.id===r.id}
            onSelect={isNavigating ? ()=>{} : setSelected} />
        ))}
      </div>
    );

    const overlayBottom = isMobile ? "170px" : "12px";
    const mapOverlays = (
      <>
        {geoError && (
          <div style={{ position:"absolute", top:"12px", right:"12px",
            background:"#1c1400cc", backdropFilter:"blur(6px)",
            border:"1px solid #78350f", borderRadius:"8px",
            padding:"5px 10px", pointerEvents:"none",
            display:"flex", alignItems:"center", gap:"6px" }}>
            <span style={{ fontSize:"11px" }}>📍</span>
            <span style={{ fontSize:"11px", color:"#fbbf24" }}>{geoError}</span>
          </div>
        )}
        <div style={{ position:"absolute", top:"12px", left:"12px",
          background:"#050d1aee", backdropFilter:"blur(8px)",
          borderRadius:"10px", padding:"8px 12px", border:"1px solid #1e3348",
          pointerEvents:"none" }}>
          <div style={{ fontSize:"10px", color:"#64748b" }}>FROM</div>
          <div style={{ fontSize:"12px", fontWeight:"600", color:"#e2e8f0" }}>{origin}</div>
          <div style={{ fontSize:"10px", color:"#64748b", marginTop:"3px" }}>TO</div>
          <div style={{ fontSize:"12px", fontWeight:"600", color:"#e2e8f0" }}>{dest}</div>
        </div>
        {originCoords && (
          <div style={{ position:"absolute", bottom:overlayBottom, right:"12px",
            background:"#050d1aee", backdropFilter:"blur(6px)",
            borderRadius:"8px", padding:"5px 9px", border:"1px solid #1e3348",
            pointerEvents:"none" }}>
            <span style={{ fontSize:"10px", color:"#475569", fontFamily:"monospace" }}>
              {originCoords.lat.toFixed(4)}, {originCoords.lng.toFixed(4)}
            </span>
          </div>
        )}
        {selected && (
          <div style={{ position:"absolute", bottom:overlayBottom, left:"12px",
            background:"#050d1aee", backdropFilter:"blur(6px)",
            borderRadius:"8px", padding:"6px 10px", border:"1px solid #1e3348",
            pointerEvents:"none", display:"flex", alignItems:"center", gap:"6px" }}>
            <span style={{ fontSize:"13px" }}>{selected.steps[0]?.icon}</span>
            <span style={{ fontSize:"11px", fontWeight:"600", color:"#e2e8f0" }}>{selected.label}</span>
            <span style={{ fontSize:"11px", color:"#475569" }}>· {selected.duration} min</span>
            {isNavigating && <span style={{ fontSize:"10px", color:"#22c55e", fontWeight:"700" }}>● LIVE</span>}
          </div>
        )}
      </>
    );

    return (
      <div style={{ height:"100vh", width:"100vw", display:"flex", flexDirection:"column",
        background:"#050d1a", fontFamily:"'DM Sans',sans-serif",
        backgroundImage:"radial-gradient(ellipse at 20% 50%,#0d2040 0%,transparent 60%)" }}>
        {notif && <Notif {...notif} />}

        {/* Top bar */}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
          padding:"12px 18px", borderBottom:"1px solid #1e3348",
          background:"#0a1628", flexShrink:0 }}>
          <div style={{ display:"flex", alignItems:"center", gap:"14px" }}>
            <span style={{ fontSize:"20px" }}>🚇</span>
            <div>
              <div style={{ fontSize:"12px", fontWeight:"700", color:"#e2e8f0",
                maxWidth: isMobile ? "200px" : "none",
                overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                {origin} <span style={{ color:"#334155" }}>→</span> {dest}
              </div>
              <div style={{ fontSize:"11px", color:"#475569" }}>
                {isNavigating
                  ? "🧭 Navigating · tap map to explore"
                  : `${routes.length} routes · Live data · Google Maps`}
              </div>
            </div>
          </div>
          {isNavigating ? (
            <button onClick={startNewTrip} style={{ background:"#1d4ed8",
              border:"none", color:"#fff", borderRadius:"8px",
              padding:"7px 12px", cursor:"pointer", fontSize:"12px", fontWeight:"600" }}>
              ＋ New Trip
            </button>
          ) : (
            <button onClick={()=>setScreen("main")} style={{ background:"#0d1b2a",
              border:"1px solid #1e3348", color:"#94a3b8",
              borderRadius:"8px", padding:"7px 12px", cursor:"pointer", fontSize:"12px" }}>← Back</button>
          )}
        </div>

        {isMobile ? (
          <div style={{ flex:1, position:"relative", overflow:"hidden", display:"flex", flexDirection:"column" }}>
            {/* Map fills everything */}
            <div style={{ position:"absolute", inset:0 }}>
              <RouteMap route={selected} userLocation={userLocation}
                bottomPadding={sheetOpen ? SHEET_FULL_PX + 20 : SHEET_PEEK_PX + 20} />
              {mapOverlays}
            </div>

            {/* Floating navigating prompt — shown above safe area when navigating */}
            {isNavigating && (
              <div style={{
                position:"absolute", bottom:"calc(env(safe-area-inset-bottom, 0px) + 16px)",
                left:"14px", right:"14px",
                background:"#0d1b2a", border:"1px solid #1e3348",
                borderRadius:"16px", boxShadow:"0 8px 32px #00000080",
                overflow:"hidden",
              }}>
                {actionBar}
              </div>
            )}

            {/* Bottom sheet — tap/swipe to expand; hidden when navigating */}
            {!isNavigating && <div ref={sheetRef} style={{
              position:"absolute", bottom:0, left:0, right:0,
              height: sheetOpen ? SHEET_FULL : SHEET_PEEK,
              transition:"height 0.3s cubic-bezier(0.4,0,0.2,1)",
              background:"#0d1b2a", borderTop:"1px solid #1e3348",
              borderRadius:"16px 16px 0 0", boxShadow:"0 -8px 30px #00000060",
              display:"flex", flexDirection:"column", overflow:"hidden",
            }}>
              <>
                {/* Pill handle — tap or swipe to expand/collapse */}
                  <div
                    onTouchStart={onDragStart}
                    onTouchMove={onDragMove}
                    onTouchEnd={onDragEnd}
                    style={{ flexShrink:0, padding:"10px 0 8px", cursor:"pointer",
                      display:"flex", alignItems:"center", justifyContent:"center",
                      touchAction:"none" }}>
                    <div style={{ width:"36px", height:"4px", borderRadius:"2px", background:"#334155" }} />
                  </div>

                  {!sheetOpen ? (
                    /* Peek row */
                    selected && (
                      <div style={{ flexShrink:0, padding:"0 14px 10px",
                        display:"flex", alignItems:"center", gap:"10px" }}>
                        <span style={{ fontSize:"20px", flexShrink:0 }}>{selected.steps[0]?.icon}</span>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontSize:"13px", fontWeight:"700", color:"#e2e8f0",
                            overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                            {selected.label}
                          </div>
                          <div style={{ fontSize:"11px", color:"#64748b", marginTop:"1px" }}>
                            {selected.duration} min · {routes.length} routes — swipe up
                          </div>
                        </div>
                        <span style={{ color:"#475569", fontSize:"18px", flexShrink:0 }}>›</span>
                      </div>
                    )
                  ) : (
                    /* Expanded: scrollable list; confirm button lives inside the selected card */
                    <div style={{ flex:1, minHeight:0, overflowY:"auto",
                      WebkitOverflowScrolling:"touch",
                      padding:"4px 12px",
                      paddingBottom:"calc(env(safe-area-inset-bottom, 0px) + 80px)",
                      display:"flex", flexDirection:"column", gap:"10px" }}>
                      {routes.map((r,i) => (
                        <RouteCard key={r.id} route={r} isOptimal={i===0}
                          isSelected={selected?.id===r.id}
                          onSelect={setSelected}
                          onConfirm={confirm} />
                      ))}
                    </div>
                  )}
                </>
            </div>}
          </div>
        ) : (
          /* ── DESKTOP: side-by-side ── */
          <div style={{ display:"flex", flex:1, overflow:"hidden" }}>
            {/* Left panel: route list + action bar */}
            <div style={{ width:"320px", flexShrink:0,
              borderRight:"1px solid #1e3348",
              display:"flex", flexDirection:"column", overflow:"hidden" }}>
              {routeList}
              {actionBar}
            </div>
            {/* Right: map */}
            <div style={{ flex:1, position:"relative", overflow:"hidden" }}>
              <RouteMap route={selected} userLocation={userLocation} bottomPadding={50} />
              {mapOverlays}
            </div>
          </div>
        )}

        <style>{globalStyles}</style>
      </div>
    );
  }

  // ── MAIN ─────────────────────────────────────────────────────────────────────
  return (
    <div style={{ height:"100vh", background:"#050d1a", fontFamily:"'DM Sans',sans-serif",
      backgroundImage:"radial-gradient(ellipse at 20% 50%,#0d2040 0%,transparent 60%)",
      overflowY:"auto", WebkitOverflowScrolling:"touch" }}>
      {notif && <Notif {...notif} />}
      <div style={{ maxWidth:"480px", margin:"0 auto",
        padding: isMobile ? "14px 14px" : "22px 18px",
        paddingBottom:"calc(env(safe-area-inset-bottom, 0px) + 30px)" }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
          marginBottom: isMobile ? "16px" : "26px" }}>
          <div>
            <h1 style={{ fontSize: isMobile ? "19px" : "22px", fontWeight:"800", color:"#f1f5f9", margin:0, letterSpacing:"-0.02em" }}>
              🚇 TransitAI
            </h1>
            <p style={{ fontSize:"11px", color:"#475569", margin:"3px 0 0" }}>
              Metro Vancouver · {tripCount} trips learned
            </p>
          </div>
          <div style={{ display:"flex", gap:"7px" }}>
            <NavBtn onClick={()=>setScreen("history")} title="History">🕐</NavBtn>
            <NavBtn onClick={()=>setScreen("setup")}   title="Settings">⚙️</NavBtn>
          </div>
        </div>

        <div style={{ background:"#0d1b2a", borderRadius: isMobile ? "16px" : "20px",
          border:"1px solid #1e3348",
          padding: isMobile ? "14px" : "18px",
          marginBottom: isMobile ? "12px" : "18px",
          boxShadow:"0 8px 40px #00000050" }}>
          <LocInput label="FROM" dot="#22c55e" value={origin} onChange={setOrigin} placeholder="Enter origin address…" />
          <div style={{ display:"flex", alignItems:"center", margin:"8px 0", gap:"10px" }}>
            <div style={{ flex:1, height:"1px", background:"#1e3348" }} />
            <button onClick={()=>{const t=origin;setOrigin(dest);setDest(t)}}
              style={{ background:"#0a1628", border:"1px solid #1e3348", color:"#64748b",
                borderRadius:"8px", padding:"5px 10px", cursor:"pointer", fontSize:"14px" }}>⇅</button>
            <div style={{ flex:1, height:"1px", background:"#1e3348" }} />
          </div>
          <LocInput label="TO" dot="#ef4444" value={dest} onChange={setDest} placeholder="Enter destination address…" />
          {error && (
            <div style={{ marginTop:"10px", padding:"9px 12px", background:"#2d1515",
              border:"1px solid #7f1d1d", borderRadius:"9px", fontSize:"12px", color:"#fca5a5" }}>
              ⚠ {error}
            </div>
          )}
          <button onClick={search} disabled={!origin||!dest||loading} style={{
            marginTop: isMobile ? "10px" : "14px", width:"100%", padding: isMobile ? "11px" : "13px",
            background:(!origin||!dest)?"#1e293b":"linear-gradient(135deg,#1d4ed8,#0ea5e9)",
            border:"none", borderRadius:"12px",
            color:(!origin||!dest)?"#475569":"#fff",
            fontSize:"14px", fontWeight:"700",
            cursor:(!origin||!dest||loading)?"not-allowed":"pointer",
            transition:"all .2s", display:"flex", alignItems:"center", justifyContent:"center", gap:"8px"
          }}>
            {loading ? <><Spinner />{loadingMsg || "Fetching routes…"}</> : "🔍 Find Routes"}
          </button>
        </div>

        <div style={{ marginBottom: isMobile ? "14px" : "22px" }}>
          <div style={{ fontSize:"11px", color:"#475569", marginBottom:"7px", fontFamily:"monospace" }}>QUICK ROUTES</div>
          <div style={{ display:"flex", flexDirection:"column", gap: isMobile ? "5px" : "7px" }}>
            {SUGGESTIONS.map(([f,t],i)=>(
              <button key={i} onClick={()=>{setOrigin(f);setDest(t)}} style={{
                background:"#0d1b2a", border:"1px solid #1e3348", borderRadius:"11px",
                padding: isMobile ? "7px 10px" : "9px 13px", cursor:"pointer", textAlign:"left",
                display:"flex", alignItems:"center", gap:"9px"
              }}>
                <span style={{ fontSize:"15px" }}>🗺</span>
                <div style={{ fontSize: isMobile ? "11px" : "12px", fontWeight:"600", color:"#cbd5e1" }}>{f} → {t}</div>
              </button>
            ))}
          </div>
        </div>

        <div style={{ background:"#0d1b2a", borderRadius:"16px", border:"1px solid #1e3348",
          padding: isMobile ? "10px" : "14px" }}>
          <div style={{ display:"flex", alignItems:"center", gap:"8px", marginBottom:"11px" }}>
            <span>🧠</span>
            <span style={{ fontSize:"13px", fontWeight:"700", color:"#a78bfa" }}>Personalization Profile</span>
            <span style={{ fontSize:"10px", color:"#a78bfa", background:"#a78bfa20",
              padding:"2px 7px", borderRadius:"10px", marginLeft:"auto", fontFamily:"monospace" }}>
              {tripCount} trips
            </span>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"7px" }}>
            {[["⚡ Speed",prefs.timeWeight,"#3b82f6"],["🚶 Min Walk",prefs.walkWeight,"#f59e0b"],
              ["💸 Save $",prefs.costWeight,"#22c55e"],["🌱 Eco",prefs.ecoWeight,"#34d399"]].map(([l,v,c])=>(
              <div key={l} style={{ background:"#0a1628", borderRadius:"9px",
                padding:"9px 11px", border:"1px solid #1e3348" }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:"5px" }}>
                  <span style={{ fontSize:"11px", color:"#64748b" }}>{l}</span>
                  <span style={{ fontSize:"11px", color:c, fontFamily:"monospace" }}>{v.toFixed(0)}</span>
                </div>
                <div style={{ height:"3px", background:"#1e293b", borderRadius:"2px" }}>
                  <div style={{ height:"100%", width:`${v}%`, background:c, borderRadius:"2px" }} />
                </div>
              </div>
            ))}
          </div>
          <p style={{ fontSize:"11px", color:"#334155", margin:"10px 0 0", textAlign:"center" }}>
            Weights adapt as you choose routes
          </p>
        </div>
      </div>
      <style>{globalStyles}</style>
    </div>
  );
}
