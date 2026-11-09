# React quality checks

Development tools require Node **22.13 or newer**. This minimum includes the supported ESLint 10 runtime; the application uses React 19.2.5 and keeps the existing Monaco lifecycle integration outside global StrictMode.

Run `pnpm check:react` before submitting dashboard changes. It enables the official `eslint-plugin-react-hooks` recommended rules over all dashboard TypeScript, including hooks, dependencies, purity, refs, immutability and compiler compatibility. React Compiler itself is not required or enabled by this check. `pnpm check:arch` includes this gate. `pnpm lint:react` shows the complete diagnostic list without the legacy baseline.

The initial debt is recorded individually in `scripts/react-hooks-baseline.json`, captured from the frozen dashboard **before** the 2026-11-04 corrections. Each accepted finding is tied to its file, rule, description, offending source and count. New findings, duplicate occurrences and new files fail `check:react`; the command cannot enlarge or regenerate the baseline. Resolved entries should be removed during review. The baseline is explicit technical debt, not a claim that these legacy issues are safe or fixed.

Changes to memoization must be supported by an interaction profile. Preserve narrow subscriptions, stable selectors and bounded DOM; `memo` does not fix an expensive parser, an unbounded row or a transport left running after unsubscribe. A targeted `use no memo` directive is appropriate for an imperative API that React Compiler cannot safely transform, with its reason documented at the integration; do not disable hook rules globally.

Retained panes provide `SurfaceVisibilityContext`. Visual subscriptions use `useVisibleExternalStore`, polling uses `usePolling`, and elapsed labels use the shared clock. Hidden consumers unsubscribe and freeze their last snapshot; revealing reads current state. Streaming transport and canonical session data stay independent of visibility. Test hiding, updating, revealing and unmounting, including two consumers of one source.

The Company agent preview is a separate presentation projection limited to 81 UTF-16 code units per agent (80 displayed plus ellipsis detection). `useCompanyStream` observes the status summary, while each `AgentPane` observes only its own preview. Canonical message text is stored by the coder session and is never truncated by this display policy.

References: [official hooks rules](https://react.dev/reference/eslint-plugin-react-hooks), [memo guidance](https://react.dev/reference/react/memo), [ESLint flat configuration](https://eslint.org/docs/latest/use/configure/configuration-files).
