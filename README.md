# Plan (.pln)

Open a plan file as a project list instead of raw markdown. A `.pln` file is just
markdown with checkboxes: headings become sections and checkbox lines become
issues you can click through three states — todo, in progress, and done.

The file stays plain text, so it diffs and merges like any other file in your
repository. Everything you do in the editor writes straight back to it.

![A .pln file open in the editor](docs/screenshot.png)

## Example

```markdown
# Product Launch Plan

## Research

- [x] Define target audience
- [-] Review competitive landscape

## Build

- [ ] Implement onboarding flow
- [ ] Run load tests
```

`[ ]` is todo, `[-]` is in progress, and `[x]` is done.

## Install

Search for **Plan (.pln)** in the VS Code Extensions view, or install it from the
[Marketplace](https://marketplace.visualstudio.com/items?itemName=emanuelaromano.pln-plan).

## Usage

Create or open a file ending in `.pln` and it opens in the plan editor. To see
the underlying markdown at any point, use **Reopen Editor With… → Text Editor**.

- **Add a section** with the *Add section* button at the bottom. The name is
  selected so you can type over it right away.
- **Add an issue** by pressing `Enter` while renaming one — this commits the
  current issue and starts the next.
- **Change a status** by clicking its circle, which cycles todo → in progress →
  done. The issue menu (`⋯`) sets a status directly.
- **Rename or delete** a section or an issue from its `⋯` menu. Clearing an
  issue's text deletes it.
- **Collapse a section** by clicking its header. Collapsed sections are
  remembered per file.

## Early release

This is version 0.1.0, an early release. It covers sections, issues, statuses,
renaming, and deletion. Anything else you put in a `.pln` file is left untouched
but is not shown in the editor.

Issues and feedback: <https://github.com/emanuelaromano/pln/issues>

## License

MIT
