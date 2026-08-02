# Getting the contractor apps onto the App Store

A working plan for taking `contractor-estimator` and `field-log` from single HTML files to
listed apps. Written to be honest about cost, effort, and the two ways Apple is most likely to
reject this.

---

## The short version

| Phase | What | Cost | Effort |
| --- | --- | --- | --- |
| 1 | Make them installable web apps (PWA) | $0 | ~1 day |
| 2 | Merge into one app with two tools | $0 | ~2 days |
| 3 | Native wrap with Capacitor | $0 | ~2 days |
| 4 | Google Play listing | $25 once | ~2 days |
| 5 | App Store listing | $99/year | ~3 days + review |

Roughly **two to four weeks part-time**, and about **$125 in year one**.

**Do phase 1 now. Hold phases 3–5 until someone who is not you is using the thing.** A store
listing is a distribution channel, and contractors do not find tools by browsing the App Store —
they find them because someone handed them a phone. Phase 1 gets you an icon on a home screen
this week for nothing.

---

## Phase 1 — Installable web apps

Both files already work offline and store everything on the device. Three additions make them
installable, and none of it is throwaway — phase 3 builds on all of it.

**What gets added**

- `manifest.webmanifest` — app name, theme colour (`#16301F`), background, display `standalone`,
  and an icon set. Standalone display is what removes the browser chrome so it opens like an app.
- A service worker that caches the single HTML file. The apps have no network calls, so the
  worker is close to trivial: cache on install, serve from cache, done.
- Icons at 192, 512, and 1024 px, plus `apple-touch-icon` at 180. Needed here and again in
  phases 4 and 5, so make them once and properly.

**Hosting.** GitHub Pages, Cloudflare Pages, or Netlify — free, https, and https is required for
both service workers and geolocation. A custom domain is optional and cheap.

**How it installs.** Android offers a real install prompt. iOS requires Share → Add to Home
Screen, which nobody discovers on their own, so the page needs a one-line hint telling them to
do it. Once added, it launches full screen, works with no signal, and keeps its data.

**What you get:** a home-screen icon, offline operation, GPS, and a URL you can text. For
handing to a contractor in a parking lot this is genuinely most of the value of a store listing.

---

## Phase 2 — One app, not two

Merge the estimator and the field log into a single app with a tool switcher.

Two reasons, and the second is the one that matters:

1. **A contractor wants one icon.** Quoting and daily logs are the same job — same company, same
   crew, same equipment list. Right now the roster is typed twice.
2. **Apple's Guideline 4.3 treats multiple similar apps from one developer as spam.** Two
   contractor tools with shared code and shared design, submitted from the same account, is
   exactly the pattern that rule targets. One app with two sections is not.

The merge is mostly mechanical — both already share a design system and a storage pattern. The
real work is unifying company setup, the crew roster, and the equipment list so they are entered
once and used by both.

---

## Phase 3 — Native wrap (Capacitor)

Capacitor puts the web app inside a native shell and gives it real native APIs. This is the step
that turns "a website in a box" into something defensible.

**Swap the browser APIs for native plugins:**

| Now | Becomes | Why it matters |
| --- | --- | --- |
| `navigator.geolocation` | `@capacitor/geolocation` | Proper permission prompts, better accuracy, background-safe |
| `<a download>` for KMZ | `@capacitor/filesystem` + `@capacitor/share` | Downloads are awkward in a WebView; Share sheet is how you actually send a KMZ or a PDF |
| `localStorage` | `@capacitor/preferences` | Survives WebView storage eviction — iOS *will* clear localStorage under storage pressure |

That last row is not cosmetic. iOS clears localStorage for apps that have not been opened in a
while. For a field log that is a data-loss bug, and it becomes a real one the moment this is a
native app people trust.

**Also add:** native file picker for backup import/export, and a proper share sheet for the quote
PDF. Both are things a website genuinely cannot do well, which is the point.

**Build machine.** iOS builds need Xcode, which needs macOS. If you do not have a Mac: cloud CI
(Codemagic, Expo EAS) builds and signs without one, on a usable free tier. Renting a cloud Mac
runs about $30/month if you would rather drive Xcode directly.

---

## Phase 4 — Google Play first

Cheaper, faster, and a lower-stakes place to find out what breaks.

- **$25, one time, forever.**
- Needs: signed AAB, store listing, feature graphic, screenshots, privacy policy URL, content
  rating questionnaire, and a data-safety form.
- **Check the current testing requirement.** New *personal* developer accounts have had to run a
  closed test with a group of testers for a continuous period before production release;
  organisation accounts have not. This rule has changed more than once — read the current console
  requirements before you plan a launch date around it.

Ship here first. Fix whatever the first real users hit. Then go to Apple with a version that has
already survived contact.

---

## Phase 5 — App Store

**Account.** Apple Developer Program, **$99/year**, renewed or the apps come down. Individual
enrolment needs no D-U-N-S; a company enrolment does.

**What the listing needs**

- App icon at 1024×1024, no transparency, no rounded corners (Apple rounds it)
- Screenshots for current required device sizes — Apple changes these; check App Store Connect
  rather than trusting any list, including this one
- Name (30 chars), subtitle (30), description, keywords (100), support URL
- **Privacy policy URL — required even though you collect nothing**
- Privacy nutrition label: **Data Not Collected**, which is true and is also a selling point
- Category: Business, or Productivity

**The 4.2 problem, and how to answer it**

Apple rejects apps that are "a repackaged website." Expect the question. The honest answer is
strong, so make it explicitly in the review notes:

- Works with **no network at all** — not a degraded offline mode, no server exists
- Uses **GPS** to walk a property boundary and compute acreage
- **Generates files** (KMZ, PDF) and hands them to the system share sheet
- **Stores everything on-device**; nothing is transmitted anywhere

Give the reviewer a demo account note explaining there is no login and no server, and point them
at the `#demo` data so they see a filled-in app in three seconds rather than an empty one. A
reviewer who opens a blank screen rejects it.

**Do not** submit a thin wrapper with none of phase 3 done. That is the version that gets
rejected, and a rejection costs you a week.

**Review time** is usually a day or two now, but budget for at least one rejection and one
resubmission.

---

## If you want it to make money

- **Paid up front.** Simplest. Contractors will pay $20–50 once for something that saves an
  evening of quoting. No subscription plumbing, no server, nothing to maintain.
- **Free with a one-time unlock.** Free version does one estimate; unlock is an in-app purchase.
  Better conversion, more code.
- **Avoid a subscription.** There is no server and no ongoing cost, so a subscription is hard to
  justify to a buyer who can tell there is nothing to host.

Apple and Google both take **15%** under their small-business programmes (under $1M/year), not
30%.

---

## Order of operations

1. Icons and manifest → installable, hosted, textable. **This week.**
2. Put it in front of one contractor. Fix what they hit.
3. Merge to one app.
4. Capacitor + native storage, geolocation, and share.
5. Google Play.
6. App Store.

Steps 3 through 6 are only worth the money and the weeks once step 2 has told you the thing is
wanted. Everything before that is free.
