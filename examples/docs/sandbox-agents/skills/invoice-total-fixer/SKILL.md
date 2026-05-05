---
name: invoice-total-fixer
description: Use when fixing invoice total calculations in the sandbox quickstart repository.
---

# Invoice Total Fixer

Inspect the implementation and test before editing. The total should apply tax as a percentage of the subtotal, so the expected formula is `subtotal + subtotal * taxRate`.

After editing, run `npm test` from the repository directory and report the command result.
