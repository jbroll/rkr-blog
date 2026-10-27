# Proposal: richer page design (site chrome, sections, listings)

Status: for later consideration. Nothing here is decided or built. Written 2026-10-21, revised 2026-10-22 from a full inventory of the site. Same conversation as [proposal-static-publishing.md](./proposal-static-publishing.md): moving the Electric City Community Grocery website (`electriccityfood.coop`, now on Squarespace 7.1) onto rkr-blog. This proposal assumes static publishing but does not depend on it.

## Why

The Squarespace site's header and page bodies are richer than anything rkr-blog renders. rkr-blog's header is a title, a tagline, and a fixed Home / About / Login nav (`docs/theming.md`, "Site chrome"). Its body is prose plus `::figure` and `::video`. Themes are CSS only and never change templates, so no theme can add a menu item, a button, or a section with a background.

## What the Squarespace site uses

From all 260 sitemap URLs plus 39 extra requests (`?format=json`, RSS, search, 404), fetched 2026-10-22. Evidence is `data-definition-name`, `data-current-styles`, and Fluid Engine `grid-area` rules. Layouts are inferred from markup; no screenshots were taken.

Content: 13 standalone pages, 9 collection indexes, 116 events, 33 recipes, 28 member-owner profiles, 22 Food for Thought issues, 16 board members, 8 NYS grant posts, 6 important-news items, 7 products.

### Header and footer

Identical on every page.

- Header: logo image, 7 flat menu links (Join, About Us, Contribute, News, FAQs, Contact Us, Shop; no dropdowns), Facebook and Instagram icons, a "Capital Campaign →" button, and an announcement bar ("Our Capital Campaign is underway!…") that a reader can close. Fixed to the top, solid aubergine. Cart, search, and login are hidden. On phones the menu is a full-screen overlay.
- Footer: logo, postal address and phone, social icons, three links (Sponsorships, FAQs, Bylaws), three buttons (Join, Contribute, Get Updates). No copyright line or signup form.

### Blocks

Counted inside page bodies, excluding header and footer:

| Block | Count | Pages | rkr-blog today |
| --- | --- | --- | --- |
| text | 497 | 235 | prose |
| image | 185 | 103 | `::figure` |
| horizontal rule | 18 | 18 | Markdown `---` |
| button | 15 | 5 | none |
| code | 10 | 5 | none; 7 are only anchors (`#News-id`), 3 are the fundraising thermometers, 1 a pasted table |
| marquee (scrolling text) | 5 | 5 | none |
| embed | 1 | 1 | none; a Google Form on `/contact` |
| contact form | 1 | 1 | none |
| newsletter signup | 1 | 1 | none; shows "needs a storage option", so it likely saves nothing |
| accordion | 1 | 1 | none; the newsletter archive on `/news` |
| summary + calendar | 1 each | 1 | none; the events band on `/news` |
| gallery, image layout, shape | 1 each | 1 | `::figure` covers them |

Not used anywhere: video, maps, quotes, Instagram, audio, countdowns, lightboxes, comments, share buttons.

### Sections

445 sections. Section themes: white-bold 153, dark 143, white 127, and a few black, light, and dark-bold. 147 have a wavy bottom edge, and 134 of those are empty spacer bands that separate the other sections. Only 9 have background images; none have video or animation. Images are sometimes masked to a circle or a "TV" shape.

Recurring arrangements, by count:

| Pattern | Count | Where |
| --- | --- | --- |
| wave spacer band | 134 | nearly every page |
| stacked centred article: title, image, body | 53 | recipes, board members, some FFT |
| image beside text | 40 | about, join, member-owners, important news |
| long-form article | ~20 | Food for Thought |
| hero on a background photo with heading, text, 1–2 buttons | 6 | home, join, news, buildbackbetter |
| collection grid, 3 columns, title on hover | 5 | every portfolio index |
| marquee band | 5 | home, about, join, get-involved, capitalstack |
| three cards + button | 3 | news (recipes, FFT, press) |
| fundraising thermometer row | 2 | get-involved, capitalstack |
| sponsor logo wall | 2 | get-involved, capitalstack |
| one each | | collage of round photos (home), icon grid 4×2 (join), board people grid 4×4 (about), card carousel (home), FAQ stack of 14 plain text blocks (faqs), contact text + form, events band, newsletter band |

### Collections

No collection uses tags or categories, and none has date or author fields except events and the NYS blog.

