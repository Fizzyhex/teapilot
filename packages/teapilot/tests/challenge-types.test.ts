// These negative examples are checked by tsc, not merely by Vitest's transpiler.
import { expect, it } from 'vitest';
import type { CaseStep, ChallengeCase, Expectation, Expectations } from '../scripts/bench/challenge/case.mjs';

const valid = {
  id: 'typed-example',
  steps: [
    { say: `a multiline
prompt`, as: 'user', attach: ['samples/tree.png'] },
    { slash: '/convo clear', choose: 0, oneShot: true, wait: false },
    { click: 'go', message: 'm2', wait: true },
    { select: { control: 'category', values: ['breakfast', 'sweets'] } },
    { submit: { recipe: 'cake' } },
    { approve: false },
    { advance: '1500ms' },
    { restart: true },
    { sleep: 100 },
    { inspect: true, record: true },
  ],
  expect: ['noRejections', { check: 'appSourceContains', options: { pattern: 'cake', flags: 'i' } }],
} satisfies ChallengeCase;

// Deliberately never executed. An unused @ts-expect-error fails the package typecheck.
function rejectedExamples() {
  // @ts-expect-error a step must have an action
  const missing = { note: 'nothing to do' } satisfies CaseStep;
  // @ts-expect-error a step must have exactly one action
  const multiple = { say: 'hello', restart: true } satisfies CaseStep;
  // @ts-expect-error actors are the simulator's known people
  const actor = { say: 'hello', as: 'usr' } satisfies CaseStep;
  // @ts-expect-error attachments are only supported by say
  const misplaced = { click: 'go', attach: ['file.png'] } satisfies CaseStep;
  // @ts-expect-error misplaced fields stay invalid even through a variable
  const spread = { ...{ click: 'go', choose: 1 } } satisfies CaseStep;
  // @ts-expect-error the old regex field was not implemented
  const ignored = { say: 'hello', for: '^Result: ' } satisfies CaseStep;
  // @ts-expect-error automatic approvals are not implemented
  const autoApprove = { say: 'hello', autoApprove: true } satisfies CaseStep;
  // @ts-expect-error restart is a marker, not a toggle
  const restart = { restart: false } satisfies CaseStep;
  // @ts-expect-error durations carry units
  const duration = { advance: '30' } satisfies CaseStep;
  // @ts-expect-error select separates the control from selected values
  const selection = { select: 'breakfast' } satisfies CaseStep;
  // @ts-expect-error select needs at least one value
  const emptySelection = { select: { control: 'category', values: [] } } satisfies CaseStep;
  // @ts-expect-error check names are not arbitrary strings
  const unknown = ['noRejection'] satisfies Expectations;
  // @ts-expect-error a typo in object check names also fails
  const unknownObject = { check: 'appExist' } satisfies Expectation;
  // @ts-expect-error options are correlated with the selected check
  const wrongOptions = { check: 'appExists', options: { maxBytes: 100 } } satisfies Expectation;
  // @ts-expect-error no catch-all index signature permits misspelled options
  const typo = { check: 'appExists', options: { show: 'cake' } } satisfies Expectation;
  // @ts-expect-error option values have concrete types
  const optionType = { check: 'fixtureInvocations', options: { max: 'two' } } satisfies Expectation;
  // @ts-expect-error this check needs a pattern
  const missingOptions = { check: 'appSourceContains' } satisfies Expectation;
  // @ts-expect-error bare check names cannot bypass required options
  const bareRequired = ['appSourceContains'] satisfies Expectations;
  // @ts-expect-error checks with no author-facing options reject options
  const noOptions = { check: 'noRejections', options: { max: 1 } } satisfies Expectation;
  // @ts-expect-error runtime dependencies are not case-author options
  const validator = { check: 'controlsAreValid', options: { validate: { checkMessage() {} } } } satisfies Expectation;
  // @ts-expect-error case fields are checked too
  const caseTypo = { id: 'typo', steps: [{ inspect: true }], judgedd: [] } satisfies ChallengeCase;
  void [missing, multiple, actor, misplaced, spread, ignored, autoApprove, restart, duration, selection,
    emptySelection, unknown, unknownObject, wrongOptions, typo, optionType, missingOptions, bareRequired,
    noOptions, validator, caseTypo];
}
void rejectedExamples;

it('accepts a typed case with every supported action', () => {
  expect(valid.steps).toHaveLength(10);
});
