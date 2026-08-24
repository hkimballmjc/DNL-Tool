# DNL Site Assessment Tool

A static, browser-only tool that speeds up HUD Day/Night Noise Level (DNL)
concept package work: it does the road/rail DNL math per HUD's published
algorithm, and pulls AADT (TX/OK/TN/AR), posted speed limits, and FRA rail
crossing data automatically where possible.

## ⚠️ Before you rely on this for a real submission

1. **Heavy truck EADT factor ("Table 8")** — HUD's published algorithm
   references a factor table for heavy trucks that isn't reproduced in the
   public flowchart summary I built this from. The code currently uses a
   placeholder (factor = 1.0). **Confirm this against a known result from
   HUD's live calculator before trusting heavy-truck-heavy results.** See
   the comment block at the top of `js/dnl-calc.js`.
2. **Railway horns / bolted track adjustments** — accepted as future inputs
   but not yet applied. Same caution applies.
3. **State AADT endpoints** — `js/aadt-lookup.js` has the state DOT dataset
   *landing pages* but needs the exact `FeatureServer` REST URL pasted in
   for TX/OK/TN/AR (see comments in that file for how to find them — takes
   about 2 minutes per state).
4. **FRA rail lookup and Overpass speed lookup** are wired to real, live
   public endpoints and should work as-is, but double-check the FRA field
   names returned (`RAILROAD`, day/night traffic fields) match what you see
   in a first real query, since FRA's schema has changed over the years.

None of this blocks getting started — the site works today for manual entry
and does all the math instantly. The above are the automation pieces to
verify/finish before trusting the automated data pulls.

## What's in this repo

```
dnl-tool/
├── index.html          # main page
├── style.css
├── app.js              # wires the UI to the calculation modules
├── js/
│   ├── dnl-calc.js      # core HUD DNL formulas (road + rail)
│   ├── aadt-lookup.js   # state AADT lookups (TX/OK/TN/AR)
│   ├── rail-lookup.js   # FRA crossing inventory lookup
│   ├── speed-lookup.js  # OpenStreetMap posted speed limit lookup
│   └── summary.js       # generates the exportable mitigant paragraph
└── README.md
```

## Setting up the GitHub repo (starting from scratch)

1. **Create the repo on GitHub**
   - Go to [github.com/new](https://github.com/new)
   - Name it something like `dnl-tool`
   - Leave it **Public** (required for the free GitHub Pages hosting) or
     Private if you have a paid plan that supports Pages on private repos
   - Don't initialize with a README (you already have one) — just click
     **Create repository**

2. **Push these files up.** On your computer, open a terminal in this
   folder and run:
   ```bash
   git init
   git add .
   git commit -m "Initial DNL tool"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/dnl-tool.git
   git push -u origin main
   ```
   (Replace `YOUR-USERNAME` with your actual GitHub username. If you don't
   have `git` installed, GitHub's web UI also lets you drag-and-drop these
   files directly into a new repo — no command line needed.)

3. **Turn on GitHub Pages**
   - In the repo, go to **Settings → Pages**
   - Under "Build and deployment," set **Source** to `Deploy from a branch`
   - Set **Branch** to `main` and folder to `/ (root)`
   - Click **Save**
   - After a minute or two, GitHub will show you a live URL like
     `https://YOUR-USERNAME.github.io/dnl-tool/` — that's your site.

4. **Every future update** is just:
   ```bash
   git add .
   git commit -m "describe what changed"
   git push
   ```
   GitHub Pages redeploys automatically within a minute.

## Finding the exact AADT FeatureServer URL for a state

1. Open the dataset landing page (linked in `js/aadt-lookup.js`)
2. Look for a button labeled **"View API Resource"**, **"I want to use
   this"** → **API**, or similar
3. Copy the URL — it'll end in something like `.../FeatureServer/0`
4. Paste it into the matching `featureServerUrl` in `js/aadt-lookup.js`

## Confirming the heavy truck Table 8 factor

Fastest way: open HUD's live calculator
(https://www.hudexchange.info/programs/environmental-review/dnl-calculator/),
add one road source with **only heavy trucks checked**, plug in a known
speed/distance/ADT, and note the resulting DNL. Send me that result and I
can back-solve the missing factor and correct `js/dnl-calc.js` in one pass.