- **Events**: title, date, start and end time, optional address with a map link (12 of 116), Google Calendar and ICS links, one body block, previous and next. The index shows 30 past events with no way to reach older ones. 0 upcoming. Recurring events were made by duplicating items: 42 items share 11 base names, and 14 have random 30-character slugs.
- **Food for Thought, recipes, member-owners, board, important news**: title, cover image, body, previous and next. Index is a square image grid with titles on hover. Recipe contributors are typed into the title.
- **NYS grant answers**: a list with image, author, date, excerpt, and Read More.
- **News** is a hand-built hub page: three press cards, the events band, Member-Owner of the Month, three recipe cards, three FFT cards, and the newsletter band. Every card is copied in by hand.
- The board appears twice: the collection, and a hand-built photo grid on `/about` that has one person the collection lacks. Member-owners appear three times: the collection, the home carousel, and the news band.

### Theme

Fonts are Adobe Fonts: "new-spirit" for headings and buttons, "adonis-web" for body text. Decided 2026-10-22: use fonts already installed on the reader's device, with no font files downloaded. Both Squarespace fonts are serifs, so the co-op theme sets `--rkr-prose-font` to the stack `default.css` already uses (`ui-serif, Georgia, "Times New Roman", Times, serif`) and `--rkr-display-font` to a serif stack too (for example `ui-serif, Charter, "Bitstream Charter", Cambria, Georgia, serif`) instead of the default theme's system sans. The pages will look plainer than with "new-spirit" headings. A web font is added only where a system font cannot do the job, and then it comes from Fontsource (the `@fontsource/<font>` npm packages, SIL Open Font License). Its `woff2` files are copied into the theme and served from the site itself, never from a CDN, so no third party sees readers' requests. Shared CDNs give no speed benefit since browsers began caching per site. Colors: lime `hsl(69.39,100%,35.1%)`, dark green `hsl(132.27,37.93%,22.75%)`, aubergine `#51284e`. Pill-shaped buttons. Maximum width 1800px, side padding 6vw.

## Parts

### 1. Site chrome from settings

The header and footer templates gain slots filled from `config/site.json`, edited on the settings page by the owner role:

- logo image (an image id, rendered through the image pipeline)
- menu: an ordered list of label and target (a page, a listing page, or a URL); flat
- call-to-action button: label and target
- social accounts: platform and URL; bundled SVG icons
- announcement bar: text, optional link, on/off; closing it is remembered in the reader's browser
- footer: address and phone, a list of links, and up to three buttons
- fixed header on/off; full-screen menu on phones

Templates own the structure; themes style it through new class hooks added to `docs/theming.md` in the same change, as that contract requires. The Login/Logout slot becomes a plain editor link under static publishing.

### 2. Sections

A section is a container directive (`:::section … :::`) with:

- theme: `light`, `light-bold`, `dark`, `dark-bold`, mapped to theme tokens, not free colors
- optional background image (an image id)
- bottom edge: `straight` or `wave`
- layout, one of:
  - `stack`: blocks one under another, centred (covers the stacked article and long-form patterns)
  - `split`: image on one side, the rest on the other, side chosen per section
  - `hero`: full-width background photo with heading, text, and buttons over it
  - `columns`: 2, 3, or 4 equal columns
  - `band`: a single full-width line, for a marquee or a call to action

The 134 empty wave spacer bands become the `wave` bottom edge of the section above, not sections of their own.

Free positioning (Fluid Engine) is not copied. Pages look more regular than on Squarespace; in exchange they work on phones without per-device adjustments, and a non-technical editor cannot break the layout.

Container directives are the same mechanism as the deferred "Container directive for galleries" item in backlog group 4; building it once serves both.

### 3. Listing block

`::list{tag="board" layout="grid" sort="order" limit=…}` renders one card per page that has the tag, at build time: the page's cover image, title, and summary.

- Layouts: `grid` (the square hover grid), `cards` (image, title, summary, link), `list` (image beside title, date, excerpt), `carousel`.
- Sort: `order` (a per-page sort field, for officers first), `title`, `date`, or `start` for events.
- `limit` shows only the newest few, for hub pages like `/news`.
- Tags marked as collections in settings keep their pages out of the home index and feed. Each such page gets "Back to <listing>" and previous/next links within the tag, and its own RSS feed.

Editor preview: `/admin/view/:slug` renders in the browser from the editor's local copy, which holds one post and its image sidecars (`/admin/post-bundle/:slug`). A listing needs every other page with the tag, which that copy does not have. Online, the preview asks a new editor endpoint (for example `GET /admin/listing?tag=board`) for the cards, rendered by the same code the build uses. Offline, it shows a placeholder naming the tag and the last known page count. Decided 2026-10-22: the placeholder is enough, and the offline bundle stays as it is.

