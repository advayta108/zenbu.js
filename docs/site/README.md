# Zenbu.js docs site

Public documentation for Zenbu.js. Authored as MDX, rendered with [Mintlify](https://mintlify.com).

## Local preview

```bash
cd docs/site
ni                  # install mintlify CLI
nr dev              # serves on http://localhost:3000
```

## Editing

- Pages are MDX files. The site map lives in [`docs.json`](./docs.json).
- API references are organized under `api/` and follow one section per public surface (no internal helpers).
- Conceptual ("Guide") pages live at the top level under their feature folder. Each subsystem has at minimum:
  1. an `overview.mdx` framing the concept and motivation,
  2. a "doing X" page with concrete code, and
  3. a corresponding `api/<subsystem>.mdx` reference page.

## Source of truth

The doc set is the **public-API contract**. Anything not documented here is internal — even if it's accidentally exported from a package today, it is subject to change without a deprecation cycle. Put another way: if you want a symbol to be public, document it here first.

## API design principles

See [`reference/api-design-principles.mdx`](./reference/api-design-principles.mdx).
