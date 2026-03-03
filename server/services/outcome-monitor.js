/**
 * Outcome Monitor — Automatically detects appeal outcomes
 * 
 * Flow:
 * 1. After hearing date passes → status moves to "awaiting_result"
 * 2. Periodically checks county appraisal district websites for updated values
 * 3. If new assessed value < original → WON (auto-calculates savings, triggers invoice)
 * 4. If new assessed value >= original → LOST (auto-updates status)
 * 5. Also parses inbound emails for result notifications
 */

const { supabaseAdmin, isSupabaseEnabled } = require('../lib/supabase');
const { fetchPropertyData } = require('./property-data');

// County website scrapers for hearing results
const COUNTY_SCRAPERS = {
    'bexar': checkBexarCounty,
    'travis': checkTravisCounty,
    'harris': checkHarrisCounty,
    'dallas': checkDallasCounty,
    'tarrant': checkTarrantCounty,
    'comal': checkComalCounty,
    'guadalupe': checkGuadalupeCounty,
    'kendall': checkKendallCounty,
    'hays': checkHaysCounty,
    'williamson': checkWilliamsonCounty
};

/**
 * Main monitoring loop — call this on a schedule (e.g., every 6 hours)
 * Checks all appeals that are in hearing/awaiting_result status
 */
async function checkAllPendingOutcomes() {
    if (!isSupabaseEnabled()) return { checked: 0, updated: 0 };

    console.log('[OutcomeMonitor] Starting outcome check...');

    // Get appeals that need outcome checking
    const { data: appeals, error } = await supabaseAdmin
        .from('appeals')
        .select('*, properties(address, city, state, county, current_assessed_value, property_id_county), clients(name, email)')
        .in('status', ['hearing_scheduled', 'informal_hearing', 'formal_hearing', 'awaiting_result'])
        .order('hearing_date', { ascending: true });

    if (error) {
        console.error('[OutcomeMonitor] DB error:', error.message);
        return { checked: 0, updated: 0, error: error.message };
    }

    if (!appeals || appeals.length === 0) {
        console.log('[OutcomeMonitor] No pending appeals to check');
        return { checked: 0, updated: 0 };
    }

    let checked = 0;
    let updated = 0;
    const results = [];

    for (const appeal of appeals) {
        checked++;

        // Step 1: Auto-move to awaiting_result if hearing date has passed
        if (appeal.hearing_date && new Date(appeal.hearing_date) < new Date() && 
            appeal.status !== 'awaiting_result') {
            await supabaseAdmin
                .from('appeals')
                .update({ status: 'awaiting_result' })
                .eq('id', appeal.id);
            console.log(`[OutcomeMonitor] ${appeal.case_id || appeal.id}: Moved to awaiting_result (hearing date passed)`);
        }

        // Step 2: Check county website for new assessed value
        const county = (appeal.properties?.county || appeal.county || '').toLowerCase().replace(' county', '').trim();
        const propertyIdCounty = appeal.properties?.property_id_county;
        const originalValue = appeal.properties?.current_assessed_value;

        if (!county || !originalValue) {
            console.log(`[OutcomeMonitor] ${appeal.case_id || appeal.id}: Skipping — missing county or original value`);
            continue;
        }

        try {
            const scraper = COUNTY_SCRAPERS[county];
            let newValue = null;

            if (scraper && propertyIdCounty) {
                newValue = await scraper(propertyIdCounty);
            }

            // Fallback: try fetching via our property data service
            if (newValue === null && appeal.properties?.address) {
                try {
                    const propData = await fetchPropertyData(
                        appeal.properties.address,
                        appeal.properties.city || '',
                        appeal.properties.state || 'TX'
                    );
                    if (propData && propData.assessedValue && propData.assessedValue !== originalValue) {
                        newValue = propData.assessedValue;
                    }
                } catch (e) {
                    // Property data fetch failed — not critical
                }
            }

            if (newValue !== null && newValue !== originalValue) {
                const savings = originalValue - newValue;

                if (savings > 0) {
                    // WON — value was reduced
                    const state = (appeal.state || 'TX').toUpperCase();
                    const feePercent = appeal.our_fee_percent || (state === 'TX' ? 20 : state === 'GA' ? 25 : 20);
                    const taxRate = await getEstimatedTaxRate(county, state) || 0.025; // default 2.5%
                    const annualSavings = Math.round(savings * taxRate * 100) / 100;
                    
                    console.log(`[OutcomeMonitor] ✅ ${appeal.case_id}: WON — Value reduced from $${originalValue} to $${newValue} (savings: $${annualSavings}/yr)`);

                    await supabaseAdmin
                        .from('appeals')
                        .update({
                            status: 'won',
                            outcome: 'reduced',
                            savings_amount: annualSavings,
                            our_fee_percent: feePercent,
                            our_fee_amount: Math.round(annualSavings * (feePercent / 100) * 100) / 100
                        })
                        .eq('id', appeal.id);

                    // Update property with new value
                    await supabaseAdmin
                        .from('properties')
                        .update({ current_assessed_value: newValue })
                        .eq('id', appeal.property_id);

                    updated++;
                    results.push({
                        case_id: appeal.case_id,
                        outcome: 'won',
                        original: originalValue,
                        new_value: newValue,
                        annual_savings: annualSavings
                    });

                } else {
                    // LOST — value stayed same or increased
                    console.log(`[OutcomeMonitor] ❌ ${appeal.case_id}: LOST — Value unchanged or increased ($${originalValue} → $${newValue})`);

                    await supabaseAdmin
                        .from('appeals')
                        .update({
                            status: 'lost',
                            outcome: 'no_change',
                            savings_amount: 0,
                            payment_status: 'not_applicable'
                        })
                        .eq('id', appeal.id);

                    updated++;
                    results.push({
                        case_id: appeal.case_id,
                        outcome: 'lost',
                        original: originalValue,
                        new_value: newValue
                    });
                }
            }
        } catch (err) {
            console.error(`[OutcomeMonitor] Error checking ${appeal.case_id}:`, err.message);
        }
    }

    console.log(`[OutcomeMonitor] Done. Checked: ${checked}, Updated: ${updated}`);
    return { checked, updated, results };
}

