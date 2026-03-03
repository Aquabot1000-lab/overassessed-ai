# OverAssessed.ai — End-to-End Flow Test Report

**Date:** March 3, 2026  
**Tested by:** AquaBot (automated E2E)  
**Site:** https://overassessed.ai  
**Environment:** Production (Railway)

---

## Summary

| Severity | Count |
|----------|-------|
| 🔴 Critical | 2 |
| 🟠 High | 3 |
| 🟡 Medium | 4 |
| 🔵 Low | 3 |

---

## 🔴 CRITICAL Issues

### C1. Server Route Nesting Bug — `/calculator`, `/terms`, `/pre-register` routes malformed

**File:** `server/server.js` lines 1562–1577  
**Steps:** Visit `https://overassessed.ai/calculator`  
**Expected:** Calculator page loads  
**Actual:** Homepage loads (catch-all serves `index.html`)

**Root Cause:** Route handlers are nested inside each other due to missing closing braces:
```javascript
app.get('/pre-register', (req, res) => {
// ← EMPTY, no sendFile, no closing brace

app.get('/privacy', (req, res) => {
    res.sendFile(path.join(__dirname, '../', 'privacy.html'));
});

app.get('/terms', (req, res) => {
// ← EMPTY again

app.get('/calculator', (req, res) => {
    res.sendFile(path.join(__dirname, '../', 'calculator.html'));
});
    res.sendFile(path.join(__dirname, '../', 'terms.html'));  // orphaned
});
    res.sendFile(path.join(__dirname, '..', 'pre-register.html'));  // orphaned
});
```

**Impact:** 
- `/calculator` — shows homepage instead of calculator (**footer link broken**)
- `/pre-register` — WORKS on production (Express static middleware serves `pre-register.html` before the route), but the route itself is broken
- `/terms` — same situation, may work via static but route is invalid

**Fix:** Properly close each route handler:
```javascript
app.get('/pre-register', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'pre-register.html'));
});
app.get('/privacy', (req, res) => {
    res.sendFile(path.join(__dirname, '../', 'privacy.html'));
});
app.get('/terms', (req, res) => {
    res.sendFile(path.join(__dirname, '../', 'terms.html'));
});
app.get('/calculator', (req, res) => {
    res.sendFile(path.join(__dirname, '../', 'calculator.html'));
});
```

### C2. 10 County Pages Show Homepage Instead of County Content

**Steps:** Click any of these footer links: Collin, Denton, Fort Bend, Williamson, Montgomery, El Paso, Hidalgo, Guadalupe, Comal, Hays  
**Expected:** County-specific landing page  
**Actual:** Homepage loads (catch-all)

**Root Cause:** Only 5 counties have root-level routes (`/bexar-county`, `/harris-county`, `/travis-county`, `/dallas-county`, `/tarrant-county`). The other 10 only have `/lp/` routes but footer links point to root paths (`/collin-county`, etc.).

**Missing routes for:**
- `/collin-county`
- `/denton-county`
- `/fort-bend-county`
- `/williamson-county`
- `/montgomery-county`
- `/el-paso-county`
- `/hidalgo-county`
- `/guadalupe-county`
- `/comal-county`
- `/hays-county`

**Fix:** Add routes for all 10 missing counties, or change footer links to `/lp/` paths.

---

## 🟠 HIGH Issues

### H1. OG Image Uses Railway Domain Instead of overassessed.ai

**Location:** `index.html` line 14  
**Current:** `https://disciplined-alignment-production.up.railway.app/assets/logo/icon-512.png`  
**Expected:** `https://overassessed.ai/assets/logo/icon-512.png`  
**Impact:** Social sharing preview image may break if Railway URL changes. Looks unprofessional.

### H2. Manifest Icon Fails to Load

**Console Warning:** `Error while trying to use the following icon from the Manifest: https://overassessed.ai/icons/icon-192.png (Download error or resource isn't a valid image)`  
**Impact:** PWA install prompt may fail; mobile "Add to Home Screen" will show generic icon.  
**Note:** Files exist in `/icons/` directory — may be a format/corruption issue.

### H3. Exemption Type Dropdown May Confuse Users

**Page:** `/exemptions`  
**Steps:** Select state "Texas", look at Exemption Type dropdown  
**Observation:** Options use `<optgroup>` tags to group TX/GA exemptions. The dropdown shows ALL exemptions (TX + GA) regardless of state selection. Users might accidentally pick a GA exemption when they selected Texas.  
**Suggestion:** Filter exemption options based on selected state via JavaScript.

---

## 🟡 MEDIUM Issues

### M1. Homepage Hero Savings Shows "$0" Before Animation

**Steps:** Load homepage  
**Expected:** Shows "$2,847" immediately or starts hidden  
**Actual:** Counter starts at "$0" and animates up. Brief "$0" display next to "per Texas homeowner" looks like no savings.  
**Suggestion:** Start counter at a non-zero value or hide until animation begins.

### M2. Homepage Nav Uses Relative Paths for Some Links

**Location:** Homepage nav  
**Current:** `href="exemptions.html"` and `href="referrals.html"`  
**Expected:** `href="/exemptions"` and `href="/referrals"`  
**Impact:** Would break on sub-paths. Inconsistent with other links using absolute paths.

