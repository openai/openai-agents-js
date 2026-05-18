import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  MapContainer,
  TileLayer,
  Circle,
  CircleMarker,
  Tooltip,
  useMap,
} from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SPCReport {
  id: number;
  time: string;
  size: string;
  loc: string;
  state: string;
  lat: number;
  lon: number;
}

type KnockStatus = 'unvisited' | 'knocked' | 'not_home' | 'interested' | 'skip';

interface GeoProspect {
  id: string;
  lat: number;
  lon: number;
  address: string;
  hailSize: number;
  roofAge: number;
  roofType: string;
  damageProb: number;
  priority: number;
  status: KnockStatus;
  distanceKm: number | null;
}

// ─── Persistence ──────────────────────────────────────────────────────────────

const STORAGE_KEY = 'stormscope-recon-v1';

function loadSavedStatuses(): Record<string, KnockStatus> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw) as {
      date: string;
      statuses: Record<string, KnockStatus>;
    };
    const today = new Date().toISOString().slice(0, 10);
    if (data.date !== today) return {}; // fresh slate each day
    return data.statuses ?? {};
  } catch {
    return {};
  }
}

function saveStatuses(prospects: GeoProspect[]) {
  const today = new Date().toISOString().slice(0, 10);
  const statuses: Record<string, KnockStatus> = {};
  prospects.forEach((p) => {
    if (p.status !== 'unvisited') statuses[p.id] = p.status;
  });
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ date: today, statuses }));
}

// ─── Utilities ────────────────────────────────────────────────────────────────

const seededRng = (seed: number) => {
  let x = seed;
  return () => {
    x = (x * 16807) % 2147483647;
    return (x - 1) / 2147483646;
  };
};

