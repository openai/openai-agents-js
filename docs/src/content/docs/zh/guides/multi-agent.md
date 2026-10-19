---
title: 智能体编排
description: Coordinate the flow between several agents
canonicalHeadingIds:
  - depth: 2
    id: 'orchestrating-via-llm'
    aliases:
      - '基于-llm-的编排'
  - depth: 3
    id: 'core-sdk-patterns'
    aliases:
      - 'sdk-核心模式'
  - depth: 2
    id: 'orchestrating-via-code'
    aliases:
      - '基于代码的编排'
  - depth: 2
    id: 'related-guides'
    aliases:
      - '相关指南'
---

编排是指应用中智能体的运行流程：哪些智能体会运行，以什么顺序运行，以及它们如何决定接下来要做什么？智能体编排主要有两种方式：

> 请先阅读[快速开始](/openai-agents-js/zh/guides/quickstart)或[智能体](/openai-agents-js/zh/guides/agents#composition-patterns)，再阅读本页。本页介绍多个智能体之间的工作流设计，而不是 `Agent` 构造函数本身。

1. 由 LLM 决策：利用 LLM 的智能进行规划、推理，并据此决定要采取的步骤。
2. 通过代码编排：通过代码确定智能体的运行流程。

您可以混合使用这些模式。每种模式都有各自的权衡，下面将分别介绍。

## 基于 LLM 的编排

智能体是配备了指令、工具和交接能力的 LLM。这意味着，面对开放式任务，LLM 可以自主规划如何处理任务，使用工具执行操作和获取数据，并通过交接将任务委派给子智能体。例如，研究智能体可以配备以下工具：

- Web 搜索，用于查找在线信息
- 文件搜索和检索，用于搜索专有数据和连接的数据源
- 计算机操作，用于在计算机上执行操作
- 代码执行，用于数据分析
- 交接，用于将任务委派给擅长规划、报告撰写等工作的专用智能体。

### SDK 核心模式

在 Agents SDK 中，最常见的编排模式有两种：

| 模式 | 工作原理 | 适用场景 |
| --- | --- | --- |
| Agents as tools | 管理智能体保持对对话的控制，并通过 `agent.asTool()` 调用专用智能体。 | 您希望由一个智能体负责最终回答、整合多个专用智能体的输出，或集中实施共用的护栏。 |
| 交接 | 分流智能体将对话路由给专用智能体，该专用智能体在本轮对话的剩余部分成为当前运行的智能体。 | 您希望专用智能体直接与用户交流、保持提示聚焦，或为各个专用智能体使用不同的指令或模型。 |

当专用智能体只需协助完成子任务，而不应接管面向用户的对话时，请使用 **agents as tools**。管理智能体仍负责决定调用哪些工具，以及如何呈现最终回复。有关 API 详情，请参阅[工具](/openai-agents-js/zh/guides/tools#4-agents-as-tools)；有关并排对比的示例，请参阅[智能体](/openai-agents-js/zh/guides/agents#composition-patterns)。

当路由本身就是工作流的一部分，且您希望由选定的专用智能体负责接下来的对话时，请使用**交接**。交接会保留对话上下文，同时将当前生效的指令限定为该专用智能体的指令。有关 API，请参阅[交接](/openai-agents-js/zh/guides/handoffs)；有关最小端到端示例，请参阅[快速开始](/openai-agents-js/zh/guides/quickstart#define-your-handoffs)。

您可以结合使用这两种模式。分流智能体可以交接给专用智能体，而该专用智能体仍可采用 agents as tools 模式，调用其他智能体来处理范围明确的子任务。

当任务是开放式的，且您希望依靠 LLM 的智能时，这种模式非常适合。最重要的策略如下：

1. 精心设计提示。明确可用的工具、工具的使用方式，以及智能体必须遵守的约束条件。
2. 监控应用并持续迭代。找出问题所在，并不断改进提示。
3. 让智能体自省和改进。例如，让它循环运行并进行自我评估；或者提供错误信息，让它据此改进。
4. 使用擅长某一项任务的专用智能体，而不是期望一个通用智能体擅长所有任务。
5. 重视[评估](https://platform.openai.com/docs/guides/evals)。这能帮助您训练智能体，使其不断改进，更好地完成任务。

如果您想了解支撑这种编排方式的 SDK 基础组件，请从[工具](/openai-agents-js/zh/guides/tools)、[交接](/openai-agents-js/zh/guides/handoffs)和[运行智能体](/openai-agents-js/zh/guides/running-agents)开始。

## 基于代码的编排

虽然基于 LLM 的编排功能强大，但通过代码编排可以让任务在速度、成本和性能方面更确定、更可预测。常见模式包括：

- 使用 [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs) 生成格式良好的数据，以便通过代码检查。例如，您可以让智能体将任务归入几个类别之一，然后根据类别选择下一个智能体。
- 将一个智能体的输出转换为下一个智能体的输入，从而将多个智能体串联起来。您可以将撰写博客文章这样的任务分解为一系列步骤：开展研究、编写大纲、撰写文章、评审文章，然后进行改进。
- 在 `while` 循环中运行执行任务的智能体，并搭配一个负责评估和提供反馈的智能体，直到评估智能体判定输出满足特定标准。
- 并行运行多个智能体，例如使用 `Promise.all` 等 JavaScript 基础组件。当您有多个互不依赖的任务时，这种方式有助于提升速度。

我们在 [`examples/agent-patterns`](https://github.com/openai/openai-agents-js/tree/main/examples/agent-patterns) 中提供了多个代码示例。

## 相关指南

- [智能体](/openai-agents-js/zh/guides/agents)：介绍组合模式和智能体配置。
- [工具](/openai-agents-js/zh/guides/tools#4-agents-as-tools)：介绍 `agent.asTool()` 和管理者式编排。
- [交接](/openai-agents-js/zh/guides/handoffs)：介绍专用智能体之间的任务委派。
- [运行智能体](/openai-agents-js/zh/guides/running-agents)：介绍 `Runner` 和单次运行的编排控制。
- [快速开始](/openai-agents-js/zh/guides/quickstart)：提供最小端到端交接示例。
