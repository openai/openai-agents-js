import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  runSupplementCopilot,
  runAIScout,
  runConcierge,
  type SupplementDraft,
  type ConciergeResponse,
} from './agents';
import { ReconMap } from './ReconMap';

// ═══════════════════════════════════════════════════
// DATA + API LAYER
// ═══════════════════════════════════════════════════

interface NWSAlert {
  id: string;
  event: string;
  headline: string;
  severity: string;
}

interface SPCReport {
  id: number;
  time: string;
  size: string;
  loc: string;
  state: string;
  lat: number;
  lon: number;
}

interface Property {
  id: string;
  address: string;
  homeowner: string;
  phone: string;
  mesh: number;
  roof: string;
  cond: string;
  age: number;
  sqft: number;
  year: number;
  damageProb: number;
  closeProb: number;
  estValue: number;
  expectedValue: number;
  source: string;
  status:
    | 'new'
    | 'contacted'
    | 'inspected'
    | 'proposed'
    | 'contracted'
    | 'installed';
  claims: number;
  contactPref: 'phone' | 'text' | 'email';
  minsAgo: number;
  responseTime: string;
  hasInspection: boolean;
  hasSupplement: boolean;
}

async function fetchNWSAlerts(): Promise<NWSAlert[]> {
  try {
    const pt = await fetch('https://api.weather.gov/points/30.22,-92.02', {
      headers: { 'User-Agent': 'StormScope/3.0' },
    });
    const d = await pt.json();
    const zone = d?.properties?.forecastZone?.split('/').pop();
    const county = d?.properties?.county?.split('/').pop();
    const r = await fetch(
      `https://api.weather.gov/alerts/active?zone=${zone},${county}`,
      {
        headers: { 'User-Agent': 'StormScope/3.0' },
      },
    );
    return ((await r.json()).features || []).map(
      (f: {
        properties: {
          id: string;
          event: string;
          headline: string;
          severity: string;
        };
      }) => ({
        id: f.properties.id,
        event: f.properties.event,
        headline: f.properties.headline,
        severity: f.properties.severity,
      }),
    );
  } catch {
    return [];
  }
}

async function fetchSPC(): Promise<SPCReport[]> {
  try {
    const r = await fetch(
      'https://www.spc.noaa.gov/climo/reports/today_filtered_hail.csv',
    );
    const t = await r.text();
    return t
      .trim()
      .split('\n')
      .slice(1, 25)
      .map((l, i) => {
        const p = l.split(',');
        return {
          id: i,
          time: p[0],
          size: p[1],
          loc: p[2],
          state: p[4],
          lat: +p[5],
          lon: +p[6],
        };
      })
      .filter((row) => row.lat);
  } catch {
    return [];
  }
}

const R = (s: number) => {
  let x = s;
  return () => {
    x = (x * 16807) % 2147483647;
    return (x - 1) / 2147483646;
  };
};

const STREETS = [
  'Johnston St',
  'Ambassador Caffery',
  'Kaliste Saloom',
  'Pinhook Rd',
  'Congress St',
  'University Ave',
  'Bertrand Dr',
  'Camellia Blvd',
  'Verot School Rd',
  'Ridge Rd',
  'Settlers Trace',
  'Guilbeau Rd',
  'Bonin Rd',
  'Surrey St',
  'Cajundome Blvd',
  'Eraste Landry Rd',
];
const ROOFS = [
  'Asphalt 3-Tab',
  'Architectural Shingle',
  'Metal Standing Seam',
  'Clay Tile',
  'TPO Membrane',
  'Wood Shake',
];
const NAMES = [
  'Sarah M.',
  'James T.',
  'Maria G.',
  'Robert K.',
  'Lisa P.',
  'David W.',
  'Jennifer H.',
  'Michael C.',
  'Amanda R.',
  'Chris L.',
  'Nicole B.',
  'Tyler F.',
  'Karen D.',
  'Brian S.',
  'Ashley J.',
];
const SOURCES = [
  'Storm Canvass',
  'Google Ads',
  'Referral',
  'GBP Organic',
  'Yard Sign',
  'Repeat Customer',
  'Nextdoor',
  'Facebook Ad',
  'Insurance Referral',
  'Home Advisor',
];
const CONDS = ['New', 'Good', 'Aging', 'Worn', 'Critical'] as const;
const STATUSES = [
  'new',
  'new',
  'new',
  'contacted',
  'inspected',
  'proposed',
  'contracted',
  'installed',
] as const;

