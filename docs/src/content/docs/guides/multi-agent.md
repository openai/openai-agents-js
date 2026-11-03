---
title: Agent Orchestration
description: Coordinate the flow between several agents
---

Orchestration determines which agents run in your app, in what order, and how they decide what happens next. There are two main approaches:

> Read this page after the [Quickstart](/openai-agents-js/guides/quickstart) or the [Agents guide](/openai-agents-js/guides/agents#composition-patterns). This page is about workflow design across multiple agents, not the `Agent` constructor itself.

1. Let the LLM plan, reason, and decide which steps to take.
2. Use code to determine the order in which agents run.

You can combine these patterns. Each has tradeoffs, described below.

## Orchestrating via LLM

An agent is an LLM with instructions, tools, and handoffs. Given an open-ended task, the LLM can plan its approach, use tools to take actions and gather data, and delegate tasks to sub-agents through handoffs. For example, a research agent could use:

- Web search to find information online
- File search and retrieval to search through proprietary data and connections
- Computer use to take actions on a computer
- Code execution to do data analysis
- Handoffs to agents that specialize in tasks such as planning or report writing.

### Core SDK patterns

In the Agents SDK, two orchestration patterns come up most often:

| Pattern | How it works | Best when |
| --- | --- | --- |
| Agents as tools | A manager agent keeps control of the conversation and calls specialist agents through `agent.asTool()`. | You want one agent to own the final answer, combine outputs from multiple specialists, or enforce shared guardrails in one place. |
| Handoffs | A triage agent routes the conversation to a specialist, and that specialist becomes the active agent for the rest of the turn. | You want the specialist to speak directly to the user, keep prompts focused, or use different instructions/models per specialist. |

Use **agents as tools** when the specialist should help with a subtask but should not take over the user-facing conversation. The manager stays responsible for deciding which tools to call and how to present the final response. See the [tools guide](/openai-agents-js/guides/tools#4-agents-as-tools) for the API details, and the [agents guide](/openai-agents-js/guides/agents#composition-patterns) for a side-by-side example.

Use **handoffs** when routing itself is part of the workflow and you want the selected specialist to own the next part of the conversation. The handoff preserves the conversation context while narrowing the active instructions to the specialist. See the [handoffs guide](/openai-agents-js/guides/handoffs) for the API, and the [quickstart](/openai-agents-js/guides/quickstart#define-your-handoffs) for the smallest end-to-end example.

You can combine the two patterns. A triage agent might hand off to a specialist, and that specialist can still use other agents as tools for bounded subtasks.

Use LLM orchestration for open-ended tasks where you want the LLM to make decisions. To improve results:

1. Write clear prompts that explain which tools are available, how to use them, and which limits the agent must follow.
2. Monitor your app for failures and revise your prompts.
3. Let the agent review and improve its work. For example, run it in a loop to critique its output, or provide error messages it can use to improve.
4. Use agents that specialize in one task instead of expecting one general-purpose agent to handle every task well.
5. Use [evals](https://platform.openai.com/docs/guides/evals) to train your agents to improve at tasks.

If you want the SDK primitives behind this style of orchestration, start with [tools](/openai-agents-js/guides/tools), [handoffs](/openai-agents-js/guides/handoffs), and [running agents](/openai-agents-js/guides/running-agents).

## Orchestrating via code

Code orchestration makes tasks more deterministic and their speed, cost, and performance more predictable. Common patterns include:

- Use [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs) to generate well-formed data that your code can inspect. For example, ask an agent to classify a task, then pick the next agent based on the category.
- Chain agents by transforming one agent's output into the next agent's input. For example, split blog writing into research, outlining, writing, critique, and revision.
- Run a task agent in a `while` loop with an evaluator agent that provides feedback. Repeat until the evaluator says the output meets the criteria.
- Run multiple agents in parallel with JavaScript features such as `Promise.all`. This improves speed when tasks don't depend on each other.

See examples in [`examples/agent-patterns`](https://github.com/openai/openai-agents-js/tree/main/examples/agent-patterns).

## Related guides

- [Agents](/openai-agents-js/guides/agents) for composition patterns and agent configuration.
- [Tools](/openai-agents-js/guides/tools#4-agents-as-tools) for `agent.asTool()` and manager-style orchestration.
- [Handoffs](/openai-agents-js/guides/handoffs) for delegation between specialist agents.
- [Running Agents](/openai-agents-js/guides/running-agents) for `Runner` and per-run orchestration controls.
- [Quickstart](/openai-agents-js/guides/quickstart) for a minimal end-to-end handoff example.
