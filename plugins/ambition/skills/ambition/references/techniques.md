# techniques from other fields

a starter list for the range lens. each entry is a method the executor can run, not a persona to imitate. a field outside this list is welcome when it yields something equally concrete.

| technique | field | what you do | fits when |
|---|---|---|---|
| premortem | decision science (Gary Klein) | assume the work shipped and failed, list the reasons, turn each into a test or a guard | any plan with a launch or a deadline |
| pre-registration | experimental science | fix the hypothesis, metric, analysis and pass/fail before looking at results | any measured target |
| holdout or backtest | ML, quantitative finance | build on past data, predict a period you hid, compare | claims about causes, signals, or prompt quality |
| differential diagnosis | medicine | list the candidate causes, run the test that best separates them, repeat | debugging, root-cause work |
| bisection | numerical methods, git | halve the search space each step (git bisect, config halving, input halving) | regressions, "it worked before" |
| reconciliation | forensic accounting | compute the same number from independent sources. every mismatch is a finding | any reported metric or total |
| short-seller thesis | finance | find the claim that collapses the story if false, then look for evidence against it | reports, recommendations, decks |
| commander's intent | military doctrine | state the purpose and end state so the executor can adapt when the plan breaks | writing the rewritten prompt, delegating |
| five whys, jobs to be done | manufacturing (Toyota), product | ask why the outcome matters until the answer stops changing | the altitude lens |
| control charts | manufacturing (statistical process control) | plot the metric over time with control limits to separate change from noise | "did it get better?", monitoring |
| Little's law, load testing | operations research | relate throughput, latency and concurrency, then drive load until the curve bends | performance and capacity |
| fault injection | SRE, chaos engineering | break a dependency on purpose and watch what happens | reliability and resilience claims |
| fuzzing, property-based tests | security, testing | generate adversarial inputs against stated invariants | parsers, input handling, protocols |
| threat modeling (STRIDE, attack trees) | security | list actors, assets and trust boundaries, then the attacks at each boundary | anything with a trust boundary |
| five-user usability test, cognitive walkthrough | HCI | watch someone do the task cold, or step through each action asking what the user expects next | UI, CLI ergonomics, docs |
| inverted pyramid | journalism | lead with the conclusion, then the support in falling order of importance | reports, writeups, status updates |
| Fermi estimate | physics | bound the number from first principles before measuring it | setting targets, sanity-checking baselines |
| blocking and storyboards | theater, film, 3D | lay out the whole scene in space or sequence before any detail work | creative and visual work |