function genProps(n: number, seed: number): Property[] {
  const r = R(seed);
  return Array.from({ length: n }, (_, i) => {
    const mesh = r() * 3.5 + 0.5;
    const age = Math.floor(r() * 35);
    const ci = age < 3 ? 0 : age < 8 ? 1 : age < 15 ? 2 : age < 25 ? 3 : 4;
    const vuln = [0.1, 0.25, 0.5, 0.75, 0.95][ci];
    const raw =
      Math.min(mesh / 2.5, 1) * 0.45 +
      vuln * 0.3 +
      r() * 0.3 * 0.15 +
      r() * 0.15 * 0.1;
    const prob = Math.min(Math.max(raw + (r() - 0.5) * 0.1, 0.02), 0.99);
    const closeProb = prob * (0.5 + r() * 0.4) * (age > 15 ? 1.2 : 1);
    const jobValue = Math.floor(6000 + r() * 18000);
    const minsAgo = Math.floor(r() * 480);
    return {
      id: `P${String(i).padStart(3, '0')}`,
      address: `${Math.floor(r() * 9000 + 100)} ${STREETS[Math.floor(r() * STREETS.length)]}`,
      homeowner: NAMES[Math.floor(r() * NAMES.length)],
      phone: `(337) ${Math.floor(r() * 900 + 100)}-${Math.floor(r() * 9000 + 1000)}`,
      mesh: +mesh.toFixed(2),
      roof: ROOFS[Math.floor(r() * ROOFS.length)],
      cond: CONDS[ci],
      age,
      sqft: Math.floor(r() * 3000 + 800),
      year: 2026 - Math.floor(r() * 55 + 5),
      damageProb: +prob.toFixed(3),
      closeProb: +Math.min(closeProb, 0.95).toFixed(3),
      estValue: jobValue,
      expectedValue: Math.floor(jobValue * closeProb),
      source: SOURCES[Math.floor(r() * SOURCES.length)],
      status: STATUSES[Math.floor(r() * 8)],
      claims: Math.floor(r() * 3),
      contactPref: (r() > 0.6 ? 'phone' : r() > 0.3 ? 'text' : 'email') as
        | 'phone'
        | 'text'
        | 'email',
      minsAgo,
      responseTime:
        minsAgo < 5
          ? '< 5 min'
          : minsAgo < 30
            ? `${minsAgo} min`
            : `${Math.floor(minsAgo / 60)}h ${minsAgo % 60}m`,
      hasInspection: r() > 0.6,
      hasSupplement: r() > 0.8,
    };
  }).sort((a, b) => b.expectedValue - a.expectedValue);
}

// ═══════════════════════════════════════════════════
// SHARED UI PRIMITIVES
// ═══════════════════════════════════════════════════

const pc = (p: number) =>
  p > 0.7 ? '#ef4444' : p > 0.4 ? '#f59e0b' : p > 0.2 ? '#22c55e' : '#52525b';
const pt = (p: number) =>
  p > 0.7
    ? 'text-red-400'
    : p > 0.4
      ? 'text-amber-400'
      : p > 0.2
        ? 'text-emerald-400'
        : 'text-zinc-500';

const BADGE_COLORS: Record<string, string> = {
  red: 'bg-red-500/15 text-red-400 border-red-500/25',
  amber: 'bg-amber-500/15 text-amber-400 border-amber-500/25',
  green: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
  blue: 'bg-sky-500/15 text-sky-400 border-sky-500/25',
  violet: 'bg-violet-500/15 text-violet-400 border-violet-500/25',
  zinc: 'bg-zinc-800 text-zinc-400 border-zinc-700',
  cyan: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/25',
};

function Badge({
  children,
  color = 'zinc',
}: {
  children: React.ReactNode;
  color?: string;
}) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider border rounded-md ${BADGE_COLORS[color]}`}
    >
      {children}
    </span>
  );
}

function Bar({ value, max = 1 }: { value: number; max?: number }) {
  return (
    <div className="w-full h-1.5 bg-zinc-800/80 rounded-full overflow-hidden">
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${(value / max) * 100}%`, backgroundColor: pc(value) }}
      />
    </div>
  );
}

function KPI({
  label,
  value,
  sub,
  accent,
  large,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: string;
  large?: boolean;
}) {
  return (
    <div
      className={`bg-zinc-900/70 border border-zinc-800/60 rounded-xl ${large ? 'p-4' : 'p-2.5'}`}
    >
      <div className="text-[8px] uppercase tracking-[0.2em] text-zinc-600 mb-0.5">
        {label}
      </div>
      <div
        className={`${large ? 'text-3xl' : 'text-xl'} font-black tabular-nums leading-tight ${accent || 'text-zinc-100'}`}
      >
        {value}
      </div>
      {sub && <div className="text-[10px] text-zinc-600 mt-0.5">{sub}</div>}
    </div>
  );
}

const STATUS_MAP: Record<string, [string, string]> = {
  new: ['New', 'blue'],
  contacted: ['Contacted', 'cyan'],
  inspected: ['Inspected', 'amber'],
  proposed: ['Proposed', 'violet'],
  contracted: ['Contracted', 'green'],
  installed: ['Installed', 'green'],
};

function StatusPill({ status }: { status: string }) {
  const [label, color] = STATUS_MAP[status] ?? ['Unknown', 'zinc'];
  return <Badge color={color}>{label}</Badge>;
}

function Spinner({
  className = 'w-3.5 h-3.5 border-amber-400',
}: {
  className?: string;
}) {
  return (
    <span
      className={`${className} border-2 border-t-transparent rounded-full animate-spin inline-block`}
    />
  );
}

// ═══════════════════════════════════════════════════
// VIEW: OWNER KPI COMMAND CENTER
// ═══════════════════════════════════════════════════

