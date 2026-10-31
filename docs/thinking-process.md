# How I thought about this

## Stack

TypeScript and Express, it's what Beloz runs. Plain SQL with `pg`, no ORM. For the parts that move money I want to read the exact query, locks and all.

## Yes, it's a monolith

One app, one Postgres, code split by area. Bank, card network and login are faked, Acme doesn't own those.

The reason: when a purchase comes in, the limit check, the hold and the ledger write have to land together or not at all. One database, one transaction, done. With separate services I'd need sagas to undo half a money move. Way too much for a 4 person team.

## Real Postgres

Memory was allowed, but a lock inside one Node process tells you nothing once there are two replicas. SQLite has no row locks, so a race test would pass without testing anything. So the tests run on Postgres, same as prod would.

## Money rules

- Centavos as integers, MXN only. No floats anywhere.
- Double entry ledger, append only. You fix a mistake with a new entry, the app can't edit or delete rows.
- Holds aren't real money yet, so they're not in the ledger. They just eat the available credit.
- We can say no to a purchase, we can't say no to a capture, the merchant already got paid. So the limit is checked at authorization with the row locked, and captures always go in, even late or bigger than the hold. Which means debt can end up bigger than the collateral, so closing needs a charge off.
- Freeze just stops new purchases. Stuff already in flight still settles, and if ops froze it the customer can't unfreeze it.

## What worried me most

Payouts timing out. If the bank doesn't answer and we just retry, we might pay twice. So it sits as `unknown` until someone checks, nothing retries it automatically, and the bank gets our payout id so even a manual retry can't double pay.

Incoming money is the same story backwards. The bank can send the same webhook twice, so we dedupe on its transaction id. And money we can't match still gets recorded, cause bouncing the webhook doesn't give the money back.

## Does it actually work

I didn't trust green tests alone. Each important guard got removed on purpose to check its test goes red, and a couple of tests turned out to be passing for the wrong reason.

The stress test throws 50 mixed requests at one account at once. Without the lock the customer ended up with 17,500 in credit instead of 10,000. That's 7,500 we'd pay out for nothing.

Then two blind reviews with a non Anthropic model, only the code and the rules. Still found money bugs late, like paying out credit to someone who owed us. Fixed each one with a failing test first.

## Not done

No UI, no interest, no statements. Interest means rounding rules and a clock, I'd rather ship a core I trust than a bigger one I don't.
