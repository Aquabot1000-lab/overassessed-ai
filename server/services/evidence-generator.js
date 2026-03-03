/**
 * Evidence Packet Generator — creates professional PDF evidence packets
 * using PDFKit. Branded with OverAssessed purple-blue gradient.
 */

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const EVIDENCE_DIR = path.join(__dirname, '..', 'evidence-packets');

// Brand colors
const PURPLE = '#6c5ce7';
const BLUE = '#0984e3';
const GREEN = '#00b894';
const TEXT_DARK = '#2d3436';
const TEXT_MUTED = '#6b7280';
const LIGHT_BG = '#f8f9ff';

/**
 * Generate a professional evidence packet PDF.
 * 
 * @param {Object} caseData - The case/submission data
 * @param {Object} propertyData - Property details from property-data service
 * @param {Object} compResults - Results from comp-engine
 * @returns {string} Path to generated PDF
 */
async function generateEvidencePacket(caseData, propertyData, compResults) {
    await fs.promises.mkdir(EVIDENCE_DIR, { recursive: true });

    const filename = `${(caseData.caseId || 'case').replace(/[^a-zA-Z0-9-]/g, '')}-Evidence-Packet.pdf`;
    const filepath = path.join(EVIDENCE_DIR, filename);

    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: 'letter',
            margins: { top: 50, bottom: 50, left: 60, right: 60 },
            info: {
                Title: `Property Tax Protest Evidence — ${caseData.caseId}`,
                Author: 'OverAssessed',
                Subject: `Evidence packet for ${caseData.propertyAddress}`
            }
        });

        const stream = fs.createWriteStream(filepath);
        doc.pipe(stream);

        try {
            // ===== PAGE 1: COVER =====
            drawHeader(doc);
            doc.moveDown(2);

            doc.fontSize(28).fillColor(TEXT_DARK).font('Helvetica-Bold')
                .text('Property Tax Protest', { align: 'center' });
            doc.fontSize(18).fillColor(PURPLE)
                .text('Evidence Packet', { align: 'center' });

            doc.moveDown(2);

            // Case info box
            const boxY = doc.y;
            doc.rect(60, boxY, 492, 160).fill('#f0f0ff').stroke(PURPLE);
            doc.fillColor(TEXT_DARK);

            let infoY = boxY + 20;
            const infoLeft = 80;
            const infoRight = 280;

            drawInfoRow(doc, infoLeft, infoY, 'Case ID:', caseData.caseId || 'N/A'); infoY += 28;
            drawInfoRow(doc, infoLeft, infoY, 'Property Owner:', caseData.ownerName || 'N/A'); infoY += 28;
            drawInfoRow(doc, infoLeft, infoY, 'Property Address:', caseData.propertyAddress || 'N/A'); infoY += 28;
            drawInfoRow(doc, infoLeft, infoY, 'Account Number:', propertyData.accountId || 'On file'); infoY += 28;
            drawInfoRow(doc, infoLeft, infoY, 'Current Assessed Value:', `$${(propertyData.assessedValue || 0).toLocaleString()}`);

            doc.y = boxY + 180;
            doc.moveDown(2);

            // Summary box
            if (compResults.estimatedSavings > 0) {
                const sumY = doc.y;
                doc.rect(60, sumY, 492, 80).fill('#e8fff5').stroke(GREEN);
                doc.fontSize(12).fillColor(TEXT_MUTED).font('Helvetica')
                    .text('Recommended Protest Value', 80, sumY + 15, { align: 'center', width: 452 });
                doc.fontSize(24).fillColor(GREEN).font('Helvetica-Bold')
                    .text(`$${compResults.recommendedValue.toLocaleString()}`, 80, sumY + 35, { align: 'center', width: 452 });
                const strategyLabel = compResults.primaryStrategy === 'equal_and_uniform' ? 'Equal & Uniform (§42.26)' : 'Market Value Approach';
                doc.fontSize(11).fillColor(TEXT_MUTED).font('Helvetica')
                    .text(`Estimated Annual Tax Savings: $${compResults.estimatedSavings.toLocaleString()} | Strategy: ${strategyLabel}`, 80, sumY + 58, { align: 'center', width: 452 });
                doc.y = sumY + 100;
            }

            doc.moveDown(3);
            doc.fontSize(10).fillColor(TEXT_MUTED).font('Helvetica')
                .text(`Prepared by OverAssessed — ${new Date().toLocaleDateString()}`, { align: 'center' });
            doc.text('San Antonio, Texas', { align: 'center' });

            // ===== PAGE 2: SUBJECT PROPERTY DETAILS =====
            doc.addPage();
            drawHeader(doc);
            doc.moveDown(1);

            doc.fontSize(16).fillColor(TEXT_DARK).font('Helvetica-Bold')
                .text('Subject Property Details');
            doc.moveDown(0.5);
            drawDivider(doc);
            doc.moveDown(0.5);

            const details = [
                ['Property Address', caseData.propertyAddress],
                ['Owner', caseData.ownerName],
                ['Account Number', propertyData.accountId || 'On file'],
                ['Property Type', propertyData.propertyType || caseData.propertyType || 'Residential'],
                ['Square Footage', propertyData.sqft ? `${propertyData.sqft.toLocaleString()} sq ft` : 'On file'],
                ['Year Built', propertyData.yearBuilt || 'On file'],
                ['Bedrooms / Bathrooms', `${propertyData.bedrooms || '—'} / ${propertyData.bathrooms || '—'}`],
                ['Lot Size', propertyData.lotSize ? `${propertyData.lotSize.toLocaleString()} sq ft` : 'On file'],
                ['Neighborhood Code', propertyData.neighborhoodCode || 'On file'],
                ['Land Value', propertyData.landValue ? `$${propertyData.landValue.toLocaleString()}` : '—'],
                ['Improvement Value', propertyData.improvementValue ? `$${propertyData.improvementValue.toLocaleString()}` : '—'],
                ['Total Assessed Value', `$${(propertyData.assessedValue || 0).toLocaleString()}`],
                ['Exemptions', propertyData.exemptions || 'None listed']
            ];

            details.forEach(([label, value], i) => {
                const y = doc.y;
                if (i % 2 === 0) {
                    doc.rect(60, y - 2, 492, 20).fill('#f8f8ff');
                }
                doc.fontSize(10).fillColor(TEXT_MUTED).font('Helvetica')
                    .text(label, 70, y, { width: 180 });
                doc.fontSize(10).fillColor(TEXT_DARK).font('Helvetica-Bold')
                    .text(String(value), 260, y, { width: 280 });
                doc.y = y + 22;
            });

            // Assessment History
            if (propertyData.valueHistory && propertyData.valueHistory.length > 0) {
                doc.moveDown(1.5);
                doc.fontSize(14).fillColor(TEXT_DARK).font('Helvetica-Bold')
                    .text('Assessment History');
                doc.moveDown(0.5);

                // Table header
                const tableX = 80;
                const colWidths = [100, 150, 150];
                const headerY = doc.y;

                doc.rect(60, headerY - 4, 492, 22).fill(PURPLE);
                doc.fontSize(9).fillColor('white').font('Helvetica-Bold');
                doc.text('Year', tableX, headerY, { width: colWidths[0] });
                doc.text('Assessed Value', tableX + colWidths[0], headerY, { width: colWidths[1] });
                doc.text('Change', tableX + colWidths[0] + colWidths[1], headerY, { width: colWidths[2] });
                doc.y = headerY + 22;

                propertyData.valueHistory.sort((a, b) => b.year - a.year).forEach((entry, i) => {
                    const rowY = doc.y;
                    if (i % 2 === 0) doc.rect(60, rowY - 2, 492, 18).fill('#fafafa');

                    const prevEntry = propertyData.valueHistory.find(h => h.year === entry.year - 1);
                    const change = prevEntry ? ((entry.value - prevEntry.value) / prevEntry.value * 100).toFixed(1) : '—';
                    const changeStr = prevEntry ? `${change > 0 ? '+' : ''}${change}%` : '—';

                    doc.fontSize(9).fillColor(TEXT_DARK).font('Helvetica');
                    doc.text(String(entry.year), tableX, rowY, { width: colWidths[0] });
                    doc.text(`$${entry.value.toLocaleString()}`, tableX + colWidths[0], rowY, { width: colWidths[1] });
                    doc.fillColor(change > 0 ? '#e17055' : GREEN)
                        .text(changeStr, tableX + colWidths[0] + colWidths[1], rowY, { width: colWidths[2] });
                    doc.y = rowY + 18;
                });
            }

            // ===== PAGE 3: COMPARABLE PROPERTIES =====
            doc.addPage();
            drawHeader(doc);
            doc.moveDown(1);

            doc.fontSize(16).fillColor(TEXT_DARK).font('Helvetica-Bold')
                .text('Comparable Properties Analysis');
            doc.moveDown(0.3);
            doc.fontSize(10).fillColor(TEXT_MUTED).font('Helvetica')
                .text(`${compResults.comps.length} comparable properties identified from appraisal district records`);
            doc.moveDown(0.5);
            drawDivider(doc);
            doc.moveDown(0.5);

            compResults.comps.forEach((comp, i) => {
                if (doc.y > 620) doc.addPage();

                const compY = doc.y;
                doc.rect(60, compY, 492, 24).fill(PURPLE);
                doc.fontSize(11).fillColor('white').font('Helvetica-Bold')
                    .text(`Comparable #${i + 1} — ${comp.address}`, 70, compY + 6, { width: 472 });
                doc.y = compY + 30;

                const compDetails = [
                    ['Assessed Value', `$${(comp.assessedValue || 0).toLocaleString()}`],
                    ['Adjusted Value', `$${(comp.adjustedValue || 0).toLocaleString()}`],
                    ['Square Footage', comp.sqft ? `${comp.sqft.toLocaleString()} sq ft` : '—'],
                    ['Year Built', comp.yearBuilt || '—'],
                    ['Lot Size', comp.lotSize ? `${comp.lotSize.toLocaleString()} sq ft` : '—'],
                    ['Price / Sq Ft', comp.pricePerSqft ? `$${comp.pricePerSqft}` : '—'],
                    ['Similarity Score', `${comp.score}/100`]
                ];

                compDetails.forEach(([label, value], j) => {
                    const y = doc.y;
                    if (j % 2 === 0) doc.rect(60, y - 2, 492, 17).fill('#fafafa');
                    doc.fontSize(9).fillColor(TEXT_MUTED).font('Helvetica')
                        .text(label, 80, y, { width: 160 });
                    doc.fontSize(9).fillColor(TEXT_DARK).font('Helvetica-Bold')
                        .text(String(value), 250, y, { width: 280 });
                    doc.y = y + 17;
                });

                doc.moveDown(0.5);
            });

            // ===== PAGE 4: ADJUSTMENT GRID + RECOMMENDATION =====
            doc.addPage();
            drawHeader(doc);
            doc.moveDown(1);

            doc.fontSize(16).fillColor(TEXT_DARK).font('Helvetica-Bold')
                .text('Value Adjustment Summary');
            doc.moveDown(0.5);
            drawDivider(doc);
            doc.moveDown(0.5);

            // Adjustment grid
            const gridX = 60;
            const gridColW = [160, 110, 110, 110];
            const gridHeaderY = doc.y;

            doc.rect(gridX, gridHeaderY - 4, 492, 22).fill(PURPLE);
            doc.fontSize(9).fillColor('white').font('Helvetica-Bold');
            doc.text('Property', gridX + 10, gridHeaderY, { width: gridColW[0] });
            doc.text('Raw Value', gridX + gridColW[0], gridHeaderY, { width: gridColW[1], align: 'right' });
            doc.text('Adjusted Value', gridX + gridColW[0] + gridColW[1], gridHeaderY, { width: gridColW[2], align: 'right' });
            doc.text('Score', gridX + gridColW[0] + gridColW[1] + gridColW[2], gridHeaderY, { width: gridColW[3], align: 'right' });
            doc.y = gridHeaderY + 24;

            // Subject row
            let rowY = doc.y;
            doc.rect(gridX, rowY - 2, 492, 18).fill('#e8e6ff');
            doc.fontSize(9).fillColor(TEXT_DARK).font('Helvetica-Bold');
            doc.text('SUBJECT', gridX + 10, rowY, { width: gridColW[0] });
            doc.text(`$${(propertyData.assessedValue || 0).toLocaleString()}`, gridX + gridColW[0], rowY, { width: gridColW[1], align: 'right' });
            doc.text('—', gridX + gridColW[0] + gridColW[1], rowY, { width: gridColW[2], align: 'right' });
            doc.text('—', gridX + gridColW[0] + gridColW[1] + gridColW[2], rowY, { width: gridColW[3], align: 'right' });
            doc.y = rowY + 20;

            compResults.comps.forEach((comp, i) => {
                rowY = doc.y;
                if (i % 2 === 0) doc.rect(gridX, rowY - 2, 492, 18).fill('#fafafa');
                doc.fontSize(9).fillColor(TEXT_DARK).font('Helvetica');
                const shortAddr = (comp.address || '').substring(0, 25);
                doc.text(`Comp #${i + 1}: ${shortAddr}`, gridX + 10, rowY, { width: gridColW[0] });
                doc.text(`$${(comp.assessedValue || 0).toLocaleString()}`, gridX + gridColW[0], rowY, { width: gridColW[1], align: 'right' });
                doc.fillColor(comp.adjustedValue < propertyData.assessedValue ? GREEN : '#e17055').font('Helvetica-Bold');
                doc.text(`$${(comp.adjustedValue || 0).toLocaleString()}`, gridX + gridColW[0] + gridColW[1], rowY, { width: gridColW[2], align: 'right' });
                doc.fillColor(TEXT_DARK).font('Helvetica');
                doc.text(`${comp.score}/100`, gridX + gridColW[0] + gridColW[1] + gridColW[2], rowY, { width: gridColW[3], align: 'right' });
                doc.y = rowY + 20;
            });

            // Recommendation box
            doc.moveDown(2);
            const recY = doc.y;
            doc.rect(60, recY, 492, 100).fill('#e8fff5').stroke(GREEN);
            doc.fontSize(14).fillColor(TEXT_DARK).font('Helvetica-Bold')
                .text('Recommended Protest Value', 80, recY + 12, { width: 452, align: 'center' });
            doc.fontSize(28).fillColor(GREEN).font('Helvetica-Bold')
                .text(`$${compResults.recommendedValue.toLocaleString()}`, 80, recY + 35, { width: 452, align: 'center' });
            doc.fontSize(11).fillColor(TEXT_DARK).font('Helvetica')
                .text(`Potential Reduction: $${compResults.reduction.toLocaleString()} | Estimated Annual Tax Savings: $${compResults.estimatedSavings.toLocaleString()}`,
                    80, recY + 70, { width: 452, align: 'center' });
            doc.y = recY + 120;

            // Methodology
            doc.moveDown(1);
            doc.fontSize(12).fillColor(TEXT_DARK).font('Helvetica-Bold')
                .text('Methodology');
            doc.moveDown(0.3);
            doc.fontSize(9).fillColor(TEXT_MUTED).font('Helvetica')
                .text(compResults.methodology, { width: 492 });

            // Summary argument
            doc.moveDown(1.5);
            doc.fontSize(12).fillColor(TEXT_DARK).font('Helvetica-Bold')
                .text('Summary Argument');
            doc.moveDown(0.3);
            doc.fontSize(10).fillColor(TEXT_DARK).font('Helvetica')
                .text(buildSummaryArgument(caseData, propertyData, compResults), { width: 492 });

            // ===== PAGE 5: EQUAL & UNIFORM ANALYSIS (if available) =====
            if (compResults.euAnalysis && compResults.euAnalysis.recommendation !== 'INSUFFICIENT_DATA') {
                const eu = compResults.euAnalysis;
                doc.addPage();
                drawHeader(doc);
                doc.moveDown(1);

                doc.fontSize(16).fillColor(TEXT_DARK).font('Helvetica-Bold')
                    .text('Equal & Uniform Analysis (Tax Code §42.26)');
                doc.moveDown(0.3);
                doc.fontSize(9).fillColor(TEXT_MUTED).font('Helvetica')
                    .text('This analysis demonstrates that the subject property is appraised at a higher ratio relative to market value than comparable properties, constituting unequal appraisal.');
                doc.moveDown(0.5);
                drawDivider(doc);
                doc.moveDown(0.5);

                // Strategy badge
                const isPrimary = compResults.primaryStrategy === 'equal_and_uniform';
                if (isPrimary) {
                    const badgeY = doc.y;
                    doc.rect(60, badgeY, 492, 24).fill(GREEN);
                    doc.fontSize(11).fillColor('white').font('Helvetica-Bold')
                        .text('★ PRIMARY STRATEGY — This produces the greatest reduction', 70, badgeY + 6, { width: 472, align: 'center' });
                    doc.y = badgeY + 32;
                }

                // Key metrics row
                doc.moveDown(0.3);
                const metricsY = doc.y;
                const mBoxW = 155;
                
                // Median Ratio
                doc.rect(60, metricsY, mBoxW, 50).fill(LIGHT_BG).stroke('#e2e8f0');
                doc.fontSize(8).fillColor(TEXT_MUTED).font('Helvetica').text('Median Assessment Ratio', 65, metricsY + 6, { width: mBoxW - 10 });
                doc.fontSize(20).fillColor(PURPLE).font('Helvetica-Bold').text(`${eu.medianRatio}`, 65, metricsY + 22, { width: mBoxW - 10 });

                // E&U Target
                doc.rect(60 + mBoxW + 10, metricsY, mBoxW, 50).fill(LIGHT_BG).stroke('#e2e8f0');
                doc.fontSize(8).fillColor(TEXT_MUTED).font('Helvetica').text('E&U Target Value', 65 + mBoxW + 10, metricsY + 6, { width: mBoxW - 10 });
                doc.fontSize(20).fillColor(GREEN).font('Helvetica-Bold').text(`$${eu.euTargetValue.toLocaleString()}`, 65 + mBoxW + 10, metricsY + 22, { width: mBoxW - 10 });

                // Potential Reduction
                const euReduction = eu.subjectAssessedValue - eu.euTargetValue;
                doc.rect(60 + (mBoxW + 10) * 2, metricsY, mBoxW, 50).fill(LIGHT_BG).stroke('#e2e8f0');
                doc.fontSize(8).fillColor(TEXT_MUTED).font('Helvetica').text('Potential Reduction', 65 + (mBoxW + 10) * 2, metricsY + 6, { width: mBoxW - 10 });
                doc.fontSize(20).fillColor(euReduction > 0 ? GREEN : '#e17055').font('Helvetica-Bold')
                    .text(`$${Math.max(0, euReduction).toLocaleString()}`, 65 + (mBoxW + 10) * 2, metricsY + 22, { width: mBoxW - 10 });

                doc.y = metricsY + 60;
                doc.moveDown(1);

                // Comp ratio table
                doc.fontSize(12).fillColor(TEXT_DARK).font('Helvetica-Bold').text('Comparable Assessment Ratios');
                doc.moveDown(0.5);

                const tX = 60;
                const tColW = [180, 100, 100, 60, 52];
                const tHeaderY = doc.y;

                doc.rect(tX, tHeaderY - 4, 492, 22).fill(PURPLE);
                doc.fontSize(8).fillColor('white').font('Helvetica-Bold');
                doc.text('Address', tX + 8, tHeaderY, { width: tColW[0] });
                doc.text('Assessed', tX + tColW[0], tHeaderY, { width: tColW[1], align: 'right' });
                doc.text('Sale Price', tX + tColW[0] + tColW[1], tHeaderY, { width: tColW[2], align: 'right' });
                doc.text('Ratio', tX + tColW[0] + tColW[1] + tColW[2], tHeaderY, { width: tColW[3], align: 'right' });
                doc.text('Status', tX + tColW[0] + tColW[1] + tColW[2] + tColW[3], tHeaderY, { width: tColW[4], align: 'right' });
                doc.y = tHeaderY + 24;

                const euComps = eu.compAnalysis || [];
                euComps.forEach((comp, i) => {
                    if (i >= 10) return; // Max 10 rows
                    const rY = doc.y;
                    if (i % 2 === 0) doc.rect(tX, rY - 2, 492, 16).fill('#fafafa');
                    doc.fontSize(8).fillColor(TEXT_DARK).font('Helvetica');
                    const addr = (comp.address || '').substring(0, 30);
                    doc.text(addr, tX + 8, rY, { width: tColW[0] });
                    doc.text(`$${(comp.assessed_value || 0).toLocaleString()}`, tX + tColW[0], rY, { width: tColW[1], align: 'right' });
                    doc.text(`$${(comp.sale_price || 0).toLocaleString()}`, tX + tColW[0] + tColW[1], rY, { width: tColW[2], align: 'right' });
                    doc.fillColor(comp.excluded ? '#e17055' : TEXT_DARK).font(comp.excluded ? 'Helvetica' : 'Helvetica-Bold');
                    doc.text(comp.ratio !== null ? `${comp.ratio}` : 'N/A', tX + tColW[0] + tColW[1] + tColW[2], rY, { width: tColW[3], align: 'right' });
                    doc.fillColor(comp.excluded ? '#e17055' : GREEN).fontSize(7);
                    doc.text(comp.excluded ? 'Excl.' : 'Incl.', tX + tColW[0] + tColW[1] + tColW[2] + tColW[3], rY, { width: tColW[4], align: 'right' });
                    doc.y = rY + 18;
                });

                // E&U explanation
                doc.moveDown(1);
                doc.fontSize(10).fillColor(TEXT_DARK).font('Helvetica-Bold').text('Equal & Uniform Argument');
                doc.moveDown(0.3);
                doc.fontSize(9).fillColor(TEXT_DARK).font('Helvetica')
                    .text(`Under Texas Tax Code §42.26, a property owner may protest that their property is appraised at a value that exceeds the median level of appraisal of comparable properties. ` +
                        `Our analysis of ${eu.includedCount} comparable properties shows a median assessment-to-sale ratio of ${eu.medianRatio}. ` +
                        `Applying this ratio to the subject property's market value of $${(eu.marketValue || eu.subjectAssessedValue).toLocaleString()} ` +
                        `yields a target value of $${eu.euTargetValue.toLocaleString()}, ` +
                        `which is $${Math.max(0, euReduction).toLocaleString()} less than the current assessed value of $${eu.subjectAssessedValue.toLocaleString()}. ` +
                        `This demonstrates that the subject property is being appraised at a disproportionately high level compared to similar properties in the area.`,
                        { width: 492 });
            }

            // Footer
            doc.moveDown(2);
            drawDivider(doc);
            doc.moveDown(0.5);
            doc.fontSize(8).fillColor(TEXT_MUTED).font('Helvetica')
                .text('This evidence packet was prepared by OverAssessed, LLC for use in property tax protest proceedings. ', { continued: true })
                .text('All data sourced from publicly available appraisal district records. ', { continued: true })
                .text(`Generated ${new Date().toLocaleDateString()}.`);

        } catch (err) {
            console.error('[EvidenceGen] PDF creation error:', err.message);
        }

        doc.end();
        stream.on('finish', () => resolve(filepath));
        stream.on('error', reject);
    });
}

