import { useState, useEffect, useCallback, useRef, useMemo } from 'react';

// --- Data Generation Utilities ---
const seededRandom = (seed: number) => {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
};

interface StormEvent {
  id: string;
  name: string;
  timestamp: string;
  maxMesh: number;
  status: 'active' | 'verified' | 'archived';
  county: string;
  lat: number;
  lng: number;
}

const STORM_EVENTS: StormEvent[] = [
  {
    id: 'S-2026-0517A',
    name: 'Lafayette Cell',
    timestamp: '2026-05-17T14:32:00',
    maxMesh: 2.1,
    status: 'active',
    county: 'Lafayette Parish',
    lat: 30.22,
    lng: -92.02,
  },
  {
    id: 'S-2026-0517B',
    name: 'Scott Supercell',
    timestamp: '2026-05-17T13:48:00',
    maxMesh: 3.4,
    status: 'active',
    county: 'Lafayette Parish',
    lat: 30.24,
    lng: -92.08,
  },
  {
    id: 'S-2026-0516C',
    name: 'Broussard Line',
    timestamp: '2026-05-16T19:12:00',
    maxMesh: 1.8,
    status: 'verified',
    county: 'Lafayette Parish',
    lat: 30.15,
    lng: -91.96,
  },
  {
    id: 'S-2026-0515D',
    name: 'Youngsville Cluster',
    timestamp: '2026-05-15T16:05:00',
    maxMesh: 2.7,
    status: 'verified',
    county: 'Lafayette Parish',
    lat: 30.1,
    lng: -91.99,
  },
  {
    id: 'S-2026-0514E',
    name: 'Carencro Storm',
    timestamp: '2026-05-14T20:30:00',
    maxMesh: 1.2,
    status: 'archived',
    county: 'Lafayette Parish',
    lat: 30.32,
    lng: -92.05,
  },
];

const STREET_NAMES = [
  'Johnston St',
  'Ambassador Caffery',
  'Kaliste Saloom',
  'Pinhook Rd',
  'Congress St',
  'University Ave',
  'Bertrand Dr',
  'Evangeline Thwy',
  'Cameron St',
  'Camellia Blvd',
  'Verot School Rd',
  'Ridge Rd',
  'Dulles Dr',
  'Settlers Trace',
  'Guilbeau Rd',
  'Bonin Rd',
  'Doucet Rd',
  'E Broussard Rd',
  'W Congress St',
  'Surrey St',
];

const ROOF_TYPES = [
  'Asphalt Shingle',
  'Metal Standing Seam',
  'Clay Tile',
  'TPO Membrane',
  'Built-Up (BUR)',
  'Slate',
  'Wood Shake',
];
const ROOF_CONDITIONS = [
  'New (0-3yr)',
  'Good (3-8yr)',
  'Aging (8-15yr)',
  'Worn (15-25yr)',
  'Critical (25yr+)',
];

interface Property {
  id: string;
  address: string;
  city: string;
  meshAtSite: number;
  roofType: string;
  roofCondition: string;
  roofAge: number;
  sqft: number;
  yearBuilt: number;
  damageProb: number;
  confidence: 'high' | 'medium' | 'low';
  canvassStatus: 'unvisited' | 'visited' | 'flagged';
  x: number;
  y: number;
  hasDroneData: boolean;
  priorClaims: number;
}

