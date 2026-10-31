# Open questions

Each question blocks the tasks that name it. When Henry answers one, move it to
[decisions.md](decisions.md). OQ-01 to OQ-12 are answered there.

| ID | Question | AI lean | Blocks |
|---|---|---|---|
| OQ-13 | When ops cancels a failed payout, the reservation ends, so the next `send-payouts` or `progress-closures` run creates a *new* payout for the same money (new ID). With a bad payout CLABE this loops: fail, cancel, recreate. Is that the wanted behaviour? | `cancel` parks the money: the jobs skip it until ops changes the payout CLABE or releases it explicitly. | Backlog (no milestone) |