/**
 * Get estimated property tax rate for a county
 */
async function getEstimatedTaxRate(county, state) {
    // SA area average tax rates (assessment value * rate = annual tax)
    const TX_RATES = {
        'bexar': 0.0247,
        'comal': 0.0195,
        'guadalupe': 0.0218,
        'kendall': 0.0175,
        'hays': 0.0215,
        'travis': 0.0198,
        'williamson': 0.0208,
        'harris': 0.0232,
        'dallas': 0.0218,
        'tarrant': 0.0238,
    };
    const GA_RATES = {
        'fulton': 0.0134,
        'dekalb': 0.0126,
        'gwinnett': 0.0120,
        'cobb': 0.0112
    };

    const rates = state === 'GA' ? GA_RATES : TX_RATES;
    return rates[county] || (state === 'GA' ? 0.012 : 0.025);
}

// ==================== County Scrapers ====================
// Each returns the new assessed value or null if not yet updated

async function checkBexarCounty(propertyId) {
    // BCAD (bcad.org) — check property detail page for current year value
    try {
        const url = `https://bexar.trueautomation.com/clientdb/Property.aspx?prop_id=${propertyId}`;
        const response = await fetch(url);
        if (!response.ok) return null;
        const html = await response.text();
        
        // Look for current year market value
        const currentYear = new Date().getFullYear();
        const regex = new RegExp(`${currentYear}[\\s\\S]*?Market Value[\\s\\S]*?\\$([\\d,]+)`, 'i');
        const match = html.match(regex);
        if (match) {
            return parseInt(match[1].replace(/,/g, ''));
        }
        return null;
    } catch (e) {
        console.log(`[BCAD Scraper] Error: ${e.message}`);
        return null;
    }
}

async function checkTravisCounty(propertyId) {
    try {
        const url = `https://travis.trueautomation.com/clientdb/Property.aspx?prop_id=${propertyId}`;
        const response = await fetch(url);
        if (!response.ok) return null;
        const html = await response.text();
        const currentYear = new Date().getFullYear();
        const regex = new RegExp(`${currentYear}[\\s\\S]*?Market Value[\\s\\S]*?\\$([\\d,]+)`, 'i');
        const match = html.match(regex);
        return match ? parseInt(match[1].replace(/,/g, '')) : null;
    } catch (e) { return null; }
}

async function checkHarrisCounty(propertyId) {
    // HCAD uses a different system
    try {
        const url = `https://public.hcad.org/records/details.asp?cession=1&search=acct&term=${propertyId}`;
        const response = await fetch(url);
        if (!response.ok) return null;
        const html = await response.text();
        const regex = /Total Appraised Value[\s\S]*?\$([\d,]+)/i;
        const match = html.match(regex);
        return match ? parseInt(match[1].replace(/,/g, '')) : null;
    } catch (e) { return null; }
}

