[README.md](https://github.com/user-attachments/files/31180423/README.md)
# SEVEN — Critical Path Dashboard

A standalone dashboard for tracking the Madina SEVEN critical path. You own every file here — there's no account, no third-party builder, and no backend. It's just three files that run entirely in the browser.

## Files

- `index.html` — page structure
- `app.js` — reads your Excel file and draws every chart
- `logo.png` — your logo
- (styling lives inside `index.html` in a `<style>` block)

## How it works

Click **"Update from Excel"** (or drag a file onto the upload area) and pick your tracker file. It reads the **"Critical Path"** tab specifically — the same one your current dashboard uses — and expects these columns: `Department`, `Label`, `Start Date`, `End Date`, `Status`, `Key Milestone (Y/N)`, `Owner`, `Items`, `Complete`, `In-Progress`, `Starting Date Delayed`, `Completion Date Overdue`, `Not Started Yet`. It also looks anywhere in the workbook for a cell literally labeled "Opening Date" to drive the countdown.

Nothing is uploaded anywhere — the file is parsed on your own machine in memory, so this is safe to use with confidential project data.

## What's on the page

1. **Critical Path — Track to Opening**: one runway bar for overall % complete (today → opening day), then a card per department, each with its own progress ring and an "At risk" tag when that department has delayed starts or overdue completions.
2. **KPI cards**: Total Items, Completed, In Progress, Not Started, Start Delayed, Completion Overdue.
3. **Tasks per Department**: each column is a full 0–100% scale, split into Complete / In Progress / Pending, with % complete above and the item count below.
4. **Key Milestones**: anything flagged `Y` in the Key Milestone column.
5. **Department Timeline**: full-width Gantt-style bars, with the scale running all the way through to opening day (not just to the last dated task) and a teal line marking opening day.
6. **Donuts**: status, start-time, and completion breakdowns.
7. **Departments Readiness per Owner**: % of items **started** (complete + in progress) by department × owning team. Hover a cell for the raw counts.

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
1. Create a new repository on GitHub and push these three files/folders to it.
2. In the repo, go to Settings → Pages.
3. Under "Source," choose the `main` branch and `/ (root)`, then save.
4. Your site will be live at `https://<your-username>.github.io/<repo-name>/` within a few minutes.
5. To use your own domain: add a `CNAME` file with your domain name, and point your domain's DNS to GitHub Pages per their docs.

Either way, updating the site later just means editing these files and re-uploading/re-pushing them — no rebuild step, no dependencies to install.

## Customizing

- **Colors**: all defined as CSS variables at the top of the `<style>` block in `index.html` (`--teal`, `--orange`, `--magenta`, `--blue`, etc.) — change one value and it updates everywhere.
- **Departments**: the order and colors are set in `DEPT_ORDER` and `DEPT_COLORS` at the top of `app.js`. Add or reorder department names there if your project structure changes.
- **Logo**: just replace `logo.png` with a new file of the same name.
