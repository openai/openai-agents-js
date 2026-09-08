---
'@openai/agents-extensions': patch
---

fix: TextEncoderStream이 없는 환경에서 청크 경계에 걸친 유니코드 문자가 손상되지 않도록 수정합니다.
