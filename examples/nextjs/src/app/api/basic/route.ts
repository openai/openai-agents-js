import { NextRequest, NextResponse } from 'next/server';

import { agent } from '@/agents';
import { run } from '@openai/agents';

export async function POST(req: NextRequest) {
  try {
    const { messages } = await req.json();
    const input = messages ?? [];
    const result = await run(agent, input);
    // Example: echo back the received data
    return NextResponse.json({
      response: result.finalOutput,
      history: result.history,
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: 400 },
    );
  }
}