const haversineKm = (
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number => {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

function openInMaps(lat: number, lon: number) {
  window.open(
    `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`,
    '_blank',
    'noopener',
  );
}

const ROOF_TYPES = [
  'Asphalt 3-Tab',
  'Architectural Shingle',
  'Metal Standing Seam',
  'Clay Tile',
  'Wood Shake',
  'TPO Membrane',
];

const STREET_NAMES = [
  'Oak',
  'Maple',
  'Cedar',
  'Pine',
  'Elm',
  'Walnut',
  'Birch',
  'Willow',
  'Ash',
  'Hickory',
  'Pecan',
  'Magnolia',
  'Cypress',
  'Peachtree',
  'Dogwood',
  'Sycamore',
  'Poplar',
  'Chestnut',
];
const STREET_TYPES = ['St', 'Ave', 'Dr', 'Blvd', 'Ln', 'Rd', 'Ct', 'Way', 'Pl'];
const STREET_DIRS = ['N', 'S', 'E', 'W', ''];

const FALLBACK_REPORTS: SPCReport[] = [
  {
    id: 0,
    time: '1800',
    size: '2.00',
    loc: 'Edmond',
    state: 'OK',
    lat: 35.65,
    lon: -97.48,
  },
  {
    id: 1,
    time: '1830',
    size: '1.75',
    loc: 'Moore',
    state: 'OK',
    lat: 35.34,
    lon: -97.49,
  },
  {
    id: 2,
    time: '1845',
    size: '2.50',
    loc: 'Midwest City',
    state: 'OK',
    lat: 35.45,
    lon: -97.4,
  },
  {
    id: 3,
    time: '1900',
    size: '1.25',
    loc: 'Norman',
    state: 'OK',
    lat: 35.22,
    lon: -97.44,
  },
  {
    id: 4,
    time: '1910',
    size: '3.00',
    loc: 'Choctaw',
    state: 'OK',
    lat: 35.5,
    lon: -97.27,
  },
];

function generateGeoProspects(
  reports: SPCReport[],
  count: number,
  seed = 42,
): GeoProspect[] {
  const rng = seededRng(seed);
  const src = reports.length > 0 ? reports : FALLBACK_REPORTS;

  return Array.from({ length: count }, (_, i) => {
    const report = src[Math.floor(rng() * src.length)];
    const hailSize = Math.max(parseFloat(report.size) || 1.0, 0.5);

    const angle = rng() * 2 * Math.PI;
    const distKm = rng() * 2.5;
    const lat = report.lat + (distKm / 111.0) * Math.cos(angle);
    const lon =
      report.lon +
      (distKm / (111.0 * Math.cos((report.lat * Math.PI) / 180))) *
        Math.sin(angle);

    const roofAge = Math.floor(rng() * 34 + 1);
    const roofType = ROOF_TYPES[Math.floor(rng() * ROOF_TYPES.length)];

    const sizeScore = Math.min(hailSize / 3.0, 1.0) * 0.5;
    const ageScore = Math.min(roofAge / 30, 1.0) * 0.32;
    const variance = (rng() - 0.4) * 0.18;
    const damageProb = Math.min(
      Math.max(sizeScore + ageScore + variance, 0.04),
      0.97,
    );

    const houseNum = Math.floor(rng() * 8900 + 100);
    const dir = STREET_DIRS[Math.floor(rng() * STREET_DIRS.length)];
    const street = STREET_NAMES[Math.floor(rng() * STREET_NAMES.length)];
    const type = STREET_TYPES[Math.floor(rng() * STREET_TYPES.length)];
    const address = `${houseNum}${dir ? ' ' + dir : ''} ${street} ${type}`;

    return {
      id: `R${String(i).padStart(3, '0')}`,
      lat,
      lon,
      address,
      hailSize,
      roofAge,
      roofType,
      damageProb: +damageProb.toFixed(3),
      priority: +damageProb.toFixed(3),
      status: 'unvisited' as KnockStatus,
      distanceKm: null,
    };
  }).sort((a, b) => b.priority - a.priority);
}

// ─── Color helpers ────────────────────────────────────────────────────────────

function hailColor(sizeIn: number): string {
  if (sizeIn >= 3.0) return '#dc2626';
  if (sizeIn >= 2.0) return '#ef4444';
  if (sizeIn >= 1.5) return '#f97316';
  if (sizeIn >= 1.0) return '#eab308';
  if (sizeIn >= 0.75) return '#84cc16';
  return '#22c55e';
}

function pinColor(p: GeoProspect): string {
  if (p.status === 'interested') return '#22d3ee';
  if (p.status === 'knocked' || p.status === 'not_home') return '#4b5563';
  if (p.status === 'skip') return '#1f2937';
  if (p.priority > 0.7) return '#ef4444';
  if (p.priority > 0.45) return '#f59e0b';
  return '#22c55e';
}

const pt = (p: number) =>
  p > 0.7 ? 'text-red-400' : p > 0.45 ? 'text-amber-400' : 'text-emerald-400';

const pBorder = (p: number) =>
  p > 0.7
    ? 'border-red-500/40'
    : p > 0.45
      ? 'border-amber-500/40'
      : 'border-emerald-500/40';

const STATUS_ICON: Record<KnockStatus, string> = {
  unvisited: '',
  knocked: '🚪',
  not_home: '🔕',
  interested: '⭐',
  skip: '✕',
};

// ─── Map sub-components ───────────────────────────────────────────────────────

function BoundsFitter({ reports }: { reports: SPCReport[] }) {
  const map = useMap();
  const fitted = useRef(false);

  useEffect(() => {
    if (fitted.current) return;
    const src = reports.length > 0 ? reports : FALLBACK_REPORTS;
    if (src.length === 0) return;
    const lats = src.map((r) => r.lat);
    const lons = src.map((r) => r.lon);
    const bounds = L.latLngBounds(
      [Math.min(...lats) - 0.25, Math.min(...lons) - 0.25],
      [Math.max(...lats) + 0.25, Math.max(...lons) + 0.25],
    );
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 });
    fitted.current = true;
  }, [map, reports]);

  return null;
}

