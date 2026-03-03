/**
 * Tests for E&U Analysis Module
 * Uses realistic Bexar County property data
 */

const { runEUAnalysis, generateEUReport, _helpers } = require('./eu-analysis');
const { median, mean, stddev, round2 } = _helpers;

// ─── Realistic Bexar County test data ───────────────────────────────

const SUBJECT = {
    address: '14523 Hillside Post',
    county: 'Bexar',
    assessedValue: 400000
};

function makeComps(overrides = []) {
    const base = [
        { address: '14601 Hillside Post',   assessed_value: 365000, sale_price: 430000, sqft: 2450, yearBuilt: 2018, sale_date: '2025-06-15' },
        { address: '14710 Hillside Post',   assessed_value: 372000, sale_price: 425000, sqft: 2520, yearBuilt: 2017, sale_date: '2025-04-22' },
        { address: '8203 Pointe Gate',      assessed_value: 358000, sale_price: 410000, sqft: 2380, yearBuilt: 2019, sale_date: '2025-07-01' },
        { address: '8119 Pointe Gate',      assessed_value: 381000, sale_price: 435000, sqft: 2600, yearBuilt: 2017, sale_date: '2025-05-10' },
        { address: '3402 Cibolo Trl',       assessed_value: 370000, sale_price: 420000, sqft: 2490, yearBuilt: 2018, sale_date: '2025-08-03' },
        { address: '3510 Cibolo Trl',       assessed_value: 355000, sale_price: 398000, sqft: 2300, yearBuilt: 2020, sale_date: '2025-03-18' },
    ];
    return overrides.length ? overrides : base;
}

// ─── Helper unit tests ──────────────────────────────────────────────

describe('helpers', () => {
    test('median odd count', () => {
        expect(median([0.85, 0.88, 0.92])).toBe(0.88);
    });
    test('median even count', () => {
        expect(median([0.85, 0.88, 0.90, 0.92])).toBe(0.89);
    });
    test('median empty', () => {
        expect(median([])).toBeNull();
    });
    test('mean', () => {
        expect(mean([1, 2, 3])).toBeCloseTo(2);
    });
    test('stddev', () => {
        expect(stddev([2, 2, 2])).toBe(0);
    });
    test('round2', () => {
        expect(round2(0.87647)).toBe(0.88);
    });
});

// ─── runEUAnalysis ──────────────────────────────────────────────────

