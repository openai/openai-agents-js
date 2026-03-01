---
title: 多智能体编排
description: Coordinate the flow between several agents
---

编排是指应用中智能体的流转过程。哪些智能体会运行、按什么顺序运行，以及它们如何决定下一步发生什么？编排智能体主要有两种方式：

1. 让 LLM 做决策：利用 LLM 的智能进行规划、推理，并据此决定要采取的步骤。
2. 通过代码编排：由您的代码来决定智能体的流转。

您可以混合使用这两种模式。它们各有取舍，详见下文。

## LLM 编排

智能体是配备了 instructions、工具和交接的 LLM。这意味着面对开放式任务时，LLM 可以自主规划如何完成任务，使用工具执行操作并获取数据，并通过交接把任务委派给子智能体。比如，一个研究智能体可以配备以下工具：

- 使用 Web 搜索在线查找信息
- 使用文件搜索与检索在专有数据和连接中查找内容
- 使用计算机操作在计算机上执行操作
- 使用代码执行进行数据分析
- 交接给擅长规划、报告撰写等工作的专业智能体

### SDK 核心模式

在 Agents SDK 中，最常见的两种编排模式是：

| 模式            | 工作方式                                                                   | 最适用场景                                                                        |
| --------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Agents as tools | 一个管理智能体持续控制对话，并通过 `agent.asTool()` 调用专业智能体。       | 您希望由一个智能体负责最终答案、整合多个专家输出，或在一个地方统一执行共享护栏。  |
| 交接            | 一个分诊智能体将对话路由给某位专家，该专家在本轮剩余时间内成为活跃智能体。 | 您希望专家直接与用户交流、让提示更聚焦，或让不同专家使用不同 instructions／模型。 |

当专业智能体只需协助子任务、但不应接管面向用户的对话时，使用 **Agents as tools**。管理智能体仍负责决定调用哪些工具，以及如何呈现最终回复。API 细节见[工具指南](/openai-agents-js/zh/guides/tools#agents-as-tools)，并排示例见[智能体指南](/openai-agents-js/zh/guides/agents#composition-patterns)。

当“路由”本身就是工作流的一部分，并且您希望被选中的专家主导对话下一阶段时，使用 **交接**。交接会保留对话上下文，同时将当前 instructions 收敛到该专家。API 见[交接指南](/openai-agents-js/zh/guides/handoffs)，最小端到端示例见[快速开始](/openai-agents-js/zh/guides/quickstart#define-your-handoffs)。

您可以组合这两种模式。分诊智能体可以先交接给某位专家，而该专家仍可将其他智能体作为工具用于边界清晰的子任务。

这种模式非常适合开放式任务，以及您希望依赖 LLM 智能的场景。最重要的策略包括：

1. 投入时间打磨高质量提示。清楚说明可用工具、使用方式，以及必须遵守的参数边界。
2. 监控应用并持续迭代。定位问题出现的位置，并迭代提示。
3. 让智能体具备自省与改进能力。例如，在循环中运行它并让其自我评估；或提供错误信息让其自行改进。
4. 使用在单一任务上表现突出的专业智能体，而不是期望一个通用智能体样样都精通。
5. 投入 [evals](https://platform.openai.com/docs/guides/evals)。这能帮助您训练智能体持续改进并更擅长任务。

如果您想了解这类编排方式背后的 SDK basic components，可从[工具](/openai-agents-js/zh/guides/tools)、[交接](/openai-agents-js/zh/guides/handoffs)和[运行智能体](/openai-agents-js/zh/guides/running-agents)开始。

## 代码编排

虽然通过 LLM 编排功能强大，但通过代码编排在速度、成本和性能上通常更具确定性和可预测性。常见模式有：

- 使用 [structured outputs](https://platform.openai.com/docs/guides/structured-outputs) 生成可由代码检查的格式良好的数据。例如，您可以让智能体先将任务分类到几个类别中，再根据类别选择下一个智能体。
- 将多个智能体串联：把前一个智能体的输出转换为下一个智能体的输入。您可以把“写博客文章”拆成一系列步骤——做研究、写大纲、写正文、评审，然后改进。
- 在 `while` 循环中运行执行任务的智能体，并配合一个负责评估与反馈的智能体，直到评估者判定输出满足某些标准。
- 并行运行多个智能体，例如通过 JavaScript 原语 `Promise.all`。当多个任务彼此无依赖时，这对提升速度很有帮助。

我们在 [`examples/agent-patterns`](https://github.com/openai/openai-agents-js/tree/main/examples/agent-patterns) 中提供了不少代码示例。

## 相关指南

- [智能体](/openai-agents-js/zh/guides/agents)：了解组合模式与智能体配置。
- [工具](/openai-agents-js/zh/guides/tools#agents-as-tools)：了解 `agent.asTool()` 与管理者式编排。
- [交接](/openai-agents-js/zh/guides/handoffs)：了解专业智能体之间的委派。
- [运行智能体](/openai-agents-js/zh/guides/running-agents)：了解 `Runner` 与按次运行的编排控制。
- [快速开始](/openai-agents-js/zh/guides/quickstart)：查看最小端到端交接示例。