function HeatBlobs({
  reports,
  visible,
}: {
  reports: SPCReport[];
  visible: boolean;
}) {
  if (!visible) return null;
  const src = reports.length > 0 ? reports : FALLBACK_REPORTS;
  return (
    <>
      {src.map((r) => {
        const color = hailColor(parseFloat(r.size) || 1.0);
        const base = Math.max(parseFloat(r.size) || 1.0, 0.5) * 1200;
        return (
          <React.Fragment key={r.id}>
            <Circle
              center={[r.lat, r.lon]}
              radius={base * 3}
              pathOptions={{
                color,
                fillColor: color,
                fillOpacity: 0.04,
                weight: 0,
              }}
            />
            <Circle
              center={[r.lat, r.lon]}
              radius={base * 2}
              pathOptions={{
                color,
                fillColor: color,
                fillOpacity: 0.09,
                weight: 0,
              }}
            />
            <Circle
              center={[r.lat, r.lon]}
              radius={base * 1.2}
              pathOptions={{
                color,
                fillColor: color,
                fillOpacity: 0.18,
                weight: 0,
              }}
            />
            <Circle
              center={[r.lat, r.lon]}
              radius={base * 0.55}
              pathOptions={{
                color,
                fillColor: color,
                fillOpacity: 0.42,
                weight: 0,
              }}
            />
            <CircleMarker
              center={[r.lat, r.lon]}
              radius={6}
              pathOptions={{
                color: '#fff',
                fillColor: color,
                fillOpacity: 1,
                weight: 1.5,
              }}
            >
              <Tooltip sticky>
                <div className="text-xs font-mono leading-tight">
                  <div className="font-bold">{r.size}" MESH</div>
                  <div>
                    {r.loc}, {r.state}
                  </div>
                  <div className="text-zinc-400">{r.time}Z</div>
                </div>
              </Tooltip>
            </CircleMarker>
          </React.Fragment>
        );
      })}
    </>
  );
}

