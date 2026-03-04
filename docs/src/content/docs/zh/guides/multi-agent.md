---
title: 智能体编排
description: Coordinate the flow between several agents
---

智能体编排指的是应用中智能体的流程：哪些智能体会运行、按什么顺序运行，以及它们如何决定下一步发生什么。主要有两种智能体编排方式：

> 请在阅读[快速开始](/openai-agents-js/zh/guides/quickstart)或[智能体指南](/openai-agents-js/zh/guides/agents#composition-patterns)后再阅读本页。本页讨论的是跨多个智能体的工作流设计，而不是 `Agent` 构造函数本身。

1. 让 LLM 做决策：利用 LLM 的智能进行规划、推理，并据此决定要执行的步骤。
2. 通过代码编排：通过你的代码来决定智能体流程。

你可以混合使用这两种模式。它们各有权衡，详见下文。

## 通过 LLM 进行智能体编排

智能体是一个配备了 instructions、tools 和 handoffs 的 LLM。这意味着面对开放式任务时，LLM 可以自主规划如何完成任务：使用工具执行动作和获取数据，并通过交接将任务委派给子智能体。例如，一个研究智能体可以配备如下工具：

- 使用 Web 搜索在线查找信息
- 使用文件搜索与检索在专有数据和连接中搜索
- 使用计算机操作在电脑上执行操作
- 使用代码执行进行数据分析
- 交接给擅长规划、撰写报告等任务的专业智能体

### SDK 核心模式

在 Agents SDK 中，最常见的两种智能体编排模式是：

| 模式 | 工作方式 | 最适用场景 |
| --- | --- | --- |
| Agents as tools | 一个管理智能体始终控制对话，并通过 `agent.asTool()` 调用专业智能体。 | 你希望由一个智能体负责最终答案、整合多个专家输出，或在单点统一执行共享护栏。 |
| 交接 | 一个分诊智能体将对话路由给某个专家，该专家在当前轮次剩余部分成为活跃智能体。 | 你希望专家直接对用户发言、让提示词更聚焦，或为不同专家使用不同 instructions/模型。 |

当专家只需协助完成某个子任务、但不应接管面向用户的对话时，使用**Agents as tools**。管理智能体仍负责决定调用哪些工具，以及如何呈现最终回复。API 细节见[工具指南](/openai-agents-js/zh/guides/tools#agents-as-tools)，并行对比示例见[智能体指南](/openai-agents-js/zh/guides/agents#composition-patterns)。

当路由本身就是工作流的一部分，且你希望被选中的专家接管对话下一阶段时，使用**交接**。交接会保留对话上下文，同时将活跃 instructions 收敛到该专家。API 见[交接指南](/openai-agents-js/zh/guides/handoffs)，最小端到端示例见[快速开始](/openai-agents-js/zh/guides/quickstart#define-your-handoffs)。

你可以组合这两种模式。分诊智能体可以先交接给某个专家，而该专家仍可把其他智能体作为工具来处理边界清晰的子任务。

这种模式非常适合开放式任务，且你希望依赖 LLM 的智能。最重要的策略是：

1. 投入精力编写高质量提示词。明确可用工具、使用方式，以及必须遵守的参数边界。
2. 监控你的应用并持续迭代。定位问题发生点，并迭代优化提示词。
3. 让智能体具备自我反思和改进能力。例如，在循环中运行它并让它自我评审；或提供错误信息并让它自行改进。
4. 使用在单一任务上表现卓越的专业智能体，而不是期望一个通用智能体样样精通。
5. 投入 [evals](https://platform.openai.com/docs/guides/evals)。这可以帮助你训练智能体持续改进、在任务上表现更好。

如果你想了解这种编排风格背后的 SDK 基础组件，可从[工具](/openai-agents-js/zh/guides/tools)、[交接](/openai-agents-js/zh/guides/handoffs)和[运行智能体](/openai-agents-js/zh/guides/running-agents)开始。

## 通过代码进行智能体编排

虽然通过 LLM 进行编排很强大，但通过代码进行编排在速度、成本和性能上更具确定性和可预测性。常见模式包括：

- 使用 [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs) 生成可由代码检查的格式良好的数据。例如，你可以让智能体先将任务分类到几个类别中，再根据类别选择下一个智能体。
- 将多个智能体串联，把前一个智能体的输出转换为后一个智能体的输入。你可以把“写博客文章”拆分为一系列步骤：做研究、写大纲、写正文、做评审，再进行改进。
- 在 `while` 循环中运行执行任务的智能体，并配合一个负责评估和反馈的智能体，直到评估者判定输出满足特定标准。
- 并行运行多个智能体，例如使用 JavaScript 原语 `Promise.all`。当多个任务彼此独立时，这对提速很有帮助。

我们在 [`examples/agent-patterns`](https://github.com/openai/openai-agents-js/tree/main/examples/agent-patterns) 中提供了许多示例。

## 相关指南

- [智能体](/openai-agents-js/zh/guides/agents)：了解组合模式与智能体配置。
- [工具](/openai-agents-js/zh/guides/tools#agents-as-tools)：了解 `agent.asTool()` 与管理者风格的智能体编排。
- [交接](/openai-agents-js/zh/guides/handoffs)：了解专业智能体之间的委派。
- [运行智能体](/openai-agents-js/zh/guides/running-agents)：了解 `Runner` 与按次运行的编排控制。
- [快速开始](/openai-agents-js/zh/guides/quickstart)：最小端到端交接示例。
