import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';

import { agent } from '@/agents';
import { Runner, RunState, RunToolApprovalItem } from '@openai/agents/classic';
import type { AgentInputItem } from '@openai/agents/classic';
import { db } from '@/db';
import {
  getDemoSession,
  readLimitedJson,
  reserveModelRun,
  sameOrigin,
} from '@/demoSession';

function generateConversationId() {
  return `conv_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) {
    return NextResponse.json({ error: 'Invalid origin' }, { status: 403 });
  }
  const session = getDemoSession(req);
  if (!session) {
    return NextResponse.json(
      { error: 'Demo session required' },
      { status: 401 },
    );
  }
  try {
    const body = await readLimitedJson(req, 256 * 1024);
    if ('status' in body) {
      return NextResponse.json(
        {
          error:
            body.status === 413
              ? 'Conversation exceeds 256 KiB'
              : 'Invalid request',
        },
        { status: body.status },
      );
    }
    const data = body.value as {
      messages?: AgentInputItem[];
      conversationId?: string | null;
      decisions?: Record<string, string>;
    };
    if (
      !data ||
      typeof data !== 'object' ||
      !Array.isArray(data.messages) ||
      (data.conversationId !== undefined &&
        data.conversationId !== null &&
        typeof data.conversationId !== 'string') ||
      (data.decisions !== undefined &&
        (typeof data.decisions !== 'object' ||
          data.decisions === null ||
          Array.isArray(data.decisions)))
    ) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    const { messages } = data;
    let { conversationId, decisions } = data;

    if (!conversationId) {
      // we will generate a conversation ID so we can keep track of the state in case of conversations
      // this is just a key that we can use to store information in the database
      conversationId = generateConversationId();
    }

    decisions ??= {};

    const runner = new Runner({
      groupId: conversationId,
    });

    let input: AgentInputItem[] | RunState<any, any>;
    if (
      Object.keys(decisions).length > 0 &&
      data.conversationId /* original conversationId */
    ) {
      // If we receive a new request with decisions, we will look up the current state in the database
      const stateString = await db().get(`${session}:${data.conversationId}`);

      if (!stateString) {
        return NextResponse.json(
          { error: 'Conversation not found' },
          { status: 404 },
        );
      }

      // We then deserialize the state so we can manipulate it and continue the run
      const state = await RunState.fromString(agent, stateString);

      const interruptions = state.getInterruptions();

      interruptions.forEach((item: RunToolApprovalItem) => {
        // For each interruption, we will then check if the decision is to approve or reject the tool call
        if (item.type === 'tool_approval_item' && 'callId' in item.rawItem) {
          const callId = item.rawItem.callId;

          if (decisions[callId] === 'approved') {
            state.approve(item);
          } else if (decisions[callId] === 'rejected') {
            state.reject(item);
          }
        }
      });

      // We will use the new updated state to continue the run
      input = state;
    } else {
      // If we don't have any decisions, we will just assume this is a regular chat and use the messages
      // as input for the next run
      input = messages;
    }

    const reservation = reserveModelRun(session);
    if (reservation === 'expired') {
      return NextResponse.json(
        { error: 'Demo session required' },
        { status: 401 },
      );
    }
    if (reservation === 'limited') {
      return NextResponse.json(
        { error: 'Model run limit reached' },
        { status: 429 },
      );
    }
    const result = await runner.run(agent, input);

    if (result.interruptions.length > 0) {
      // If the run resulted in one or more interruptions, we will store the current state in the database

      // store the state in the database
      await db().set(
        `${session}:${conversationId}`,
        JSON.stringify(result.state),
      );

      // We will return all the interruptions as approval requests to the UI/client so it can generate
      // the UI for approvals
      // We will also still return the history that contains the tool calls and potentially any interim
      // text response the agent might have generated (like announcing that it's calling a function)
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
