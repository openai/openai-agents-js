---
title: 智能体编排
description: Coordinate the flow between several agents
---

编排是指应用中智能体的运行流程：运行哪些智能体、按什么顺序运行，以及它们如何决定下一步操作？智能体编排主要有两种方式：

> 请先阅读[快速开始](/openai-agents-js/zh/guides/quickstart)或[智能体](/openai-agents-js/zh/guides/agents#composition-patterns)。本页介绍多个智能体之间的工作流设计，而非 `Agent` 构造函数本身。

1. 让 LLM 做出决策：利用 LLM 的智能进行规划、推理，并据此决定要采取的步骤。
2. 通过代码编排：通过代码确定智能体的运行流程。

您可以混合使用这些模式。每种模式都有各自的权衡，具体如下。

## 基于 LLM 的编排

智能体是配备了指令、工具和交接能力的 LLM。这意味着，在接到开放式任务时，LLM 可以自主规划任务的处理方式，使用工具执行操作并获取数据，还可以通过交接将任务委派给子智能体。例如，可以为研究智能体配备以下工具：

- 通过 Web 搜索查找在线信息
- 通过文件搜索和检索功能搜索专有数据和连接的数据源
- 通过计算机操作在计算机上执行操作
- 通过代码执行开展数据分析
- 交接给擅长规划、报告撰写等工作的专业智能体。

### SDK 核心模式

在 Agents SDK 中，最常见的两种编排模式如下：

| 模式 | 工作方式 | 最适用的场景 |
| --- | --- | --- |
| Agents as tools | 管理者智能体持续掌控对话，并通过 `agent.asTool()` 调用专业智能体。 | 您希望由一个智能体负责最终答案、整合多个专家的输出，或在一个位置统一实施共享护栏。 |
| 交接 | 分诊智能体将对话路由给专业智能体，后者会在该轮接下来的交互中成为活跃智能体。 | 您希望专业智能体直接与用户交流、保持提示词聚焦，或为每个专家使用不同的指令或模型。 |

如果专业智能体只需协助处理子任务，而不应接管面向用户的对话，请使用**agents as tools**。管理者仍负责决定调用哪些工具，以及如何呈现最终响应。有关 API 的详细信息，请参阅[工具](/openai-agents-js/zh/guides/tools#4-agents-as-tools)；有关并列对比示例，请参阅[智能体](/openai-agents-js/zh/guides/agents#composition-patterns)。

如果路由本身就是工作流的一部分，并且您希望选中的专业智能体负责接下来的对话，请使用**交接**。交接会保留对话上下文，同时将活跃指令限定为该专业智能体的指令。有关 API，请参阅[交接](/openai-agents-js/zh/guides/handoffs)；有关最精简的端到端示例，请参阅[快速开始](/openai-agents-js/zh/guides/quickstart#define-your-handoffs)。

您可以结合使用这两种模式。分诊智能体可以交接给专业智能体，而该专业智能体仍可将其他智能体用作工具，以处理边界明确的子任务。

当任务具有开放性，并且您希望依靠 LLM 的智能时，这种模式非常适合。最重要的策略包括：

1. 精心设计提示词。明确说明有哪些可用工具、如何使用它们，以及必须遵守哪些参数约束。
2. 监控应用并持续迭代。找出问题所在，并改进提示词。
3. 允许智能体自我审视和改进。例如，让它循环运行并进行自我评析；或者提供错误消息，让它进行改进。
4. 使用专注于单项任务的专业智能体，而不是期望一个通用智能体擅长所有事情。
5. 投入建设[评估](https://platform.openai.com/docs/guides/evals)。这样可以训练智能体，使其不断改进并更好地完成任务。

如需了解这种编排方式背后的 SDK 基础组件，请先阅读[工具](/openai-agents-js/zh/guides/tools)、[交接](/openai-agents-js/zh/guides/handoffs)和[运行智能体](/openai-agents-js/zh/guides/running-agents)。

## 基于代码的编排

虽然基于 LLM 的编排功能强大，但基于代码的编排可以让任务在速度、成本和性能方面更具确定性和可预测性。常见模式包括：

- 使用 [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs) 生成可供代码检查的格式良好的数据。例如，可以让智能体将任务划分为几个类别，然后根据类别选择下一个智能体。
- 通过将一个智能体的输出转换为下一个智能体的输入，串联多个智能体。您可以将撰写博客文章这样的任务分解成一系列步骤：开展研究、编写提纲、撰写博客文章、进行评析，然后加以改进。
- 在 `while` 循环中运行负责执行任务的智能体，并搭配一个负责评估和提供反馈的智能体，直到评估智能体认定输出符合特定标准。
- 并行运行多个智能体，例如使用 `Promise.all` 等 JavaScript 基础组件。当多个任务互不依赖时，这种方式有助于提升速度。

我们在 [`examples/agent-patterns`](https://github.com/openai/openai-agents-js/tree/main/examples/agent-patterns) 中提供了多个代码示例。

## 相关指南

- [智能体](/openai-agents-js/zh/guides/agents)：了解组合模式和智能体配置。
- [工具](/openai-agents-js/zh/guides/tools#4-agents-as-tools)：了解 `agent.asTool()` 和管理者式编排。
- [交接](/openai-agents-js/zh/guides/handoffs)：了解专业智能体之间的任务委派。
- [运行智能体](/openai-agents-js/zh/guides/running-agents)：了解 `Runner` 和每次运行的编排控制。
- [快速开始](/openai-agents-js/zh/guides/quickstart)：查看最精简的端到端交接示例。