function generateProperties(count: number, stormId: string): Property[] {
  const rng = seededRandom(stormId.charCodeAt(stormId.length - 1) * 7919);
  const props: Property[] = [];
  for (let i = 0; i < count; i++) {
    const meshAtSite = rng() * 3.5 + 0.5;
    const roofAge = Math.floor(rng() * 35);
    const roofCondIdx =
      roofAge < 3
        ? 0
        : roofAge < 8
          ? 1
          : roofAge < 15
            ? 2
            : roofAge < 25
              ? 3
              : 4;
    const roofVulnerability = [0.1, 0.25, 0.5, 0.75, 0.95][roofCondIdx];
    const meshFactor = Math.min(meshAtSite / 2.5, 1);
    const windFactor = rng() * 0.3;
    const treeCover = rng() * 0.15;
    const rawScore =
      meshFactor * 0.45 +
      roofVulnerability * 0.3 +
      windFactor * 0.15 +
      treeCover * 0.1;
    const damageProb = Math.min(
      Math.max(rawScore + (rng() - 0.5) * 0.1, 0.02),
      0.99,
    );
    const x = rng() * 100;
    const y = rng() * 100;
    const confidenceRoll = rng();

    props.push({
      id: `P-${stormId.slice(-1)}-${String(i).padStart(4, '0')}`,
      address: `${Math.floor(rng() * 9000 + 100)} ${STREET_NAMES[Math.floor(rng() * STREET_NAMES.length)]}`,
      city: 'Lafayette, LA',
      meshAtSite: +meshAtSite.toFixed(2),
      roofType: ROOF_TYPES[Math.floor(rng() * ROOF_TYPES.length)],
      roofCondition: ROOF_CONDITIONS[roofCondIdx],
      roofAge,
      sqft: Math.floor(rng() * 3000 + 800),
      yearBuilt: 2026 - Math.floor(rng() * 60 + 5),
      damageProb: +damageProb.toFixed(3),
      confidence:
        confidenceRoll > 0.3
          ? 'high'
          : confidenceRoll > 0.15
            ? 'medium'
            : 'low',
      canvassStatus: 'unvisited',
      x,
      y,
      hasDroneData: rng() > 0.85,
      priorClaims: Math.floor(rng() * 3),
    });
  }
  return props.sort((a, b) => b.damageProb - a.damageProb);
}

// --- UI Components ---
type BadgeColor = 'red' | 'amber' | 'green' | 'blue' | 'gray' | 'purple';

