---
title: 智能体编排
description: Coordinate the flow between several agents
---

编排指应用中智能体的流转方式。哪些智能体运行、按什么顺序运行，以及它们如何决定下一步做什么？编排智能体主要有两种方式：

> 请在阅读[快速开始](/openai-agents-js/zh/guides/quickstart)或[智能体](/openai-agents-js/zh/guides/agents#composition-patterns)后再阅读本页。本页讨论的是多个智能体之间的工作流设计，而不是 `Agent` 构造函数本身。

1. 让 LLM 做决策：使用 LLM 的智能来规划、推理，并据此决定要采取哪些步骤。
2. 通过代码编排：通过你的代码来决定智能体的流转方式。

你可以混合搭配这些模式。它们各有取舍，下文会进行说明。

## 基于 LLM 的编排

智能体是配备了指令、工具和交接的 LLM。这意味着，对于开放式任务，LLM 可以自主规划如何处理任务：使用工具执行操作并获取数据，使用交接将任务委派给子智能体。例如，一个研究智能体可以配备如下工具：

- Web 搜索，用于在线查找信息
- 文件搜索和检索，用于搜索专有数据和连接
- 计算机操作，用于在计算机上执行操作
- 代码执行，用于进行数据分析
- 交接给擅长规划、报告撰写等工作的专用智能体。

### 核心 SDK 模式

在 Agents SDK 中，最常见的是两种编排模式：

| Pattern | How it works | Best when |
| --- | --- | --- |
| Agents as tools | 管理智能体保持对话控制权，并通过 `agent.asTool()` 调用专家智能体。 | 你希望由一个智能体负责最终答案、合并多个专家的输出，或在同一处执行共享护栏。 |
| 交接 | 分流智能体将对话路由到专家智能体，该专家智能体会在本轮其余部分成为活动智能体。 | 你希望专家智能体直接与用户对话、保持提示聚焦，或为每个专家使用不同的指令/模型。 |

当专家智能体应协助完成子任务，但不应接管面向用户的对话时，请使用 **agents as tools**。管理智能体仍负责决定调用哪些工具，以及如何呈现最终响应。API 详情请参见[工具](/openai-agents-js/zh/guides/tools#agents-as-tools)，并在[智能体](/openai-agents-js/zh/guides/agents#composition-patterns)中查看并列示例。

当路由本身是工作流的一部分，并且你希望被选中的专家智能体负责对话的下一部分时，请使用 **handoffs**。交接会保留对话上下文，同时将活动指令收窄到专家智能体。API 请参见[交接](/openai-agents-js/zh/guides/handoffs)，最小的端到端示例请参见[快速开始](/openai-agents-js/zh/guides/quickstart#define-your-handoffs)。

你可以组合这两种模式。分流智能体可以交接给专家智能体，而该专家智能体仍然可以将其他智能体作为工具，用于边界明确的子任务。

当任务是开放式的，并且你希望依赖 LLM 的智能时，这种模式非常适合。这里最重要的策略是：

1. 投入精力编写好的提示。清楚说明有哪些工具可用、如何使用它们，以及必须在哪些参数范围内运行。
2. 监控你的应用并不断迭代。观察哪里出错，然后迭代你的提示。
3. 允许智能体自省并改进。例如，在循环中运行它，并让它自我批判；或者提供错误消息，让它进行改进。
4. 使用在单一任务上表现出色的专用智能体，而不是期望一个通用智能体擅长所有事情。
5. 投入[评估（evals）](https://platform.openai.com/docs/guides/evals)。这可以让你训练智能体，使其在任务上不断改进、表现更好。

如果你想了解支撑这种编排风格的 SDK 基础组件，可以从[工具](/openai-agents-js/zh/guides/tools)、[交接](/openai-agents-js/zh/guides/handoffs)和[运行智能体](/openai-agents-js/zh/guides/running-agents)开始。

## 基于代码的编排

虽然通过 LLM 编排非常强大，但通过代码编排可以让任务在速度、成本和性能方面更加确定、可预测。这里的常见模式包括：

- 使用 [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs) 生成格式良好的数据，供你的代码检查。例如，你可以让智能体将任务分类到几个类别中，然后根据类别选择下一个智能体。
- 通过将一个智能体的输出转换为下一个智能体的输入，来串联多个智能体。你可以将撰写博客文章这样的任务拆解为一系列步骤——做研究、写大纲、撰写博客文章、提出批评，然后改进它。
- 在 `while` 循环中运行执行任务的智能体，并配合一个负责评估和提供反馈的智能体，直到评估器认为输出符合某些标准。
- 并行运行多个智能体，例如通过 JavaScript 基础组件（如 `Promise.all`）。当你有多个互不依赖的任务时，这对提升速度很有用。

我们在 [`examples/agent-patterns`](https://github.com/openai/openai-agents-js/tree/main/examples/agent-patterns) 中提供了多个代码示例。

## 相关指南

- [智能体](/openai-agents-js/zh/guides/agents)：组合模式和智能体配置。
- [工具](/openai-agents-js/zh/guides/tools#agents-as-tools)：了解 `agent.asTool()` 和管理器式编排。
- [交接](/openai-agents-js/zh/guides/handoffs)：了解专家智能体之间的委派。
- [运行智能体](/openai-agents-js/zh/guides/running-agents)：了解 `Runner` 和每次运行的编排控制。
- [快速开始](/openai-agents-js/zh/guides/quickstart)：查看最小的端到端交接示例。
