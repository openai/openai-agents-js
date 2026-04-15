---
title: 에이전트 오케스트레이션
description: Coordinate the flow between several agents
---

에이전트 오케스트레이션은 앱에서 에이전트가 흐르는 방식을 뜻합니다. 어떤 에이전트가, 어떤 순서로 실행되며, 다음에 무슨 일이 일어날지를 어떻게 결정할까요? 에이전트를 오케스트레이션하는 주요 방법은 두 가지입니다.

> 이 페이지는 [빠른 시작](/openai-agents-js/ko/guides/quickstart) 또는 [에이전트 가이드](/openai-agents-js/ko/guides/agents#composition-patterns)를 읽은 뒤에 보시기 바랍니다. 이 페이지는 `Agent` 생성자 자체가 아니라, 여러 에이전트에 걸친 워크플로 설계에 관한 내용입니다.

1. LLM 이 의사결정을 하도록 허용: LLM 의 지능을 사용해 계획하고, 추론하고, 이를 바탕으로 어떤 단계를 수행할지 결정합니다.
2. 코드를 통한 오케스트레이션: 코드로 에이전트의 흐름을 결정합니다.

이 패턴들은 함께 섞어 사용할 수 있습니다. 각각에는 아래 설명된 고유한 장단점이 있습니다.

## LLM 을 통한 오케스트레이션

에이전트는 instructions, tools, handoffs 를 갖춘 LLM 입니다. 즉, 개방형 작업이 주어졌을 때 LLM 이 자율적으로 작업을 어떻게 처리할지 계획하고, 도구를 사용해 행동을 수행하고 데이터를 확보하며, 핸드오프를 사용해 하위 에이전트에 작업을 위임할 수 있습니다. 예를 들어, 리서치 에이전트는 다음과 같은 도구를 갖출 수 있습니다.

- 온라인에서 정보를 찾기 위한 웹 검색
- 사내 데이터와 연결 정보를 검색하기 위한 파일 검색 및 검색 결과 가져오기
- 컴퓨터에서 작업을 수행하기 위한 컴퓨터 사용
- 데이터 분석을 위한 코드 실행
- 계획 수립, 보고서 작성 등에 뛰어난 전문 에이전트로의 핸드오프

### SDK 핵심 패턴

Agents SDK 에서는 두 가지 오케스트레이션 패턴이 가장 자주 사용됩니다.

| Pattern | How it works | Best when |
| --- | --- | --- |
| Agents as tools | 관리자 에이전트가 대화의 제어권을 유지하면서 `agent.asTool()` 을 통해 전문 에이전트를 호출합니다. | 하나의 에이전트가 최종 답변을 책임지고, 여러 전문가의 출력을 결합하거나, 공통 가드레일을 한 곳에서 적용하길 원할 때 |
| Handoffs | 분류 에이전트가 대화를 전문가에게 라우팅하고, 그 전문가가 해당 턴의 나머지 동안 활성 에이전트가 됩니다. | 전문가가 사용자와 직접 대화하고, 프롬프트를 집중되게 유지하거나, 전문가별로 서로 다른 instructions/models 를 사용하길 원할 때 |

전문가가 하위 작업을 돕되 사용자 대상 대화를 넘겨받아서는 안 되는 경우 **agents as tools** 를 사용하세요. 어떤 도구를 호출할지와 최종 응답을 어떻게 제시할지는 관리자 에이전트가 계속 책임집니다. API 세부 사항은 [도구 가이드](/openai-agents-js/ko/guides/tools#agents-as-tools)를, 나란히 비교한 예시는 [에이전트 가이드](/openai-agents-js/ko/guides/agents#composition-patterns)를 참고하세요.

라우팅 자체가 워크플로의 일부이고, 선택된 전문가가 대화의 다음 부분을 맡아야 하는 경우 **handoffs** 를 사용하세요. 핸드오프는 대화 컨텍스트를 유지하면서 활성 instructions 를 해당 전문가에 맞게 좁혀 줍니다. API 는 [핸드오프 가이드](/openai-agents-js/ko/guides/handoffs)를, 가장 작은 엔드투엔드 예시는 [빠른 시작](/openai-agents-js/ko/guides/quickstart#define-your-handoffs)를 참고하세요.

두 패턴을 함께 사용할 수도 있습니다. 분류 에이전트가 전문가에게 핸드오프할 수 있고, 그 전문가가 다시 제한된 하위 작업에 대해 다른 에이전트를 도구처럼 사용할 수도 있습니다.

이 패턴은 작업이 개방형이고 LLM 의 지능에 의존하고 싶을 때 매우 적합합니다. 여기서 가장 중요한 전략은 다음과 같습니다.

1. 좋은 프롬프트에 투자하세요. 어떤 도구를 사용할 수 있는지, 어떻게 사용해야 하는지, 어떤 제약 내에서 작동해야 하는지를 명확히 하세요.
2. 앱을 모니터링하고 반복적으로 개선하세요. 어디서 문제가 생기는지 확인하고, 프롬프트를 개선하세요.
3. 에이전트가 스스로 성찰하고 개선할 수 있게 하세요. 예를 들어 루프에서 실행하고 스스로 비평하게 하거나, 오류 메시지를 제공해 개선하게 할 수 있습니다.
4. 무엇이든 잘해야 하는 범용 에이전트 하나를 두기보다, 하나의 작업에 뛰어난 전문 에이전트를 두세요.
5. [evals](https://platform.openai.com/docs/guides/evals)에 투자하세요. 이를 통해 에이전트를 훈련시켜 작업 수행 능력을 개선하고 더 잘하게 만들 수 있습니다.

이 스타일의 오케스트레이션을 이루는 SDK 기본 구성 요소를 알고 싶다면 [도구](/openai-agents-js/ko/guides/tools), [핸드오프](/openai-agents-js/ko/guides/handoffs), [에이전트 실행](/openai-agents-js/ko/guides/running-agents)부터 시작하세요.

## 코드를 통한 오케스트레이션

LLM 을 통한 오케스트레이션은 강력하지만, 코드를 통한 오케스트레이션은 속도, 비용, 성능 측면에서 작업을 더 결정적이고 예측 가능하게 만듭니다. 여기서 흔한 패턴은 다음과 같습니다.

- [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)를 사용해 코드로 검사할 수 있는 적절한 형식의 데이터를 생성합니다. 예를 들어, 에이전트에게 작업을 몇 가지 카테고리로 분류하게 한 다음, 그 카테고리를 기준으로 다음 에이전트를 선택할 수 있습니다.
- 여러 에이전트를 체인으로 연결하면서 한 에이전트의 출력을 다음 에이전트의 입력으로 변환합니다. 블로그 글 작성 같은 작업을 리서치, 개요 작성, 초안 작성, 비평, 개선과 같은 일련의 단계로 분해할 수 있습니다.
- 작업을 수행하는 에이전트를, 평가하고 피드백을 제공하는 에이전트와 함께 `while` 루프에서 실행하고, 평가자가 출력이 특정 기준을 충족한다고 말할 때까지 반복합니다.
- 여러 에이전트를 병렬로 실행합니다. 예를 들어 `Promise.all` 같은 JavaScript 기본 구성 요소를 사용할 수 있습니다. 이는 서로 의존하지 않는 여러 작업이 있을 때 속도 측면에서 유용합니다.

[`examples/agent-patterns`](https://github.com/openai/openai-agents-js/tree/main/examples/agent-patterns)에는 다양한 예제가 있습니다.

## 관련 가이드

- 구성 패턴과 에이전트 설정은 [에이전트](/openai-agents-js/ko/guides/agents)를 참고하세요
- `agent.asTool()` 및 관리자 스타일 오케스트레이션은 [도구](/openai-agents-js/ko/guides/tools#agents-as-tools)를 참고하세요
- 전문 에이전트 간 위임은 [핸드오프](/openai-agents-js/ko/guides/handoffs)를 참고하세요
- `Runner` 및 실행별 오케스트레이션 제어는 [에이전트 실행](/openai-agents-js/ko/guides/running-agents)를 참고하세요
- 최소한의 엔드투엔드 핸드오프 예시는 [빠른 시작](/openai-agents-js/ko/guides/quickstart)를 참고하세요