function buildSummaryArgument(caseData, propertyData, compResults) {
    const compsBelow = compResults.comps.filter(c => c.adjustedValue < propertyData.assessedValue);
    return `The property located at ${caseData.propertyAddress} is currently assessed at ` +
        `$${(propertyData.assessedValue || 0).toLocaleString()} for the ${new Date().getFullYear()} tax year. ` +
        `Our analysis identified ${compResults.comps.length} comparable properties within the same area, ` +
        `of which ${compsBelow.length} are assessed at values below the subject property after adjustments ` +
        `for differences in size, age, and lot characteristics. ` +
        `Based on the comparable sales analysis, the property's value should be no more than ` +
        `$${compResults.recommendedValue.toLocaleString()}, representing a reduction of ` +
        `$${compResults.reduction.toLocaleString()} from the current assessment. ` +
        `This reduction would result in estimated annual tax savings of approximately ` +
        `$${compResults.estimatedSavings.toLocaleString()}. ` +
        `We respectfully request that the appraisal review board adjust the assessed value ` +
        `to reflect the true market value as demonstrated by these comparable properties.`;
}

function drawHeader(doc) {
    // Purple-blue gradient header bar
    doc.rect(0, 0, 612, 40).fill(PURPLE);
    doc.rect(0, 0, 612, 3).fill(BLUE);
    doc.fontSize(12).fillColor('white').font('Helvetica-Bold')
        .text('OverAssessed', 60, 12);
    doc.fontSize(8).fillColor('white').font('Helvetica')
        .text('Property Tax Protest Evidence', 400, 15, { align: 'right', width: 152 });
    doc.y = 55;
}

function drawDivider(doc) {
    const y = doc.y;
    doc.moveTo(60, y).lineTo(552, y).strokeColor(PURPLE).lineWidth(1).stroke();
    doc.y = y + 2;
}

function drawInfoRow(doc, x, y, label, value) {
    doc.fontSize(10).fillColor(TEXT_MUTED).font('Helvetica')
        .text(label, x, y, { width: 160 });
    doc.fontSize(11).fillColor(TEXT_DARK).font('Helvetica-Bold')
        .text(String(value || '—'), x + 165, y, { width: 280 });
}

module.exports = {
    generateEvidencePacket,
    EVIDENCE_DIR
};