const Badge = ({
  children,
  color = 'gray',
}: {
  children: React.ReactNode;
  color?: BadgeColor;
}) => {
  const colors: Record<BadgeColor, string> = {
    red: 'bg-red-500/20 text-red-300 border-red-500/30',
    amber: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
    green: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
    blue: 'bg-sky-500/20 text-sky-300 border-sky-500/30',
    gray: 'bg-zinc-700/40 text-zinc-400 border-zinc-600/30',
    purple: 'bg-violet-500/20 text-violet-300 border-violet-500/30',
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border rounded ${colors[color]}`}
    >
      {children}
    </span>
  );
};

const DamageBar = ({
  value,
  size = 'sm',
}: {
  value: number;
  size?: 'sm' | 'lg';
}) => {
  const pct = value * 100;
  const color =
    pct > 70
      ? '#ef4444'
      : pct > 40
        ? '#f59e0b'
        : pct > 20
          ? '#22c55e'
          : '#6b7280';
  const h = size === 'sm' ? 'h-1.5' : 'h-3';
  return (
    <div className={`w-full ${h} bg-zinc-800 rounded-full overflow-hidden`}>
      <div
        className={`${h} rounded-full transition-all duration-700`}
        style={{ width: `${pct}%`, backgroundColor: color }}
      />
    </div>
  );
};

const StatCard = ({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: number;
  sub?: string;
  accent?: string;
}) => (
  <div className="bg-zinc-900/80 border border-zinc-800 rounded-lg p-3">
    <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1">
      {label}
    </div>
    <div
      className={`text-2xl font-black tabular-nums ${accent ?? 'text-zinc-100'}`}
    >
      {value}
    </div>
    {sub && <div className="text-[11px] text-zinc-500 mt-0.5">{sub}</div>}
  </div>
);

// --- Hail Swath Map Component ---
const HailSwathMap = ({
  properties,
  selectedId,
  onSelect,
  meshMax,
}: {
  properties: Property[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  meshMax: number;
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const W = rect.width;
    const H = rect.height;

    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = '#1a1a2e';
    ctx.lineWidth = 0.5;
    for (let x = 0; x < W; x += 30) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    for (let y = 0; y < H; y += 30) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }

    const swathCenters = [
      { x: W * 0.35, y: H * 0.3, r: W * 0.25, intensity: 0.9 },
      { x: W * 0.55, y: H * 0.5, r: W * 0.2, intensity: 0.7 },
      { x: W * 0.7, y: H * 0.65, r: W * 0.15, intensity: 0.4 },
    ];
    swathCenters.forEach(({ x, y, r, intensity }) => {
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      if (intensity > 0.7) {
        grad.addColorStop(0, 'rgba(239,68,68,0.25)');
        grad.addColorStop(0.4, 'rgba(245,158,11,0.15)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
      } else if (intensity > 0.4) {
        grad.addColorStop(0, 'rgba(245,158,11,0.2)');
        grad.addColorStop(0.5, 'rgba(34,197,94,0.1)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
      } else {
        grad.addColorStop(0, 'rgba(34,197,94,0.15)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
      }
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    });

    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(245,158,11,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(W * 0.45, H * 0.42, W * 0.32, H * 0.35, 0.3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = '#1e1e3a';
    ctx.lineWidth = 1;
    const streets: [[number, number], [number, number]][] = [
      [
        [W * 0.1, H * 0.2],
        [W * 0.9, H * 0.25],
      ],
      [
        [W * 0.15, H * 0.4],
        [W * 0.85, H * 0.38],
      ],
      [
        [W * 0.1, H * 0.6],
        [W * 0.9, H * 0.62],
      ],
      [
        [W * 0.1, H * 0.8],
        [W * 0.85, H * 0.78],
      ],
      [
        [W * 0.2, H * 0.05],
        [W * 0.22, H * 0.95],
      ],
      [
        [W * 0.4, H * 0.05],
        [W * 0.38, H * 0.95],
      ],
      [
        [W * 0.6, H * 0.05],
        [W * 0.62, H * 0.95],
      ],
      [
        [W * 0.8, H * 0.05],
        [W * 0.78, H * 0.95],
      ],
    ];
    streets.forEach(([a, b]) => {
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    });

    properties.forEach((p) => {
      const px = (p.x / 100) * W;
      const py = (p.y / 100) * H;
      const isSelected = p.id === selectedId;
      const isHovered = p.id === hoveredId;
      const sz = isSelected ? 7 : isHovered ? 6 : 4;

      const dmg = p.damageProb;
      const fillColor =
        dmg > 0.7
          ? '#ef4444'
          : dmg > 0.4
            ? '#f59e0b'
            : dmg > 0.2
              ? '#22c55e'
              : '#6b7280';

      if (isSelected) {
        ctx.beginPath();
        ctx.arc(px, py, 14, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(56,189,248,0.5)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      if (p.canvassStatus === 'visited') {
        ctx.beginPath();
        ctx.arc(px, py, sz + 2, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(168,85,247,0.6)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      ctx.fillStyle = fillColor;
      ctx.globalAlpha = isSelected || isHovered ? 1 : 0.75;
      ctx.fillRect(px - sz, py - sz, sz * 2, sz * 2);
      ctx.globalAlpha = 1;

      if (p.hasDroneData) {
        ctx.fillStyle = '#38bdf8';
        ctx.beginPath();
        ctx.arc(px + sz + 3, py - sz - 2, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    ctx.fillStyle = 'rgba(10,10,10,0.85)';
    ctx.fillRect(8, H - 90, 160, 82);
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.strokeRect(8, H - 90, 160, 82);
    ctx.font = 'bold 9px monospace';
    ctx.fillStyle = '#888';
    ctx.fillText('DAMAGE PROBABILITY', 16, H - 74);
    const legendItems: [string, string][] = [
      ['#ef4444', '> 70% HIGH'],
      ['#f59e0b', '40-70% MODERATE'],
      ['#22c55e', '20-40% LOW'],
      ['#6b7280', '< 20% MINIMAL'],
    ];
    legendItems.forEach(([c, label], i) => {
      ctx.fillStyle = c;
      ctx.fillRect(16, H - 62 + i * 15, 8, 8);
      ctx.fillStyle = '#aaa';
      ctx.font = '9px monospace';
      ctx.fillText(label, 30, H - 55 + i * 15);
    });

    ctx.fillStyle = 'rgba(10,10,10,0.8)';
    ctx.fillRect(W - 150, 8, 142, 28);
    ctx.font = 'bold 10px monospace';
    ctx.fillStyle = '#f59e0b';
    ctx.fillText(`MESH MAX: ${meshMax}" ⚡`, W - 142, 26);
  }, [properties, selectedId, hoveredId, meshMax]);

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mx = ((e.clientX - rect.left) / rect.width) * 100;
      const my = ((e.clientY - rect.top) / rect.height) * 100;
      let closest: Property | null = null;
      let closestDist = Infinity;
      properties.forEach((p) => {
        const d = Math.hypot(p.x - mx, p.y - my);
        if (d < closestDist && d < 4) {
          closest = p;
          closestDist = d;
        }
      });
      if (closest) onSelect((closest as Property).id);
    },
    [properties, onSelect],
  );

  const handleCanvasMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mx = ((e.clientX - rect.left) / rect.width) * 100;
      const my = ((e.clientY - rect.top) / rect.height) * 100;
      let closest: Property | null = null;
      let closestDist = Infinity;
      properties.forEach((p) => {
        const d = Math.hypot(p.x - mx, p.y - my);
        if (d < closestDist && d < 4) {
          closest = p;
          closestDist = d;
        }
      });
      setHoveredId((closest as Property | null)?.id ?? null);
    },
    [properties],
  );

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full cursor-crosshair rounded-lg"
      onClick={handleCanvasClick}
      onMouseMove={handleCanvasMove}
    />
  );
};

