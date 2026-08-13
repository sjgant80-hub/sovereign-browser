Give it a page — and make the page run the real kernel

This repo had no live surface. Anyone arriving had to read source to find out
whether the central claim held, which means in practice nobody checked it.

index.html is GENERATED from kernel/governor.mjs and kernel/envelope.mjs by
build-page.mjs: the two files are inlined verbatim, module keywords stripped,
not one line of logic re-typed. So the verdict a visitor exercises is the same
code the mutation gate proved. A page that reimplements its own kernel is a
brochure that drifts, and the drift is invisible until it matters.

The demo is the thesis, made playable. The agent's declared label is a free
text box the kernel never reads; the observed event is what decides. Claim
"just scrolling the page", set the observed event to a purchase over the cap,
and watch the claim be ignored. A guarantee you cannot try to break is a
guarantee you have to take on faith.

The event table and the prohibited set are read out of the kernel at runtime
rather than listed in the markup, so the page cannot fall out of step with what
the governor actually knows.

Provenance is a control rather than a hidden constant, because it is a real
dimension of the design: the same read is allowed when the user asked for it
and needs confirmation when it came from text on the page.

Honest wall kept prominent: this is the engine-room, not a browser. The
guarantee holds exactly as far as the bridge's observations are honest, and no
purity below that fixes a bridge that mis-resolves what it saw. The page states
what it proves and what it does not.

One bug worth recording, and it was mine: re-arming the killswitch read a
`userNonce` field that does not exist, so it passed 1 against a kill epoch of
1, and the kernel refused — re-arm requires a STRICTLY greater nonce, because
replaying the same number is exactly the attack that invariant exists to stop.
The kernel was right and the page was wrong.
