/**
 * Equal & Uniform (E&U) Analysis Module
 * Texas Tax Code §42.26 — proves unequal appraisal by comparing
 * assessment-to-sale ratios across comparable properties.
 *
 * Integration: import { runEUAnalysis, generateEUReport } from './eu-analysis'
 * Called from comp-engine.js and evidence-generator.js
 */

const MIN_COMPS = 5;
const RATIO_FLOOR = 0.50;
const RATIO_CEILING = 1.10;
const DEFAULT_TAX_RATE = 0.025; // ~2.5% typical TX

// ─── Helpers ────────────────────────────────────────────────────────

function median(arr) {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}

function mean(arr) {
    if (!arr.length) return null;
    return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr) {
    const m = mean(arr);
    if (m === null) return null;
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

function round2(n) { return Math.round(n * 100) / 100; }
function dollars(n) { return '$' + Math.round(n).toLocaleString(); }
function pct(n) { return (n * 100).toFixed(1) + '%'; }

// ─── Core Analysis ──────────────────────────────────────────────────

/**
 * Run Equal & Uniform analysis.
 *
 * @param {string} propertyAddress - Subject property address
 * @param {string} county - County name (e.g. "Bexar")
 * @param {number} assessedValue - Subject's current assessed/appraised value
 * @param {Array<Object>} comps - Comparable sold properties, each must have:
 *   { address, assessed_value, sale_price, sqft?, yearBuilt?, sale_date? }
 * @param {Object} [options]
 * @param {number} [options.marketValue] - Subject market value (defaults to assessedValue)
 * @param {number} [options.taxRate] - Override tax rate
 * @returns {Object} Full E&U analysis result
 */
function runEUAnalysis(propertyAddress, county, assessedValue, comps, options = {}) {
    const marketValue = options.marketValue || assessedValue;
    const taxRate = options.taxRate || DEFAULT_TAX_RATE;

    // Validate inputs
    if (!propertyAddress) throw new Error('propertyAddress is required');
    if (!county) throw new Error('county is required');
    if (typeof assessedValue !== 'number' || assessedValue <= 0) {
        throw new Error('assessedValue must be a positive number');
    }
    if (!Array.isArray(comps)) throw new Error('comps must be an array');

    // Calculate ratio for each comp, flag outliers
    const compAnalysis = comps.map(c => {
        if (!c.sale_price || c.sale_price <= 0 || !c.assessed_value || c.assessed_value <= 0) {
            return { ...c, ratio: null, excluded: true, excludeReason: 'Missing or invalid sale_price/assessed_value' };
        }
        const ratio = round2(c.assessed_value / c.sale_price);
        const isOutlier = ratio < RATIO_FLOOR || ratio > RATIO_CEILING;
        return {
            ...c,
            ratio,
            excluded: isOutlier,
            excludeReason: isOutlier ? `Ratio ${ratio} outside range [${RATIO_FLOOR}-${RATIO_CEILING}]` : null
        };
    });

    const included = compAnalysis.filter(c => !c.excluded);
    const excluded = compAnalysis.filter(c => c.excluded);
    const ratios = included.map(c => c.ratio);

    const insufficientData = included.length < MIN_COMPS;

    const medianRatio = median(ratios);
    const meanRatio = mean(ratios);
    const ratioStdDev = stddev(ratios);

    // E&U target value: median ratio × market value
    const euTargetValue = medianRatio !== null ? Math.round(medianRatio * marketValue) : null;
    const potentialReduction = euTargetValue !== null ? Math.max(0, assessedValue - euTargetValue) : 0;
    const estimatedTaxSavings = Math.round(potentialReduction * taxRate);

    // Subject's own ratio (assessed / market)
    const subjectRatio = marketValue > 0 ? round2(assessedValue / marketValue) : null;

    // Determine recommendation
    let recommendation;
    if (insufficientData) {
        recommendation = 'INSUFFICIENT_DATA';
    } else if (euTargetValue !== null && euTargetValue < assessedValue) {
        // E&U argument is viable — check if it's strong
        const ratiosBelow = ratios.filter(r => r < subjectRatio).length;
        const percentBelow = ratiosBelow / ratios.length;
        if (percentBelow >= 0.6 && potentialReduction > assessedValue * 0.03) {
            recommendation = 'EQUAL_AND_UNIFORM';
        } else {
            recommendation = 'EQUAL_AND_UNIFORM_WEAK';
        }
    } else {
        recommendation = 'MARKET_VALUE';
    }

    return {
        subject: {
            address: propertyAddress,
            county,
            assessedValue,
            marketValue,
            subjectRatio
        },
        comps: {
            total: comps.length,
            included: included.length,
            excluded: excluded.length,
            details: compAnalysis,
            excludedDetails: excluded
        },
        ratios: {
            individual: ratios,
            median: medianRatio,
            mean: meanRatio !== null ? round2(meanRatio) : null,
            stdDev: ratioStdDev !== null ? round2(ratioStdDev) : null
        },
        result: {
            euTargetValue,
            potentialReduction,
            estimatedTaxSavings,
            taxRate
        },
        recommendation,
        insufficientData,
        analyzedAt: new Date().toISOString()
    };
}

// ─── Report Generation ──────────────────────────────────────────────

/**
 * Generate a formatted E&U evidence report for ARB hearing.
 *
 * @param {Object} analysis - Result from runEUAnalysis()
 * @returns {Object} { text, html, chartsData }
 */
function generateEUReport(analysis) {
    const { subject, comps, ratios, result, recommendation, insufficientData } = analysis;
    const included = comps.details.filter(c => !c.excluded);

    // ── Text report ──
    const lines = [];
    const hr = '═'.repeat(70);
    const hr2 = '─'.repeat(70);

    lines.push(hr);
    lines.push('EQUAL & UNIFORM ANALYSIS — EVIDENCE FOR ARB HEARING');
    lines.push(`Texas Tax Code §42.26`);
    lines.push(hr);
    lines.push('');
    lines.push('SUBJECT PROPERTY');
    lines.push(hr2);
    lines.push(`Address:          ${subject.address}`);
    lines.push(`County:           ${subject.county}`);
    lines.push(`Current Assessed: ${dollars(subject.assessedValue)}`);
    lines.push(`Market Value:     ${dollars(subject.marketValue)}`);
    lines.push(`Subject Ratio:    ${subject.subjectRatio !== null ? pct(subject.subjectRatio) : 'N/A'}`);
    lines.push('');

    lines.push('COMPARABLE SALES ANALYSIS');
    lines.push(hr2);
    lines.push(`Total Comps Evaluated:  ${comps.total}`);
    lines.push(`Comps Included:         ${comps.included}`);
    lines.push(`Comps Excluded:         ${comps.excluded} (outlier ratios)`);
    lines.push('');

    // Comp table
    lines.push('COMP  ADDRESS                              ASSESSED     SALE PRICE   RATIO');
    lines.push(hr2);
    included.forEach((c, i) => {
        const addr = (c.address || 'Unknown').substring(0, 36).padEnd(36);
        const av = dollars(c.assessed_value).padStart(12);
        const sp = dollars(c.sale_price).padStart(12);
        const r = c.ratio.toFixed(2).padStart(7);
        lines.push(`  ${(i + 1).toString().padEnd(4)}${addr} ${av} ${sp} ${r}`);
    });
    lines.push('');

    if (comps.excluded > 0) {
        lines.push('EXCLUDED COMPS (outlier ratios):');
        comps.details.filter(c => c.excluded).forEach(c => {
            lines.push(`  - ${c.address || 'Unknown'}: ${c.excludeReason}`);
        });
        lines.push('');
    }

    lines.push('RATIO ANALYSIS');
    lines.push(hr2);
    lines.push(`Median Ratio:     ${ratios.median !== null ? ratios.median.toFixed(2) : 'N/A'}`);
    lines.push(`Mean Ratio:       ${ratios.mean !== null ? ratios.mean.toFixed(2) : 'N/A'}`);
    lines.push(`Std Deviation:    ${ratios.stdDev !== null ? ratios.stdDev.toFixed(2) : 'N/A'}`);
    lines.push('');

    lines.push('EQUAL & UNIFORM RESULT');
    lines.push(hr2);
    if (result.euTargetValue !== null) {
        lines.push(`E&U Target Value:     ${dollars(result.euTargetValue)}`);
        lines.push(`  (Median Ratio ${ratios.median.toFixed(2)} × Market Value ${dollars(subject.marketValue)})`);
        lines.push(`Current Assessment:   ${dollars(subject.assessedValue)}`);
        lines.push(`Potential Reduction:  ${dollars(result.potentialReduction)}`);
        lines.push(`Est. Tax Savings:     ${dollars(result.estimatedTaxSavings)}/yr`);
    } else {
        lines.push('Unable to calculate E&U target — insufficient data.');
    }
    lines.push('');

    lines.push('RECOMMENDATION');
    lines.push(hr2);
    const recText = {
        EQUAL_AND_UNIFORM: 'STRONG E&U argument. The median assessment ratio of comparable sales is significantly below the subject\'s ratio, indicating unequal appraisal under Tax Code §42.26.',
        EQUAL_AND_UNIFORM_WEAK: 'E&U argument exists but is moderate. Consider presenting both E&U and market value evidence.',
        MARKET_VALUE: 'E&U approach does not produce a lower value than market value. Recommend standard market value protest.',
        INSUFFICIENT_DATA: `Insufficient comparable sales data (${comps.included} of ${MIN_COMPS} minimum). Gather additional comps before proceeding with E&U.`
    };
    lines.push(recText[recommendation] || recommendation);
    lines.push('');
    lines.push(hr);
    lines.push(`Analysis Date: ${analysis.analyzedAt}`);
    lines.push(`Prepared for ARB Hearing — ${subject.county} County Appraisal District`);
    lines.push(hr);

    const text = lines.join('\n');

    // ── Charts data for frontend rendering ──
    const chartsData = {
        ratioDistribution: {
            type: 'bar',
            labels: included.map((c, i) => `Comp ${i + 1}`),
            datasets: [
                {
                    label: 'Assessment Ratio',
                    data: included.map(c => c.ratio)
                },
                {
                    label: 'Subject Ratio',
                    data: included.map(() => subject.subjectRatio)
                },
                {
                    label: 'Median Ratio',
                    data: included.map(() => ratios.median)
                }
            ]
        },
        valueComparison: {
            type: 'bar',
            labels: ['Current Assessment', 'E&U Target', 'Market Value'],
            data: [subject.assessedValue, result.euTargetValue, subject.marketValue]
        },
        compScatter: {
            type: 'scatter',
            points: included.map(c => ({
                x: c.sale_price,
                y: c.assessed_value,
                label: c.address
            }))
        }
    };

    return { text, chartsData, recommendation };
}

module.exports = {
    runEUAnalysis,
    generateEUReport,
    // Expose helpers for testing
    _helpers: { median, mean, stddev, round2 }
};