function OwnerDashboard({
  props,
  alerts,
  spc,
}: {
  props: Property[];
  alerts: NWSAlert[];
  spc: SPCReport[];
}) {
  const stats = useMemo(() => {
    const byStatus = (s: string) => props.filter((p) => p.status === s).length;
    const pipeline = props.filter((p) =>
      ['contacted', 'inspected', 'proposed', 'contracted'].includes(p.status),
    );
    const slow = props.filter(
      (p) => p.minsAgo > 30 && p.status === 'new',
    ).length;
    const bySource: Record<string, number> = {};
    props.forEach((p) => {
      bySource[p.source] = (bySource[p.source] || 0) + 1;
    });
    return {
      leads: byStatus('new'),
      contacted: byStatus('contacted'),
      inspected: byStatus('inspected'),
      proposed: byStatus('proposed'),
      contracted: byStatus('contracted'),
      installed: byStatus('installed'),
      pipelineValue: pipeline.reduce((s, p) => s + p.estValue, 0),
      avgClose: props.reduce((s, p) => s + p.closeProb, 0) / props.length,
      fast: props.filter((p) => p.minsAgo < 5).length,
      slow,
      avgJobValue: Math.floor(
        props.reduce((s, p) => s + p.estValue, 0) / props.length,
      ),
      topSources: Object.entries(bySource)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5),
      total: props.length,
    };
  }, [props]);

  const PIPELINE = [
    ['New', stats.leads, 'text-sky-400'],
    ['Contacted', stats.contacted, 'text-cyan-400'],
    ['Inspected', stats.inspected, 'text-amber-400'],
    ['Proposed', stats.proposed, 'text-violet-400'],
    ['Contracted', stats.contracted, 'text-emerald-400'],
    ['Installed', stats.installed, 'text-emerald-400'],
  ] as const;

  return (
    <div className="space-y-3">
      <div className="bg-zinc-900/50 rounded-xl border border-zinc-800/50 p-3">
        <div className="text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-500 mb-3">
          Sales Pipeline
        </div>
        <div className="grid grid-cols-6 gap-1">
          {PIPELINE.map(([label, val, cls]) => (
            <div key={label} className="text-center">
              <div className={`text-lg font-black tabular-nums ${cls}`}>
                {val}
              </div>
              <div className="text-[7px] uppercase text-zinc-600 tracking-wider">
                {label}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[10px] text-zinc-500">Pipeline Value</span>
          <span className="text-sm font-black text-emerald-400">
            ${(stats.pipelineValue / 1000).toFixed(0)}K
          </span>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <KPI
          label="Avg Job Value"
          value={`$${(stats.avgJobValue / 1000).toFixed(1)}K`}
        />
        <KPI
          label="Avg Close Prob"
          value={`${(stats.avgClose * 100).toFixed(0)}%`}
          accent={pt(stats.avgClose)}
        />
        <KPI
          label="Fast Response"
          value={stats.fast}
          sub="< 5 min"
          accent="text-emerald-400"
        />
        <KPI
          label="Stale Leads"
          value={stats.slow}
          sub="> 30 min"
          accent={stats.slow > 5 ? 'text-red-400' : 'text-amber-400'}
        />
        <KPI
          label="SPC Reports"
          value={spc.length}
          sub="today"
          accent="text-amber-400"
        />
        <KPI
          label="NWS Alerts"
          value={alerts.length}
          sub="active"
          accent={alerts.length > 0 ? 'text-red-400' : 'text-emerald-400'}
        />
      </div>

      <div className="bg-zinc-900/50 rounded-xl border border-zinc-800/50 p-3">
        <div className="text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-500 mb-2">
          Lead Sources
        </div>
        {stats.topSources.map(([source, count]) => (
          <div key={source} className="flex items-center gap-2 mb-1.5">
            <span className="text-[10px] text-zinc-400 w-28 truncate">
              {source}
            </span>
            <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-amber-500/60 rounded-full"
                style={{ width: `${(count / stats.total) * 100}%` }}
              />
            </div>
            <span className="text-[10px] text-zinc-500 tabular-nums w-6 text-right">
              {count}
            </span>
          </div>
        ))}
      </div>

      <div className="bg-zinc-900/50 rounded-xl border border-zinc-800/50 p-3">
        <div className="text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-500 mb-2">
          ⚠ Action Items
        </div>
        <div className="space-y-1.5 text-[11px]">
          {stats.slow > 0 && (
            <div className="flex items-start gap-2 text-red-400">
              <span className="mt-0.5">●</span>
              <span>
                {stats.slow} leads waiting 30+ min — speed compounds before
                competitors answer
              </span>
            </div>
          )}
          {stats.inspected > 3 && (
            <div className="flex items-start gap-2 text-amber-400">
              <span className="mt-0.5">●</span>
              <span>
                {stats.inspected} inspections need proposals — cycle time is
                leaking close rate
              </span>
            </div>
          )}
          {stats.proposed > 2 && (
            <div className="flex items-start gap-2 text-violet-400">
              <span className="mt-0.5">●</span>
              <span>
                {stats.proposed} proposals out — follow-up cadence check needed
              </span>
            </div>
          )}
          <div className="flex items-start gap-2 text-emerald-400">
            <span className="mt-0.5">●</span>
            <span>
              {stats.installed} jobs completed — trigger review request within
              48h
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════
// VIEW: SALES REP — TERRITORY + LEADS + AI SCOUT
// ═══════════════════════════════════════════════════

function SalesView({
  props,
  onSelect,
  aiEnabled,
  scoutReasons,
  scoutLoading,
  scoutError,
  onRunScout,
  conciergeState,
  onDraftResponse,
}: {
  props: Property[];
  onSelect: (p: Property) => void;
  aiEnabled: boolean;
  scoutReasons: Map<string, string>;
  scoutLoading: boolean;
  scoutError: string | null;
  onRunScout: () => void;
  conciergeState: Map<
    string,
    { loading: boolean; result: ConciergeResponse | null; error: string | null }
  >;
  onDraftResponse: (p: Property) => void;
}) {
  const [filter, setFilter] = useState<'all' | 'hot' | 'stale' | 'ready'>(
    'all',
  );
  const filtered = useMemo(() => {
    if (filter === 'hot')
      return props.filter((p) => p.expectedValue > 5000 && p.status === 'new');
    if (filter === 'stale')
      return props.filter((p) => p.minsAgo > 30 && p.status === 'new');
    if (filter === 'ready')
      return props.filter((p) => p.hasInspection && p.status === 'inspected');
    return props;
  }, [props, filter]);

  return (
    <div className="space-y-2">
      {/* AI Concierge status bar */}
      <div className="bg-gradient-to-r from-sky-500/10 to-violet-500/10 rounded-xl border border-sky-500/20 p-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-sky-400">
            🤖 AI Lead Concierge
          </span>
          <Badge color={aiEnabled ? 'green' : 'zinc'}>
            {aiEnabled ? 'Active' : 'No API Key'}
          </Badge>
        </div>
        <div className="text-[11px] text-zinc-400">
          {aiEnabled ? (
            <>
              Auto-responding to new leads via preferred channel. Avg response:{' '}
              <span className="text-emerald-400 font-bold">47 sec</span>. Set
              rate: <span className="text-emerald-400 font-bold">78%</span>
            </>
          ) : (
            'Add VITE_OPENAI_API_KEY to .env.local to enable AI features'
          )}
        </div>
      </div>

      {/* AI Scout trigger */}
      <div className="flex items-center gap-2">
        <button
          onClick={onRunScout}
          disabled={!aiEnabled || scoutLoading}
          title={
            !aiEnabled ? 'Add VITE_OPENAI_API_KEY to .env.local' : undefined
          }
          className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all flex items-center gap-1.5 ${
            !aiEnabled
              ? 'text-zinc-700 cursor-not-allowed'
              : scoutLoading
                ? 'bg-amber-500/10 text-amber-500'
                : scoutReasons.size > 0
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                  : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
          }`}
        >
          {scoutLoading ? (
            <>
              <Spinner className="w-3 h-3 border-amber-400" /> Scouting...
            </>
          ) : (
            '⚡ Run AI Scout'
          )}
        </button>
        {scoutError && (
          <span className="text-[10px] text-red-400">{scoutError}</span>
        )}
        {scoutReasons.size > 0 && !scoutLoading && (
          <span className="text-[10px] text-amber-400">
            {scoutReasons.size} properties analyzed
          </span>
        )}
      </div>

      {/* Filters */}
      <div className="flex gap-1.5">
        {(
          [
            ['all', 'All'],
            ['hot', '🔥 High EV'],
            ['stale', '⚠ Stale'],
            ['ready', '✓ Needs Proposal'],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            onClick={() => setFilter(k)}
            className={`px-2.5 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all ${filter === k ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-600'}`}
          >
            {l}
          </button>
        ))}
      </div>

      <div className="text-[9px] font-bold uppercase tracking-[0.2em] text-amber-400 px-1">
        ⚡ {filtered.length} Targets — Ranked by Expected Value
      </div>

      {filtered.slice(0, 15).map((p, i) => {
        const conc = conciergeState.get(p.id);
        return (
          <div
            key={p.id}
            className="bg-zinc-900/40 rounded-xl border border-zinc-800/40 overflow-hidden"
          >
            <button
              onClick={() => onSelect(p)}
              className="w-full text-left p-3 hover:bg-zinc-800/40 transition-all"
            >
              <div className="flex items-start justify-between mb-1.5">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-[10px] font-mono text-zinc-600">
                      #{i + 1}
                    </span>
                    <span className="text-[12px] font-semibold text-zinc-200 truncate">
                      {p.address}
                    </span>
                  </div>
                  <div className="text-[10px] text-zinc-500">
                    {p.homeowner} · {p.contactPref} preferred · {p.source}
                  </div>
                  {scoutReasons.has(p.id) && (
                    <div className="text-[10px] text-amber-300/80 mt-0.5 italic">
                      ⚡ {scoutReasons.get(p.id)}
                    </div>
                  )}
                </div>
                <StatusPill status={p.status} />
              </div>
              <div className="flex items-center gap-3 text-[10px]">
                <span className="text-zinc-500">
                  MESH{' '}
                  <span className={`font-bold ${pt(p.damageProb)}`}>
                    {p.mesh}"
                  </span>
                </span>
                <span className="text-zinc-500">
                  Dmg{' '}
                  <span className={`font-bold ${pt(p.damageProb)}`}>
                    {(p.damageProb * 100).toFixed(0)}%
                  </span>
                </span>
                <span className="text-zinc-500">
                  Close{' '}
                  <span className={`font-bold ${pt(p.closeProb)}`}>
                    {(p.closeProb * 100).toFixed(0)}%
                  </span>
                </span>
                <span className="text-zinc-500">
                  EV{' '}
                  <span className="font-bold text-emerald-400">
                    ${(p.expectedValue / 1000).toFixed(1)}K
                  </span>
                </span>
                <span
                  className={`ml-auto font-bold ${p.minsAgo < 5 ? 'text-emerald-400' : p.minsAgo < 30 ? 'text-amber-400' : 'text-red-400'}`}
                >
                  {p.responseTime}
                </span>
              </div>
              <Bar value={p.closeProb} />
            </button>

            {/* Draft Response row — visible for new leads when AI is enabled */}
            {p.status === 'new' && (
              <div className="border-t border-zinc-800/40 px-3 py-2">
                {!conc || (!conc.loading && !conc.result) ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDraftResponse(p);
                    }}
                    disabled={!aiEnabled}
                    title={
                      !aiEnabled
                        ? 'Add VITE_OPENAI_API_KEY to .env.local'
                        : undefined
                    }
                    className={`text-[10px] font-bold uppercase tracking-wider transition-all ${aiEnabled ? 'text-sky-400 hover:text-sky-300' : 'text-zinc-700 cursor-not-allowed'}`}
                  >
                    🤖 Draft Response via {p.contactPref}
                  </button>
                ) : conc.loading ? (
                  <div className="flex items-center gap-1.5 text-[10px] text-zinc-500">
                    <Spinner className="w-3 h-3 border-zinc-500" /> Drafting{' '}
                    {p.contactPref} response...
                  </div>
                ) : conc.error ? (
                  <span className="text-[10px] text-red-400">{conc.error}</span>
                ) : conc.result ? (
                  <div className="space-y-1.5">
                    <div className="text-[9px] font-bold uppercase tracking-wider text-sky-400">
                      AI-Drafted {conc.result.channel.toUpperCase()} Response
                    </div>
                    {conc.result.channel === 'phone' ? (
                      <ul className="space-y-0.5">
                        {conc.result.talkingPoints.map((pt, i) => (
                          <li
                            key={i}
                            className="text-[11px] text-zinc-300 flex gap-1.5"
                          >
                            <span className="text-zinc-600">{i + 1}.</span>
                            {pt}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="text-[11px] text-zinc-300">
                        {conc.result.message}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════
// VIEW: PROPERTY DETAIL — FULL FLYWHEEL
// ═══════════════════════════════════════════════════

function PropertyDetail({
  p,
  onBack,
  aiEnabled,
}: {
  p: Property;
  onBack: () => void;
  aiEnabled: boolean;
}) {
  const [activeTab, setActiveTab] = useState<
    'overview' | 'evidence' | 'supplement' | 'homeowner'
  >('overview');
  const [supplementDraft, setSupplementDraft] =
    useState<SupplementDraft | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [supplementError, setSupplementError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const draftSupplement = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setDrafting(true);
    setSupplementError(null);
    try {
      const draft = await runSupplementCopilot(
        {
          roof: p.roof,
          age: p.age,
          sqft: p.sqft,
          mesh: p.mesh,
          damageProb: p.damageProb,
          cond: p.cond,
        },
        ctrl.signal,
      );
      setSupplementDraft(draft);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setSupplementError(String(e));
    } finally {
      setDrafting(false);
    }
  }, [p]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const TABS = [
    ['overview', 'Property'],
    ['evidence', 'Evidence'],
    ['supplement', 'Supplement'],
    ['homeowner', 'Homeowner View'],
  ] as const;

  return (
    <div className="space-y-3">
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        <span>←</span> Back to list
      </button>

      <div className="bg-zinc-900/60 rounded-xl border border-zinc-800/50 p-4">
        <div className="flex items-start justify-between mb-2">
          <div>
            <div className="text-[14px] font-bold text-zinc-100">
              {p.address}
            </div>
            <div className="text-[11px] text-zinc-500">
              {p.homeowner} · {p.phone} · Prefers {p.contactPref}
            </div>
          </div>
          <StatusPill status={p.status} />
        </div>
        <div className="grid grid-cols-4 gap-2 mt-3">
          {[
            [`${(p.damageProb * 100).toFixed(0)}%`, 'Damage', pt(p.damageProb)],
            [`${(p.closeProb * 100).toFixed(0)}%`, 'Close', pt(p.closeProb)],
            [
              `$${(p.estValue / 1000).toFixed(1)}K`,
              'Est Value',
              'text-zinc-200',
            ],
            [
              `$${(p.expectedValue / 1000).toFixed(1)}K`,
              'Exp Value',
              'text-emerald-400',
            ],
          ].map(([val, label, cls]) => (
            <div key={label} className="text-center">
              <div className={`text-lg font-black ${cls}`}>{val}</div>
              <div className="text-[8px] text-zinc-600 uppercase">{label}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex gap-1 flex-wrap">
        {TABS.map(([k, l]) => (
          <button
            key={k}
            onClick={() => setActiveTab(k)}
            className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider ${activeTab === k ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-600'}`}
          >
            {l}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ['MESH at Site', `${p.mesh}"`],
              ['Roof Type', p.roof],
              ['Roof Age', `${p.age} yr`],
              ['Condition', p.cond],
              ['Year Built', p.year],
              ['Sqft', p.sqft.toLocaleString()],
              ['Prior Claims', p.claims],
              ['Source', p.source],
            ] as const
          ).map(([l, v]) => (
            <div
              key={l}
              className="bg-zinc-900/40 rounded-lg p-2.5 border border-zinc-800/40"
            >
              <div className="text-[8px] uppercase tracking-widest text-zinc-600">
                {l}
              </div>
              <div className="text-[12px] text-zinc-200 font-semibold mt-0.5">
                {v}
              </div>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'evidence' && (
        <div className="space-y-2">
          <div className="text-[10px] text-zinc-500">
            Turn every inspection into a homeowner-ready AND claim-ready proof
            package in minutes.
          </div>
          <div className="bg-zinc-900/40 rounded-xl border border-zinc-800/40 p-3">
            <div className="text-[9px] font-bold uppercase tracking-[0.2em] text-sky-400 mb-2">
              📋 Evidence Pack Status
            </div>
            {(
              [
                ['Hail swath overlay', 'MESH radar confirmation', true],
                ['Property attributes', 'Roof age, type, sqft', true],
                ['Inspection photos', 'Field capture', false],
                ['AI damage analysis', 'Claude Vision scoring', false],
                ['Weather event timestamp', 'NOAA verification', true],
              ] as const
            ).map(([item, desc, done]) => (
              <div
                key={item}
                className="flex items-center gap-2 py-1.5 border-b border-zinc-800/30 last:border-0"
              >
                <span
                  className={`text-[10px] w-4 ${done ? 'text-emerald-400' : 'text-zinc-600'}`}
                >
                  {done ? '✓' : '—'}
                </span>
                <div className="flex-1">
                  <div className="text-[11px] text-zinc-300">{item}</div>
                  <div className="text-[9px] text-zinc-600">{desc}</div>
                </div>
              </div>
            ))}
          </div>
          <button className="w-full py-3 rounded-xl bg-sky-500/10 border border-sky-500/20 text-sky-400 text-[11px] font-bold uppercase tracking-wider">
            🛸 Upload Drone Imagery for AI Scan
          </button>
          <button className="w-full py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[11px] font-bold uppercase tracking-wider">
            📄 Generate Evidence Pack (PDF)
          </button>
        </div>
      )}

      {activeTab === 'supplement' && (
        <div className="space-y-2">
          <div className="text-[10px] text-zinc-500">
            Cut supplement prep from hours to minutes while keeping human
            approval in the loop.
          </div>
          {!supplementDraft ? (
            <>
              <button
                onClick={draftSupplement}
                disabled={drafting || !aiEnabled}
                title={
                  !aiEnabled
                    ? 'Add VITE_OPENAI_API_KEY to .env.local'
                    : undefined
                }
                className={`w-full py-4 rounded-xl border text-[12px] font-bold uppercase tracking-wider transition-all ${
                  !aiEnabled
                    ? 'bg-zinc-900 border-zinc-800 text-zinc-700 cursor-not-allowed'
                    : drafting
                      ? 'bg-zinc-800 border-zinc-700 text-zinc-500'
                      : 'bg-amber-500/10 border-amber-500/20 text-amber-400 hover:bg-amber-500/15'
                }`}
              >
                {drafting ? (
                  <span className="flex items-center justify-center gap-2">
                    <Spinner className="w-3.5 h-3.5 border-amber-400" />{' '}
                    Drafting supplement with AI...
                  </span>
                ) : (
                  '⚡ Draft Supplement with AI Copilot'
                )}
              </button>
              {supplementError && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 text-[11px] text-red-400">
                  {supplementError}
                </div>
              )}
            </>
          ) : (
            <div className="space-y-2">
              <div className="bg-zinc-900/50 rounded-xl border border-amber-500/20 p-3">
                <div className="text-[9px] font-bold uppercase tracking-[0.2em] text-amber-400 mb-2">
                  AI-Drafted Line Items (Human Review Required)
                </div>
                {supplementDraft.items.map((item, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 py-2 border-b border-zinc-800/30 last:border-0"
                  >
                    <span className="text-[9px] font-mono text-zinc-600 w-20 flex-shrink-0">
                      {item.code}
                    </span>
                    <div className="flex-1">
                      <div className="text-[11px] text-zinc-300">
                        {item.description}
                      </div>
                      <div className="text-[9px] text-zinc-500">
                        {item.quantity} — {item.note}
                      </div>
                    </div>
                  </div>
                ))}
                <div className="mt-2 pt-2 border-t border-zinc-800/30">
                  <div className="text-[10px] text-zinc-500">
                    Waste: {supplementDraft.wastePercent}% —{' '}
                    {supplementDraft.wasteReason}
                  </div>
                  <div className="text-[11px] text-zinc-300 font-bold mt-1">
                    Est. Range: {supplementDraft.estimatedRange}
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <button className="flex-1 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-bold uppercase">
                  ✓ Approve & Export
                </button>
                <button
                  onClick={() => setSupplementDraft(null)}
                  className="flex-1 py-2.5 rounded-xl bg-zinc-800 border border-zinc-700 text-zinc-400 text-[10px] font-bold uppercase"
                >
                  ↺ Redraft
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'homeowner' && (
        <div className="space-y-2">
          <div className="text-[10px] text-zinc-500">
            79% use referrals first. 67% say reviews very important. 40% say
            poor communication is the biggest challenge.
          </div>
          <div className="bg-gradient-to-br from-zinc-900 to-zinc-800/50 rounded-xl border border-zinc-700/50 p-4">
            <div className="text-center mb-3">
              <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500 mb-1">
                What {p.homeowner} sees
              </div>
              <div className="text-[16px] font-bold text-zinc-100">
                Your Roof Assessment
              </div>
            </div>
            <div className="bg-zinc-800/50 rounded-lg p-3 mb-3">
              <div className="text-[10px] text-zinc-500 uppercase mb-1">
                Property
              </div>
              <div className="text-[12px] text-zinc-300">{p.address}</div>
              <div className="text-[10px] text-zinc-500 mt-2 uppercase mb-1">
                What We Found
              </div>
              <div className="text-[12px] text-zinc-300">
                {p.damageProb > 0.6
                  ? 'Our inspection identified significant storm-related damage consistent with the recent hail event.'
                  : p.damageProb > 0.3
                    ? 'We found moderate indicators of weather-related wear that should be addressed.'
                    : 'Your roof is in reasonable condition with minor areas to monitor.'}
              </div>
              <div className="text-[10px] text-zinc-500 mt-2 uppercase mb-1">
                Recommended Action
              </div>
              <div className="text-[12px] text-zinc-300">
                {p.damageProb > 0.5
                  ? "File an insurance claim — we'll handle the documentation."
                  : 'Schedule a maintenance visit within 6 months.'}
              </div>
            </div>
            <div className="text-[9px] text-zinc-600 text-center">
              Transparent. No pressure. Your timeline.
            </div>
          </div>
          <button className="w-full py-2.5 rounded-xl bg-violet-500/10 border border-violet-500/20 text-violet-400 text-[10px] font-bold uppercase">
            📱 Send to Homeowner via {p.contactPref}
          </button>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════
// VIEW: LIVE WEATHER INTEL
// ═══════════════════════════════════════════════════

function WeatherView({
  alerts,
  spc,
  loading,
}: {
  alerts: NWSAlert[];
  spc: SPCReport[];
  loading: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-500">
        NWS Active Alerts — Lafayette Parish
      </div>
      {loading && (
        <div className="flex items-center gap-2 py-6 justify-center">
          <Spinner className="w-4 h-4 border-amber-500" />
          <span className="text-[10px] text-zinc-600">
            Fetching live data...
          </span>
        </div>
      )}
      {!loading && alerts.length === 0 && (
        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-3 text-center text-[11px] text-emerald-400">
          ✓ No active severe weather alerts
        </div>
      )}
      {alerts.map((a) => (
        <div
          key={a.id}
          className={`rounded-xl p-3 border ${a.severity === 'Severe' ? 'bg-red-500/10 border-red-500/20' : 'bg-amber-500/10 border-amber-500/20'}`}
        >
          <div className="text-[12px] font-bold text-zinc-200">{a.event}</div>
          <div className="text-[10px] text-zinc-400 mt-1">{a.headline}</div>
        </div>
      ))}
      <div className="text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-500 mt-4">
        SPC Hail Reports Today
      </div>
      {spc.length === 0 ? (
        <div className="text-[11px] text-zinc-600 bg-zinc-900/40 rounded-xl p-3 text-center">
          No reports today
        </div>
      ) : (
        <div className="space-y-1">
          {spc.slice(0, 12).map((r) => (
            <div
              key={r.id}
              className="flex items-center gap-3 bg-zinc-900/40 rounded-lg p-2.5 border border-zinc-800/40"
            >
              <div className="w-9 h-9 rounded-lg bg-amber-500/15 flex items-center justify-center text-amber-400 font-black text-[11px]">
                {r.size}"
              </div>
              <div>
                <div className="text-[11px] text-zinc-300">
                  {r.loc}, {r.state}
                </div>
                <div className="text-[9px] text-zinc-600">{r.time}Z</div>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="p-2.5 rounded-lg border border-dashed border-zinc-800 text-center text-[9px] text-zinc-600">
        api.weather.gov · spc.noaa.gov · NOAA MRMS/MESH
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════

type View = 'owner' | 'sales' | 'weather' | 'recon';
type ConciergeEntry = {
  loading: boolean;
  result: ConciergeResponse | null;
  error: string | null;
};

export default function StormScopeV3() {
  const [props] = useState<Property[]>(() => genProps(80, 42));
  const [view, setView] = useState<View>('owner');
  const [selected, setSelected] = useState<Property | null>(null);
  const [alerts, setAlerts] = useState<NWSAlert[]>([]);
  const [spc, setSpc] = useState<SPCReport[]>([]);
  const [loading, setLoading] = useState(true);

  // AI Scout state
  const [scoutReasons, setScoutReasons] = useState<Map<string, string>>(
    new Map(),
  );
  const [scoutLoading, setScoutLoading] = useState(false);
  const [scoutError, setScoutError] = useState<string | null>(null);
  const scoutAbortRef = useRef<AbortController | null>(null);

  // Concierge state per property
  const [conciergeState, setConciergeState] = useState<
    Map<string, ConciergeEntry>
  >(new Map());

  const aiEnabled = !!import.meta.env.VITE_OPENAI_API_KEY;

  useEffect(() => {
    Promise.allSettled([fetchNWSAlerts(), fetchSPC()]).then(([a, s]) => {
      setAlerts(a.status === 'fulfilled' ? a.value : []);
      setSpc(s.status === 'fulfilled' ? s.value : []);
      setLoading(false);
    });
  }, []);

  const handleRunScout = useCallback(async () => {
    scoutAbortRef.current?.abort();
    const ctrl = new AbortController();
    scoutAbortRef.current = ctrl;
    setScoutLoading(true);
    setScoutError(null);
    try {
      const rankings = await runAIScout(props, ctrl.signal);
      const map = new Map<string, string>();
      rankings.forEach((r) => map.set(r.id, r.reason));
      setScoutReasons(map);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setScoutError(String(e));
    } finally {
      setScoutLoading(false);
    }
  }, [props]);

  const handleDraftResponse = useCallback(async (p: Property) => {
    setConciergeState((prev) =>
      new Map(prev).set(p.id, { loading: true, result: null, error: null }),
    );
    try {
      const result = await runConcierge({
        address: p.address,
        homeowner: p.homeowner,
        contactPref: p.contactPref,
        mesh: p.mesh,
        damageProb: p.damageProb,
      });
      setConciergeState((prev) =>
        new Map(prev).set(p.id, { loading: false, result, error: null }),
      );
    } catch (e) {
      setConciergeState((prev) =>
        new Map(prev).set(p.id, {
          loading: false,
          result: null,
          error: String(e),
        }),
      );
    }
  }, []);

  const handleNavChange = useCallback((v: View) => {
    setView(v);
    setSelected(null);
  }, []);

  const NAV = [
    { key: 'owner' as const, icon: '📊', label: 'Command' },
    { key: 'sales' as const, icon: '⚡', label: 'Sales' },
    { key: 'weather' as const, icon: '🌩️', label: 'Weather' },
    { key: 'recon' as const, icon: '🗺️', label: 'Recon' },
  ];

  return (
    <div
      className="h-screen w-full bg-[#060609] text-zinc-100 flex flex-col overflow-hidden"
      style={{
        fontFamily: "'DM Mono', 'JetBrains Mono', 'SF Mono', monospace",
      }}
    >
      <header className="flex items-center justify-between px-4 py-2 border-b border-zinc-800/60 bg-[#09090d] flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center text-[10px] font-black text-white"
            style={{
              background: 'linear-gradient(135deg, #f59e0b 0%, #dc2626 100%)',
            }}
          >
            SS
          </div>
          <div>
            <div className="text-[13px] font-black tracking-tight">
              STORMSCOPE
            </div>
            <div className="text-[7px] text-zinc-600 tracking-[0.25em] uppercase">
              Signal → Sale → Supplement → Scale
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-zinc-900 rounded-md px-2 py-1 border border-zinc-800">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-[8px] text-zinc-500 uppercase">Live</span>
          </div>
        </div>
      </header>

      <div className="flex items-center gap-0.5 px-3 py-1 border-b border-zinc-800/40 bg-[#09090d] flex-shrink-0 overflow-x-auto">
        {NAV.map((t) => (
          <button
            key={t.key}
            onClick={() => handleNavChange(t.key)}
            className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider whitespace-nowrap transition-all ${view === t.key ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-600 hover:text-zinc-400'}`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {view === 'recon' ? (
        <div className="flex-1 overflow-hidden">
          <ReconMap spc={spc} spcLoading={loading} />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-3 py-3">
          {selected ? (
            <PropertyDetail
              p={selected}
              onBack={() => setSelected(null)}
              aiEnabled={aiEnabled}
            />
          ) : (
            <>
              {view === 'owner' && (
                <OwnerDashboard props={props} alerts={alerts} spc={spc} />
              )}
              {view === 'sales' && (
                <SalesView
                  props={props}
                  onSelect={setSelected}
                  aiEnabled={aiEnabled}
                  scoutReasons={scoutReasons}
                  scoutLoading={scoutLoading}
                  scoutError={scoutError}
                  onRunScout={handleRunScout}
                  conciergeState={conciergeState}
                  onDraftResponse={handleDraftResponse}
                />
              )}
              {view === 'weather' && (
                <WeatherView alerts={alerts} spc={spc} loading={loading} />
              )}
            </>
          )}
        </div>
      )}

      <footer className="flex items-center justify-between px-4 py-1 border-t border-zinc-800/40 bg-[#09090d] text-[7px] text-zinc-700 uppercase tracking-wider flex-shrink-0">
        <span>MRMS · NWS · SPC · Claude Vision</span>
        <span>Lafayette, LA · 30.22°N</span>
      </footer>
    </div>
  );
}
