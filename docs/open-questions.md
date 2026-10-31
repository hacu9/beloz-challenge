# Open questions

Each question blocks the tasks that name it. When Henry answers one, move it to
[decisions.md](decisions.md). OQ-01 to OQ-11 are answered there.

| ID | Question | AI lean | Blocks |
|---|---|---|---|
| OQ-12 | A payout is `unknown`, and later the bank sends a signed `payout.completed` or `payout.failed` webhook for it. Does the webhook resolve the payout, or does it only attach evidence for the person who resolves it? | The signed webhook is the bank's final answer, so it resolves the payout and writes an audit row. A person resolves only the payouts that get no webhook. | M6 |
