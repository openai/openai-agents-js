import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';

import { agent } from '@/agents';
import {
  AgentInputItem,
  Runner,
  RunState,
  RunToolApprovalItem,
} from '@openai/agents';
import { db } from '@/db';

function generateConversationId() {
  return `conv_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export async function POST(req: NextRequest) {
  try {
    const data = await req.json();
    let { messages, conversationId, decisions } = data;

    if (!messages) {
      messages = [];
    }

    if (!conversationId) {
      conversationId = generateConversationId();
    }

    if (!decisions) {
      decisions = null;
    }

    const runner = new Runner({
      groupId: conversationId,
    });

    let input: AgentInputItem[] | RunState<any, any>;
    if (
      Object.keys(decisions).length > 0 &&
      data.conversationId /* original conversationId */
    ) {
      const stateString = await db().get(data.conversationId);

      if (!stateString) {
        return NextResponse.json(
          { error: 'Conversation not found' },
          { status: 404 },
        );
      }

      const state = await RunState.fromString(agent, stateString);

      const interruptions = state.getInterruptions();

      console.log('interruptions', interruptions);
      console.log('decisions', decisions);
      interruptions.forEach((item: RunToolApprovalItem) => {
        if (item.type === 'tool_approval_item' && 'callId' in item.rawItem) {
          const callId = item.rawItem.callId;

          if (decisions[callId] === 'approved') {
            state.approve(item);
          } else if (decisions[callId] === 'rejected') {
            state.reject(item);
          }
        }
      });

      input = state;
    } else {
      input = messages;
    }

    const result = await runner.run(agent, input);

    if (result.interruptions.length > 0) {
      // We need to handle the interruptions here.

      // store the state in the database
      await db().set(conversationId, JSON.stringify(result.state));

      return NextResponse.json({
        conversationId,
        approvals: result.interruptions
          .filter((item) => item.type === 'tool_approval_item')
          .map((item) => item.toJSON()),
        history: result.history,
      });
    }

    return NextResponse.json({
      response: result.finalOutput,
      history: result.history,
      conversationId,
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
