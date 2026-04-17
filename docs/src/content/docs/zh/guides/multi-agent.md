---
title: 智能体编排
description: Coordinate the flow between several agents
---

智能体编排是指应用中智能体的流转方式。哪些智能体会运行、按什么顺序运行，以及它们如何决定下一步发生什么？编排智能体主要有两种方式：

> 请在阅读完[快速开始](/openai-agents-js/zh/guides/quickstart)或[智能体指南](/openai-agents-js/zh/guides/agents#composition-patterns)后再阅读本页。本页讨论的是多个智能体之间的工作流设计，而不是 `Agent` 构造函数本身。

1. 允许 LLM 做决策：利用 LLM 的智能进行规划、推理，并据此决定要采取哪些步骤。
2. 通过代码进行编排：由代码决定智能体的流转方式。

你可以混合使用这两种模式。它们各自都有不同的权衡，详见下文。

## 通过 LLM 进行编排

智能体是配备了 instructions、工具和交接的 LLM。这意味着，面对开放式任务时，LLM 可以自主规划如何处理任务，使用工具采取行动并获取数据，同时通过交接将任务委派给子智能体。例如，一个研究智能体可以配备以下工具：

- Web 搜索，用于在线查找信息
- 文件搜索和检索，用于搜索专有数据和连接
- 计算机操作，用于在计算机上执行操作
- 代码执行，用于进行数据分析
- 交接给擅长规划、撰写报告等任务的专业智能体

### SDK 核心模式

在 Agents SDK 中，最常见的两种编排模式是：

| 模式 | 工作方式 | 最适用场景 |
| --- | --- | --- |
| Agents as tools | 管理者智能体保持对对话的控制，并通过 `agent.asTool()` 调用专业智能体。 | 你希望由一个智能体负责最终回答、整合多个专业智能体的输出，或在一个地方统一实施共享护栏。 |
| 交接 | 分流智能体将对话路由到某个专业智能体，而该专业智能体会在当前轮次的剩余过程中成为活跃智能体。 | 你希望由专业智能体直接与用户交流、保持提示聚焦，或为不同专业智能体使用不同的 instructions／模型。 |

当专业智能体应协助完成某个子任务、但不应接管面向用户的对话时，请使用**Agents as tools**。管理者智能体仍负责决定调用哪些工具，以及如何呈现最终回复。API 细节请参阅[工具指南](/openai-agents-js/zh/guides/tools#agents-as-tools)，并参阅[智能体指南](/openai-agents-js/zh/guides/agents#composition-patterns)了解并列示例。

当路由本身就是工作流的一部分，并且你希望被选中的专业智能体负责对话的下一部分时，请使用**交接**。交接会保留对话上下文，同时将当前生效的 instructions 收窄到该专业智能体。API 请参阅[交接指南](/openai-agents-js/zh/guides/handoffs)，最小端到端示例请参阅[快速开始](/openai-agents-js/zh/guides/quickstart#define-your-handoffs)。

你可以将这两种模式结合使用。一个分流智能体可以先交接给某个专业智能体，而该专业智能体仍然可以将其他智能体作为工具来处理边界清晰的子任务。

当任务是开放式的，并且你希望依赖 LLM 的智能时，这种模式非常适合。这里最重要的策略包括：

1. 投入精力编写高质量提示。明确有哪些工具可用、如何使用它们，以及它必须在什么参数范围内运行。
2. 监控应用并持续迭代。找出问题出现在哪里，并不断优化提示。
3. 允许智能体自我反思和改进。例如，在循环中运行它，让它自我批评；或者向它提供错误信息，让它进行改进。
4. 使用在单一任务上表现出色的专业智能体，而不是期望一个通用智能体样样精通。
5. 投入精力做 [evals](https://platform.openai.com/docs/guides/evals)。这能让你训练智能体持续改进，更擅长完成任务。

如果你想了解这种编排风格背后的 SDK 基本组件，可以从[工具](/openai-agents-js/zh/guides/tools)、[交接](/openai-agents-js/zh/guides/handoffs)和[运行智能体](/openai-agents-js/zh/guides/running-agents)开始。

## 通过代码进行编排

虽然通过 LLM 进行编排很强大，但通过代码进行编排在速度、成本和性能方面会让任务更具确定性和可预测性。这里的常见模式包括：

- 使用 [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs) 生成可由代码检查的格式良好的数据。例如，你可以让智能体将任务分类到几个类别中，然后根据类别选择下一个智能体。
- 通过将一个智能体的输出转换为下一个智能体的输入来串联多个智能体。你可以将撰写博客文章这样的任务拆解为一系列步骤——做研究、写大纲、写博客文章、提出批评意见，然后再改进。
- 在 `while` 循环中运行执行任务的智能体，并搭配一个负责评估和提供反馈的智能体，直到评估智能体认为输出满足特定标准。
- 并行运行多个智能体，例如通过 JavaScript 基本组件（primitives），如 `Promise.all`。当你有多个彼此独立的任务时，这对提升速度很有帮助。

我们在 [`examples/agent-patterns`](https://github.com/openai/openai-agents-js/tree/main/examples/agent-patterns) 中提供了多个示例。

## 相关指南

- [智能体](/openai-agents-js/zh/guides/agents)，了解组合模式和智能体配置。
- [工具](/openai-agents-js/zh/guides/tools#agents-as-tools)，了解 `agent.asTool()` 和管理者风格的编排。
- [交接](/openai-agents-js/zh/guides/handoffs)，了解专业智能体之间的委派。
- [运行智能体](/openai-agents-js/zh/guides/running-agents)，了解 `Runner` 和每次运行的编排控制。
- [快速开始](/openai-agents-js/zh/guides/quickstart)，了解最小化的端到端交接示例。
