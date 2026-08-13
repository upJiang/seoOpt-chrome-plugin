# SEO Opt Design System

**Product:** Chrome SEO audit side panel  
**Direction:** Flat Playful Tool UI  
**Design dials:** Variance 8/10, motion 3/10, density 7/10

This system synthesizes the `ui-ux-pro-max` Flat Design, Flat Touch-First and light
Neubrutalism results. It intentionally avoids the generic analytics-dashboard look:
color blocks, clear icon tiles and stable offset shadows create personality, while
SEO evidence remains compact and scannable.

## Visual Language

- Use solid cobalt, sky blue, yellow, orange, green and pink. No gradients or blurred decoration.
- Use 2px dark outlines and 2-4px hard offset shadows on primary repeated items and actions.
- Keep card radii at 8px or below. Circular treatment is reserved for the score gauge.
- Use full-width sections for page structure; cards are only for repeated metrics, findings, recommendations and messages.
- Use Lucide outline icons only. Give important icons a solid geometric container.
- Use Nunito for UI copy and Fira Code only for URLs, metrics, status codes and code.
- Do not introduce a mascot, emoji, glassmorphism, gradients, decorative orbs or nested cards.

## Color Tokens

The extension uses a fixed light theme so audit colors keep one stable meaning.

| Role | Value |
| --- | --- |
| Background | `#EDF3FF` |
| Surface | `#FFFFFF` |
| Primary | `#3157D8` |
| Action | `#C2410C` |
| Highlight | `#FFD84D` |
| Success | `#108A5B` |
| Destructive | `#D92D20` |
| Ink / hard shadow | `#17213D` |
| Sky block | `#9EDCFF` |
| Lime block | `#A8DC72` |
| Pink block | `#FF8A98` |

## Component Rules

- Header and tabs form one cobalt control band. The active tab is a white tile with a yellow icon tile.
- The SEO score is the first visual anchor: yellow evidence panel, circular gauge, orange sticker and hard shadow.
- Category metrics use a responsive 1/2-column repeated-item grid with distinct icon colors.
- Issue and recommendation rows use thick outlines and status color, without changing layout on hover.
- AI suggestions and messages read as speech bubbles through alignment, solid fills and offset shadows.
- Settings uses a fixed blue header, independently scrolling body and fixed yellow footer. The save action must always remain visible.
- API Key fields never display a stored secret. Show only stored/not-stored status and an explicit clear command.

## Interaction

- Minimum target size is 44x44px.
- Use 150-200ms color, border and opacity transitions. Press feedback must not move surrounding layout.
- Keep visible focus rings, keyboard tab navigation and accessible names for every icon button.
- Respect `prefers-reduced-motion`; never hide content behind entrance animation.
- At 320-439px, use one-column category and AI suggestion layouts. At 700px+, use two-column category cards.

## Pre-Delivery Checks

- No horizontal overflow at 320, 375, 414 and 768px.
- Save footer remains visible at 320x800 and when AI fields are expanded.
- Text meets WCAG contrast in the fixed light palette, including colored blocks and disabled states.
- No JSX `<strong>` tags and no emoji icons.
- AI Key and conversations persist in local extension storage and each has a manual clear path.