describe('runEUAnalysis', () => {
    test('basic Bexar County analysis with 6 comps', () => {
        const result = runEUAnalysis(SUBJECT.address, SUBJECT.county, SUBJECT.assessedValue, makeComps());

        expect(result.subject.address).toBe(SUBJECT.address);
        expect(result.subject.county).toBe('Bexar');
        expect(result.comps.included).toBe(6);
        expect(result.comps.excluded).toBe(0);
        expect(result.insufficientData).toBe(false);

        // All ratios should be ~0.85-0.89
        result.ratios.individual.forEach(r => {
            expect(r).toBeGreaterThanOrEqual(0.5);
            expect(r).toBeLessThanOrEqual(1.1);
        });

        // Median ratio applied to market value should be < assessed
        expect(result.result.euTargetValue).toBeLessThan(SUBJECT.assessedValue);
        expect(result.result.potentialReduction).toBeGreaterThan(0);
        expect(result.result.estimatedTaxSavings).toBeGreaterThan(0);
        expect(result.recommendation).toMatch(/EQUAL_AND_UNIFORM/);
    });

    test('uses marketValue option when provided', () => {
        const result = runEUAnalysis(SUBJECT.address, SUBJECT.county, 400000, makeComps(), { marketValue: 420000 });
        // E&U target = median ratio * 420K (higher base)
        expect(result.subject.marketValue).toBe(420000);
        expect(result.result.euTargetValue).toBeGreaterThan(result.ratios.median * 400000 - 1);
    });

    test('excludes outlier ratios', () => {
        const comps = makeComps();
        comps.push({ address: '999 Outlier Ln', assessed_value: 500000, sale_price: 200000 }); // ratio 2.5 → excluded
        comps.push({ address: '998 Low Ln', assessed_value: 50000, sale_price: 400000 });       // ratio 0.125 → excluded
        const result = runEUAnalysis(SUBJECT.address, SUBJECT.county, 400000, comps);
        expect(result.comps.excluded).toBe(2);
        expect(result.comps.included).toBe(6);
    });

    test('flags insufficient data with < 5 valid comps', () => {
        const comps = makeComps().slice(0, 3); // only 3
        const result = runEUAnalysis(SUBJECT.address, SUBJECT.county, 400000, comps);
        expect(result.insufficientData).toBe(true);
        expect(result.recommendation).toBe('INSUFFICIENT_DATA');
    });

    test('handles comps with missing sale_price', () => {
        const comps = makeComps();
        comps[0] = { address: '100 Bad Data', assessed_value: 350000, sale_price: 0 };
        const result = runEUAnalysis(SUBJECT.address, SUBJECT.county, 400000, comps);
        expect(result.comps.excluded).toBe(1);
        expect(result.comps.included).toBe(5);
    });

    test('recommends MARKET_VALUE when E&U is not favorable', () => {
        // Comps where assessed > sale (ratios > 1.0 but within ceiling)
        const highComps = [
            { address: '1 High St', assessed_value: 420000, sale_price: 410000 },
            { address: '2 High St', assessed_value: 415000, sale_price: 405000 },
            { address: '3 High St', assessed_value: 425000, sale_price: 420000 },
            { address: '4 High St', assessed_value: 410000, sale_price: 400000 },
            { address: '5 High St', assessed_value: 418000, sale_price: 415000 },
        ];
        const result = runEUAnalysis(SUBJECT.address, SUBJECT.county, 400000, highComps);
        // Median ratio ~1.02, target ~408K > 400K assessed → no E&U benefit
        expect(result.recommendation).toBe('MARKET_VALUE');
    });

    test('throws on invalid inputs', () => {
        expect(() => runEUAnalysis('', 'Bexar', 400000, [])).toThrow('propertyAddress');
        expect(() => runEUAnalysis('123 Main', '', 400000, [])).toThrow('county');
        expect(() => runEUAnalysis('123 Main', 'Bexar', -1, [])).toThrow('positive');
        expect(() => runEUAnalysis('123 Main', 'Bexar', 400000, 'bad')).toThrow('array');
    });

    test('example from task description matches', () => {
        // Manually set ratios: 0.85, 0.88, 0.92, 0.87, 0.90 → median 0.88
        const comps = [
            { address: 'A', assessed_value: 340000, sale_price: 400000 },  // 0.85
            { address: 'B', assessed_value: 352000, sale_price: 400000 },  // 0.88
            { address: 'C', assessed_value: 368000, sale_price: 400000 },  // 0.92
            { address: 'D', assessed_value: 348000, sale_price: 400000 },  // 0.87
            { address: 'E', assessed_value: 360000, sale_price: 400000 },  // 0.90
        ];
        const result = runEUAnalysis('My Home', 'Bexar', 400000, comps, { marketValue: 420000 });
        expect(result.ratios.median).toBe(0.88);
        expect(result.result.euTargetValue).toBe(Math.round(0.88 * 420000)); // 369600
        expect(result.result.potentialReduction).toBe(400000 - 369600);       // 30400
    });
});

// ─── generateEUReport ───────────────────────────────────────────────

describe('generateEUReport', () => {
    test('produces text report with all sections', () => {
        const analysis = runEUAnalysis(SUBJECT.address, SUBJECT.county, 400000, makeComps());
        const report = generateEUReport(analysis);

        expect(report.text).toContain('EQUAL & UNIFORM ANALYSIS');
        expect(report.text).toContain('Texas Tax Code §42.26');
        expect(report.text).toContain(SUBJECT.address);
        expect(report.text).toContain('Bexar');
        expect(report.text).toContain('COMPARABLE SALES ANALYSIS');
        expect(report.text).toContain('RATIO ANALYSIS');
        expect(report.text).toContain('Median Ratio');
        expect(report.text).toContain('RECOMMENDATION');
        expect(report.text).toContain('E&U Target Value');
    });

    test('includes charts data', () => {
        const analysis = runEUAnalysis(SUBJECT.address, SUBJECT.county, 400000, makeComps());
        const report = generateEUReport(analysis);

        expect(report.chartsData.ratioDistribution.type).toBe('bar');
        expect(report.chartsData.ratioDistribution.datasets).toHaveLength(3);
        expect(report.chartsData.valueComparison.data).toHaveLength(3);
        expect(report.chartsData.compScatter.points.length).toBeGreaterThan(0);
    });

    test('handles insufficient data gracefully', () => {
        const analysis = runEUAnalysis(SUBJECT.address, SUBJECT.county, 400000, makeComps().slice(0, 2));
        const report = generateEUReport(analysis);

        expect(report.text).toContain('Insufficient');
        expect(report.recommendation).toBe('INSUFFICIENT_DATA');
    });
});