This replaces every hand-copied card set found in the inventory: the five collection grids, the board grid on `/about`, the home carousel, the three-card bands and Member-Owner of the Month on `/news`, and the NYS blog list. Adding a board member becomes: create a page, apply the `board` tag, publish.

### 4. Events

An event is a page with the `event` tag and extra fields: start and end date and time, optional location (name, address), and optional repeat dates.

- The event page shows date, time, location with a map link, and Add to Google Calendar and ICS links. The ICS file is generated at build time.
- `::list{tag="event" sort="start"}` splits into upcoming and past, with pagination so older events stay reachable.
- Repeat dates on one event replace the duplicated items (the Greenmarket appears 6–7 times today). Whether that fits how the co-op schedules events is an open question.
- A site-wide ICS feed lets the Nextcloud store calendar subscribe to public events.

### 5. Smaller blocks

| Block | Replaces | Notes |
| --- | --- | --- |
| button | 15 buttons, plus footer and hero buttons | label, target, `primary`/`secondary`, size; pill shape from the theme |
| marquee | 5 scrolling bands | text, speed; stops for readers who ask for reduced motion |
| accordion | the newsletter archive; the FAQ page could use it too | items of title and body, one open at a time |
| progress | the carrot thermometers | goal and raised amounts held once in settings, so every page shows the same figure (they disagree today: $747,485 and $429,085); image chosen by the theme |
| embed | the Google Form on `/contact` | allowlisted URLs only (Google Forms, YouTube, Vimeo, maps); no pasted HTML or scripts |
| image mask | circle and TV-shaped photos | a `mask` attribute on `::figure` |
| anchor | the 7 anchor-only code blocks | an `id` attribute on a section or heading |

The icon grid, sponsor logo wall, and photo collage are `::figure` grids or a `columns` section of small images, so they need no block of their own.

### 6. Forms

Static publishing has no server to receive a form, so:

- **Contact form**: replace with a Google Form or Nextcloud Forms link, or route it through the optional comment service as a second endpoint with the same honeypot, rate limit, and spam check, mailing the co-op. Open question.
- **Newsletter signup**: Mailchimp's own embed form posts to `list-manage.com` and works on a static page. The current Squarespace block likely saves nothing.

### 7. Page metadata

The build emits, per page: meta description and `og:description` from a summary field (only 36 of 260 pages have one today), `og:image` from the cover image with the logo as default, and JSON-LD for the organization. The editor warns when an image has no alt text (216 images lack it today).

### 8. No outside scripts

Decided 2026-10-22: the HubSpot script (`js-na1.hs-scripts.com/49028473.js`, on every page) is removed. On 2026-10-22 it loaded HubSpot's visitor analytics (`js.hs-analytics.net/analytics/…/49028473.js`) and its cookie banner (`js.hs-banner.com/v2/49028473/banner.js`); it did not load chat, form capture, or an ad pixel. With system fonts too, published pages load nothing from outside the site except embeds an editor adds.

## Found during the inventory

Fix during import, not in rkr-blog:

- strip Mailchimp tracking from 355 pasted links (`list-manage.com/track/click`, `mc_cid`, `mc_eid`)
- merge or retire the 42 duplicated events and give the 14 random slugs real ones
- broken links: `/why-a-community-owned-grocery-store/` (from `/where`) and `/services` (from the home carousel)
- drop template leftovers: `/digital-products-3-1`, the "It all begins with an idea" block on `/memberships`, `blog-post-title-*` slugs, the empty `/shop/memebership` category
- copy the fiscal-sponsor donation PDF off Squarespace's CDN
- redirect old Squarespace URLs, `/homepage`, and the apex domain

Commerce is outside this proposal. Notes for whoever replaces it: the membership checkout asks for name, phone, email, a required bylaws checkbox, and who referred the member. Tier 1 has six fixed amounts from $25 to $1999, Tier 2 nine amounts with about 3.3% added (probably card fees), and sponsorships four levels from $1k to $10k. The four merch items have stock counts, and the tee has six sizes.

## Open questions

- Is the cart in the header still needed once merch and memberships move off Squarespace?
- Contact form: outside form, or an endpoint on the comment service?
- Do repeat dates on one event match how the co-op runs recurring events?
- Should the co-op theme live in `static/themes/` or in the deployment's site root?
- Screenshots were not taken (Playwright could not find Chrome). Confirm the section patterns visually before designing the layouts.
