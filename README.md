# SEVEN Dashboards

Three dashboards for the Madina SEVEN opening, sharing one look. You own every file here — there's no account, no third-party builder, and no backend. Everything runs in the browser.

## Files

| File | What it is |
|---|---|
| `home.html` | The index page — the three dashboards, nothing else |
| `index.html` | Critical Path dashboard (page structure + its own styles) |
| `app.js` | Reads the Critical Path Excel file and draws every chart on it |
| `visualizer.html` / `visualizer.js` | Drop in any spreadsheet, get a dashboard |
| `discovery.html` / `discovery.js` | Same, but recognised files get a dedicated template |
| `engine.js` | The shared chart engine behind Visualizer and Discovery |
| **`seven.css`** | **The design system — colours, type and every shared component, for all four pages** |
| `logo.png` | The SEVEN mark, on a transparent background |

`seven.css` is the file to edit when you want to change how the whole site looks. Each page adds only the styles that are unique to it.

## Design

The palette is sampled from `logo.png`, so the site and the mark are literally the same colours:

| Token | Hex | Where it comes from |
|---|---|---|
| `--navy` | `#12406F` | the blue arm — primary buttons, the countdown |
| `--cyan` | `#0092AC` | the light-blue arm — progress, single-series charts |
| `--magenta` | `#D6004E` | the pink arm — at-risk, delayed, opening day |
| `--amber` | `#C98A00` | the yellow flecks — in progress |
| `--green` | `#00874A` | the green arm — complete |
| `--coral` | `#E4572E` | the red-orange leg — overdue |
| `--violet` | `#7A4DA0` | the purple flecks — 7th series |

The page sits on warm paper (`--paper #F7F5F0`) with white cards, so colour only ever appears where it means something. Type is **Archivo** for text and **IBM Plex Mono** for every number and label.

The categorical order above (cyan → magenta → amber → green → navy → coral → violet) is checked for colour-blind separation and contrast against white. Assign series in that order; don't shuffle it.

## How it works

Click **"Update from Excel"** (or drag a file onto the upload area) and pick your tracker file. It reads the **"Critical Path"** tab specifically — the same one your current dashboard uses — and expects these columns: `Department`, `Label`, `Start Date`, `End Date`, `Status`, `Key Milestone (Y/N)`, `Owner`, `Items`, `Complete`, `In-Progress`, `Starting Date Delayed`, `Completion Date Overdue`, `Not Started Yet`. It also looks anywhere in the workbook for a cell literally labeled "Opening Date" to drive the countdown.

Nothing is uploaded anywhere — the file is parsed on your own machine in memory, so this is safe to use with confidential project data.

## What's on the page

1. **Critical Path — Track to Opening**: one runway bar for overall % complete (today → opening day), then a card per department, each with its own progress ring and an "At risk" tag when that department has delayed starts or overdue completions.
2. **KPI cards**: Total Items, Completed, In Progress, Not Started, Start Delayed, Completion Overdue.
3. **Tasks per Department**: each column is a full 0–100% scale, split into Complete / In Progress / Pending, with % complete above and the item count below.
4. **Department Timeline**: full-width Gantt-style bars, with the scale running all the way through to opening day (not just to the last dated task) and a magenta line marking opening day.
5. **Donuts**: status, start-time, and completion breakdowns.
6. **Departments Readiness per Owner**: % of items **started** (complete + in progress) by department × owning team. Hover a cell for the raw counts.

## Running it locally

You can just double-click `index.html` and it'll open in your browser. For the file upload to work reliably in every browser, it's better to serve it locally:

```bash
cd seven-dashboard
python3 -m http.server 8000
```

Then open `http://localhost:8000` in your browser.

## Publishing it for free (so it has a real URL)

**Option A — Vercel (recommended, easiest)**
1. Create a free account at vercel.com
2. Install the CLI: `npm install -g vercel`
3. From inside the `seven-dashboard` folder, run: `vercel`
4. Follow the prompts (accept the defaults) — you'll get a live URL in under a minute.
5. To use your own domain later: Vercel dashboard → your project → Settings → Domains.

**Option B — GitHub Pages**
1. Create a new repository on GitHub and push these files to it.
2. In the repo, go to Settings → Pages.
3. Under "Source," choose the `main` branch and `/ (root)`, then save.
4. Your site will be live at `https://<your-username>.github.io/<repo-name>/` within a few minutes.
5. To use your own domain: add a `CNAME` file with your domain name, and point your domain's DNS to GitHub Pages per their docs.

Either way, updating the site later just means editing these files and re-uploading/re-pushing them — no rebuild step, no dependencies to install.

## Customizing

