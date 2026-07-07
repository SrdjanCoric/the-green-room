/**
 * Neutralize any literal fence delimiter embedded in untrusted content before it is
 * wrapped in a `<cv>`/`<posting>`/`<transcript>`/`<profile>`/`<brief>`/`<grades>` fence. A candidate whose CV or answer
 * contains a forged closing tag (e.g. `</transcript>` followed by injected instructions)
 * could otherwise close the fence early and smuggle text past the "untrusted data" guard
 * the system prompts rely on. The angle brackets become square brackets: still readable to
 * the model, but inert as a fence. The director's `subject`/`reason` — quoted near-verbatim
 * from the candidate's own answer — pass through here too, since they ride into the
 * interviewer's directive alongside the same fenced blocks.
 */
export function neutralizeFences(text: string): string {
  return text.replace(
    /<(\/?)(cv|posting|transcript|profile|brief|grades|prior_sessions)>/gi,
    (_match, slash, tag) => `[${slash}${tag}]`,
  );
}