async function checkDallasCounty(propertyId) {
    try {
        const url = `https://www.dallascad.org/AcctDetailRes.aspx?ID=${propertyId}`;
        const response = await fetch(url);
        if (!response.ok) return null;
        const html = await response.text();
        const regex = /Market Value[\s\S]*?\$([\d,]+)/i;
        const match = html.match(regex);
        return match ? parseInt(match[1].replace(/,/g, '')) : null;
    } catch (e) { return null; }
}

async function checkTarrantCounty(propertyId) {
    try {
        const url = `https://www.tad.org/property/${propertyId}`;
        const response = await fetch(url);
        if (!response.ok) return null;
        const html = await response.text();
        const regex = /Market Value[\s\S]*?\$([\d,]+)/i;
        const match = html.match(regex);
        return match ? parseInt(match[1].replace(/,/g, '')) : null;
    } catch (e) { return null; }
}

async function checkComalCounty(propertyId) {
    try {
        const url = `https://esearch.comalcad.org/Property/View/${propertyId}`;
        const response = await fetch(url);
        if (!response.ok) return null;
        const html = await response.text();
        const regex = /Market Value[\s\S]*?\$([\d,]+)/i;
        const match = html.match(regex);
        return match ? parseInt(match[1].replace(/,/g, '')) : null;
    } catch (e) { return null; }
}

async function checkGuadalupeCounty(propertyId) {
    try {
        const url = `https://guadalupe.trueautomation.com/clientdb/Property.aspx?prop_id=${propertyId}`;
        const response = await fetch(url);
        if (!response.ok) return null;
        const html = await response.text();
        const currentYear = new Date().getFullYear();
        const regex = new RegExp(`${currentYear}[\\s\\S]*?Market Value[\\s\\S]*?\\$([\\d,]+)`, 'i');
        const match = html.match(regex);
        return match ? parseInt(match[1].replace(/,/g, '')) : null;
    } catch (e) { return null; }
}

async function checkKendallCounty(propertyId) {
    try {
        const url = `https://kendall.trueautomation.com/clientdb/Property.aspx?prop_id=${propertyId}`;
        const response = await fetch(url);
        if (!response.ok) return null;
        const html = await response.text();
        const currentYear = new Date().getFullYear();
        const regex = new RegExp(`${currentYear}[\\s\\S]*?Market Value[\\s\\S]*?\\$([\\d,]+)`, 'i');
        const match = html.match(regex);
        return match ? parseInt(match[1].replace(/,/g, '')) : null;
    } catch (e) { return null; }
}

async function checkHaysCounty(propertyId) {
    try {
        const url = `https://esearch.hayscad.com/Property/View/${propertyId}`;
        const response = await fetch(url);
        if (!response.ok) return null;
        const html = await response.text();
        const regex = /Market Value[\s\S]*?\$([\d,]+)/i;
        const match = html.match(regex);
        return match ? parseInt(match[1].replace(/,/g, '')) : null;
    } catch (e) { return null; }
}

async function checkWilliamsonCounty(propertyId) {
    try {
        const url = `https://search.wcad.org/Property-Detail?PropertyQuickRefID=${propertyId}`;
        const response = await fetch(url);
        if (!response.ok) return null;
        const html = await response.text();
        const regex = /Market Value[\s\S]*?\$([\d,]+)/i;
        const match = html.match(regex);
        return match ? parseInt(match[1].replace(/,/g, '')) : null;
    } catch (e) { return null; }
}

// ==================== Email-Based Outcome Detection ====================

/**
 * Parse an inbound email for hearing results
 * Called when emails arrive at appeals@overassessed.ai
 */
async function parseResultEmail(subject, body, from) {
    const resultPatterns = [
        /protest.*(?:approved|granted|reduced)/i,
        /hearing.*(?:result|order|determination)/i,
        /value.*(?:reduced|lowered|changed)/i,
        /appraisal.*(?:review|board).*(?:order|result)/i
    ];

    const isResult = resultPatterns.some(p => p.test(subject) || p.test(body));
    if (!isResult) return null;

    // Try to extract case reference or property info
    const caseMatch = body.match(/OA-\d+/);
    const valueMatch = body.match(/(?:new|reduced|appraised).*?value.*?\$?([\d,]+)/i);
    
    return {
        isResult: true,
        caseId: caseMatch ? caseMatch[0] : null,
        newValue: valueMatch ? parseInt(valueMatch[1].replace(/,/g, '')) : null,
        rawSubject: subject,
        from
    };
}

module.exports = {
    checkAllPendingOutcomes,
    parseResultEmail,
    COUNTY_SCRAPERS
};