- **Colours and type**: every token is at the top of `seven.css` under `:root`. Change one value there and it updates on all four pages.
- **The one line on the home page**: `home.html`, inside `<h1>` in the `.masthead` block.
- **Departments**: the order and colours are set in `DEPT_ORDER` and `DEPT_COLORS` at the top of `app.js`. Add or reorder department names there if your project structure changes.
- **Chart colours**: `PALETTE` at the top of `engine.js`. Single-measure bar charts deliberately use one hue (`SERIES_HUE`) — colouring those bars individually would encode rank, which means nothing.
- **Logo**: just replace `logo.png` with a new file of the same name.

## Visualizer (editable dashboard builder)

Alongside the Critical Path dashboard there's a second page, **`visualizer.html`**, that reads *any* Excel or CSV and builds a dashboard you can then edit yourself.

- **`home.html`** — launcher with two doors: Critical Path Dashboard and Visualizer.
- **`visualizer.html`** + **`visualizer.js`** — the builder.

Drop in a spreadsheet and it detects each column's type (text / number / date) and generates a starting dashboard. From there you control everything:

- **+ Add chart** — pick from 18 types: KPI number, gauge, countdown, deadlines list, bar, horizontal bar, stacked bar, combo (bars + line), line, area, donut, pie, treemap, funnel, waterfall, heatmap table, progress bars, table.
- **Per chart** (hover the card): edit ✎, duplicate ⧉, move ◀ ▶, remove ✕.
- **In the editor**: chart type, title, group-by column, split-by column (for stacked), measure (count / sum / average / min / max) and which column to measure, size (quarter / half / full width), how many items to show, and sort order.
- **Name the dashboard** — click the big title and type.
- **↻ Auto-rebuild** regenerates the automatic starting layout.
- **⎙ Print / PDF** produces a clean printable version with the editing controls hidden.

Your layout and title are remembered per file and sheet, so reopening the same file brings your dashboard back exactly as you left it.

It works best on a clean table (one header row, one record per row). Everything runs in the browser — files never leave the machine. The Critical Path dashboard (`index.html` + `app.js`) is untouched.

## File map

| File | Purpose |
|---|---|
| `home.html` | launcher — three doors |
| `index.html` + `app.js` | Critical Path dashboard (hand-built for that file) |
| `visualizer.html` + `visualizer.js` | Visualizer — upload any file |
| `live.html` + `live.js` | Live — connected to SeaTable |
| `engine.js` | shared chart builder used by Visualizer and Live |
| `scripts/fetch_seatable.py` | SeaTable → `data/live.json` |
| `.github/workflows/refresh-data.yml` | scheduled refresh |
| `logo.png` | logo |

## Discovery Dashboard

A third page, **`discovery.html`**, replaces the old Live/SeaTable page. It works like the Visualizer (upload a file, get an editable dashboard) but checks the file's columns against a library of templates first.

Recognized shapes get a dedicated, hand-designed dashboard instead of a generic guess. Right now there's one template:

- **Maintenance & Certification** — matches any file with a missing-docs count and a recertification or frequency column. Shows a certification countdown, missing docs per item, recert status breakdown, and manufacturer-level totals.
- **Consumables & COGS Budget** — matches any file with a consumable item column plus a P&L/COGS classification. Shows item counts by area, COGS vs OPEX split, budget priority split, and a stacked breakdown. If Monthly/Annual Cost columns are actually filled in, it automatically switches from counting items to summing real SAR totals.

When a file matches, a "Template: ..." badge shows next to the file name. Anything that doesn't match a known shape falls back to the same smart auto-dashboard as the Visualizer.

New templates (consumables, etc.) get added to the `TEMPLATES` list at the top of `engine.js` as more sample files define their shape.

## Cross-filtering (Power BI style)

Click any bar, slice, treemap tile, funnel band, progress row, or table row on any chart, and every other chart on the page narrows to just the matching rows. KPIs recalculate, gauges move, and a banner at the top shows what's filtered with a **Clear filter** button. Click the same element again to clear. This works on both the Visualizer and the Discovery Dashboard.

## Gauge target

A gauge shows a value as a dial against a target. Set the target in the chart editor. Leave it blank and the target defaults to the unfiltered total, so with a filter active the gauge reads as "share of the whole".

## Analysis layer ("What the data shows")

Every uploaded file is now run through a statistical analysis engine before the dashboard is drawn. It profiles each numeric column (mean, median, quartiles, standard deviation, IQR outliers, skew, coefficient of variation) and surfaces ranked plain-language findings in a panel above the charts:

- **Compliance** — items past due, rows flagged expired/overdue, items with missing documents.
- **Pareto / concentration** — "X% of rows make up 80% of the total", so effort goes where it matters.
- **Outliers** — unusually high or low values worth checking.
- **Correlation** — numeric columns that move together (trivial unit-conversions like monthly vs annual are suppressed).
- **Shape** — skew, so you know when a few big values are pulling an average.
- **Data quality** — columns with lots of missing data, or all-zero columns still awaiting real values.

Findings are ranked by severity (red = high, orange = medium, teal = low) and the top six show in the panel. This is real statistics computed in the browser — no keys, no cost.
