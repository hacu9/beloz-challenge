Problem Statement

You are an engineer tasked with building a brand-new service for an
innovative FinTech company called Acme Credit. The company is launching a
secured credit card: before a customer gets an active card, they must
deposit money as a guarantee (collateral). That deposit sets their credit
limit, and it protects the company if the customer doesn't pay back what
they spend.

Your service will own this lending flow. At minimum, it should cover:

- Collateral deposit: receiving and confirming the customer's guarantee
deposit.
- Card activation: a card becomes active only once its collateral is
confirmed, with a credit limit derived from the deposit.
- Spending: authorizing purchases against the available credit. A purchase
must never exceed the limit.
- Repayments: customers paying back what they've spent, which restores
their available credit.
- Collateral release or application: returning the deposit when an account
is closed in good standing, or applying it to cover unpaid debt.

How far you go beyond this is up to you: interest, statements, late fees,
limit increases, card freezing, and so on. Money is moving, and part of it
is held as a guarantee, so this is a critical service. Every type of
measure and strategy needed to make sure it works as expected should be in
place. Keeping customer money safe is what keeps a fintech in business.

Instructions

- Architecture: A microservice is recommended, but you can choose a
different style if you think it fits better. Explain why you chose it, as
thoroughly as you can, with clear concepts.
- Critical-service concerns: This is a lending system in a financial
context. Think about what you need to guarantee safe concurrency (e.g., two
purchases hitting the same card at once), security, data consistency,
idempotency, auditability, and correct handling of money amounts.
- Infrastructure: You don't need a real database or a real authentication
service. You can simulate them in code, keep everything in memory, and so
on. If you want, you can add a real PostgreSQL instance, SQLite, or
anything else. It's not critical. If you do add real services, think about
how to make them easy to run locally (containers, perhaps?).
- Cloud native: You don't need to deploy to the cloud. Explain how you
would deploy to any cloud provider (e.g., AWS), and try to include some
form of Infrastructure as Code (IaC).
- AI usage: You can use AI. If you do, we recommend telling the AI what to
do rather than asking it how to think.
- Build prompts (required if you use AI): Include every prompt you used
during the build process, along with every response, in order. This covers
all AI tools: chat assistants, coding agents, IDE copilots, and so on. A
PROMPTS.md file or an exported conversation log in the repo is fine. We
want to see how you directed the AI, not just the final code.
- Your thinking process: Describe how you made your choices on
architecture, tech stack, and strategy for the critical parts of the
service. Include the trade-offs you considered and anything else you think
is important.
- Deadline: You have 5 calendar days from the moment you receive this
challenge to deliver it. Use that time to deliver the best result you can.
- Delivery: Send the project however is easiest for you: GitHub, a ZIP on
Google Drive, or a single PDF. Keep in mind that email can be slow and
limited.
- Live demo: Publishing the project to a live site isn't required, but it
doesn't hurt, as long as you also share the source files.
- Tech stack: Use whatever you like, ideally Python, TypeScript, or Go.

This challenge is open-ended on purpose, apart from a few constraints and
recommendations. Be as creative as you want and add your own ideas and
personal touch. We value quality over quantity. And have fun: see this as a
chance to show your passion for building solutions, not as a chore.