### M3. Referral Flow — No Visible Acknowledgment for Referred Users

**Steps:** Visit `https://overassessed.ai/?ref=OA-59986795`  
**Expected:** Banner or message acknowledging referral  
**Actual:** Homepage looks identical. The `ref` param is silently captured in JS and passed with form submission, but the user has no idea they arrived via referral.  
**Suggestion:** Show a banner like "Referred by a friend! You're all set."

### M4. Pre-Register Count Shows "1"

**Page:** `/pre-register`  
**Text:** "Join **1** homeowners already pre-registered"  
**Expected:** Dynamic count or realistic number  
**Actual:** Shows "1" — looks broken or like nobody uses the service

---

## 🔵 LOW Issues

### L1. Stripe Live Key in Client JS

**File:** `app.js` line 120  
**Note:** Publishable keys are designed to be public (not a security issue). But test form submissions will create real Stripe customers.

### L2. Calculator "Get Started" Nav Link Goes Nowhere

**Page:** `/calculator.html`  
**Nav link:** "Get Started" has `href="#"` — does nothing  
**Fix:** Link to `/#intake-form`

### L3. Footer Missing "Refer & Earn" Link

**Observation:** Footer has county links, calculator, exemptions, pre-register, privacy, and terms — but no link to the referral program page.

---

## Flow Test Results

### ✅ Flow 1: Pre-Register (Homepage bottom section)
- Filled name, email, address, selected Bexar county, clicked submit
- **Result:** SUCCESS — Shows "You're Pre-Registered!" confirmation inline
- No redirect, stays on same page with form replaced by success message

### ✅ Flow 2: Pre-Register (Standalone `/pre-register` page)
- Page loads correctly with countdown ("~7 weeks until notices arrive")
- Has additional phone field vs homepage version
- Not tested submission (already verified via homepage)

### ⚠️ Flow 3: Full Intake (Homepage)
- Form at bottom of homepage with all fields visible
- Stripe card element renders correctly
- Card is optional — if blank or Stripe fails, form still submits
- **NOT fully tested** to avoid creating real Stripe customer
- **Form fields:** Address, property type (6 options), name, phone, email, assessed value, bedrooms, bathrooms, sqft, year built, renovations, conditions, appraisal, state (TX/GA), update preference, payment

### ✅ Flow 4: Exemption Intake
- Filled all required fields, selected TX Homestead, submitted
- **Result:** SUCCESS — Shows "Exemption Request Received!"
- All 9 exemption types available (TX: 5, GA: 4) via optgroups
- Document upload available (PDF, JPG, PNG)
- Cross-sell checkbox pre-checked for protest analysis

### ✅ Flow 5: Referral
- Entered name + email, clicked "Get My Referral Link"
- **Result:** SUCCESS — Generated `https://overassessed.ai/?ref=OA-59986795`
- Copy button available
- No referral tracking dashboard for referrer

### ✅ Flow 6: Calculator
- Entered $350K value in Bexar County, residential
- **Result:** $1,029 estimated savings
- **Math verified:** $350K × 12% reduction = $42K × 2.45% tax rate = $1,029 ✓
- Lead capture form appears below results
- **Only accessible at `/calculator.html`, NOT at `/calculator`** (see C1)

### ❌ Flow 7: County Pages (10 of 15 broken)
- **Working:** Bexar, Harris, Travis, Dallas, Tarrant
- **Broken (show homepage):** Collin, Denton, Fort Bend, Williamson, Montgomery, El Paso, Hidalgo, Guadalupe, Comal, Hays

---

## All Pages Status

| Page | Status | Notes |
|------|--------|-------|
| `/` (homepage) | ✅ | |
| `/pre-register` | ✅ | Works via static middleware |
| `/exemptions` | ✅ | |
| `/referrals` | ✅ | |
| `/calculator` | ❌ | Shows homepage (route bug) |
| `/calculator.html` | ✅ | Direct file works |
| `/privacy` | ✅ | |
| `/terms` | ✅ | Works via static middleware |
| `/bexar-county` | ✅ | |
| `/harris-county` | ✅ | |
| `/travis-county` | ✅ | |
| `/dallas-county` | ✅ | |
| `/tarrant-county` | ✅ | |
| `/collin-county` | ❌ | Shows homepage |
| `/denton-county` | ❌ | Shows homepage |
| `/fort-bend-county` | ❌ | Shows homepage |
| `/williamson-county` | ❌ | Shows homepage |
| `/montgomery-county` | ❌ | Shows homepage |
| `/el-paso-county` | ❌ | Shows homepage |
| `/hidalgo-county` | ❌ | Shows homepage |
| `/guadalupe-county` | ❌ | Shows homepage |
| `/comal-county` | ❌ | Shows homepage |
| `/hays-county` | ❌ | Shows homepage |

---

## Recommended Priority Fixes

1. **Fix server.js route nesting** (C1) — 5 min fix, deploy immediately
2. **Add 10 missing county routes** (C2) — 10 min fix
3. **Update OG image URL** (H1) — 1 min fix
4. **Debug manifest icon** (H2) — check PNG file validity
5. **Add referral acknowledgment banner** (M3) — UX improvement
6. **Fix pre-register count** (M4) — pull from DB or hardcode realistic number
