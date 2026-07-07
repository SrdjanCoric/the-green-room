# Scope your story to the target level

The same project can be a strong answer for one level and a weak one for the next. What
changes is the *scope* of ownership the story demonstrates. Pick and frame stories so the
scope matches the level you're interviewing for.

## What each level is listening for

- **Junior / early-career** — that you can execute a well-defined task competently, ask
  for help at the right moment, and learn from it. A story about fixing a specific bug,
  understanding *why* it happened, and adding a test is exactly right.
- **Mid-level** — that you own a feature or component end to end: you handle ambiguity in
  the requirements, make reasonable trade-offs, and see it through to production and its
  consequences. The story should show you deciding, not just doing.
- **Senior** — that you own a *problem*, not a ticket. You define what needs solving,
  navigate the messy parts (competing priorities, unclear ownership, pushback), and drive
  impact beyond the immediate task — a system, a team's velocity, a class of bugs. Senior
  answers name the trade-offs you rejected and why.
- **Staff and beyond** — that your impact is leveraged through others and across teams:
  setting technical direction, de-risking a large effort, making a decision whose blast
  radius is the org, not the codebase.

## Level a story up or down

The same migration story:

- *Mid framing* — "I migrated our auth service to the new platform and shipped it safely."
- *Senior framing* — "I noticed three teams were each hand-rolling the same fragile
  cutover, so I owned the migration pattern: I ran mine first as the reference, wrote the
  reconciliation tooling, and got the other two teams onto it, which killed a recurring
  class of cutover incidents."

Same underlying work; the senior framing shows problem-ownership and impact beyond the
one service.

## The drill

For your strongest story, write one sentence that states the scope of what you owned.
If that sentence is smaller than the target level is listening for, either reach for a
larger story or surface the larger-scope decisions that are already in this one but you've
been under-selling.
