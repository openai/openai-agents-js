---
'@openai/agents-realtime': patch
---

Encode realtime audio buffers safely so large chunks no longer crash. The realtime `arrayBufferToBase64` helper now uses the shared `encodeUint8ArrayToBase64` encoder instead of spreading every byte into `String.fromCharCode`, which threw a RangeError for larger audio buffers.
