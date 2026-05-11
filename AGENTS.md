# Agent Guidelines

- Put planning notes, task lists, scratch files, generated reports, smoke-test notes, and other temporary agent artifacts under `.plan/`.
- `.plan/` is gitignored; do not place source code, user-facing documentation, or files that need to be committed there.

## Commit messages

Use Conventional Commits for all commits:

```text
<type>(<scope>): <short imperative summary>
```

- Keep the subject line under 72 characters when practical.
- Use lowercase `type`; use `scope` when it clarifies the affected area.
- Prefer one logical change per commit.
- Add a body when the reason, risk, migration impact, or validation is not obvious from the diff.

Accepted types:

- `feat`: user-facing feature or capability
- `fix`: bug fix or correctness/security fix
- `docs`: documentation-only change
- `test`: test-only change
- `build`: build system, package manager, or CI change
- `chore`: maintenance with no runtime/docs behavior change
- `refactor`: code restructuring without behavior change
- `perf`: performance improvement
- `style`: formatting-only change

Examples:

```text
fix(store): preserve session metadata on close

docs: add public release security policy

build(ci): run release checks on macos
```
