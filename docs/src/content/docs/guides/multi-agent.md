---
title: Agent orchestration
description: Coordinate the flow between several agents
---

Orchestration refers to the flow of agents in your app. Which agents run, in what order, and how do they decide what happens next? There are two main ways to orchestrate agents:

1. Allowing the LLM to make decisions: this uses the intelligence of an LLM to plan, reason, and decide on what steps to take based on that.
2. Orchestrating via code: determining the flow of agents via your code.

You can mix and match these patterns. Each has their own tradeoffs, described below.

## Orchestrating via LLM

An agent is an LLM equipped with instructions, tools and handoffs. This means that given an open-ended task, the LLM can autonomously plan how it will tackle the task, using tools to take actions and acquire data, and using handoffs to delegate tasks to sub-agents. For example, a research agent could be equipped with tools like:

- Web search to find information online
- File search and retrieval to search through proprietary data and connections
- Computer use to take actions on a computer
- Code execution to do data analysis
- Handoffs to specialized agents that are great at planning, report writing and more.

### Core SDK patterns

In the Agents SDK, two orchestration patterns come up most often:

| Pattern         | How it works                                                                                                                   | Best when                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Agents as tools | A manager agent keeps control of the conversation and calls specialist agents through `agent.asTool()`.                        | You want one agent to own the final answer, combine outputs from multiple specialists, or enforce shared guardrails in one place. |
| Handoffs        | A triage agent routes the conversation to a specialist, and that specialist becomes the active agent for the rest of the turn. | You want the specialist to speak directly to the user, keep prompts focused, or use different instructions/models per specialist. |

Use **agents as tools** when the specialist should help with a subtask but should not take over the user-facing conversation. The manager stays responsible for deciding which tools to call and how to present the final response. See the [tools guide](/openai-agents-js/guides/tools#agents-as-tools) for the API details, and the [agents guide](/openai-agents-js/guides/agents#composition-patterns) for a side-by-side example.

Use **handoffs** when routing itself is part of the workflow and you want the selected specialist to own the next part of the conversation. The handoff preserves the conversation context while narrowing the active instructions to the specialist. See the [handoffs guide](/openai-agents-js/guides/handoffs) for the API, and the [quickstart](/openai-agents-js/guides/quickstart#define-your-handoffs) for the smallest end-to-end example.

You can combine the two patterns. A triage agent might hand off to a specialist, and that specialist can still use other agents as tools for bounded subtasks.

This pattern is great when the task is open-ended and you want to rely on the intelligence of an LLM. The most important tactics here are:

1. Invest in good prompts. Make it clear what tools are available, how to use them, and what parameters it must operate within.
2. Monitor your app and iterate on it. See where things go wrong, and iterate on your prompts.
3. Allow the agent to introspect and improve. For example, run it in a loop, and let it critique itself; or, provide error messages and let it improve.
4. Have specialized agents that excel in one task, rather than having a general purpose agent that is expected to be good at anything.
5. Invest in [evals](https://platform.openai.com/docs/guides/evals). This lets you train your agents to improve and get better at tasks.

If you want the SDK primitives behind this style of orchestration, start with [tools](/openai-agents-js/guides/tools), [handoffs](/openai-agents-js/guides/handoffs), and [running agents](/openai-agents-js/guides/running-agents).

## Orchestrating via code

While orchestrating via LLM is powerful, orchestrating via code makes tasks more deterministic and predictable, in terms of speed, cost and performance. Common patterns here are:

- Using [structured outputs](https://platform.openai.com/docs/guides/structured-outputs) to generate well formed data that you can inspect with your code. For example, you might ask an agent to classify the task into a few categories, and then pick the next agent based on the category.
- Chaining multiple agents by transforming the output of one into the input of the next. You can decompose a task like writing a blog post into a series of steps - do research, write an outline, write the blog post, critique it, and then improve it.
- Running the agent that performs the task in a `while` loop with an agent that evaluates and provides feedback, until the evaluator says the output passes certain criteria.
- Running multiple agents in parallel, e.g. via JavaScript primitives like `Promise.all`. This is useful for speed when you have multiple tasks that don't depend on each other.

We have a number of examples in [`examples/agent-patterns`](https://github.com/openai/openai-agents-js/tree/main/examples/agent-patterns).

## Related guides

- [Agents](/openai-agents-js/guides/agents) for composition patterns and agent configuration.
- [Tools](/openai-agents-js/guides/tools#agents-as-tools) for `agent.asTool()` and manager-style orchestration.
- [Handoffs](/openai-agents-js/guides/handoffs) for delegation between specialist agents.
- [Running Agents](/openai-agents-js/guides/running-agents) for `Runner` and per-run orchestration controls.
- [Quickstart](/openai-agents-js/guides/quickstart) for a minimal end-to-end handoff example.
