# Engineering & Interface Rules

## 1. Interface Bans (Anti-Slop Protocol)
- Zero Emojis: No emojis anywhere in the UI, code comments, system notifications, or terminal outputs.
- Zero Neon & Glow: No ambient background glows, no blurred radial light circles, no neon text, and no generic electric purple/blue gradients.
- Zero Decorative SVGs: No abstract shapes, no floating marketing graphics, and no illustrative fluff. Use only functional mono icons (Lucide) where practically necessary.
- Zero Fake Metrics: No fabricated marketing numbers ("99.9% accuracy", "Trusted by thousands"). Display only authentic runtime metrics (exact line citations, millisecond runtimes, byte sizes).
- Zero Text Ornaments: No decorative dashes around headers (e.g. `--- TITLE ---`), no quote ornaments, and no conversational AI filler.
- Zero Card Bloat: Avoid chunky cards with heavy drop shadows. Keep interfaces dense, functional, and organized with hairline structural borders.

## 2. Design Standards
- High-craft, surgical developer tool aesthetic (Linear, Raycast, Vercel standard).
- Clean monochrome canvas with high-contrast text and subtle structural separators.
- Strict monospaced formatting for all code snippets, file paths, line citations, and diff views.
- Restrained, crisp micro-interactions and state transitions without sluggish or theatrical animations.

## 3. Engine & Audit Invariants
- Deterministic Provenance: Every drift finding must link directly to an exact relative file path and line number for both documentation and code.
- Strict Schema Enforcement: Engine output must strictly adhere to the `DriftFinding` interface defined in `docs/PRD.md`.
- Drift Classifications:
  - `ROUTE_MISMATCH`: Endpoint path or HTTP method contradiction.
  - `PARAM_MISMATCH`: Request payload or parameter key contradiction.
  - `AUTH_MISMATCH`: Header authentication or session handling contradiction.
  - `RESPONSE_MISMATCH`: Returned payload structure or data schema contradiction.
- Patch Cleanliness: Generated markdown patches must target only the contradicted text without reformatting or refactoring unaffected documentation.