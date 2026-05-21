---
'@openai/agents-core': patch
---

fix: mark rejected tool call results as incomplete

Approval rejections previously emitted `function_call_result` items with `status: 'completed'`, identical to successful tool runs. The structural status contradicted the rejection text and could cause models to claim a rejected tool actually executed. Rejected results now use `status: 'incomplete'`.