// --- Property Detail Panel ---
const PropertyDetail = ({
  property,
  onCanvass,
  onClose,
}: {
  property: Property;
  onCanvass: (id: string, status: 'visited' | 'flagged') => void;
  onClose: () => void;
}) => {
  const p = property;
  const pct = (p.damageProb * 100).toFixed(1);
  const color =
    p.damageProb > 0.7
      ? 'text-red-400'
      : p.damageProb > 0.4
        ? 'text-amber-400'
        : p.damageProb > 0.2
          ? 'text-emerald-400'
          : 'text-zinc-400';

  return (
    <div className="bg-zinc-950 border border-zinc-800 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 bg-zinc-900/50">
        <div className="flex items-center gap-2">
          <div
            className={`w-3 h-3 rounded-sm ${p.damageProb > 0.7 ? 'bg-red-500' : p.damageProb > 0.4 ? 'bg-amber-500' : 'bg-emerald-500'}`}
          />
          <span className="text-xs font-mono text-zinc-400">{p.id}</span>
        </div>
        <button
          onClick={onClose}
          className="text-zinc-500 hover:text-zinc-300 text-sm"
        >
          ✕
        </button>
      </div>

      <div className="p-4 space-y-4">
        <div>
          <div className="text-sm font-semibold text-zinc-100">{p.address}</div>
          <div className="text-xs text-zinc-500">
            {p.city} · Built {p.yearBuilt} · {p.sqft.toLocaleString()} sqft
          </div>
        </div>

        <div className="bg-zinc-900/60 rounded-lg p-3 border border-zinc-800">
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-[10px] uppercase tracking-widest text-zinc-500">
              Damage Probability
            </span>
            <span className={`text-2xl font-black tabular-nums ${color}`}>
              {pct}%
            </span>
          </div>
          <DamageBar value={p.damageProb} size="lg" />
          <div className="flex justify-between mt-2">
            <Badge
              color={
                p.confidence === 'high'
                  ? 'green'
                  : p.confidence === 'medium'
                    ? 'amber'
                    : 'red'
              }
            >
              {p.confidence} confidence
            </Badge>
            {p.hasDroneData && <Badge color="blue">drone verified</Badge>}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="bg-zinc-900/40 rounded p-2 border border-zinc-800/50">
            <div className="text-zinc-500 text-[10px] uppercase">
              MESH at Site
            </div>
            <div className="text-zinc-200 font-bold text-lg tabular-nums">
              {p.meshAtSite}"
            </div>
          </div>
          <div className="bg-zinc-900/40 rounded p-2 border border-zinc-800/50">
            <div className="text-zinc-500 text-[10px] uppercase">Roof Age</div>
            <div className="text-zinc-200 font-bold text-lg tabular-nums">
              {p.roofAge} yr
            </div>
          </div>
          <div className="bg-zinc-900/40 rounded p-2 border border-zinc-800/50">
            <div className="text-zinc-500 text-[10px] uppercase">Roof Type</div>
            <div className="text-zinc-200 font-semibold text-xs mt-0.5">
              {p.roofType}
            </div>
          </div>
          <div className="bg-zinc-900/40 rounded p-2 border border-zinc-800/50">
            <div className="text-zinc-500 text-[10px] uppercase">Condition</div>
            <div className="text-zinc-200 font-semibold text-xs mt-0.5">
              {p.roofCondition}
            </div>
          </div>
        </div>

        {p.priorClaims > 0 && (
          <div className="flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2">
            <span>⚠</span>
            <span>
              {p.priorClaims} prior claim{p.priorClaims > 1 ? 's' : ''} on file
            </span>
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={() => onCanvass(p.id, 'visited')}
            className={`flex-1 text-xs font-bold uppercase tracking-wider py-2.5 rounded-lg border transition-all ${
              p.canvassStatus === 'visited'
                ? 'bg-violet-500/20 border-violet-500/40 text-violet-300'
                : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700'
            }`}
          >
            {p.canvassStatus === 'visited' ? '✓ Visited' : 'Mark Visited'}
          </button>
          <button
            onClick={() => onCanvass(p.id, 'flagged')}
            className={`flex-1 text-xs font-bold uppercase tracking-wider py-2.5 rounded-lg border transition-all ${
              p.canvassStatus === 'flagged'
                ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700'
            }`}
          >
            {p.canvassStatus === 'flagged' ? '⚑ Flagged' : 'Flag for Review'}
          </button>
        </div>

        <button className="w-full text-xs font-bold uppercase tracking-wider py-2.5 rounded-lg border bg-sky-500/15 border-sky-500/30 text-sky-300 hover:bg-sky-500/25 transition-all">
          Generate Hail Report →
        </button>
      </div>
    </div>
  );
};

// --- AI Scout Panel ---
const AIScoutPanel = ({
  properties,
  onSelect,
}: {
  properties: Property[];
  onSelect: (id: string) => void;
}) => {
  const top10 = properties.slice(0, 10);
  return (
    <div className="space-y-1">
      {top10.map((p, i) => (
        <button
          key={p.id}
          onClick={() => onSelect(p.id)}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-zinc-800/60 transition-colors text-left group"
        >
          <span className="text-[10px] font-mono text-zinc-600 w-4">
            {String(i + 1).padStart(2, '0')}
          </span>
          <div
            className={`w-2.5 h-2.5 rounded-sm flex-shrink-0 ${p.damageProb > 0.7 ? 'bg-red-500' : p.damageProb > 0.4 ? 'bg-amber-500' : 'bg-emerald-500'}`}
          />
          <div className="flex-1 min-w-0">
            <div className="text-xs text-zinc-300 truncate group-hover:text-zinc-100">
              {p.address}
            </div>
            <div className="text-[10px] text-zinc-600">
              {p.roofCondition} · {p.meshAtSite}" MESH
            </div>
          </div>
          <span
            className={`text-xs font-black tabular-nums ${p.damageProb > 0.7 ? 'text-red-400' : p.damageProb > 0.4 ? 'text-amber-400' : 'text-emerald-400'}`}
          >
            {(p.damageProb * 100).toFixed(0)}%
          </span>
        </button>
      ))}
    </div>
  );
};

// --- Main App ---
type ViewKey = 'map' | 'scout' | 'storms';
type FilterKey = 'all' | 'high' | 'unvisited';

export default function StormScope() {
  const [activeStorm, setActiveStorm] = useState<StormEvent>(STORM_EVENTS[0]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [selectedPropId, setSelectedPropId] = useState<string | null>(null);
  const [view, setView] = useState<ViewKey>('map');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const timer = setTimeout(() => {
      setProperties(generateProperties(80, activeStorm.id));
      setSelectedPropId(null);
      setLoading(false);
    }, 600);
    return () => clearTimeout(timer);
  }, [activeStorm]);

  const handleCanvass = useCallback(
    (id: string, status: 'visited' | 'flagged') => {
      setProperties((prev) =>
        prev.map((p) =>
          p.id === id
            ? {
                ...p,
                canvassStatus:
                  p.canvassStatus === status ? 'unvisited' : status,
              }
            : p,
        ),
      );
    },
    [],
  );

  const filteredProperties = useMemo(() => {
    if (filter === 'high') return properties.filter((p) => p.damageProb > 0.6);
    if (filter === 'unvisited')
      return properties.filter((p) => p.canvassStatus === 'unvisited');
    return properties;
  }, [properties, filter]);

  const selectedProp = properties.find((p) => p.id === selectedPropId) ?? null;

  const stats = useMemo(() => {
    const high = properties.filter((p) => p.damageProb > 0.7).length;
    const mod = properties.filter(
      (p) => p.damageProb > 0.4 && p.damageProb <= 0.7,
    ).length;
    const visited = properties.filter(
      (p) => p.canvassStatus === 'visited',
    ).length;
    const drone = properties.filter((p) => p.hasDroneData).length;
    return { high, mod, visited, drone, total: properties.length };
  }, [properties]);

  return (
    <div
      className="h-screen w-full bg-[#050508] text-zinc-100 flex flex-col overflow-hidden"
      style={{
        fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
      }}
    >
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800/80 bg-[#08080d] flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-gradient-to-br from-amber-500 to-red-600 rounded-lg flex items-center justify-center text-[10px] font-black text-white">
              SS
            </div>
            <div>
              <div className="text-sm font-black tracking-tight text-zinc-100">
                STORMSCOPE
              </div>
              <div className="text-[9px] text-zinc-600 tracking-widest uppercase">
                Hail Intelligence Platform
              </div>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-[10px] text-emerald-400 uppercase tracking-wider">
              Live
            </span>
          </div>
          <div className="text-[10px] text-zinc-600">
            {new Date().toLocaleString('en-US', {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </div>
        </div>
      </header>

      {/* Storm Selector Bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-800/50 bg-[#08080d] overflow-x-auto flex-shrink-0">
        {STORM_EVENTS.map((s) => (
          <button
            key={s.id}
            onClick={() => setActiveStorm(s)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs whitespace-nowrap transition-all border ${
              activeStorm.id === s.id
                ? 'bg-zinc-800 border-zinc-600 text-zinc-100'
                : 'bg-transparent border-transparent text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900'
            }`}
          >
            <div
              className={`w-1.5 h-1.5 rounded-full ${s.status === 'active' ? 'bg-red-500 animate-pulse' : s.status === 'verified' ? 'bg-emerald-500' : 'bg-zinc-600'}`}
            />
            <span className="font-semibold">{s.name}</span>
            <span className="text-zinc-600">{s.maxMesh}"</span>
          </button>
        ))}
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-5 gap-2 px-4 py-2 border-b border-zinc-800/50 bg-[#08080d] flex-shrink-0">
        <StatCard label="Properties" value={stats.total} sub="in swath" />
        <StatCard
          label="High Risk"
          value={stats.high}
          accent="text-red-400"
          sub={`>${stats.total > 0 ? ((stats.high / stats.total) * 100).toFixed(0) : 0}%`}
        />
        <StatCard label="Moderate" value={stats.mod} accent="text-amber-400" />
        <StatCard
          label="Canvassed"
          value={stats.visited}
          accent="text-violet-400"
          sub={`of ${stats.total}`}
        />
        <StatCard
          label="Drone Data"
          value={stats.drone}
          accent="text-sky-400"
          sub="verified"
        />
      </div>

      {/* Tab Nav */}
      <div className="flex items-center justify-between px-4 py-1.5 border-b border-zinc-800/50 bg-[#08080d] flex-shrink-0">
        <div className="flex items-center gap-1">
          {(
            [
              { key: 'map', label: '◉ Map' },
              { key: 'scout', label: '⚡ AI Scout' },
              { key: 'storms', label: '☁ Storms' },
            ] as { key: ViewKey; label: string }[]
          ).map((t) => (
            <button
              key={t.key}
              onClick={() => setView(t.key)}
              className={`px-3 py-1.5 rounded text-[11px] font-bold uppercase tracking-wider transition-all ${
                view === t.key
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          {(
            [
              { key: 'all', label: 'All' },
              { key: 'high', label: 'High Risk' },
              { key: 'unvisited', label: 'Unvisited' },
            ] as { key: FilterKey; label: string }[]
          ).map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-2.5 py-1 rounded text-[10px] uppercase tracking-wider transition-all border ${
                filter === f.key
                  ? 'bg-zinc-800 border-zinc-600 text-zinc-300'
                  : 'border-transparent text-zinc-600 hover:text-zinc-400'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex min-h-0">
        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
              <div className="text-xs text-zinc-500 uppercase tracking-widest">
                Processing MESH Data...
              </div>
              <div className="text-[10px] text-zinc-700 mt-1">
                {activeStorm.name} · {activeStorm.county}
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="flex-1 min-w-0 relative">
              {view === 'map' && (
                <div className="absolute inset-0 p-2">
                  <HailSwathMap
                    properties={filteredProperties}
                    selectedId={selectedPropId}
                    onSelect={setSelectedPropId}
                    meshMax={activeStorm.maxMesh}
                  />
                </div>
              )}
              {view === 'scout' && (
                <div className="absolute inset-0 overflow-y-auto p-4">
                  <div className="mb-3">
                    <h3 className="text-xs font-black uppercase tracking-widest text-amber-400 mb-1">
                      ⚡ AI Scout — Top Targets
                    </h3>
                    <p className="text-[10px] text-zinc-600">
                      Ranked by composite damage probability: MESH intensity ×
                      roof vulnerability × wind exposure × prior claims history
                    </p>
                  </div>
                  <AIScoutPanel
                    properties={filteredProperties}
                    onSelect={(id) => {
                      setSelectedPropId(id);
                      setView('map');
                    }}
                  />
                </div>
              )}
              {view === 'storms' && (
                <div className="absolute inset-0 overflow-y-auto p-4 space-y-2">
                  <h3 className="text-xs font-black uppercase tracking-widest text-zinc-400 mb-2">
                    Recent Storm Events
                  </h3>
                  {STORM_EVENTS.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => {
                        setActiveStorm(s);
                        setView('map');
                      }}
                      className={`w-full text-left p-3 rounded-lg border transition-all ${
                        activeStorm.id === s.id
                          ? 'bg-zinc-800 border-zinc-600'
                          : 'bg-zinc-900/40 border-zinc-800/50 hover:bg-zinc-800/60'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-bold">{s.name}</span>
                        <Badge
                          color={
                            s.status === 'active'
                              ? 'red'
                              : s.status === 'verified'
                                ? 'green'
                                : 'gray'
                          }
                        >
                          {s.status}
                        </Badge>
                      </div>
                      <div className="text-[10px] text-zinc-500">
                        {s.county} · Max MESH: {s.maxMesh}" ·{' '}
                        {new Date(s.timestamp).toLocaleString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </div>
                      <div className="text-[10px] text-zinc-600 mt-1">
                        Lat {s.lat.toFixed(4)} · Lng {s.lng.toFixed(4)}
                      </div>
                    </button>
                  ))}
                  <div className="p-3 rounded-lg border border-dashed border-zinc-800 text-center">
                    <div className="text-[10px] text-zinc-600 uppercase tracking-wider">
                      Data Sources
                    </div>
                    <div className="text-[10px] text-zinc-700 mt-1">
                      NOAA MRMS/MESH · SPC Storm Reports · NWS Alerts
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Right Sidebar */}
            <div className="w-80 border-l border-zinc-800/80 bg-[#08080d] overflow-y-auto flex-shrink-0">
              {selectedProp ? (
                <PropertyDetail
                  property={selectedProp}
                  onCanvass={handleCanvass}
                  onClose={() => setSelectedPropId(null)}
                />
              ) : (
                <div className="p-4">
                  <div className="text-center py-8">
                    <div className="text-zinc-700 text-3xl mb-2">◎</div>
                    <div className="text-[10px] text-zinc-600 uppercase tracking-widest">
                      Select a property on the map
                    </div>
                    <div className="text-[10px] text-zinc-700 mt-1">
                      or use AI Scout to find targets
                    </div>
                  </div>

                  <div className="mt-4">
                    <div className="text-[10px] uppercase tracking-widest text-zinc-600 mb-2 px-1">
                      Quick Actions
                    </div>
                    <div className="space-y-1.5">
                      <button
                        onClick={() => setView('scout')}
                        className="w-full text-left px-3 py-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs hover:bg-amber-500/15 transition-all"
                      >
                        <div className="font-bold">⚡ AI Scout</div>
                        <div className="text-[10px] text-amber-400/60 mt-0.5">
                          Top {stats.high} high-risk properties ranked
                        </div>
                      </button>
                      <button className="w-full text-left px-3 py-2.5 rounded-lg bg-sky-500/10 border border-sky-500/20 text-sky-300 text-xs hover:bg-sky-500/15 transition-all">
                        <div className="font-bold">🛸 Request Drone Scan</div>
                        <div className="text-[10px] text-sky-400/60 mt-0.5">
                          Upload or request aerial verification
                        </div>
                      </button>
                      <button className="w-full text-left px-3 py-2.5 rounded-lg bg-violet-500/10 border border-violet-500/20 text-violet-300 text-xs hover:bg-violet-500/15 transition-all">
                        <div className="font-bold">📋 Export Canvass Route</div>
                        <div className="text-[10px] text-violet-400/60 mt-0.5">
                          {stats.total - stats.visited} unvisited properties
                        </div>
                      </button>
                      <button className="w-full text-left px-3 py-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs hover:bg-emerald-500/15 transition-all">
                        <div className="font-bold">📊 Storm Impact Report</div>
                        <div className="text-[10px] text-emerald-400/60 mt-0.5">
                          Generate PDF for {activeStorm.name}
                        </div>
                      </button>
                    </div>
                  </div>

                  <div className="mt-6 p-3 rounded-lg border border-zinc-800/60 bg-zinc-900/30">
                    <div className="text-[10px] uppercase tracking-widest text-zinc-600 mb-2">
                      Scoring Model
                    </div>
                    <div className="space-y-1 text-[10px] text-zinc-500">
                      <div className="flex justify-between">
                        <span>MESH Intensity</span>
                        <span className="text-zinc-400">45%</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Roof Vulnerability</span>
                        <span className="text-zinc-400">30%</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Wind Exposure</span>
                        <span className="text-zinc-400">15%</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Tree Cover Factor</span>
                        <span className="text-zinc-400">10%</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Status Bar */}
      <footer className="flex items-center justify-between px-4 py-1.5 border-t border-zinc-800/50 bg-[#08080d] text-[9px] text-zinc-600 uppercase tracking-wider flex-shrink-0">
        <div className="flex items-center gap-4">
          <span>
            MRMS Feed: <span className="text-emerald-500">Connected</span>
          </span>
          <span>
            SPC Reports: <span className="text-emerald-500">Synced</span>
          </span>
          <span>MESH v12.2</span>
        </div>
        <div className="flex items-center gap-4">
          <span>
            Properties: {filteredProperties.length}/{stats.total}
          </span>
          <span>Region: Lafayette Parish, LA</span>
        </div>
      </footer>
    </div>
  );
}