function ProspectPins({
  prospects,
  visible,
  selectedId,
  onSelect,
}: {
  prospects: GeoProspect[];
  visible: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (!visible) return null;
  return (
    <>
      {prospects.map((p) => {
        const sel = p.id === selectedId;
        const color = pinColor(p);
        const radius = p.priority > 0.7 ? 9 : p.priority > 0.45 ? 7 : 5;
        return (
          <CircleMarker
            key={p.id}
            center={[p.lat, p.lon]}
            radius={sel ? radius + 4 : radius}
            pathOptions={{
              color: sel ? '#fff' : color,
              fillColor: color,
              fillOpacity:
                p.status === 'skip'
                  ? 0.15
                  : p.status !== 'unvisited'
                    ? 0.45
                    : 0.9,
              weight: sel ? 2.5 : 1,
            }}
            eventHandlers={{ click: () => onSelect(p.id) }}
          >
            <Tooltip sticky>
              <div className="text-xs font-mono leading-tight">
                <div className="font-bold">{p.address}</div>
                <div>
                  {(p.priority * 100).toFixed(0)}% damage · {p.hailSize}" hail ·{' '}
                  {p.roofAge}yr roof
                </div>
                {p.status !== 'unvisited' && (
                  <div className="text-amber-300">
                    {STATUS_ICON[p.status]} {p.status.replace('_', ' ')}
                  </div>
                )}
              </div>
            </Tooltip>
          </CircleMarker>
        );
      })}
    </>
  );
}

function UserDot({ pos }: { pos: [number, number] | null }) {
  if (!pos) return null;
  return (
    <>
      <Circle
        center={pos}
        radius={80}
        pathOptions={{
          color: '#38bdf8',
          fillColor: '#38bdf8',
          fillOpacity: 0.15,
          weight: 0,
        }}
      />
      <CircleMarker
        center={pos}
        radius={7}
        pathOptions={{
          color: '#fff',
          fillColor: '#38bdf8',
          fillOpacity: 1,
          weight: 2,
        }}
      />
    </>
  );
}

// ─── Day Summary ──────────────────────────────────────────────────────────────

function DaySummary({ prospects }: { prospects: GeoProspect[] }) {
  const [copied, setCopied] = useState(false);

  const interested = prospects.filter((p) => p.status === 'interested');
  const notHome = prospects.filter((p) => p.status === 'not_home');
  const knocked = prospects.filter((p) => p.status === 'knocked');
  const skipped = prospects.filter((p) => p.status === 'skip');
  const total =
    interested.length + notHome.length + knocked.length + skipped.length;

  const copyReport = () => {
    const date = new Date().toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    const lines = [
      `STORMSCOPE RECON — ${date}`,
      `${'─'.repeat(30)}`,
      `Doors worked:   ${total}`,
      `Hot leads:      ${interested.length}`,
      `Not home:       ${notHome.length}`,
      `Knocked/done:   ${knocked.length}`,
      '',
    ];
    if (interested.length > 0) {
      lines.push('⭐ HOT LEADS — follow up ASAP:');
      interested.forEach((p) =>
        lines.push(
          `  • ${p.address}  [${(p.priority * 100).toFixed(0)}% dmg est, ${p.hailSize}" hail, ${p.roofAge}yr roof]`,
        ),
      );
      lines.push('');
    }
    if (notHome.length > 0) {
      lines.push('🔕 CIRCLE BACK:');
      notHome.forEach((p) => lines.push(`  • ${p.address}`));
      lines.push('');
    }
    lines.push('Sent from StormScope');
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  };

  if (total === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="text-4xl mb-3">👋</div>
        <div className="text-[13px] font-bold text-zinc-300">
          Nothing logged yet
        </div>
        <div className="text-[11px] text-zinc-600 mt-1">
          Tap a prospect on the map or list to start tracking
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 pb-4">
      {/* Stat row */}
      <div className="grid grid-cols-4 gap-1.5">
        {[
          [total.toString(), 'Worked', 'text-zinc-200'],
          [interested.length.toString(), 'Hot', 'text-cyan-400'],
          [notHome.length.toString(), 'Not Home', 'text-amber-400'],
          [knocked.length.toString(), 'Done', 'text-emerald-400'],
        ].map(([val, label, cls]) => (
          <div
            key={label}
            className="bg-zinc-900/60 border border-zinc-800/50 rounded-xl p-2 text-center"
          >
            <div className={`text-[22px] font-black tabular-nums ${cls}`}>
              {val}
            </div>
            <div className="text-[8px] uppercase tracking-[0.15em] text-zinc-600">
              {label}
            </div>
          </div>
        ))}
      </div>

      {/* Hot leads */}
      {interested.length > 0 && (
        <div>
          <div className="text-[9px] font-bold uppercase tracking-[0.2em] text-cyan-400 mb-1.5">
            ⭐ Hot Leads — Follow Up ASAP
          </div>
          <div className="space-y-1">
            {interested.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-2 bg-cyan-500/10 border border-cyan-500/25 rounded-xl px-3 py-2"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-semibold text-zinc-200 truncate">
                    {p.address}
                  </div>
                  <div className="text-[9px] text-zinc-500">
                    {(p.priority * 100).toFixed(0)}% dmg · {p.hailSize}" hail ·{' '}
                    {p.roofAge}yr {p.roofType}
                  </div>
                </div>
                <button
                  onClick={() => openInMaps(p.lat, p.lon)}
                  className="flex-shrink-0 px-2 py-1 rounded-lg bg-cyan-500/20 border border-cyan-500/30 text-cyan-400 text-[9px] font-bold uppercase"
                >
                  🗺️
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Not home */}
      {notHome.length > 0 && (
        <div>
          <div className="text-[9px] font-bold uppercase tracking-[0.2em] text-amber-400 mb-1.5">
            🔕 Circle Back
          </div>
          <div className="space-y-1">
            {notHome.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-2 bg-zinc-900/50 border border-zinc-800/40 rounded-xl px-3 py-2"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] text-zinc-400 truncate">
                    {p.address}
                  </div>
                </div>
                <button
                  onClick={() => openInMaps(p.lat, p.lon)}
                  className="flex-shrink-0 px-2 py-1 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-400 text-[9px] font-bold"
                >
                  🗺️
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Copy report button */}
      <button
        onClick={copyReport}
        className={`w-full py-3 rounded-xl border text-[11px] font-bold uppercase tracking-wider transition-all ${
          copied
            ? 'bg-emerald-500/20 border-emerald-500/30 text-emerald-400'
            : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700'
        }`}
      >
        {copied ? '✓ Copied to Clipboard' : '📋 Copy Day Report'}
      </button>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

type ListFilter = 'all' | 'priority' | 'interested' | 'done' | 'summary';

export function ReconMap({
  spc,
  spcLoading,
}: {
  spc: SPCReport[];
  spcLoading: boolean;
}) {
  const isDemoMode = spc.length === 0 && !spcLoading;
  const reports = isDemoMode ? FALLBACK_REPORTS : spc;

  const [prospects, setProspects] = useState<GeoProspect[]>([]);
  useEffect(() => {
    const generated = generateGeoProspects(reports, 75, 42);
    const saved = loadSavedStatuses();
    setProspects(
      generated.map((p) => ({ ...p, status: saved[p.id] ?? p.status })),
    );
  }, [reports]);

  const [heatVisible, setHeatVisible] = useState(true);
  const [pinsVisible, setPinsVisible] = useState(true);
  const [listOpen, setListOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [userPos, setUserPos] = useState<[number, number] | null>(null);
  const [filter, setFilter] = useState<ListFilter>('all');

  // GPS
  useEffect(() => {
    if (!navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (pos) => setUserPos([pos.coords.latitude, pos.coords.longitude]),
      () => {},
      { enableHighAccuracy: true },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  // Update walking distances when GPS changes
  useEffect(() => {
    if (!userPos) return;
    setProspects((prev) =>
      prev.map((p) => ({
        ...p,
        distanceKm: +haversineKm(userPos[0], userPos[1], p.lat, p.lon).toFixed(
          2,
        ),
      })),
    );
  }, [userPos]);

  const updateStatus = (id: string, status: KnockStatus) => {
    setProspects((prev) => {
      const next = prev.map((p) => (p.id === id ? { ...p, status } : p));
      saveStatuses(next);
      return next;
    });
    setSelectedId(null);
  };

  // Counts
  const counts = useMemo(
    () => ({
      unvisited: prospects.filter((p) => p.status === 'unvisited').length,
      interested: prospects.filter((p) => p.status === 'interested').length,
      done: prospects.filter(
        (p) => p.status !== 'unvisited' && p.status !== 'interested',
      ).length,
      priority: prospects.filter(
        (p) => p.status === 'unvisited' && p.priority > 0.5,
      ).length,
    }),
    [prospects],
  );

  // Filtered + sorted list
  const listProspects = useMemo(() => {
    let list = [...prospects];
    if (filter === 'priority')
      list = list.filter((p) => p.status === 'unvisited' && p.priority > 0.5);
    if (filter === 'interested')
      list = list.filter((p) => p.status === 'interested');
    if (filter === 'done')
      list = list.filter(
        (p) => p.status !== 'unvisited' && p.status !== 'interested',
      );

    return list.sort((a, b) => {
      // Interested always first
      if (a.status === 'interested' && b.status !== 'interested') return -1;
      if (b.status === 'interested' && a.status !== 'interested') return 1;
      // Done last
      const aDone = a.status !== 'unvisited' && a.status !== 'interested';
      const bDone = b.status !== 'unvisited' && b.status !== 'interested';
      if (aDone && !bDone) return 1;
      if (bDone && !aDone) return -1;
      // GPS distance when available
      if (
        userPos &&
        a.distanceKm != null &&
        b.distanceKm != null &&
        !aDone &&
        !bDone
      ) {
        return a.distanceKm - b.distanceKm;
      }
      return b.priority - a.priority;
    });
  }, [prospects, filter, userPos]);

  const selectedProspect = useMemo(
    () => prospects.find((p) => p.id === selectedId) ?? null,
    [prospects, selectedId],
  );

  const mapCenter = useMemo((): [number, number] => {
    const src = reports.length > 0 ? reports : FALLBACK_REPORTS;
    return [
      src.reduce((s, r) => s + r.lat, 0) / src.length,
      src.reduce((s, r) => s + r.lon, 0) / src.length,
    ];
  }, [reports]);

  const distLabel = (km: number | null) => {
    if (km == null) return null;
    return km < 1 ? `${(km * 1000).toFixed(0)}m` : `${km.toFixed(1)}km`;
  };

  return (
    <div className="relative w-full h-full flex flex-col">
      {/* ── Map ───────────────────────────────────────────────────────────── */}
      <div className="flex-1 relative min-h-0">
        <MapContainer
          center={mapCenter}
          zoom={10}
          style={{ height: '100%', width: '100%', background: '#0c0c10' }}
          zoomControl={false}
        >
          <TileLayer
            attribution='&copy; <a href="https://carto.com/">CARTO</a>'
            url="https://{s}.basemaps.cartocdn.com/dark_matter_nolabels/{z}/{x}/{y}{r}.png"
            subdomains="abcd"
          />
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/dark_matter_only_labels/{z}/{x}/{y}{r}.png"
            subdomains="abcd"
          />
          <BoundsFitter reports={reports} />
          <HeatBlobs reports={reports} visible={heatVisible} />
          <ProspectPins
            prospects={prospects}
            visible={pinsVisible}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              setListOpen(true);
              setFilter('all');
            }}
          />
          <UserDot pos={userPos} />
        </MapContainer>

        {/* Top-left: storm badge */}
        <div className="absolute top-3 left-3 z-[1000] bg-black/75 backdrop-blur-sm rounded-xl border border-zinc-700/50 px-3 py-2">
          <div className="text-[9px] font-bold uppercase tracking-[0.2em] text-amber-400 leading-tight">
            {isDemoMode
              ? '⚡ Demo — OKC Storm'
              : `🌩️ ${reports.length} SPC Reports`}
          </div>
          <div className="text-[10px] text-zinc-300 mt-0.5">
            {counts.unvisited} to knock
            {counts.interested > 0 && (
              <span className="text-cyan-400"> · {counts.interested} hot</span>
            )}
            {counts.done > 0 && (
              <span className="text-zinc-500"> · {counts.done} done</span>
            )}
          </div>
        </div>

        {/* Top-right: layer toggles */}
        <div className="absolute top-3 right-3 z-[1000] flex flex-col gap-1.5">
          <div className="flex gap-1.5">
            <button
              onClick={() => setHeatVisible((v) => !v)}
              className={`px-2.5 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider backdrop-blur-sm border transition-all ${
                heatVisible
                  ? 'bg-amber-500/25 border-amber-500/40 text-amber-300'
                  : 'bg-black/60 border-zinc-700/50 text-zinc-500'
              }`}
            >
              🔥 Heat
            </button>
            <button
              onClick={() => setPinsVisible((v) => !v)}
              className={`px-2.5 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider backdrop-blur-sm border transition-all ${
                pinsVisible
                  ? 'bg-sky-500/25 border-sky-500/40 text-sky-300'
                  : 'bg-black/60 border-zinc-700/50 text-zinc-500'
              }`}
            >
              📍 Pins
            </button>
          </div>
        </div>

        {/* Bottom-left: hail legend */}
        <div className="absolute bottom-16 left-3 z-[1000] bg-black/75 backdrop-blur-sm rounded-xl border border-zinc-700/50 px-3 py-2">
          <div className="text-[8px] uppercase tracking-[0.15em] text-zinc-500 mb-1.5">
            Hail Size
          </div>
          {[
            ['≥ 3"', '#dc2626'],
            ['≥ 2"', '#ef4444'],
            ['≥ 1.5"', '#f97316'],
            ['≥ 1"', '#eab308'],
            ['< 1"', '#22c55e'],
          ].map(([label, color]) => (
            <div key={label} className="flex items-center gap-1.5 mb-0.5">
              <div
                className="w-2.5 h-2.5 rounded-full"
                style={{ backgroundColor: color }}
              />
              <span className="text-[9px] text-zinc-400">{label}</span>
            </div>
          ))}
        </div>

        {/* Bottom-center: list toggle */}
        <button
          onClick={() => setListOpen((v) => !v)}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 z-[1000] bg-black/85 backdrop-blur-sm border border-zinc-600/60 rounded-full px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-zinc-200 flex items-center gap-2 shadow-lg"
        >
          <span>{listOpen ? '▼ Map' : '▲ Prospect List'}</span>
          {counts.unvisited > 0 && (
            <span className="bg-red-500 text-white rounded-full w-4 h-4 flex items-center justify-center text-[8px] font-black">
              {Math.min(counts.unvisited, 99)}
            </span>
          )}
          {counts.interested > 0 && (
            <span className="bg-cyan-500 text-white rounded-full w-4 h-4 flex items-center justify-center text-[8px] font-black">
              {counts.interested}
            </span>
          )}
        </button>
      </div>

      {/* ── Bottom Sheet ──────────────────────────────────────────────────── */}
      <div
        className={`flex-shrink-0 bg-[#09090d] border-t border-zinc-800/70 overflow-hidden transition-all duration-300 ease-in-out ${
          listOpen ? 'h-[60vh]' : 'h-0'
        }`}
      >
        {listOpen && (
          <div className="h-full flex flex-col">
            {/* Sheet header */}
            <div className="flex-shrink-0 px-3 pt-3 pb-2 space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-[9px] font-bold uppercase tracking-[0.2em] text-amber-400">
                  ⚡ Recon List
                  {userPos && (
                    <span className="text-zinc-500 ml-2 normal-case tracking-normal font-normal">
                      · GPS active
                    </span>
                  )}
                </div>
                <button
                  onClick={() => setListOpen(false)}
                  className="text-zinc-600 hover:text-zinc-300 text-[16px] leading-none w-6 h-6 flex items-center justify-center"
                >
                  ✕
                </button>
              </div>

              {/* Filter tabs */}
              <div className="flex gap-1 overflow-x-auto pb-0.5 scrollbar-none">
                {(
                  [
                    ['all', `All (${prospects.length})`],
                    ['priority', `🔥 Priority (${counts.priority})`],
                    ['interested', `⭐ Hot (${counts.interested})`],
                    ['done', `Done (${counts.done})`],
                    ['summary', '📋 Summary'],
                  ] as [ListFilter, string][]
                ).map(([k, l]) => (
                  <button
                    key={k}
                    onClick={() => setFilter(k)}
                    className={`px-2.5 py-1 rounded-lg text-[10px] font-bold whitespace-nowrap transition-all flex-shrink-0 ${
                      filter === k
                        ? 'bg-zinc-800 text-zinc-200'
                        : 'text-zinc-600 hover:text-zinc-400'
                    }`}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </div>

            {/* Summary view */}
            {filter === 'summary' ? (
              <div className="flex-1 overflow-y-auto px-3 pb-2">
                <DaySummary prospects={prospects} />
              </div>
            ) : (
              <>
                {/* Selected prospect action card */}
                {selectedProspect && (
                  <div
                    className={`flex-shrink-0 mx-3 mb-2 rounded-xl border p-3 ${pBorder(selectedProspect.priority)} bg-zinc-900/80`}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex-1 min-w-0 pr-2">
                        <div className="text-[12px] font-bold text-zinc-100 truncate">
                          {selectedProspect.address}
                        </div>
                        <div className="text-[10px] text-zinc-500 mt-0.5">
                          {selectedProspect.hailSize}" hail ·{' '}
                          {selectedProspect.roofAge}yr{' '}
                          {selectedProspect.roofType}
                          {selectedProspect.distanceKm != null && (
                            <>
                              {' '}
                              · {distLabel(selectedProspect.distanceKm)} away
                            </>
                          )}
                        </div>
                      </div>
                      <div
                        className={`flex-shrink-0 text-[20px] font-black tabular-nums ${pt(selectedProspect.priority)}`}
                      >
                        {(selectedProspect.priority * 100).toFixed(0)}%
                      </div>
                    </div>
                    <div className="flex gap-1.5 flex-wrap">
                      <button
                        onClick={() =>
                          openInMaps(selectedProspect.lat, selectedProspect.lon)
                        }
                        className="py-2 px-3 rounded-lg bg-violet-500/15 border border-violet-500/30 text-violet-400 text-[10px] font-bold uppercase tracking-wider"
                      >
                        🗺️ Navigate
                      </button>
                      {selectedProspect.status !== 'knocked' && (
                        <button
                          onClick={() =>
                            updateStatus(selectedProspect.id, 'knocked')
                          }
                          className="flex-1 py-2 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-[10px] font-bold uppercase tracking-wider"
                        >
                          🚪 Knocked
                        </button>
                      )}
                      {selectedProspect.status !== 'not_home' && (
                        <button
                          onClick={() =>
                            updateStatus(selectedProspect.id, 'not_home')
                          }
                          className="flex-1 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-400 text-[10px] font-bold uppercase tracking-wider"
                        >
                          🔕 Not Home
                        </button>
                      )}
                      {selectedProspect.status !== 'interested' && (
                        <button
                          onClick={() =>
                            updateStatus(selectedProspect.id, 'interested')
                          }
                          className="flex-1 py-2 rounded-lg bg-cyan-500/15 border border-cyan-500/30 text-cyan-400 text-[10px] font-bold uppercase tracking-wider"
                        >
                          ⭐ Hot Lead
                        </button>
                      )}
                      {selectedProspect.status !== 'skip' && (
                        <button
                          onClick={() =>
                            updateStatus(selectedProspect.id, 'skip')
                          }
                          className="py-2 px-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-600 text-[10px] font-bold"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* Scrollable prospect rows */}
                <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-1.5">
                  {listProspects.slice(0, 60).map((p, i) => {
                    const isDone =
                      p.status !== 'unvisited' && p.status !== 'interested';
                    const isHot = p.status === 'interested';
                    return (
                      <button
                        key={p.id}
                        onClick={() =>
                          setSelectedId(p.id === selectedId ? null : p.id)
                        }
                        className={`w-full text-left rounded-xl border px-3 py-2.5 transition-all ${
                          p.id === selectedId
                            ? 'bg-zinc-800/80 border-zinc-600'
                            : isDone
                              ? 'bg-zinc-900/30 border-zinc-800/30 opacity-40'
                              : isHot
                                ? 'bg-cyan-500/10 border-cyan-500/30'
                                : 'bg-zinc-900/50 border-zinc-800/50 hover:bg-zinc-800/50'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <div className="text-[9px] font-mono text-zinc-600 w-5 flex-shrink-0">
                            {isDone || isHot
                              ? STATUS_ICON[p.status]
                              : `#${i + 1}`}
                          </div>
                          <div
                            className="w-2 h-2 rounded-full flex-shrink-0"
                            style={{ backgroundColor: pinColor(p) }}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-[11px] font-semibold text-zinc-200 truncate">
                              {p.address}
                            </div>
                            <div className="text-[9px] text-zinc-600">
                              {p.hailSize}" hail · {p.roofAge}yr {p.roofType}
                            </div>
                          </div>
                          <div className="flex-shrink-0 flex items-center gap-2">
                            {/* Navigate shortcut */}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                openInMaps(p.lat, p.lon);
                              }}
                              className="text-[13px] opacity-40 hover:opacity-100 transition-opacity"
                              title="Navigate"
                            >
                              🗺️
                            </button>
                            <div className="text-right">
                              <div
                                className={`text-[13px] font-black tabular-nums ${pt(p.priority)}`}
                              >
                                {(p.priority * 100).toFixed(0)}%
                              </div>
                              {p.distanceKm != null && (
                                <div className="text-[9px] text-zinc-600">
                                  {distLabel(p.distanceKm)}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="mt-1.5 h-0.5 bg-zinc-800/80 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${p.priority * 100}%`,
                              backgroundColor: pinColor(p),
                            }}
                          />
                        </div>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
