import OpenAI from 'openai';
import {
  Agent,
  run,
  setDefaultOpenAIClient,
  setTracingDisabled,
} from '@openai/agents';
import { z } from 'zod';

setTracingDisabled(true);

export function initAgents(apiKey: string): boolean {
  if (!apiKey) return false;
  // IMPORTANT: Do not expose your API key in production browser apps.
  // In production, route AI calls through your own backend proxy.
  setDefaultOpenAIClient(new OpenAI({ apiKey, dangerouslyAllowBrowser: true }));
  return true;
}

// ─── Supplement Copilot ───────────────────────────────────────────────────────

const SupplementSchema = z.object({
  items: z.array(
    z.object({
      code: z.string(),
      description: z.string(),
      quantity: z.string(),
      note: z.string(),
    }),
  ),
  wastePercent: z.number(),
  wasteReason: z.string(),
  estimatedRange: z.string(),
});

export type SupplementDraft = z.infer<typeof SupplementSchema>;

const supplementAgent = new Agent({
  name: 'Supplement Copilot',
  model: 'gpt-4.1-mini',
  instructions:
    'You are a certified roofing insurance estimator with Xactimate expertise. Draft accurate supplement line items for hail damage claims. Use real Xactimate codes (e.g. RFG LAMI - LAM, RFG SA&S, RFG ICE&W, RFG FELT, RFG DRP). Include quantities with units (SF, LF, EA). Adjust waste percentage based on roof complexity and pitch.',
  outputType: SupplementSchema,
});

export async function runSupplementCopilot(
  property: {
    roof: string;
    age: number;
    sqft: number;
    mesh: number;
    damageProb: number;
    cond: string;
  },
  signal?: AbortSignal,
): Promise<SupplementDraft> {
  const prompt = `Property: ${property.sqft} SF, ${property.roof}, ${property.age} years old (condition: ${property.cond}). Hail size: ${property.mesh}" MESH. Damage probability: ${(property.damageProb * 100).toFixed(0)}%. Draft insurance supplement line items for a full roof replacement claim.`;
  const result = await run(supplementAgent, prompt, { signal });
  return result.finalOutput!;
}

// ─── AI Scout ─────────────────────────────────────────────────────────────────

const ScoutSchema = z.object({
  rankings: z.array(
    z.object({
      id: z.string(),
      reason: z.string(),
    }),
  ),
});

export type ScoutRanking = { id: string; reason: string };

const scoutAgent = new Agent({
  name: 'StormScope Scout',
  model: 'gpt-4.1-mini',
  instructions:
    'You are a storm damage canvass expert. Given properties ranked by expected value, write one concise sentence explaining why each is a priority target. Focus on the specific combination of hail size, roof vulnerability, age, and close probability. Be direct and specific — no filler.',
  outputType: ScoutSchema,
});

export async function runAIScout(
  properties: Array<{
    id: string;
    address: string;
    mesh: number;
    roof: string;
    age: number;
    cond: string;
    damageProb: number;
    closeProb: number;
    expectedValue: number;
  }>,
  signal?: AbortSignal,
): Promise<ScoutRanking[]> {
  const list = properties
    .slice(0, 20)
    .map(
      (p, i) =>
        `${i + 1}. ID:${p.id} | ${p.address} | MESH:${p.mesh}" | ${p.age}yr ${p.roof} (${p.cond}) | Dmg:${(p.damageProb * 100).toFixed(0)}% | Close:${(p.closeProb * 100).toFixed(0)}% | EV:$${(p.expectedValue / 1000).toFixed(1)}K`,
    )
    .join('\n');
  const result = await run(
    scoutAgent,
    `Rank and explain these targets:\n${list}`,
    { signal },
  );
  return result.finalOutput?.rankings ?? [];
}

// ─── Lead Concierge ───────────────────────────────────────────────────────────

const ConciergeSchema = z.object({
  message: z.string(),
  channel: z.enum(['sms', 'email', 'phone']),
  talkingPoints: z.array(z.string()),
});

export type ConciergeResponse = z.infer<typeof ConciergeSchema>;

const conciergeAgent = new Agent({
  name: 'AI Lead Concierge',
  model: 'gpt-4.1-mini',
  instructions:
    "You draft personalized storm damage outreach messages for a roofing contractor. Match the homeowner's contact preference exactly. SMS: under 160 characters, direct, no fluff. Email: brief subject-free body, 2-3 short paragraphs. Phone: 3-4 concise talking points only. Be warm and specific about the storm event. No pressure tactics.",
  outputType: ConciergeSchema,
});

export async function runConcierge(
  property: {
    address: string;
    homeowner: string;
    contactPref: string;
    mesh: number;
    damageProb: number;
  },
  signal?: AbortSignal,
): Promise<ConciergeResponse> {
  const prompt = `Homeowner: ${property.homeowner} at ${property.address}. Recent hail event: ${property.mesh}" MESH (${(property.damageProb * 100).toFixed(0)}% estimated damage probability). Contact preference: ${property.contactPref}. Draft an outreach message.`;
  const result = await run(conciergeAgent, prompt, { signal });
  return result.finalOutput!;
}
