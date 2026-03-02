---
title: 智能体编排
description: Coordinate the flow between several agents
---

智能体编排是指你应用中智能体的流转方式：哪些智能体会运行、按什么顺序运行，以及它们如何决定下一步做什么？编排智能体主要有两种方式：

> 建议在阅读[快速开始](/openai-agents-js/zh/guides/quickstart)或[智能体](/openai-agents-js/zh/guides/agents)指南后再阅读本页。本页讨论的是多个智能体之间的工作流设计，而不是 `Agent` 构造函数本身。

1. 由 LLM 进行决策：利用 LLM 的智能进行规划、推理，并据此决定要执行哪些步骤。
2. 通过代码进行编排：通过你的代码来决定智能体的流转方式。

你可以混合使用这两种模式。它们各有权衡，详见下文。

## 通过 LLM 进行编排

智能体是配备了 instructions、tools 和 handoffs 的 LLM。这意味着面对开放式任务时，LLM 可以自主规划如何完成任务：使用工具执行操作和获取数据，并通过交接将任务委派给子智能体。例如，一个研究智能体可以配备如下工具：

- 使用 Web 搜索在线查找信息
- 使用文件搜索与检索在私有数据和连接中进行搜索
- 使用计算机操作在电脑上执行操作
- 使用代码执行进行数据分析
- 交接给擅长规划、报告撰写等任务的专用智能体

### SDK 核心模式

在 Agents SDK 中，最常见的两种编排模式是：

| 模式            | 工作方式                                                                     | 最适用场景                                                                           |
| --------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Agents as tools | 管理者智能体保持对对话的控制，并通过 `agent.asTool()` 调用专家智能体。       | 你希望由一个智能体统一产出最终答案、整合多个专家输出，或在单一位置施加共享护栏。     |
| 交接            | 分诊智能体将对话路由给专家智能体，该专家在本轮剩余对话中成为当前活跃智能体。 | 你希望专家直接面向用户回复、让提示词更聚焦，或为不同专家使用不同 instructions/模型。 |

当专家智能体只需协助完成子任务，而不应接管面向用户的对话时，使用**Agents as tools**。管理者智能体仍负责决定调用哪些工具，以及如何组织最终回复。API 细节见[工具](/openai-agents-js/zh/guides/tools#agents-as-tools)指南，并可在[智能体](/openai-agents-js/zh/guides/agents#composition-patterns)指南中查看并排示例。

当“路由”本身就是工作流的一部分，并且你希望被选中的专家智能体接管后续对话时，使用**交接**。交接会保留对话上下文，同时将当前有效 instructions 收敛到该专家智能体。API 见[交接](/openai-agents-js/zh/guides/handoffs)指南，最小端到端示例见[快速开始](/openai-agents-js/zh/guides/quickstart#define-your-handoffs)。

你可以将两种模式结合使用。分诊智能体可以先交接给某个专家，而该专家仍可把其他智能体作为工具来完成边界清晰的子任务。

这种模式非常适合开放式任务，以及你希望依赖 LLM 智能的场景。最重要的策略包括：

1. 打磨高质量提示词。清楚说明有哪些工具可用、如何使用它们，以及必须遵守的参数范围。
2. 监控应用并持续迭代。定位问题出现的位置，并持续优化提示词。
3. 让智能体具备自省和改进能力。例如，让它在循环中运行并自我审查；或提供错误信息并让它自行改进。
4. 使用在单一任务上表现出色的专用智能体，而不是期望一个通用智能体无所不能。
5. 投入 [evals](https://platform.openai.com/docs/guides/evals)。这能帮助你训练智能体持续提升任务表现。

如果你想从这种编排风格背后的 SDK 基础组件入手，建议先看[工具](/openai-agents-js/zh/guides/tools)、[交接](/openai-agents-js/zh/guides/handoffs)和[运行智能体](/openai-agents-js/zh/guides/running-agents)。

## 通过代码进行编排

虽然通过 LLM 编排很强大，但通过代码编排在速度、成本和性能上通常更具确定性和可预测性。常见模式包括：

- 使用 [structured outputs](https://platform.openai.com/docs/guides/structured-outputs) 生成可由代码检查的格式良好的数据。例如，你可以让智能体先将任务分类到几个类别中，再根据类别选择下一个智能体。
- 串联多个智能体：将前一个智能体的输出转换为后一个智能体的输入。你可以将“写博客”这类任务拆解为一系列步骤：做研究、写大纲、写正文、评审，再改进。
- 在 `while` 循环中运行执行任务的智能体，并配合一个负责评估和反馈的智能体，直到评估者判定输出满足特定标准。
- 并行运行多个智能体，例如使用 JavaScript 原语 `Promise.all`。当多个任务彼此独立时，这对提升速度很有帮助。

我们在 [`examples/agent-patterns`](https://github.com/openai/openai-agents-js/tree/main/examples/agent-patterns) 中提供了多个示例。

## 相关指南

- [智能体](/openai-agents-js/zh/guides/agents)：了解组合模式与智能体配置。
- [工具](/openai-agents-js/zh/guides/tools#agents-as-tools)：了解 `agent.asTool()` 与管理者风格编排。
- [交接](/openai-agents-js/zh/guides/handoffs)：了解专用智能体之间的委派。
- [运行智能体](/openai-agents-js/zh/guides/running-agents)：了解 `Runner` 与单次运行级别的编排控制。
- [快速开始](/openai-agents-js/zh/guides/quickstart)：查看最小端到端交接示例。
