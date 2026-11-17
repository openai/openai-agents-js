---
'@openai/agents-extensions': patch
---

Reject tar restores on Daytona, E2B, and Blaxel while a storage mount is attached. Restore the archive before attaching mounts to protect external files from workspace cleanup.
