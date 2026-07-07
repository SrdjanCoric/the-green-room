# Structure an answer with STAR

A strong behavioral answer moves through four beats, in order: Situation, Task,
Action, Result. Skipping a beat is the most common way an answer loses the listener.

- **Situation** — one or two sentences that set the scene: the team, the system, the
  moment. Enough context that the stakes are clear, no more. "Our checkout service was
  timing out for about 3% of users during peak hours."
- **Task** — the concrete problem that was yours to solve. Name it sharply. "I owned
  the reliability of that path, and the timeouts were costing us roughly $40k a week in
  abandoned carts."
- **Action** — what *you* personally did, step by step, including the judgment calls.
  This is the heart of the answer and should be the longest beat. Use "I", not "we".
- **Result** — how it turned out, strongest when a number measures the change. Close
  the loop you opened in the Situation. "Timeouts dropped to under 0.2% and cart
  abandonment fell back to baseline within two weeks."

## Where answers leak

Most weak answers are strong through Action and then trail off before the Result. If
you notice yourself ending on "…and that fixed it", you have skipped the Result: say
what changed and by how much. The second most common leak is a Situation with no
stakes — the listener can't tell why the work mattered, so the whole answer feels flat.

## A worked contrast

Weak: "We had some performance problems so I looked into it and made it faster."
Strong: "Checkout was timing out for 3% of users at peak (Situation). I owned that path
(Task). I profiled the hot requests, found an N+1 query against the pricing service,
added a batched loader and a short-TTL cache, and shipped it behind a flag I ramped over
three days (Action). Timeouts went from 3% to under 0.2% and we recovered about $40k a
week in carts (Result)."
