---
title: 智能体编排
description: Coordinate the flow between several agents
---

智能体编排是指您应用中智能体的流转方式：哪些智能体运行、按什么顺序运行，以及它们如何决定下一步发生什么。编排智能体主要有两种方式：

1. 让 LLM 做决策：利用 LLM 的智能进行规划、推理，并据此决定要执行哪些步骤。
2. 通过代码编排：通过您的代码来决定智能体的流转。

您可以混合使用这两种模式。它们各有权衡，详见下文。

## 通过 LLM 进行编排

智能体是配备了 instructions、tools 和 handoffs 的 LLM。这意味着面对开放式任务时，LLM 可以自主规划如何完成任务：使用工具执行操作并获取数据，使用交接将任务委派给子智能体。例如，一个研究智能体可以配备如下工具：

- 用于在线查找信息的 Web 搜索
- 用于检索专有数据和连接的文件搜索与检索
- 用于在计算机上执行操作的计算机操作
- 用于进行数据分析的代码执行
- 交接给擅长规划、报告撰写等工作的专业智能体

### SDK 核心模式

在 Agents SDK 中，最常见的两种编排模式是：

| 模式            | 工作方式                                                                         | 最适用场景                                                                                       |
| --------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Agents as tools | 管理者智能体持续掌控对话，并通过 `agent.asTool()` 调用专业智能体。               | 您希望由一个智能体负责最终回答、整合多个专业智能体的输出，或在单处统一执行共享护栏。             |
| 交接            | 分诊智能体将对话路由给专业智能体，该专业智能体会在本轮剩余过程中成为活跃智能体。 | 您希望由专业智能体直接面向用户回复、保持提示聚焦，或为不同专业智能体使用不同 instructions/模型。 |

当专业智能体只需协助完成子任务，而不应接管面向用户的对话时，请使用 **agents as tools**。管理者智能体仍负责决定调用哪些工具，以及如何给出最终回复。API 细节请参见[工具](/openai-agents-js/zh/guides/tools#agents-as-tools)，并在[智能体](/openai-agents-js/zh/guides/agents#composition-patterns)中查看并排示例。

当“路由”本身就是工作流的一部分，且您希望被选中的专业智能体负责对话下一阶段时，请使用 **handoffs**。交接会保留对话上下文，同时将当前生效的 instructions 收敛到该专业智能体。API 请参见[交接](/openai-agents-js/zh/guides/handoffs)，最小端到端示例请参见[快速开始](/openai-agents-js/zh/guides/quickstart#define-your-handoffs)。

您可以组合这两种模式。分诊智能体可以先交接给某个专业智能体，而该专业智能体仍可将其他智能体作为工具用于边界明确的子任务。

当任务是开放式且您希望依赖 LLM 的智能时，这种模式非常合适。这里最重要的策略是：

1. 投入精力打磨高质量提示。明确可用工具、使用方式，以及必须遵守的参数边界。
2. 监控并持续迭代您的应用。定位问题发生的位置，并迭代提示。
3. 让智能体具备自省与改进能力。例如，将其放在循环中运行并允许自我评估；或者提供错误信息并让其自行改进。
4. 使用在单一任务上表现出色的专业智能体，而不是期望一个通用智能体样样精通。
5. 投入 [evals](https://platform.openai.com/docs/guides/evals)。这可以帮助您训练智能体持续改进、在任务上表现更好。

如果您想了解这种编排风格背后的 SDK 基本组件，请从[工具](/openai-agents-js/zh/guides/tools)、[交接](/openai-agents-js/zh/guides/handoffs)和[运行智能体](/openai-agents-js/zh/guides/running-agents)开始。

## 通过代码进行编排

虽然通过 LLM 编排很强大，但通过代码编排在速度、成本和性能方面更具确定性和可预测性。常见模式包括：

- 使用 [structured outputs](https://platform.openai.com/docs/guides/structured-outputs) 生成可由代码检查的格式良好的数据。例如，您可以让智能体先将任务分类到若干类别，再基于类别选择下一个智能体。
- 串联多个智能体：将前一个智能体的输出转换为下一个智能体的输入。比如将“写博客”拆解为一系列步骤——做调研、写大纲、写正文、评审，然后改进。
- 将执行任务的智能体放在 `while` 循环中，并配合一个负责评估和反馈的智能体，直到评估器判定输出满足特定标准。
- 并行运行多个智能体，例如通过 JavaScript 原语 `Promise.all`。当多个任务彼此无依赖时，这对提速很有帮助。

我们在 [`examples/agent-patterns`](https://github.com/openai/openai-agents-js/tree/main/examples/agent-patterns) 中提供了多个代码示例。

## 相关指南

- [智能体](/openai-agents-js/zh/guides/agents)：了解组合模式与智能体配置。
- [工具](/openai-agents-js/zh/guides/tools#agents-as-tools)：了解 `agent.asTool()` 与管理者式编排。
- [交接](/openai-agents-js/zh/guides/handoffs)：了解专业智能体之间的委派。
- [运行智能体](/openai-agents-js/zh/guides/running-agents)：了解 `Runner` 与按次运行的编排控制。
- [快速开始](/openai-agents-js/zh/guides/quickstart)：最小端到端交接示例。
