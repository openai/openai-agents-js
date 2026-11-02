---
title: 에이전트 오케스트레이션
description: Coordinate the flow between several agents
canonicalHeadingIds:
  - depth: 2
    id: 'orchestrating-via-llm'
    aliases:
      - 'llm을-통한-에이전트-오케스트레이션'
      - 'llm을-통한-오케스트레이션'
  - depth: 3
    id: 'core-sdk-patterns'
    aliases:
      - '핵심-sdk-패턴'
  - depth: 2
    id: 'orchestrating-via-code'
    aliases:
      - '코드를-통한-에이전트-오케스트레이션'
      - '코드를-통한-오케스트레이션'
  - depth: 2
    id: 'related-guides'
    aliases:
      - '관련-가이드'
---

오케스트레이션은 앱 내 에이전트의 실행 흐름을 뜻합니다. 어떤 에이전트가 어떤 순서로 실행되며, 다음에 수행할 작업은 어떻게 결정할까요? 에이전트를 오케스트레이션하는 방법은 크게 두 가지입니다.

> [빠른 시작](/openai-agents-js/ko/guides/quickstart) 또는 [에이전트](/openai-agents-js/ko/guides/agents#composition-patterns) 가이드를 읽은 후 이 페이지를 읽어보세요. 이 페이지는 `Agent` 생성자 자체가 아니라 여러 에이전트에 걸친 워크플로 설계를 다룹니다.

1. LLM에 의사 결정 맡기기: LLM의 지능을 활용해 계획하고 추론하며, 이를 바탕으로 어떤 단계를 수행할지 결정합니다.
2. 코드로 오케스트레이션하기: 코드를 통해 에이전트의 실행 흐름을 결정합니다.

이러한 패턴을 혼합하여 사용할 수 있습니다. 각 패턴에는 장단점이 있으며, 아래에서 설명합니다.

## LLM을 통한 오케스트레이션

에이전트는 지침, 도구, 핸드오프를 갖춘 LLM입니다. 즉, 정해진 해법이 없는 작업이 주어지면 LLM이 자율적으로 작업 처리 방법을 계획하고, 도구를 사용해 작업을 수행하고 데이터를 수집하며, 핸드오프를 통해 하위 에이전트에 작업을 위임할 수 있습니다. 예를 들어, 리서치 에이전트는 다음과 같은 도구를 갖출 수 있습니다.

- 온라인에서 정보를 찾기 위한 웹 검색
- 자체 데이터와 연결된 리소스를 탐색하기 위한 파일 검색 및 정보 조회
- 컴퓨터에서 작업을 수행하기 위한 컴퓨터 사용
- 데이터 분석을 위한 코드 실행
- 계획 수립, 보고서 작성 등에 뛰어난 전문 에이전트로의 핸드오프

### 핵심 SDK 패턴

Agents SDK에서 가장 자주 사용되는 오케스트레이션 패턴은 두 가지입니다.

| 패턴 | 작동 방식 | 적합한 상황 |
| --- | --- | --- |
| Agents as tools | 관리자 에이전트가 대화의 제어권을 유지하고 `agent.asTool()`을 통해 전문 에이전트를 호출합니다. | 하나의 에이전트가 최종 답변을 책임지거나, 여러 전문 에이전트의 출력을 결합하거나, 공통 가드레일을 한곳에서 적용하도록 하려는 경우 |
| 핸드오프 | 분류 에이전트가 대화를 전문 에이전트로 라우팅하고, 해당 전문 에이전트가 남은 턴 동안 활성 에이전트가 됩니다. | 전문 에이전트가 사용자와 직접 대화하도록 하거나, 프롬프트의 초점을 명확하게 유지하거나, 전문 에이전트별로 다른 지침이나 모델을 사용하려는 경우 |

전문 에이전트가 하위 작업을 돕되 사용자와의 대화를 넘겨받아서는 안 되는 경우 **agents as tools**를 사용하세요. 관리자 에이전트는 호출할 도구와 최종 응답을 제시할 방식을 결정할 책임을 계속 맡습니다. API 세부 사항은 [도구](/openai-agents-js/ko/guides/tools#4-agents-as-tools) 가이드를, 두 패턴을 나란히 비교하는 예제는 [에이전트](/openai-agents-js/ko/guides/agents#composition-patterns) 가이드를 참고하세요.

라우팅 자체가 워크플로의 일부이며 선택한 전문 에이전트가 대화의 다음 부분을 맡도록 하려면 **핸드오프**를 사용하세요. 핸드오프는 대화 컨텍스트를 유지하면서 활성 지침의 범위를 해당 전문 에이전트의 지침으로 좁힙니다. API는 [핸드오프](/openai-agents-js/ko/guides/handoffs) 가이드를, 최소한의 엔드투엔드 예제는 [빠른 시작](/openai-agents-js/ko/guides/quickstart#define-your-handoffs)을 참고하세요.

두 패턴을 결합할 수도 있습니다. 분류 에이전트가 전문 에이전트로 핸드오프하고, 해당 전문 에이전트는 범위가 한정된 하위 작업을 위해 다른 에이전트에 agents as tools 방식을 사용할 수도 있습니다.

이 패턴은 정해진 해법이 없는 작업을 수행하면서 LLM의 지능을 활용하려는 경우에 적합합니다. 여기서 가장 중요한 전략은 다음과 같습니다.

1. 좋은 프롬프트를 만드는 데 투자하세요. 어떤 도구를 사용할 수 있는지, 어떻게 사용하는지, 어떤 제약 조건을 지켜야 하는지 명확히 하세요.
2. 앱을 모니터링하고 반복적으로 개선하세요. 문제가 발생하는 지점을 파악하고 프롬프트를 지속적으로 개선하세요.
3. 에이전트가 스스로 검토하고 개선할 수 있도록 하세요. 예를 들어, 루프에서 실행하면서 스스로 평가하게 하거나, 오류 메시지를 제공하여 개선하게 하세요.
4. 모든 일을 잘할 것으로 기대하는 범용 에이전트 대신, 한 가지 작업에 뛰어난 전문 에이전트를 두세요.
5. [평가](https://platform.openai.com/docs/guides/evals)에 투자하세요. 이를 통해 에이전트를 훈련하여 작업 수행 능력을 높일 수 있습니다.

이러한 오케스트레이션 방식의 기반이 되는 SDK 기본 구성 요소를 알아보려면 [도구](/openai-agents-js/ko/guides/tools), [핸드오프](/openai-agents-js/ko/guides/handoffs), [에이전트 실행](/openai-agents-js/ko/guides/running-agents)부터 살펴보세요.

## 코드를 통한 오케스트레이션

LLM을 통한 오케스트레이션은 강력하지만, 코드로 오케스트레이션하면 속도, 비용, 성능 측면에서 작업을 더 결정적이고 예측 가능하게 만들 수 있습니다. 일반적인 패턴은 다음과 같습니다.

- [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)를 사용하여 코드로 검사할 수 있는 적절한 형식의 데이터를 생성합니다. 예를 들어, 에이전트에게 작업을 몇 가지 카테고리 중 하나로 분류하도록 요청한 다음, 해당 카테고리에 따라 다음 에이전트를 선택할 수 있습니다.
- 한 에이전트의 출력을 다음 에이전트의 입력으로 변환하여 여러 에이전트를 연결합니다. 블로그 게시물 작성 같은 작업을 조사, 개요 작성, 본문 작성, 평가, 개선과 같은 일련의 단계로 나눌 수 있습니다.
- 작업을 수행하는 에이전트와 평가 및 피드백을 제공하는 에이전트를 `while` 루프에서 함께 실행합니다. 평가 에이전트가 출력이 특정 기준을 충족한다고 판단할 때까지 반복합니다.
- `Promise.all`과 같은 JavaScript 기본 구성 요소를 통해 여러 에이전트를 병렬로 실행합니다. 서로 의존하지 않는 여러 작업이 있을 때 속도를 높이는 데 유용합니다.

[`examples/agent-patterns`](https://github.com/openai/openai-agents-js/tree/main/examples/agent-patterns)에 여러 코드 예제가 있습니다.

## 관련 가이드

- 구성 패턴과 에이전트 설정을 위한 [에이전트](/openai-agents-js/ko/guides/agents)
- `agent.asTool()`과 관리자 방식의 오케스트레이션을 위한 [도구](/openai-agents-js/ko/guides/tools#4-agents-as-tools)
- 전문 에이전트 간 위임을 위한 [핸드오프](/openai-agents-js/ko/guides/handoffs)
- `Runner`와 실행별 오케스트레이션 제어를 위한 [에이전트 실행](/openai-agents-js/ko/guides/running-agents)
- 최소한의 엔드투엔드 핸드오프 예제를 위한 [빠른 시작](/openai-agents-js/ko/guides/quickstart)
