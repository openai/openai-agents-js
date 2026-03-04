---
title: 에이전트 오케스트레이션
description: Coordinate the flow between several agents
---

오케스트레이션은 앱에서 에이전트가 흐르는 방식을 의미합니다. 어떤 에이전트가, 어떤 순서로 실행되며, 다음에 무엇이 일어날지를 어떻게 결정할까요? 에이전트를 오케스트레이션하는 주요 방법은 두 가지입니다:

> 이 페이지는 [빠른 시작](/openai-agents-js/ko/guides/quickstart) 또는 [에이전트](/openai-agents-js/ko/guides/agents#composition-patterns)를 먼저 읽은 뒤 확인하세요. 이 페이지는 `Agent` 생성자 자체가 아니라, 여러 에이전트에 걸친 워크플로 설계에 관한 내용입니다.

1. LLM 이 의사결정을 하도록 허용: LLM 의 지능을 사용해 계획하고, 추론하고, 이를 바탕으로 어떤 단계를 수행할지 결정합니다
2. 코드로 오케스트레이션: 코드로 에이전트 흐름을 결정합니다

이 패턴들은 함께 조합해서 사용할 수 있습니다. 각각의 트레이드오프는 아래에 설명합니다.

## LLM 기반 오케스트레이션

에이전트는 instructions, tools, 핸드오프를 갖춘 LLM 입니다. 즉, 개방형 작업이 주어지면 LLM 이 도구를 사용해 행동하고 데이터를 수집하며, 핸드오프를 사용해 하위 에이전트에 작업을 위임하면서 작업을 처리할 방법을 자율적으로 계획할 수 있습니다. 예를 들어 리서치 에이전트에는 다음과 같은 도구를 갖출 수 있습니다:

- 온라인 정보를 찾기 위한 웹 검색
- 사내 데이터와 연결 정보를 탐색하기 위한 파일 검색 및 검색 결과 가져오기
- 컴퓨터에서 작업을 수행하기 위한 컴퓨터 사용
- 데이터 분석을 위한 코드 실행
- 계획 수립, 보고서 작성 등에 뛰어난 전문 에이전트로의 핸드오프

### SDK 핵심 패턴

Agents SDK 에서 가장 자주 쓰이는 오케스트레이션 패턴은 두 가지입니다:

| Pattern | How it works | Best when |
| --- | --- | --- |
| Agents as tools | 매니저 에이전트가 대화 제어를 유지하고 `agent.asTool()` 을 통해 전문 에이전트를 호출합니다 | 하나의 에이전트가 최종 답변을 책임지고, 여러 전문 에이전트의 출력을 결합하거나, 공통 가드레일을 한 곳에서 강제하고 싶을 때 |
| Handoffs | 트리아지 에이전트가 대화를 전문 에이전트로 라우팅하고, 해당 턴의 나머지 동안 그 전문 에이전트가 활성 에이전트가 됩니다 | 전문 에이전트가 사용자에게 직접 응답하고, 프롬프트를 집중시키거나, 전문 에이전트별로 다른 instructions/models 를 쓰고 싶을 때 |

전문 에이전트가 하위 작업만 돕고 사용자 대상 대화를 가져가면 안 되는 경우에는 **agents as tools** 를 사용하세요. 어떤 도구를 호출할지, 최종 응답을 어떻게 제시할지는 매니저가 계속 책임집니다. API 세부 사항은 [도구](/openai-agents-js/ko/guides/tools#agents-as-tools), 나란히 비교한 예시는 [에이전트](/openai-agents-js/ko/guides/agents#composition-patterns)를 참고하세요.

라우팅 자체가 워크플로의 일부이고, 선택된 전문 에이전트가 대화의 다음 부분을 맡아야 한다면 **handoffs** 를 사용하세요. 핸드오프는 대화 컨텍스트를 유지하면서 활성 instructions 를 해당 전문 에이전트로 좁혀 줍니다. API 는 [핸드오프](/openai-agents-js/ko/guides/handoffs), 최소 종단 간 예시는 [빠른 시작](/openai-agents-js/ko/guides/quickstart#define-your-handoffs)을 참고하세요.

두 패턴을 함께 사용할 수도 있습니다. 트리아지 에이전트가 전문 에이전트로 핸드오프한 뒤, 그 전문 에이전트가 범위가 제한된 하위 작업에 대해 다른 에이전트를 도구로 계속 사용할 수 있습니다.

이 패턴은 작업이 개방형이고 LLM 의 지능에 의존하고 싶을 때 매우 좋습니다. 여기서 가장 중요한 전술은 다음과 같습니다:

1. 좋은 프롬프트에 투자하세요. 어떤 도구를 사용할 수 있는지, 어떻게 사용해야 하는지, 어떤 매개변수 범위 안에서 동작해야 하는지를 명확히 하세요
2. 앱을 모니터링하고 반복 개선하세요. 어디서 문제가 생기는지 확인하고 프롬프트를 개선하세요
3. 에이전트가 스스로 점검하고 개선하게 하세요. 예를 들어 루프에서 실행하고 자기 비평을 하게 하거나, 오류 메시지를 제공해 개선하게 하세요
4. 무엇이든 잘해야 하는 범용 에이전트 하나보다, 한 가지 작업에 뛰어난 전문 에이전트를 두세요
5. [evals](https://platform.openai.com/docs/guides/evals)에 투자하세요. 이를 통해 에이전트를 학습시켜 작업 성능을 개선할 수 있습니다

이 오케스트레이션 스타일의 SDK basic components 를 원하면 [도구](/openai-agents-js/ko/guides/tools), [핸드오프](/openai-agents-js/ko/guides/handoffs), [에이전트 실행](/openai-agents-js/ko/guides/running-agents)부터 시작하세요.

## 코드 기반 오케스트레이션

LLM 기반 오케스트레이션은 강력하지만, 코드 기반 오케스트레이션은 속도, 비용, 성능 측면에서 작업을 더 결정적이고 예측 가능하게 만듭니다. 여기서 흔한 패턴은 다음과 같습니다:

- 코드로 검사할 수 있는 적절한 형식의 데이터를 생성하기 위해 [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)를 사용하기. 예를 들어 작업을 몇 가지 카테고리로 분류하도록 에이전트에 요청하고, 카테고리에 따라 다음 에이전트를 선택할 수 있습니다
- 한 에이전트의 출력을 다음 에이전트의 입력으로 변환해 여러 에이전트를 체이닝하기. 블로그 글 작성 같은 작업을 리서치, 개요 작성, 본문 작성, 비평, 개선 같은 단계로 분해할 수 있습니다
- 작업 수행 에이전트를, 평가 및 피드백을 제공하는 에이전트와 함께 `while` 루프로 실행하고, 평가 에이전트가 출력이 특정 기준을 통과했다고 말할 때까지 반복하기
- 예: `Promise.all` 같은 JavaScript basic components 로 여러 에이전트를 병렬 실행하기. 서로 의존하지 않는 여러 작업이 있을 때 속도 측면에서 유용합니다

[`examples/agent-patterns`](https://github.com/openai/openai-agents-js/tree/main/examples/agent-patterns)에 다양한 코드 예제가 있습니다.

## 관련 가이드

- 구성 패턴과 에이전트 설정은 [에이전트](/openai-agents-js/ko/guides/agents)
- `agent.asTool()` 및 매니저 스타일 오케스트레이션은 [도구](/openai-agents-js/ko/guides/tools#agents-as-tools)
- 전문 에이전트 간 위임은 [핸드오프](/openai-agents-js/ko/guides/handoffs)
- `Runner` 및 실행별 오케스트레이션 제어는 [에이전트 실행](/openai-agents-js/ko/guides/running-agents)
- 최소 종단 간 핸드오프 예시는 [빠른 시작](/openai-agents-js/ko/guides/quickstart)
